"use strict";
/* ═══════════════════════════════════════════════════════════════════
   Blue Mobile v4 — منطق الدفتر المشترك
   كل الأقسام (مبيعات/مشتريات/مصروفات/صندوق/تقارير) تمر من هنا
   حتى تبقى الأرقام متطابقة في كل مكان.
   ═══════════════════════════════════════════════════════════════════ */
const db = require("../db");
const { HttpError } = require("./http");

const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

/* صافي القيم الفعلية للفاتورة (بعد المرتجعات) */
function invoiceEffective(inv) {
  const refunded = Number(inv.refunded || 0);
  const refundedProfit = Number(inv.refunded_profit || 0);
  return {
    total:  r2(Number(inv.total) - refunded),
    cost:   r2(Number(inv.cost_total) - (refunded - refundedProfit)),
    profit: r2(Number(inv.profit) - refundedProfit)
  };
}

/* ───────────── اليوم المفتوح ───────────── */
async function getOpenDay(client) {
  const q = client || db;
  const { rows } = await q.query("SELECT * FROM days WHERE status = 'open' LIMIT 1");
  return rows.length ? rows[0] : null;
}
async function requireOpenDay(client) {
  const day = await getOpenDay(client);
  if (!day) throw new HttpError(409, "no_open_day", "Start a day first");
  return day;
}
async function dayById(id, client) {
  const q = client || db;
  const { rows } = await q.query("SELECT * FROM days WHERE id = $1", [id]);
  if (!rows.length) throw new HttpError(404, "day_not_found", "Day not found");
  return rows[0];
}
/* يرفض الكتابة على يوم مغلق */
async function assertDayOpen(dayId, client) {
  const day = await dayById(dayId, client);
  if (day.status !== "open") throw new HttpError(409, "day_closed", "This day is closed");
  return day;
}

/* ───────────── حركة الصندوق ───────────── */
async function recordCashMove(client, move) {
  const { rows } = await client.query(
    `INSERT INTO cash_movements (day_id, direction, method, category, amount, description, ref_type, ref_id, moved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now()))
     RETURNING *`,
    [move.dayId, move.direction, move.method || null, move.category,
     move.amount, move.description || null, move.refType || null,
     move.refId || null, move.movedAt || null]);
  return rows[0];
}
/* حركة عكسية (عكس اتجاه ومبلغ حركة سابقة) */
async function reverseCashMove(client, mv, description) {
  return recordCashMove(client, {
    dayId:     mv.day_id,
    direction: mv.direction === "in" ? "out" : "in",
    method:    mv.method,
    category:  mv.category,
    amount:    mv.amount,
    description: description || ("عكس: " + (mv.description || "")),
    refType:   mv.ref_type,
    refId:     mv.ref_id
  });
}
/* الرصيد النقدي = كل داخل نقدي − كل خارج نقدي (حركات البطاقة لا تدخل الصندوق) */
const CASH_BALANCE_SQL = `
  SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END), 0) AS balance
    FROM cash_movements
   WHERE method IS NULL OR method = 'cash'`;
async function cashBalance(client) {
  const q = client || db;
  const { rows } = await q.query(CASH_BALANCE_SQL);
  return r2(rows[0].balance);
}

/* ───────────── حركة المخزون ───────────── */
async function recordStockMove(client, m) {
  const { rows } = await client.query(
    `INSERT INTO stock_movements (product_id, qty_in, qty_out, reason, ref_type, ref_id, note, day_id, moved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now()))
     RETURNING *`,
    [m.productId, m.qtyIn || 0, m.qtyOut || 0, m.reason, m.refType || null,
     m.refId || null, m.note || null, m.dayId || null, m.movedAt || null]);
  return rows[0];
}

/* ───────────── إجماليات اليوم (مبيعات فعالة + مشتريات + مصروفات + صندوق) ───────────── */
const DAY_SALES_TOTALS = `
  SELECT
    COALESCE(SUM(i.total - i.refunded), 0)                                            AS total,
    COALESCE(SUM(i.cost_total - (i.refunded - i.refunded_profit)), 0)                 AS cost,
    COALESCE(SUM(i.profit - i.refunded_profit), 0)                                    AS profit,
    COUNT(i.id)                                                                       AS count,
    COALESCE(SUM(i.total - i.refunded) FILTER (WHERE i.payment_method = 'cash'), 0)  AS cash,
    COALESCE(SUM(i.total - i.refunded) FILTER (WHERE i.payment_method = 'card'), 0)  AS card,
    COALESCE(SUM(i.total - i.refunded) FILTER (WHERE i.payment_method = 'unpaid'),0) AS unpaid,
    (SELECT COALESCE(jsonb_object_agg(x.pm, x.amt), '{}'::jsonb)
       FROM (SELECT i2.payment_method AS pm, SUM(i2.total - i2.refunded) AS amt
               FROM invoices i2 WHERE i2.day_id = d.id AND i2.status <> 'cancelled'
              GROUP BY 1) x)                                                          AS by_method
   FROM days d
   LEFT JOIN invoices i ON i.day_id = d.id AND i.status <> 'cancelled'`;

async function dayTotals(dayId, client) {
  const q = client || db;
  const [sales, purchases, expenses, cash, notesCount, returnsCount] = await Promise.all([
    q.query(DAY_SALES_TOTALS + " WHERE d.id = $1 GROUP BY d.id", [dayId]),
    q.query(`SELECT COALESCE(SUM(total),0) AS total, COALESCE(SUM(total) FILTER (WHERE paid),0) AS paid_total, count(*) AS count
               FROM purchases WHERE day_id = $1 AND status = 'completed'`, [dayId]),
    q.query(`SELECT COALESCE(SUM(cat_total),0) AS total, COALESCE(SUM(n),0) AS count,
                    COALESCE(jsonb_object_agg(category, cat_total), '{}'::jsonb) AS by_category
               FROM (SELECT category, SUM(amount) AS cat_total, count(*) AS n
                       FROM expenses WHERE day_id = $1 GROUP BY 1) t`, [dayId]),
    q.query(`SELECT
                COALESCE(SUM(amount) FILTER (WHERE direction = 'in'  AND (method IS NULL OR method = 'cash')), 0) AS cash_in,
                COALESCE(SUM(amount) FILTER (WHERE direction = 'out' AND (method IS NULL OR method = 'cash')), 0) AS cash_out,
                COALESCE(SUM(amount) FILTER (WHERE category = 'sale'    AND direction = 'in'), 0)  AS sales_cash_in,
                COALESCE(SUM(amount) FILTER (WHERE category = 'sale'    AND method = 'card'), 0)   AS sales_card,
                COALESCE(SUM(amount) FILTER (WHERE category = 'refund'), 0)                        AS refunds,
                COALESCE(SUM(amount) FILTER (WHERE category = 'expense'  AND direction = 'out'), 0) AS expenses,
                COALESCE(SUM(amount) FILTER (WHERE category = 'purchase' AND direction = 'out'), 0) AS purchases_paid,
                COALESCE(SUM(amount) FILTER (WHERE category = 'deposit'), 0)                        AS deposits,
                COALESCE(SUM(amount) FILTER (WHERE category = 'withdrawal'), 0)                     AS withdrawals
               FROM cash_movements WHERE day_id = $1`, [dayId]),
    q.query("SELECT count(*)::int AS n FROM notes WHERE day_id = $1", [dayId]),
    q.query("SELECT count(*)::int AS n FROM sale_returns WHERE day_id = $1", [dayId])
  ]);
  const s = sales.rows[0], p = purchases.rows[0], e = expenses.rows[0], c = cash.rows[0];
  const profit = r2(s.profit);
  const expensesTotal = r2(e.total);
  return {
    total: r2(s.total), cost: r2(s.cost), profit, count: Number(s.count),
    cash: r2(s.cash), card: r2(s.card), unpaid: r2(s.unpaid),
    byMethod: s.by_method || {},
    purchases: { total: r2(p.total), paid: r2(p.paid_total), count: Number(p.count) },
    expenses: { total: expensesTotal, count: Number(e.count), byCategory: e.by_category || {} },
    cashFlow: {
      in: r2(c.cash_in), out: r2(c.cash_out), net: r2(c.cash_in - c.cash_out),
      salesCash: r2(c.sales_cash_in), salesCard: r2(c.sales_card), refunds: r2(c.refunds),
      expenses: r2(c.expenses), purchases: r2(c.purchases_paid),
      deposits: r2(c.deposits), withdrawals: r2(c.withdrawals)
    },
    netProfit: r2(profit - expensesTotal),
    noteCount: Number(notesCount.rows[0].n),
    returnCount: Number(returnsCount.rows[0].n)
  };
}

/* ───────────── لقطة إغلاق اليوم (ثابتة لا تتغير) ───────────── */
async function buildDaySnapshot(dayId, client) {
  const q = client || db;
  const [totals, balance, day, invCount] = await Promise.all([
    dayTotals(dayId, q),
    cashBalance(q),
    dayById(dayId, q),
    q.query("SELECT count(*)::int AS n FROM invoices WHERE day_id = $1", [dayId])
  ]);
  return {
    totals,
    cashBalanceAtClose: balance,
    invoiceCount: Number(invCount.rows[0].n),
    day: { id: String(day.id), date: day.day_date, dayName: day.day_name,
           startedAt: day.opened_at instanceof Date ? day.opened_at.toISOString() : day.opened_at }
  };
}

/* ملخص اليوم للعرض: إن وُجدت لقطة إغلاق فهي المصدر (الأرقام لا تتغير) */
async function daySummaryForApi(dayId, client) {
  const q = client || db;
  const snap = await q.query("SELECT snapshot, cash_balance FROM day_summaries WHERE day_id = $1", [dayId]);
  if (snap.rows.length) {
    const s = snap.rows[0].snapshot;
    return { totals: s.totals, cashBalanceAtClose: Number(snap.rows[0].cash_balance), frozen: true };
  }
  const totals = await dayTotals(dayId, q);
  return { totals, cashBalanceAtClose: null, frozen: false };
}

module.exports = {
  r2, invoiceEffective, getOpenDay, requireOpenDay, dayById, assertDayOpen,
  recordCashMove, reverseCashMove, cashBalance, recordStockMove,
  dayTotals, buildDaySnapshot, daySummaryForApi, DAY_SALES_TOTALS
};
