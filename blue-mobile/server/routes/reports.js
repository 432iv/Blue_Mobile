"use strict";
/* ═══════════════════════════════════════════════════════════════════
   /api/reports — لوحة التحكم والتقارير
   dashboard · المبيعات (يوم/فترة/منتج/طريقة دفع) · الأرباح والخسائر
   · المخزون (قيمة/نواقص/الأكثر مبيعاً/الأقل حركة)
   كل الأرقام محسوبة من البيانات الفعلية — لا أرقام ثابتة.
   ═══════════════════════════════════════════════════════════════════ */
const express = require("express");
const db = require("../db");
const ledger = require("../lib/ledger");
const { wrap, isoDate } = require("../lib/http");
const { mapInvoiceLite } = require("../lib/map");

const router = express.Router();
const r2 = ledger.r2;

/* ═══════════════ لوحة التحكم ═══════════════ */
router.get("/dashboard", wrap(async (_req, res) => {
  const open = await ledger.getOpenDay();

  const [today, balance, cardTotal, inventory, grand, recentInvoices, recentPurchases, lowStock, unpaidTotal] =
    await Promise.all([
      open ? ledger.dayTotals(open.id) : null,
      ledger.cashBalance(),
      db.query(`SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS t
                  FROM cash_movements WHERE method='card'`),
      db.query(`SELECT COALESCE(SUM(quantity * purchase_price),0) AS value,
                       COALESCE(SUM(quantity * sale_price),0) AS retail,
                       count(*) FILTER (WHERE is_active) AS products,
                       count(*) FILTER (WHERE is_active AND quantity <= min_stock) AS low_count
                  FROM products`),
      db.query(`
        SELECT
          (SELECT COALESCE(SUM(total - refunded),0) FROM invoices WHERE status <> 'cancelled')                          AS sales,
          (SELECT COALESCE(SUM(profit - refunded_profit),0) FROM invoices WHERE status <> 'cancelled')                 AS profit,
          (SELECT COALESCE(SUM(total),0) FROM purchases WHERE status = 'completed')                                    AS purchases,
          (SELECT COALESCE(SUM(amount),0) FROM expenses)                                                               AS expenses,
          (SELECT count(*) FROM invoices WHERE status <> 'cancelled')                                                  AS invoice_count,
          (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE expense_date = CURRENT_DATE)                             AS expenses_today`),
      db.query(`SELECT i.*,
                       (SELECT count(*) FROM invoice_items x WHERE x.invoice_id = i.id) AS items_count,
                       (SELECT x.product_name FROM invoice_items x WHERE x.invoice_id = i.id ORDER BY x.id LIMIT 1) AS first_product
                  FROM invoices i WHERE i.status <> 'cancelled'
                 ORDER BY i.sale_time DESC, i.id DESC LIMIT 8`),
      db.query(`SELECT p.*, (SELECT count(*) FROM purchase_items x WHERE x.purchase_id = p.id) AS items_count,
                       (SELECT x.product_name FROM purchase_items x WHERE x.purchase_id = p.id ORDER BY x.id LIMIT 1) AS first_product
                  FROM purchases p WHERE p.status = 'completed'
                 ORDER BY p.created_at DESC, p.id DESC LIMIT 5`),
      db.query(`SELECT p.id, p.name, p.quantity, p.min_stock, p.kind
                  FROM products p WHERE p.is_active AND p.quantity <= p.min_stock
                 ORDER BY (p.quantity - p.min_stock), p.name LIMIT 12`),
      db.query(`SELECT COALESCE(SUM(total - refunded),0) AS t FROM invoices
                  WHERE status <> 'cancelled' AND payment_method = 'unpaid'`)
    ]);

  const g = grand.rows[0];
  const todayExpenses = today ? today.expenses.total : Number(g.expenses_today);
  res.json({
    today: today ? {
      sales: today.total, profit: today.profit, count: today.count,
      cash: today.cash, card: today.card, unpaid: today.unpaid,
      purchases: today.purchases, expenses: today.expenses,
      netProfit: today.netProfit,
      cashIn: today.cashFlow.in, cashOut: today.cashFlow.out, cashNet: today.cashFlow.net,
      deposits: today.cashFlow.deposits, withdrawals: today.cashFlow.withdrawals,
      refunds: today.cashFlow.refunds
    } : null,
    openDay: open ? { id: String(open.id), date: open.day_date, startedAt: open.opened_at } : null,
    cashBalance: r2(balance),
    cardTotal: r2(cardTotal.rows[0].t),
    unpaidTotal: r2(unpaidTotal.rows[0].t),
    inventory: {
      value: r2(inventory.rows[0].value),
      retailValue: r2(inventory.rows[0].retail),
      products: Number(inventory.rows[0].products),
      lowCount: Number(inventory.rows[0].low_count),
      lowStock: lowStock.rows.map(r => ({
        id: String(r.id), name: r.name, qty: r.quantity, minStock: r.min_stock, kind: r.kind
      }))
    },
    grand: {
      sales: r2(g.sales), profit: r2(g.profit),
      purchases: r2(g.purchases), expenses: r2(g.expenses),
      netProfit: r2(g.profit - g.expenses),
      invoiceCount: Number(g.invoice_count)
    },
    recentInvoices: recentInvoices.rows.map(mapInvoiceLite),
    recentPurchases: recentPurchases.rows.map(r => ({
      id: String(r.id), purchaseNo: r.purchase_no, total: Number(r.total),
      itemsCount: Number(r.items_count), firstProduct: r.first_product || "",
      time: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      status: r.status
    }))
  });
}));

/* ═══════════════ تقارير المبيعات ═══════════════
   ?from&to&group=day|product|method  */
router.get("/sales", wrap(async (req, res) => {
  const from = req.query.from ? isoDate(req.query.from) : null;
  const to = req.query.to ? isoDate(req.query.to) : null;
  const group = ["day", "product", "method"].includes(req.query.group) ? req.query.group : "day";
  const conds = ["i.status <> 'cancelled'"];
  const params = [];
  if (from) { params.push(from); conds.push(`i.sale_date >= $${params.length}`); }
  if (to)   { params.push(to);   conds.push(`i.sale_date <= $${params.length}`); }
  const where = "WHERE " + conds.join(" AND ");

  if (group === "product") {
    const { rows } = await db.query(`
      SELECT x.product_name AS label, x.product_id AS product_id,
             SUM(x.qty) AS qty, SUM(x.line_total_effective) AS total,
             SUM(x.line_cost_effective) AS cost, SUM(x.line_total_effective - x.line_cost_effective) AS profit
        FROM (
          SELECT ii.product_name, ii.product_id, (ii.qty - ii.qty_returned) AS qty,
                 round(ii.selling_price * (ii.qty - ii.qty_returned), 2) AS line_total_effective,
                 round(ii.wholesale_price * (ii.qty - ii.qty_returned), 2) AS line_cost_effective
            FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
            ${where}
        ) x
       GROUP BY 1, 2 ORDER BY total DESC LIMIT 200`, params);
    return res.json({ group, rows: rows.map(r => ({
      label: r.label, productId: String(r.product_id), qty: Number(r.qty),
      total: r2(r.total), cost: r2(r.cost), profit: r2(r.profit),
      margin: Number(r.total) > 0 ? Math.round((Number(r.profit) / Number(r.total)) * 1000) / 10 : 0
    })) });
  }

  if (group === "method") {
    const { rows } = await db.query(`
      SELECT i.payment_method AS label, count(*) AS count,
             SUM(i.total - i.refunded) AS total,
             SUM(i.profit - i.refunded_profit) AS profit
        FROM invoices i ${where}
       GROUP BY 1 ORDER BY total DESC`, params);
    return res.json({ group, rows: rows.map(r => ({
      label: r.label, count: Number(r.count), total: r2(r.total), profit: r2(r.profit)
    })) });
  }

  const { rows } = await db.query(`
    SELECT i.sale_date AS label, count(*) AS count,
           SUM(i.total - i.refunded) AS total,
           SUM(i.cost_total - (i.refunded - i.refunded_profit)) AS cost,
           SUM(i.profit - i.refunded_profit) AS profit
      FROM invoices i ${where}
     GROUP BY 1 ORDER BY 1 DESC LIMIT 400`, params);
  res.json({ group: "day", rows: rows.map(r => ({
    label: r.label, count: Number(r.count), total: r2(r.total), cost: r2(r.cost), profit: r2(r.profit)
  })) });
}));

/* ═══════════════ الأرباح والخسائر (فترة) ═══════════════ */
router.get("/pnl", wrap(async (req, res) => {
  const from = req.query.from ? isoDate(req.query.from) : null;
  const to = req.query.to ? isoDate(req.query.to) : null;
  const dConds = [], pConds = ["status = 'completed'"], eConds = [];
  const params = [];
  if (from) { params.push(from); dConds.push(`sale_date >= $${params.length}`); pConds.push(`purchase_date >= $${params.length}`); eConds.push(`expense_date >= $${params.length}`); }
  if (to)   { params.push(to);   dConds.push(`sale_date <= $${params.length}`); pConds.push(`purchase_date <= $${params.length}`); eConds.push(`expense_date <= $${params.length}`); }

  const [sales, purchases, expenses] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(total - refunded),0) AS sales,
                     COALESCE(SUM(cost_total - (refunded - refunded_profit)),0) AS cost,
                     COALESCE(SUM(profit - refunded_profit),0) AS profit,
                     COALESCE(SUM(discount),0) AS discounts,
                     count(*) AS count
                FROM invoices WHERE status <> 'cancelled'
                ${dConds.length ? "AND " + dConds.join(" AND ") : ""}`, params),
    db.query(`SELECT COALESCE(SUM(total),0) AS total, count(*) AS count
                FROM purchases WHERE ${pConds.join(" AND ")}`, params),
    db.query(`SELECT category, SUM(amount) AS total FROM expenses
                ${eConds.length ? "WHERE " + eConds.join(" AND ") : ""}
               GROUP BY 1`, params)
  ]);

  const s = sales.rows[0];
  const expByCat = {};
  let expTotal = 0;
  for (const r of expenses.rows) { expByCat[r.category] = r2(r.total); expTotal += Number(r.total); }
  res.json({
    period: { from, to },
    sales: { total: r2(s.sales), cost: r2(s.cost), profit: r2(s.profit), discounts: r2(s.discounts), count: Number(s.count) },
    purchases: { total: r2(purchases.rows[0].total), count: Number(purchases.rows[0].count) },
    expenses: { total: r2(expTotal), byCategory: expByCat },
    netProfit: r2(Number(s.profit) - expTotal)
  });
}));

/* ═══════════════ تقارير المخزون ═══════════════ */
router.get("/inventory", wrap(async (_req, res) => {
  const [value, low, top, slow] = await Promise.all([
    db.query(`SELECT COALESCE(SUM(quantity * purchase_price),0) AS cost_value,
                     COALESCE(SUM(quantity * sale_price),0) AS retail_value,
                     count(*) FILTER (WHERE is_active) AS products,
                     COALESCE(SUM(quantity),0) AS total_qty
                FROM products`),
    db.query(`SELECT p.id, p.name, p.kind, p.quantity, p.min_stock, p.purchase_price, p.category_id
                FROM products p WHERE p.is_active AND p.quantity <= p.min_stock
               ORDER BY (p.quantity - p.min_stock), p.name`),
    db.query(`
      SELECT ii.product_id AS id, ii.product_name AS name,
             SUM(ii.qty - ii.qty_returned) AS qty,
             SUM(ii.line_total) AS total, SUM(ii.line_total - ii.line_cost) AS profit
        FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
       WHERE i.status <> 'cancelled' AND ii.product_id IS NOT NULL
       GROUP BY 1,2 ORDER BY qty DESC LIMIT 10`),
    db.query(`
      SELECT p.id, p.name, p.quantity, p.purchase_price, p.updated_at,
             (SELECT MAX(ii.created_at) FROM invoice_items ii
               JOIN invoices i ON i.id = ii.invoice_id
              WHERE ii.product_id = p.id AND i.status <> 'cancelled') AS last_sold_at
        FROM products p
       WHERE p.is_active AND p.quantity > 0
         AND NOT EXISTS (SELECT 1 FROM invoice_items ii
                          JOIN invoices i ON i.id = ii.invoice_id
                         WHERE ii.product_id = p.id AND i.status <> 'cancelled'
                           AND i.sale_date >= CURRENT_DATE - INTERVAL '30 days')
       ORDER BY p.updated_at DESC LIMIT 10`)
  ]);

  res.json({
    value: {
      cost: r2(value.rows[0].cost_value),
      retail: r2(value.rows[0].retail_value),
      products: Number(value.rows[0].products),
      totalQty: Number(value.rows[0].total_qty)
    },
    lowStock: low.rows.map(r => ({
      id: String(r.id), name: r.name, kind: r.kind, qty: r.quantity,
      minStock: r.min_stock, purchasePrice: r2(r.purchase_price)
    })),
    topSelling: top.rows.map(r => ({
      id: String(r.id), name: r.name, qty: Number(r.qty),
      total: r2(r.total), profit: r2(r.profit)
    })),
    slowMoving: slow.rows.map(r => ({
      id: String(r.id), name: r.name, qty: r.quantity,
      value: r2(r.quantity * r.purchase_price),
      lastSoldAt: r.last_sold_at instanceof Date ? r.last_sold_at.toISOString() : r.last_sold_at
    }))
  });
}));

module.exports = router;
