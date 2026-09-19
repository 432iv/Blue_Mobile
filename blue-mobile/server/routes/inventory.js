"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/inventory — المخزون
   منتجات (هواتف/إكسسوارات) + تصنيفات + وحدات IMEI + حركة المخزون + الجرد
   كل تغيير كمية يمر عبر حركة مخزون موثقة.
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const { wrap, HttpError, cleanText, toInt, toMoney } = require("../lib/http");
const { mapProduct, mapCategory, mapUnit, mapStockMove, mapStocktake } = require("../lib/map");

const router = express.Router();
const r2 = ledger.r2;

const PRODUCT_SELECT = `
  SELECT p.*, c.name AS category_name FROM products p
  LEFT JOIN categories c ON c.id = p.category_id`;

async function getProduct(client, id, forUpdate) {
  const { rows } = await client.query(
    `SELECT p.*, c.name AS category_name FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
     WHERE p.id = $1 ${forUpdate ? "FOR UPDATE OF p" : ""}`, [id]);
  if (!rows.length) throw new HttpError(404, "product_not_found", "Product not found");
  return rows[0];
}

async function assertBarcodeFree(client, barcode, exceptId) {
  const code = String(barcode || "").trim();
  if (!code) return null;
  const { rows } = await client.query(
    "SELECT id FROM products WHERE barcode = $1 AND id <> COALESCE($2::bigint, 0)", [code, exceptId || null]);
  if (rows.length) throw new HttpError(409, "barcode_taken", "هذا الباركود مستخدم لمنتج آخر");
  return code || null;
}

/* تنظيف قائمة IMEI: إزالة الفراغات والتكرار */
function cleanImeis(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[\n,،]/);
  const out = [];
  for (let v of list) {
    v = String(v || "").replace(/\s+/g, "").trim();
    if (v && !out.includes(v)) out.push(v.slice(0, 20));
  }
  return out;
}

async function checkImeisFree(client, imeis, exceptUnitId) {
  for (const imei of imeis) {
    const { rows } = await client.query(
      "SELECT id, product_id FROM phone_units WHERE imei = $1 AND id <> COALESCE($2::bigint, 0)", [imei, exceptUnitId || null]);
    if (rows.length) throw new HttpError(409, "imei_taken", "الرقم التسلسلي IMEI " + imei + " مسجل مسبقاً");
  }
}

/* إضافة وحدات هاتف ( placeholders أو بـ IMEI ) */
async function createUnits(client, productId, imeis, purchaseItemId, dayId, reason) {
  for (const imei of imeis) {
    await client.query(
      "INSERT INTO phone_units (product_id, imei, purchase_item_id) VALUES ($1,$2,$3)",
      [productId, imei || null, purchaseItemId || null]);
  }
  if (imeis.length) {
    await client.query("UPDATE products SET quantity = quantity + $1, updated_at = now() WHERE id = $2", [imeis.length, productId]);
    await ledger.recordStockMove(client, {
      productId, qtyIn: imeis.length, reason, refType: purchaseItemId ? "purchase" : "manual",
      note: "وحدات IMEI (" + imeis.length + ")", dayId
    });
  }
}

/* ───────────── المخزون كاملاً + التصنيفات ───────────── */
router.get("/", wrap(async (_req, res) => {
  const [products, categories] = await Promise.all([
    db.query(PRODUCT_SELECT + " ORDER BY p.is_active DESC, p.name"),
    db.query("SELECT * FROM categories ORDER BY sort_order, id")
  ]);
  res.json({ products: products.rows.map(mapProduct), categories: categories.rows.map(mapCategory) });
}));

/* ───────────── بحث سريع للمنتجات (نماذج البيع والشراء) ───────────── */
router.get("/search", wrap(async (req, res) => {
  const q = String(req.query.q || "").replace(/\s+/g, " ").trim();
  const limit = Math.min(parseInt(req.query.limit || "10", 10) || 10, 25);
  if (!q) {
    const { rows } = await db.query(
      PRODUCT_SELECT + " WHERE p.is_active AND p.quantity > 0 ORDER BY p.updated_at DESC LIMIT $1", [limit]);
    return res.json({ products: rows.map(mapProduct) });
  }
  const like = "%" + q.toLowerCase() + "%";
  const { rows } = await db.query(
    `SELECT p.*, c.name AS category_name,
            (CASE
               WHEN lower(p.name) = $1 THEN 0
               WHEN lower(p.name) LIKE $2 THEN 1
               WHEN lower(p.barcode) = $1 THEN 0
               WHEN lower(c.name) LIKE $2 THEN 2
               WHEN lower(p.model) LIKE $2 THEN 2
               WHEN EXISTS (SELECT 1 FROM phone_units u WHERE u.product_id = p.id AND (lower(u.imei) LIKE $2 OR lower(u.serial) LIKE $2)) THEN 1
               ELSE 3 END) AS rank
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.is_active AND (lower(p.name) LIKE $2 OR lower(p.barcode) LIKE $2
             OR lower(p.model) LIKE $2 OR lower(c.name) LIKE $2
             OR EXISTS (SELECT 1 FROM phone_units u WHERE u.product_id = p.id AND (lower(u.imei) LIKE $2 OR lower(u.serial) LIKE $2)))
      ORDER BY rank, p.name LIMIT $3`, [q.toLowerCase(), like, limit]);
  res.json({ products: rows.map(mapProduct) });
}));

/* ───────────── إضافة منتج ───────────── */
router.post("/products", wrap(async (req, res) => {
  const product = await db.tx(async client => {
    const name = cleanText(req.body.name, { field: "name", max: 120 });
    const kind = req.body.kind === "phone" ? "phone" : "accessory";
    const categoryId = req.body.categoryId ? toInt(req.body.categoryId, { field: "categoryId", min: 1 }) : null;
    if (categoryId) {
      const c = await client.query("SELECT id FROM categories WHERE id = $1", [categoryId]);
      if (!c.rows.length) throw new HttpError(404, "category_not_found", "التصنيف غير موجود");
    }
    const barcode = await assertBarcodeFree(client, req.body.barcode, null);
    const purchasePrice = toMoney(req.body.purchasePrice ?? 0, { field: "purchasePrice" });
    const salePrice = toMoney(req.body.salePrice ?? 0, { field: "salePrice" });
    const minStock = toInt(req.body.minStock ?? 3, { field: "minStock", min: 0, max: 100000 });

    const { rows } = await client.query(
      `INSERT INTO products (name, category_id, kind, barcode, image_url, model, color, storage,
                             purchase_price, sale_price, min_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [name, categoryId, kind, barcode,
       req.body.image ? String(req.body.image).slice(0, 300000) : null,
       req.body.model ? cleanText(req.body.model, { field: "model", max: 60, required: false }) : null,
       req.body.color ? cleanText(req.body.color, { field: "color", max: 40, required: false }) : null,
       req.body.storage ? cleanText(req.body.storage, { field: "storage", max: 40, required: false }) : null,
       purchasePrice, salePrice, minStock]);
    const prod = rows[0];

    const day = await ledger.getOpenDay(client);
    if (kind === "phone") {
      const imeis = cleanImeis(req.body.imeis);
      await checkImeisFree(client, imeis, null);
      const extra = imeis.length ? 0 : Math.max(0, toInt(req.body.qty ?? 0, { field: "qty", min: 0 }));
      const all = imeis.concat(Array(extra).fill(""));
      if (all.length) await createUnits(client, prod.id, all, null, day ? day.id : null, "initial");
    } else {
      const qty = toInt(req.body.qty ?? 0, { field: "qty", min: 0, max: 100000 });
      if (qty > 0) {
        await client.query("UPDATE products SET quantity = $1 WHERE id = $2", [qty, prod.id]);
        await ledger.recordStockMove(client, {
          productId: prod.id, qtyIn: qty, reason: "initial",
          note: "رصيد افتتاحي", dayId: day ? day.id : null
        });
      }
    }
    return getProduct(client, prod.id, false);
  });
  res.status(201).json({ product: mapProduct(product) });
}));

/* ───────────── تعديل منتج ───────────── */
router.put("/products/:id(\\d+)", wrap(async (req, res) => {
  const product = await db.tx(async client => {
    const prod = await getProduct(client, req.params.id, true);

    const name = cleanText(req.body.name ?? prod.name, { field: "name", max: 120 });
    const barcode = await assertBarcodeFree(client, req.body.barcode ?? prod.barcode, prod.id);
    let categoryId = prod.category_id;
    if (req.body.categoryId !== undefined) {
      categoryId = req.body.categoryId ? toInt(req.body.categoryId, { field: "categoryId", min: 1 }) : null;
      if (categoryId) {
        const c = await client.query("SELECT id FROM categories WHERE id = $1", [categoryId]);
        if (!c.rows.length) throw new HttpError(404, "category_not_found", "التصنيف غير موجود");
      }
    }
    let kind = prod.kind;
    if (req.body.kind && req.body.kind !== prod.kind) {
      const hasUnits = await client.query("SELECT count(*)::int AS n FROM phone_units WHERE product_id = $1", [prod.id]);
      if (Number(hasUnits.rows[0].n) > 0) {
        throw new HttpError(409, "kind_locked", "لا يمكن تغيير نوع منتج له وحدات IMEI مسجلة");
      }
      kind = req.body.kind === "phone" ? "phone" : "accessory";
    }

    await client.query(
      `UPDATE products SET name=$1, category_id=$2, kind=$3, barcode=$4,
              image_url=$5, model=$6, color=$7, storage=$8,
              purchase_price=$9, sale_price=$10, min_stock=$11, is_active=$12, updated_at=now()
        WHERE id=$13`,
      [name, categoryId, kind, barcode,
       req.body.image !== undefined ? (req.body.image ? String(req.body.image).slice(0, 300000) : null) : prod.image_url,
       req.body.model !== undefined ? (req.body.model ? cleanText(req.body.model, { field: "model", max: 60, required: false }) : null) : prod.model,
       req.body.color !== undefined ? (req.body.color ? cleanText(req.body.color, { field: "color", max: 40, required: false }) : null) : prod.color,
       req.body.storage !== undefined ? (req.body.storage ? cleanText(req.body.storage, { field: "storage", max: 40, required: false }) : null) : prod.storage,
       toMoney(req.body.purchasePrice ?? prod.purchase_price, { field: "purchasePrice" }),
       toMoney(req.body.salePrice ?? prod.sale_price, { field: "salePrice" }),
       toInt(req.body.minStock ?? prod.min_stock, { field: "minStock", min: 0, max: 100000 }),
       req.body.active === undefined ? prod.is_active : !!req.body.active,
       prod.id]);
    return getProduct(client, prod.id, false);
  });
  res.json({ product: mapProduct(product) });
}));

/* ───────────── حذف منتج — فقط إذا لم يسبق تحركه (وإلا: أرشفة) ───────────── */
router.delete("/products/:id(\\d+)", wrap(async (req, res) => {
  await db.tx(async client => {
    const prod = await getProduct(client, req.params.id, true);
    const used = await client.query(
      `SELECT (SELECT count(*) FROM stock_movements WHERE product_id = $1) AS moves,
              (SELECT count(*) FROM invoice_items WHERE product_id = $1) AS sales,
              (SELECT count(*) FROM purchase_items WHERE product_id = $1) AS purchases`, [prod.id]);
    const u = used.rows[0];
    if (Number(u.moves) > 0 || Number(u.sales) > 0 || Number(u.purchases) > 0) {
      throw new HttpError(409, "product_in_use",
        "لا يمكن حذف منتج له سجل حركة أو عمليات — أرشفه بدلاً من ذلك لتبقى التقارير سليمة");
    }
    await client.query("DELETE FROM phone_units WHERE product_id = $1", [prod.id]);
    await client.query("DELETE FROM products WHERE id = $1", [prod.id]);
  });
  res.json({ ok: true, id: String(req.params.id) });
}));

/* ───────────── تسوية يدوية للكمية ───────────── */
router.post("/products/:id(\\d+)/adjust", wrap(async (req, res) => {
  const out = await db.tx(async client => {
    const prod = await getProduct(client, req.params.id, true);
    const day = await ledger.requireOpenDay(client);
    const direction = req.body.direction === "out" ? "out" : "in";
    const qty = toInt(req.body.qty, { field: "qty" });
    const note = req.body.note ? cleanText(req.body.note, { field: "note", max: 200, required: false }) : "تسوية يدوية";

    if (direction === "in") {
      if (prod.kind === "phone") {
        await createUnits(client, prod.id, Array(qty).fill(""), null, day.id, "adjustment");
      } else {
        await client.query("UPDATE products SET quantity = quantity + $1, updated_at = now() WHERE id = $2", [qty, prod.id]);
        await ledger.recordStockMove(client, { productId: prod.id, qtyIn: qty, reason: "adjustment", note, dayId: day.id });
      }
    } else {
      if (prod.quantity < qty) throw new HttpError(400, "stock_insufficient", "الكمية المتوفرة " + prod.quantity);
      if (prod.kind === "phone") {
        /* حذف أقدم الوحدات (بدون IMEI أولاً) */
        const units = await client.query(
          `SELECT id FROM phone_units WHERE product_id = $1 AND status = 'in_stock'
            ORDER BY (imei IS NULL) DESC, created_at, id LIMIT $2 FOR UPDATE`, [prod.id, qty]);
        if (units.rows.length < qty) throw new HttpError(400, "stock_insufficient", "الوحدات المتوفرة " + units.rows.length);
        for (const u of units.rows) await client.query("DELETE FROM phone_units WHERE id = $1", [u.id]);
        await client.query("UPDATE products SET quantity = quantity - $1, updated_at = now() WHERE id = $2", [qty, prod.id]);
        await ledger.recordStockMove(client, { productId: prod.id, qtyOut: qty, reason: "adjustment", note, dayId: day.id });
      } else {
        await client.query("UPDATE products SET quantity = quantity - $1, updated_at = now() WHERE id = $2", [qty, prod.id]);
        await ledger.recordStockMove(client, { productId: prod.id, qtyOut: qty, reason: "adjustment", note, dayId: day.id });
      }
    }
    return getProduct(client, prod.id, false);
  });
  res.json({ product: mapProduct(out) });
}));

/* ───────────── وحدات الهاتف ───────────── */
router.get("/products/:id(\\d+)/units", wrap(async (req, res) => {
  const prod = await db.query("SELECT id FROM products WHERE id = $1", [req.params.id]);
  if (!prod.rows.length) throw new HttpError(404, "product_not_found", "Product not found");
  const { rows } = await db.query(
    `SELECT u.*, iv.invoice_no
       FROM phone_units u
       LEFT JOIN invoice_items ii ON ii.id = u.invoice_item_id
       LEFT JOIN invoices iv ON iv.id = ii.invoice_id
      WHERE u.product_id = $1
      ORDER BY (u.status = 'in_stock') DESC, u.created_at DESC, u.id DESC`, [req.params.id]);
  res.json({ units: rows.map(r => Object.assign(mapUnit(r), { invoiceNo: r.invoice_no || null })) });
}));

router.post("/products/:id(\\d+)/units", wrap(async (req, res) => {
  const unit = await db.tx(async client => {
    const prod = await getProduct(client, req.params.id, true);
    if (prod.kind !== "phone") throw new HttpError(400, "not_a_phone", "إضافة الوحدات متاحة لمنتجات الهواتف فقط");
    const day = await ledger.requireOpenDay(client);
    const imei = String(req.body.imei || "").replace(/\s+/g, "").slice(0, 20) || null;
    const serial = req.body.serial ? cleanText(req.body.serial, { field: "serial", max: 40, required: false }) : null;
    if (imei) await checkImeisFree(client, [imei], null);
    const { rows } = await client.query(
      "INSERT INTO phone_units (product_id, imei, serial) VALUES ($1,$2,$3) RETURNING *",
      [prod.id, imei, serial]);
    await client.query("UPDATE products SET quantity = quantity + 1, updated_at = now() WHERE id = $1", [prod.id]);
    await ledger.recordStockMove(client, {
      productId: prod.id, qtyIn: 1, reason: "initial",
      note: "إضافة وحدة " + (imei || serial || ""), dayId: day.id
    });
    return rows[0];
  });
  res.status(201).json({ unit: mapUnit(unit) });
}));

router.put("/units/:id(\\d+)", wrap(async (req, res) => {
  const unit = await db.tx(async client => {
    const { rows } = await client.query("SELECT * FROM phone_units WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!rows.length) throw new HttpError(404, "unit_not_found", "الوحدة غير موجودة");
    const u = rows[0];
    const imei = req.body.imei !== undefined
      ? (String(req.body.imei || "").replace(/\s+/g, "").slice(0, 20) || null) : u.imei;
    const serial = req.body.serial !== undefined
      ? (req.body.serial ? cleanText(req.body.serial, { field: "serial", max: 40, required: false }) : null) : u.serial;
    if (imei) await checkImeisFree(client, [imei], u.id);
    const out = await client.query(
      "UPDATE phone_units SET imei = $1, serial = $2, updated_at = now() WHERE id = $3 RETURNING *",
      [imei, serial, u.id]);
    /* تحديث لقطة IMEI في بنود الفواتير السابقة غير مطلوب — اللقطة تاريخية */
    return out.rows[0];
  });
  res.json({ unit: mapUnit(unit) });
}));

router.delete("/units/:id(\\d+)", wrap(async (req, res) => {
  await db.tx(async client => {
    const { rows } = await client.query("SELECT * FROM phone_units WHERE id = $1 FOR UPDATE", [req.params.id]);
    if (!rows.length) throw new HttpError(404, "unit_not_found", "الوحدة غير موجودة");
    if (rows[0].status !== "in_stock") throw new HttpError(409, "unit_not_in_stock", "لا يمكن حذف وحدة مبيعة");
    const day = await ledger.getOpenDay(client);
    await client.query("DELETE FROM phone_units WHERE id = $1", [req.params.id]);
    await client.query("UPDATE products SET quantity = quantity - 1, updated_at = now() WHERE id = $1", [rows[0].product_id]);
    await ledger.recordStockMove(client, {
      productId: rows[0].product_id, qtyOut: 1, reason: "adjustment",
      note: "حذف وحدة " + (rows[0].imei || ""), dayId: day ? day.id : null
    });
  });
  res.json({ ok: true, id: String(req.params.id) });
}));

/* ───────────── حركة المخزون ───────────── */
router.get("/movements", wrap(async (req, res) => {
  const where = [], params = [];
  if (req.query.productId) { params.push(req.query.productId); where.push(`m.product_id = $${params.length}`); }
  if (req.query.reason)    { params.push(req.query.reason);    where.push(`m.reason = $${params.length}`); }
  if (req.query.from)      { params.push(req.query.from);      where.push(`m.moved_at >= $${params.length}::date`); }
  if (req.query.to)        { params.push(req.query.to);        where.push(`m.moved_at < ($${params.length}::date + 1)`); }
  const limit = Math.min(parseInt(req.query.limit || "500", 10) || 500, 2000);
  params.push(limit);
  const { rows } = await db.query(
    `SELECT m.*, p.name AS product_name FROM stock_movements m
      JOIN products p ON p.id = m.product_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY m.moved_at DESC, m.id DESC LIMIT $${params.length}`, params);
  res.json({ movements: rows.map(mapStockMove) });
}));

/* ───────────── التصنيفات ───────────── */
router.post("/categories", wrap(async (req, res) => {
  const name = cleanText(req.body.name, { field: "name", max: 40 });
  const { rows } = await db.query(
    `INSERT INTO categories (name, sort_order) VALUES ($1, 99)
     ON CONFLICT (name) DO UPDATE SET sort_order = categories.sort_order RETURNING *`, [name]);
  res.status(201).json({ category: mapCategory(rows[0]) });
}));
router.put("/categories/:id(\\d+)", wrap(async (req, res) => {
  const name = cleanText(req.body.name, { field: "name", max: 40 });
  const { rows } = await db.query(
    `INSERT INTO categories (id, name) VALUES ($1,$2)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name RETURNING *`, [req.params.id, name]);
  res.json({ category: mapCategory(rows[0]) });
}));
router.delete("/categories/:id(\\d+)", wrap(async (req, res) => {
  await db.query("UPDATE products SET category_id = NULL WHERE category_id = $1", [req.params.id]);
  await db.query("DELETE FROM categories WHERE id = $1", [req.params.id]);
  res.json({ ok: true, id: String(req.params.id) });
}));

/* ───────────── الجرد ───────────── */
router.get("/stocktakes", wrap(async (_req, res) => {
  const { rows } = await db.query("SELECT * FROM stocktakes ORDER BY created_at DESC, id DESC LIMIT 100");
  res.json({ stocktakes: rows.map(mapStocktake) });
}));

router.post("/stocktakes", wrap(async (req, res) => {
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  if (!lines.length) throw new HttpError(400, "lines_required", "أضف أصناف الجرد");
  const out = await db.tx(async client => {
    const day = await ledger.requireOpenDay(client);
    const note = req.body.note ? cleanText(req.body.note, { field: "note", max: 200, required: false }) : null;
    const st = (await client.query(
      "INSERT INTO stocktakes (day_id, note) VALUES ($1,$2) RETURNING *", [day.id, note])).rows[0];

    let diffLines = 0;
    for (const ln of lines) {
      const prod = await getProduct(client, ln.productId, true);
      const counted = toInt(ln.countedQty, { field: "countedQty", min: 0, max: 100000 });
      const diff = counted - prod.quantity;
      await client.query(
        `INSERT INTO stocktake_items (stocktake_id, product_id, product_name, system_qty, counted_qty)
         VALUES ($1,$2,$3,$4,$5)`, [st.id, prod.id, prod.name, prod.quantity, counted]);

      if (diff > 0) {
        if (prod.kind === "phone") {
          await createUnits(client, prod.id, Array(diff).fill(""), null, day.id, "adjustment");
        } else {
          await client.query("UPDATE products SET quantity = $1, updated_at = now() WHERE id = $2", [counted, prod.id]);
          await ledger.recordStockMove(client, {
            productId: prod.id, qtyIn: diff, reason: "adjustment",
            refType: "stocktake", refId: st.id, note: "جرد: زيادة " + diff, dayId: day.id });
        }
      } else if (diff < 0) {
        if (prod.kind === "phone") {
          const units = await client.query(
            `SELECT id FROM phone_units WHERE product_id = $1 AND status = 'in_stock'
              ORDER BY (imei IS NULL) DESC, created_at, id LIMIT $2 FOR UPDATE`, [prod.id, -diff]);
          if (units.rows.length < -diff) throw new HttpError(400, "stock_insufficient", "الوحدات المتوفرة أقل من الفرق");
          for (const u of units.rows) await client.query("DELETE FROM phone_units WHERE id = $1", [u.id]);
        }
        await client.query("UPDATE products SET quantity = $1, updated_at = now() WHERE id = $2", [counted, prod.id]);
        await ledger.recordStockMove(client, {
          productId: prod.id, qtyOut: -diff, reason: "adjustment",
          refType: "stocktake", refId: st.id, note: "جرد: نقص " + (-diff), dayId: day.id });
      }
      if (diff !== 0) diffLines++;
    }
    await client.query("UPDATE stocktakes SET lines = $1, diff_lines = $2 WHERE id = $3",
      [lines.length, diffLines, st.id]);
    return (await client.query("SELECT * FROM stocktakes WHERE id = $1", [st.id])).rows[0];
  });
  res.status(201).json({ stocktake: mapStocktake(out) });
}));

router.get("/stocktakes/:id(\\d+)", wrap(async (req, res) => {
  const st = await db.query("SELECT * FROM stocktakes WHERE id = $1", [req.params.id]);
  if (!st.rows.length) throw new HttpError(404, "stocktake_not_found", "الجرد غير موجود");
  const items = await db.query(
    "SELECT * FROM stocktake_items WHERE stocktake_id = $1 ORDER BY diff = 0, product_name", [req.params.id]);
  res.json({ stocktake: mapStocktake(st.rows[0]), items: items.rows.map(r => ({
    id: String(r.id), productId: String(r.product_id), product: r.product_name,
    systemQty: r.system_qty, countedQty: r.counted_qty, diff: r.diff
  })) });
}));

module.exports = router;
