"use strict";
/* Database rows -> the shapes the frontend renders.
   الأسماء القديمة (mapSale/mapDay/...) محفوظة كما هي حتى تبقى
   أجزاء الواجهة القائمة تعمل، والمحولات الجديدة تخدم أقسام v4. */

const str = v => (v === null || v === undefined ? null : String(v));
const iso = v => (v instanceof Date ? v.toISOString() : v);
const n = v => Number(v === null || v === undefined ? 0 : v);

const mapDay = r => ({
  id:        str(r.id),
  dayName:   r.day_name,
  date:      r.day_date,
  startedAt: iso(r.opened_at),
  closedAt:  iso(r.closed_at),
  status:    r.status
});

const mapNote = r => ({
  id:        str(r.id),
  sessionId: str(r.day_id),
  date:      r.note_date,
  text:      r.note_text,
  time:      iso(r.note_time)
});

/* ───────────── v4: الفواتير ───────────── */
const mapInvoiceItem = r => ({
  id:        str(r.id),
  productId: str(r.product_id),
  product:   r.product_name,
  qty:       n(r.qty),
  qtyReturned: n(r.qty_returned),
  wholesale: n(r.wholesale_price),
  price:     n(r.selling_price),
  total:     n(r.line_total),
  cost:      n(r.line_cost),
  unitId:    str(r.unit_id),
  imei:      r.imei || null,
  isPhone:   !!r.unit_id || !!r.imei
});

const mapInvoice = (r, items) => {
  const refunded = n(r.refunded);
  const refundedProfit = n(r.refunded_profit);
  return {
    id:         str(r.id),
    invoice:    r.invoice_no,
    sessionId:  str(r.day_id),
    date:       r.sale_date,
    time:       iso(r.sale_time),
    payment:    r.payment_method,
    debtorName: r.debtor_name || null,
    discount:   n(r.discount),
    subtotal:   n(r.subtotal),
    cost:       n(r.cost_total),
    total:      n(r.total),
    profit:     n(r.profit),
    refunded,
    refundedProfit,
    effTotal:   n(r.total) - refunded,
    effCost:    n(r.cost_total) - (refunded - refundedProfit),
    effProfit:  n(r.profit) - refundedProfit,
    status:     r.status,
    notes:      r.notes || null,
    items:      (items || []).map(mapInvoiceItem)
  };
};

/* سطر مبسّط للعمليات الأخيرة في لوحة التحكم */
const mapInvoiceLite = r => ({
  id: str(r.id), invoice: r.invoice_no, date: r.sale_date, time: iso(r.sale_time),
  payment: r.payment_method, total: n(r.total) - n(r.refunded),
  profit: n(r.profit) - n(r.refunded_profit), status: r.status,
  itemsCount: n(r.items_count), firstProduct: r.first_product || ""
});

const mapReturn = r => ({
  id: str(r.id), invoiceId: str(r.invoice_id), itemId: str(r.item_id),
  dayId: str(r.day_id), qty: n(r.qty), amount: n(r.amount),
  profitAdjust: n(r.profit_adjust), reason: r.reason || null,
  time: iso(r.returned_at)
});

/* ───────────── v4: المخزون ───────────── */
const mapProduct = r => ({
  id:         str(r.id),
  name:       r.name,
  categoryId: str(r.category_id),
  category:   r.category_name || null,
  kind:       r.kind,
  barcode:    r.barcode || null,
  image:      r.image_url || null,
  model:      r.model || null,
  color:      r.color || null,
  storage:    r.storage || null,
  qty:        n(r.quantity),
  purchasePrice: n(r.purchase_price),
  salePrice:  n(r.sale_price),
  minStock:   n(r.min_stock),
  active:     !!r.is_active,
  lowStock:   r.is_active && n(r.quantity) <= n(r.min_stock),
  stockValue: n(r.quantity) * n(r.purchase_price),
  createdAt:  iso(r.created_at),
  updatedAt:  iso(r.updated_at)
});

const mapCategory = r => ({ id: str(r.id), name: r.name, sortOrder: n(r.sort_order) });

const mapUnit = r => ({
  id: str(r.id), productId: str(r.product_id),
  imei: r.imei || null, serial: r.serial || null,
  status: r.status, invoiceItemId: str(r.invoice_item_id),
  createdAt: iso(r.created_at)
});

const mapStockMove = r => ({
  id: str(r.id), productId: str(r.product_id), product: r.product_name,
  qtyIn: n(r.qty_in), qtyOut: n(r.qty_out), reason: r.reason,
  refType: r.ref_type, refId: str(r.ref_id), note: r.note || null,
  dayId: str(r.day_id), time: iso(r.moved_at)
});

const mapStocktake = r => ({
  id: str(r.id), dayId: str(r.day_id), note: r.note || null,
  lines: n(r.lines), diffLines: n(r.diff_lines), time: iso(r.created_at)
});

/* ───────────── v4: المشتريات والمصروفات والصندوق ───────────── */
const mapPurchaseItem = r => ({
  id: str(r.id), productId: str(r.product_id), product: r.product_name,
  qty: n(r.qty), unitCost: n(r.unit_cost), total: n(r.line_total),
  imeis: r.imeis || []
});

const mapPurchase = (r, items) => ({
  id: str(r.id), purchaseNo: r.purchase_no, sessionId: str(r.day_id),
  date: r.purchase_date, total: n(r.total), paid: !!r.paid,
  notes: r.notes || null, status: r.status,
  itemsCount: n(r.items_count), time: iso(r.created_at),
  items: (items || []).map(mapPurchaseItem)
});

const mapExpense = r => ({
  id: str(r.id), sessionId: str(r.day_id), category: r.category,
  amount: n(r.amount), date: r.expense_date, notes: r.notes || null,
  time: iso(r.created_at)
});

const mapCashMove = r => ({
  id: str(r.id), dayId: str(r.day_id), direction: r.direction,
  method: r.method, category: r.category, amount: n(r.amount),
  description: r.description || null, time: iso(r.moved_at)
});

module.exports = {
  mapDay, mapNote,
  mapInvoice, mapInvoiceItem, mapInvoiceLite, mapReturn,
  mapProduct, mapCategory, mapUnit, mapStockMove, mapStocktake,
  mapPurchase, mapPurchaseItem, mapExpense, mapCashMove
};
