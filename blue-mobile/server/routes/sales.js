"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/sales — المبيعات في نموذج الفواتير متعددة الأصناف
   كل عملية بيع:
     خصم المخزون + حركة مخزون + فاتورة + أصنافها + حركة صندوق + ربح
   المرتجعات والإلغاء والتعديل تعكس كل الآثار داخل معاملة واحدة.
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const { wrap, HttpError, cleanText, toInt, toMoney, isoDate } = require("../lib/http");
const { mapInvoice, mapInvoiceLite, mapReturn } = require("../lib/map");
const { rememberName } = require("./products");

const router = express.Router();
const r2 = ledger.r2;

async function validPayment(code, client) {
  const q = client || db;
  const { rows } = await q.query("SELECT code FROM payment_methods WHERE code = $1 AND active", [code]);
  if (!rows.length) throw new HttpError(400, "payment_invalid", "Unknown payment method");
  return rows[0].code;
}

function resolveDebtorName(payment, raw) {
  if (payment !== "unpaid") return null;
  const name = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 80);
  return name || null;
}

/* ───────────── بنود الفاتورة: تحقق + تجهيز ─────────────
   البند: {productId?, name, qty, wholesale, selling, unitIds?[]}
   - بند بمنتج مخزني: يخصم من المخزون (وللهواتف عبر وحدات IMEI)
   - بند حر (بدون productId): يُباع بدون مخزون كما في النسخة السابقة */
async function prepareItems(client, rawItems, mode) {
  const prepared = [];
  for (const raw of rawItems) {
    const name = cleanText(raw.name || raw.product, { field: "product", max: 120, required: !raw.productId });
    const qty = toInt(raw.qty, { field: "qty" });
    const wholesale = toMoney(raw.wholesale ?? 0, { field: "wholesale" });
    const selling = toMoney(raw.selling ?? raw.price, { field: "price" });
    let product = null;

    if (raw.productId) {
      const { rows } = await client.query(
        "SELECT * FROM products WHERE id = $1 FOR UPDATE", [raw.productId]);
      if (!rows.length) throw new HttpError(404, "product_not_found", "Product not found");
      product = rows[0];
      if (!product.is_active) throw new HttpError(400, "product_inactive", "Product is archived");
    }

    let units = null;
    if (product && product.kind === "phone") {
      /* الهواتف: كل وحدة IMEI = صنف مستقل بكمية 1 */
      let unitIds = Array.isArray(raw.unitIds) ? raw.unitIds.map(String) : null;
      let rows;
      if (unitIds && unitIds.length) {
        if (unitIds.length !== qty) {
          throw new HttpError(400, "units_mismatch", "عدد الوحدات (IMEI) يجب أن يساوي الكمية");
        }
        rows = (await client.query(
          `SELECT * FROM phone_units WHERE id = ANY($1::bigint[]) AND product_id = $2 AND status = 'in_stock' FOR UPDATE`,
          [unitIds, product.id])).rows;
        if (rows.length !== unitIds.length) {
          throw new HttpError(400, "unit_not_available", "وحدة IMEI غير متوفرة");
        }
      } else {
        rows = (await client.query(
          `SELECT * FROM phone_units WHERE product_id = $1 AND status = 'in_stock' ORDER BY created_at, id LIMIT $2 FOR UPDATE`,
          [product.id, qty])).rows;
        if (rows.length < qty) {
          throw new HttpError(400, "stock_insufficient", "الكمية المتوفرة من " + product.name + " هي " + rows.length);
        }
      }
      units = rows;
    } else if (product) {
      if (qty > product.quantity) {
        throw new HttpError(400, "stock_insufficient", "الكمية المتوفرة من " + product.name + " هي " + product.quantity);
      }
    }

    prepared.push({ product, name: product ? product.name : name, qty, wholesale, selling, units });
  }
  return prepared;
}

/* إدخال بنود الفاتورة + خصم المخزون + حركات المخزون */
async function applyItems(client, invoiceId, dayId, prepared, reason) {
  let subtotal = 0, costTotal = 0;
  for (const p of prepared) {
    subtotal  += r2(p.selling * p.qty);
    costTotal += r2(p.wholesale * p.qty);

    if (!p.product) continue;                      /* بند حر: لا مخزون */

    if (p.units) {
      /* هواتف: صنف لكل وحدة */
      for (const u of p.units) {
        const { rows } = await client.query(
          `INSERT INTO invoice_items (invoice_id, product_id, product_name, qty, wholesale_price, selling_price, unit_id, imei)
           VALUES ($1,$2,$3,1,$4,$5,$6,$7) RETURNING *`,
          [invoiceId, p.product.id, p.name, p.wholesale, p.selling, u.id, u.imei]);
        await client.query(
          `UPDATE phone_units SET status = 'sold', invoice_item_id = $1, updated_at = now() WHERE id = $2`,
          [rows[0].id, u.id]);
      }
      await client.query("UPDATE products SET quantity = quantity - $1, updated_at = now() WHERE id = $2",
        [p.qty, p.product.id]);
      await ledger.recordStockMove(client, {
        productId: p.product.id, qtyOut: p.qty, reason, refType: "invoice", refId: invoiceId,
        note: "فاتورة بيع", dayId
      });
    } else {
      await client.query(
        `INSERT INTO invoice_items (invoice_id, product_id, product_name, qty, wholesale_price, selling_price)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [invoiceId, p.product.id, p.name, p.qty, p.wholesale, p.selling]);
      await client.query("UPDATE products SET quantity = quantity - $1, updated_at = now() WHERE id = $2",
        [p.qty, p.product.id]);
      await ledger.recordStockMove(client, {
        productId: p.product.id, qtyOut: p.qty, reason, refType: "invoice", refId: invoiceId,
        note: "فاتورة بيع", dayId
      });
    }
  }
  return { subtotal: r2(subtotal), costTotal: r2(costTotal) };
}

/* إرجاع بنود فاتورة إلى المخزون (كمية لم تُرجع) */
async function restoreInvoiceStock(client, invoice, reason, note) {
  const { rows: items } = await client.query(
    `SELECT ii.*, pu.id AS pu_id, pu.status AS pu_status
       FROM invoice_items ii
       LEFT JOIN phone_units pu ON pu.invoice_item_id = ii.id
      WHERE ii.invoice_id = $1`, [invoice.id]);
  let restoredQty = 0;
  for (const it of items) {
    const give = it.qty - it.qty_returned;
    if (!it.product_id || give <= 0) continue;
    await client.query("UPDATE products SET quantity = quantity + $1, updated_at = now() WHERE id = $2",
      [give, it.product_id]);
    await ledger.recordStockMove(client, {
      productId: it.product_id, qtyIn: give, reason, refType: "invoice", refId: invoice.id,
      note: note + " " + invoice.invoice_no, dayId: (await ledger.getOpenDay(client) || {}).id || null
    });
    restoredQty += give;
  }
  /* وحدات الهواتف المبيعة في هذه الفاتورة → متوفرة مجدداً */
  await client.query(
    `UPDATE phone_units SET status = 'in_stock', invoice_item_id = NULL, updated_at = now()
      WHERE invoice_item_id IN (SELECT id FROM invoice_items WHERE invoice_id = $1)
        AND status = 'sold'`, [invoice.id]);
  return restoredQty;
}

/* حركة الصندوق لفاتورة حسب طريقة الدفع */
async function cashForInvoice(client, invoice, dayId) {
  if (invoice.payment_method === "unpaid" || Number(invoice.total) <= 0) return;
  await ledger.recordCashMove(client, {
    dayId, direction: "in", method: invoice.payment_method, category: "sale",
    amount: Number(invoice.total), description: "فاتورة بيع " + invoice.invoice_no,
    refType: "invoice", refId: invoice.id
  });
}

async function loadInvoice(id) {
  const { rows } = await db.query("SELECT * FROM invoices WHERE id = $1", [id]);
  if (!rows.length) throw new HttpError(404, "sale_not_found", "Sale not found");
  return rows[0];
}
async function loadInvoiceWithItems(id) {
  const inv = await loadInvoice(id);
  const items = await db.query("SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id", [id]);
  return mapInvoice(inv, items.rows);
}

/* ───────────── قائمة الفواتير ───────────── */
router.get("/", wrap(async (req, res) => {
  const where = [], params = [];
  if (req.query.date)  { params.push(isoDate(req.query.date)); where.push(`i.sale_date = $${params.length}`); }
  if (req.query.dayId) { params.push(req.query.dayId);         where.push(`i.day_id = $${params.length}`); }
  if (req.query.status){ params.push(req.query.status);        where.push(`i.status = $${params.length}`); }
  if (req.query.q) {
    params.push("%" + String(req.query.q).trim().toLowerCase() + "%");
    where.push(`(lower(i.invoice_no) LIKE $${params.length}
                 OR lower(i.debtor_name) LIKE $${params.length}
                 OR EXISTS (SELECT 1 FROM invoice_items x WHERE x.invoice_id = i.id
                             AND lower(x.product_name) LIKE $${params.length}))`);
  }
  const limit = Math.min(parseInt(req.query.limit || "300", 10) || 300, 1000);
  params.push(limit);
  const { rows } = await db.query(
    `SELECT i.* FROM invoices i ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY i.sale_time DESC, i.id DESC LIMIT $${params.length}`, params);
  if (!rows.length) return res.json({ invoices: [] });
  const ids = rows.map(r => r.id);
  const items = await db.query(
    `SELECT * FROM invoice_items WHERE invoice_id = ANY($1::bigint[]) ORDER BY id`, [ids]);
  const byInv = new Map();
  for (const it of items.rows) {
    if (!byInv.has(String(it.invoice_id))) byInv.set(String(it.invoice_id), []);
    byInv.get(String(it.invoice_id)).push(it);
  }
  res.json({ invoices: rows.map(r => mapInvoice(r, byInv.get(String(r.id)) || [])) });
}));

/* ───────────── ملخص اليوم (توافق مع الواجهة القديمة) ───────────── */
router.get("/summary", wrap(async (req, res) => {
  let dayId;
  if (req.query.dayId) dayId = req.query.dayId;
  else if (req.query.date) {
    const d = await db.query("SELECT id FROM days WHERE day_date = $1", [isoDate(req.query.date)]);
    if (!d.rows.length) return res.json({ summary: null, day: null });
    dayId = d.rows[0].id;
  } else {
    const open = await ledger.getOpenDay();
    if (!open) return res.json({ summary: null, day: null });
    dayId = open.id;
  }
  const day = await ledger.dayById(dayId);
  const { totals } = await ledger.daySummaryForApi(dayId);
  res.json({
    summary: {
      total: totals.total, cost: totals.cost, profit: totals.profit, count: totals.count,
      cash: totals.cash, card: totals.card, byMethod: totals.byMethod
    },
    day: { id: String(day.id), date: day.day_date, status: day.status }
  });
}));

/* ───────────── تسجيل بيع جديد ───────────── */
router.post("/", wrap(async (req, res) => {
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rawItems.length) throw new HttpError(400, "items_required", "أضف منتجًا واحدًا على الأقل");

  const invoice = await db.tx(async client => {
    const day = req.body.dayId
      ? await ledger.assertDayOpen(req.body.dayId, client)
      : await ledger.requireOpenDay(client);

    const payment = await validPayment(req.body.payment ?? req.body.payment_method, client);
    const debtorName = resolveDebtorName(payment, req.body.debtorName ?? req.body.debtor_name);
    const prepared = await prepareItems(client, rawItems, "create");

    const { rows } = await client.query(
      `INSERT INTO invoices (day_id, invoice_no, payment_method, debtor_name, sale_date)
       VALUES ($1, 'INV-' || lpad(nextval('invoice_seq')::text, 5, '0'), $2, $3, $4)
       RETURNING *`,
      [day.id, payment, debtorName, day.day_date]);
    const inv = rows[0];

    const { subtotal, costTotal } = await applyItems(client, inv.id, day.id, prepared, "sale");
    const discount = Math.min(toMoney(req.body.discount ?? 0, { field: "discount" }), subtotal);

    await client.query(
      `UPDATE invoices SET subtotal = $1, cost_total = $2, discount = $3, notes = $4, updated_at = now()
        WHERE id = $5 RETURNING *`,
      [subtotal, costTotal, discount, req.body.notes ? cleanText(req.body.notes, { field: "notes", max: 300, required: false }) : null, inv.id]);

    /* الأسماء الحرة تدخل قاموس الإكمال التلقائي كما في السابق */
    for (const p of prepared) {
      if (!p.product) await rememberName(client, p.name);
    }

    const finalInv = (await client.query("SELECT * FROM invoices WHERE id = $1", [inv.id])).rows[0];
    await cashForInvoice(client, finalInv, day.id);
    return finalInv;
  });

  res.status(201).json({ sale: await loadInvoiceWithItems(invoice.id), invoice: await loadInvoiceWithItems(invoice.id) });
}));

/* ───────────── تفاصيل فاتورة ───────────── */
router.get("/:id(\\d+)", wrap(async (req, res) => {
  res.json({ sale: await loadInvoiceWithItems(req.params.id) });
}));

/* ───────────── تعديل فاتورة (اليوم مفتوح، بدون مرتجعات) ───────────── */
router.put("/:id(\\d+)", wrap(async (req, res) => {
  const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
  if (!rawItems.length) throw new HttpError(400, "items_required", "أضف منتجًا واحدًا على الأقل");

  const out = await db.tx(async client => {
    const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    if (!inv) throw new HttpError(404, "sale_not_found", "Sale not found");
    await ledger.assertDayOpen(inv.day_id, client);
    if (inv.status === "cancelled") throw new HttpError(409, "invoice_cancelled", "الفاتورة ملغاة");
    if (Number(inv.refunded) > 0) throw new HttpError(409, "invoice_has_returns", "الفاتورة تحتوي مرتجعات — لا يمكن تعديلها");

    /* 1) إرجاع المخزون القديم كاملاً */
    await restoreInvoiceStock(client, inv, "edit", "تعديل فاتورة");
    /* 2) حذف البنود القديمة وحركات الصندوق المرتبطة (سيُعاد بناؤها) */
    await client.query("DELETE FROM invoice_items WHERE invoice_id = $1", [inv.id]);
    await client.query("DELETE FROM cash_movements WHERE ref_type = 'invoice' AND ref_id = $1", [inv.id]);

    /* 3) إعادة التطبيق على البنود الجديدة */
    const payment = await validPayment(req.body.payment ?? req.body.payment_method ?? inv.payment_method, client);
    const debtorName = resolveDebtorName(payment, req.body.debtorName ?? req.body.debtor_name);
    const prepared = await prepareItems(client, rawItems, "edit");
    const { subtotal, costTotal } = await applyItems(client, inv.id, inv.day_id, prepared, "edit");
    const discount = Math.min(toMoney(req.body.discount ?? inv.discount, { field: "discount" }), subtotal);

    await client.query(
      `UPDATE invoices SET payment_method = $1, debtor_name = $2, subtotal = $3, cost_total = $4,
                           discount = $5, notes = $6, updated_at = now() WHERE id = $7`,
      [payment, debtorName, subtotal, costTotal, discount,
       req.body.notes !== undefined ? (req.body.notes ? cleanText(req.body.notes, { field: "notes", max: 300, required: false }) : null) : inv.notes,
       inv.id]);

    const finalInv = (await client.query("SELECT * FROM invoices WHERE id = $1", [inv.id])).rows[0];
    await cashForInvoice(client, finalInv, inv.day_id);
    return finalInv;
  });

  res.json({ sale: await loadInvoiceWithItems(out.id) });
}));

/* ───────────── إرجاع منتجات من فاتورة ───────────── */
router.post("/:id(\\d+)/returns", wrap(async (req, res) => {
  const rawReturns = Array.isArray(req.body.returns) ? req.body.returns : [];
  if (!rawReturns.length) throw new HttpError(400, "returns_required", "حدد الأصناف المرتجعة");

  const result = await db.tx(async client => {
    const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    if (!inv) throw new HttpError(404, "sale_not_found", "Sale not found");
    if (inv.status === "cancelled") throw new HttpError(409, "invoice_cancelled", "الفاتورة ملغاة");
    const day = await ledger.requireOpenDay(client);   /* الإرجاع يسجل في اليوم المفتوح الحالي */

    let refundTotal = 0, refundProfit = 0;
    const applied = [];
    for (const rt of rawReturns) {
      const item = (await client.query("SELECT * FROM invoice_items WHERE id = $1 AND invoice_id = $2 FOR UPDATE",
        [rt.itemId, inv.id])).rows[0];
      if (!item) throw new HttpError(404, "item_not_found", "صنف غير موجود في الفاتورة");
      const maxGive = item.qty - item.qty_returned;
      const qty = toInt(rt.qty, { field: "qty", min: 1, max: maxGive });
      const reason = rt.reason ? cleanText(rt.reason, { field: "reason", max: 200, required: false }) : null;

      const amount = r2(Number(item.selling_price) * qty);
      const profitAdjust = r2((Number(item.selling_price) - Number(item.wholesale_price)) * qty);

      await client.query("UPDATE invoice_items SET qty_returned = qty_returned + $1 WHERE id = $2", [qty, item.id]);
      await client.query(
        `INSERT INTO sale_returns (invoice_id, item_id, day_id, qty, amount, profit_adjust, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [inv.id, item.id, day.id, qty, amount, profitAdjust, reason]);

      if (item.product_id) {
        await client.query("UPDATE products SET quantity = quantity + $1, updated_at = now() WHERE id = $2",
          [qty, item.product_id]);
        await ledger.recordStockMove(client, {
          productId: item.product_id, qtyIn: qty, reason: "return_in",
          refType: "sale_return", refId: inv.id, note: "مرتجع فاتورة " + inv.invoice_no, dayId: day.id
        });
        if (item.unit_id) {
          await client.query(
            `UPDATE phone_units SET status = 'in_stock', invoice_item_id = NULL, updated_at = now() WHERE id = $1`,
            [item.unit_id]);
        }
      }
      refundTotal += amount;
      refundProfit += profitAdjust;
      applied.push({ itemId: String(item.id), qty, amount, profitAdjust });
    }

    await client.query(
      "UPDATE invoices SET refunded = refunded + $1, refunded_profit = refunded_profit + $2, updated_at = now() WHERE id = $3",
      [r2(refundTotal), r2(refundProfit), inv.id]);

    /* إن أُرجعت كل الكميات → الفاتورة "مُرجعة" */
    const left = await client.query(
      "SELECT count(*)::int AS n FROM invoice_items WHERE invoice_id = $1 AND qty_returned < qty", [inv.id]);
    if (left.rows[0].n === 0) {
      await client.query("UPDATE invoices SET status = 'returned', updated_at = now() WHERE id = $1", [inv.id]);
    }

    /* استرداد المبلغ حسب طريقة الدفع الأصلية */
    if (inv.payment_method !== "unpaid" && refundTotal > 0) {
      await ledger.recordCashMove(client, {
        dayId: day.id, direction: "out", method: inv.payment_method, category: "refund",
        amount: r2(refundTotal), description: "مرتجع فاتورة " + inv.invoice_no,
        refType: "invoice", refId: inv.id
      });
    }
    return applied;
  });

  res.status(201).json({ returns: result.map(a => Object.assign(a, { invoiceId: String(req.params.id) })), sale: await loadInvoiceWithItems(req.params.id) });
}));

/* ───────────── إلغاء البيع ───────────── */
router.post("/:id(\\d+)/cancel", wrap(async (req, res) => {
  const out = await db.tx(async client => {
    const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    if (!inv) throw new HttpError(404, "sale_not_found", "Sale not found");
    await ledger.assertDayOpen(inv.day_id, client);
    if (inv.status === "cancelled") throw new HttpError(409, "invoice_cancelled", "الفاتورة ملغاة بالفعل");

    /* إرجاع ما تبقى من المخزون */
    await restoreInvoiceStock(client, inv, "return_in", "إلغاء فاتورة");

    /* عكس أثر الصندوق للمبلغ الصافي المقبوض */
    const netReceived = r2(Number(inv.total) - Number(inv.refunded));
    if (inv.payment_method !== "unpaid" && netReceived > 0) {
      await ledger.recordCashMove(client, {
        dayId: inv.day_id, direction: "out", method: inv.payment_method, category: "refund",
        amount: netReceived, description: "إلغاء فاتورة " + inv.invoice_no,
        refType: "invoice", refId: inv.id
      });
    }
    await client.query("UPDATE invoices SET status = 'cancelled', updated_at = now() WHERE id = $1", [inv.id]);
    return (await client.query("SELECT * FROM invoices WHERE id = $1", [inv.id])).rows[0];
  });
  res.json({ sale: await loadInvoiceWithItems(out.id) });
}));

/* ───────────── حذف نهائي (يعكس كل الآثار) ───────────── */
router.delete("/:id(\\d+)", wrap(async (req, res) => {
  await db.tx(async client => {
    const inv = (await client.query("SELECT * FROM invoices WHERE id = $1 FOR UPDATE", [req.params.id])).rows[0];
    if (!inv) throw new HttpError(404, "sale_not_found", "Sale not found");
    await ledger.assertDayOpen(inv.day_id, client);
    if (inv.status !== "cancelled") {
      await restoreInvoiceStock(client, inv, "return_in", "حذف فاتورة");
      const netReceived = r2(Number(inv.total) - Number(inv.refunded));
      if (inv.payment_method !== "unpaid" && netReceived > 0) {
        await ledger.recordCashMove(client, {
          dayId: inv.day_id, direction: "out", method: inv.payment_method, category: "refund",
          amount: netReceived, description: "حذف فاتورة " + inv.invoice_no,
          refType: "invoice", refId: inv.id
        });
      }
    }
    await client.query("DELETE FROM sale_returns WHERE invoice_id = $1", [inv.id]);
    await client.query("DELETE FROM cash_movements WHERE ref_type = 'invoice' AND ref_id = $1", [inv.id]);
    await client.query("DELETE FROM invoices WHERE id = $1", [inv.id]);
  });
  res.json({ ok: true, id: String(req.params.id) });
}));

module.exports = router;
