/* Blue Mobile v4 — backend API suite.   node tests/api.test.js
   يغطّي: المصادقة، الأيام، الفواتير والمرتجعات، المخزون (منتجات/وحدات/حركة/جرد)،
   المشتريات، المصروفات، الصندوق، التقارير، النسخ الاحتياطي، والحماية.
   يتطلب سيرفرًا حيًّا + قاعدة بيانات (يمسح كل البيانات في البداية).          */
const BASE = process.env.BASE || "http://127.0.0.1:3000";
let pass = 0, fail = 0;
const group = n => console.log("\n=== " + n + " ===");
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  \u2713 " + label); }
  else { fail++; console.log("  \u2717 FAIL: " + label + (extra !== undefined ? "  \u2192 " + JSON.stringify(extra).slice(0, 260) : "")); }
};
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) <= eps;

/* عميل مع عزل كوكيز/توكن */
function device(name) {
  let cookie = null, token = null;
  return {
    name,
    get token() { return token; },
    async call(method, path, body, opts = {}) {
      const headers = { "content-type": "application/json" };
      if (cookie && !opts.noCookie) headers.cookie = cookie;
      if (token && opts.bearer) headers.authorization = "Bearer " + token;
      const res = await fetch(BASE + "/api" + path, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body)
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        const m = /bm_session=([^;]*)/.exec(setCookie);
        if (m) cookie = m[1] === "" ? null : "bm_session=" + m[1];
      }
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (data && data.token) token = data.token;
      return { status: res.status, data };
    },
    get(p, o)     { return this.call("GET", p, undefined, o); },
    post(p, b, o) { return this.call("POST", p, b || {}, o); },
    put(p, b)     { return this.call("PUT", p, b); },
    del(p, b)     { return this.call("DELETE", p, b); },
    forgetCookie() { cookie = null; token = null; }
  };
}

const api = device("main");
const anon = device("anon");

(async () => {
  /* ═══════════ التهيئة ═══════════ */
  group("التهيئة");
  let r = await fetch(BASE + "/api/auth/status").then(x => x.json());
  if (r.setupRequired) {
    r = await api.post("/auth/setup", { username: "owner", email: "owner@bluemobile.ly", password: "test-pass-123" });
    check("إنشاء الحساب", r.status === 201, r.data);
  }
  r = await api.post("/auth/login", { username: "owner", password: "test-pass-123" });
  check("تسجيل الدخول", r.status === 200 && r.data.token, r.data);
  r = await api.post("/auth/login", { username: "owner", password: "wrong-pass-xxx" });
  check("كلمة مرور خاطئة مرفوضة", r.status === 401, r.status);
  r = await api.del("/data", { confirm: "DELETE" });
  check("تصفير البيانات", r.status === 200, r.data);
  r = await api.del("/data", { confirm: "no" });
  check("رفض الحذف بدون تأكيد", r.status === 400, r.status);

  /* ═══════════ الحماية ═══════════ */
  group("حماية المسارات");
  r = await anon.get("/bootstrap");
  check("bootstrap بدون جلسة → 401", r.status === 401, r.status);
  r = await anon.post("/sales", {});
  check("بيع بدون جلسة → 401", r.status === 401, r.status);
  r = await api.get("/bootstrap", { noCookie: true, bearer: true });
  check("Bearer token يعمل بدون كوكيز", r.status === 200 && r.data.user, r.status);
  r = await api.get("/bootstrap", { noCookie: true });
  check("بدون توكن وبدون كوكيز → 401", r.status === 401, r.status);

  /* ═══════════ الأيام ═══════════ */
  group("أيام العمل");
  const today = new Date().toISOString().slice(0, 10);
  const otherDay = "2024-03-" + (new Date().getDate() || 1);
  r = await api.post("/days", { date: today });
  check("فتح يوم", r.status === 201 && r.data.day.id, r.data);
  const dayId = r.data.day.id;
  r = await api.post("/days", { date: today });
  check("يوم مفتوح بالفعل → 409", r.status === 409 && r.data.error === "day_already_open", r.data);
  r = await api.get("/days/current");
  check("اليوم الحالي", r.status === 200 && r.data.day && r.data.day.id === dayId, r.data.day);

  /* ═══════════ التصنيفات والمنتجات ═══════════ */
  group("التصنيفات والمنتجات");
  r = await api.post("/inventory/categories", { name: "هواتف ذكية" });
  check("تصنيف جديد", r.status === 201 && r.data.category.id, r.data);
  const catPhone = r.data.category.id;
  r = await api.post("/inventory/categories", { name: "إكسسوارات" });
  const catAcc = r.data.category.id;
  r = await api.post("/inventory/categories", { name: "إكسسوارات" });
  check("تصنيف مكرر = إرجاع نفس التصنيف (upsert)", r.status === 201 && r.data.category.id === catAcc, r.data);

  r = await api.post("/inventory/products", { name: "شاحن Anker 20W", categoryId: catAcc, kind: "accessory", purchasePrice: 20, salePrice: 35, minStock: 5, qty: 10, barcode: "BAR-100" });
  check("منتج إكسسوار برصيد افتتاحي", r.status === 201 && r.data.product.qty === 10, r.data);
  const charger = r.data.product.id;
  r = await api.post("/inventory/products", { name: "كابل مكرر", categoryId: catAcc, kind: "accessory", barcode: "BAR-100" });
  check("باركود مكرر يُرفض", r.status === 409 && r.data.error === "barcode_taken", r.data);

  r = await api.post("/inventory/products", { name: "Galaxy A55", categoryId: catPhone, kind: "phone", purchasePrice: 800, salePrice: 1000, minStock: 2, model: "SM-A55", color: "أسود", storage: "256GB", imeis: ["111111111111111", "111111111111112"] });
  check("منتج هاتف مع IMEIs", r.status === 201 && r.data.product.qty === 2, r.data);
  const a55 = r.data.product.id;
  r = await api.post("/inventory/products", { name: "مكرر IMEI", kind: "phone", imeis: ["111111111111111"] });
  check("IMEI مكرر يُرفض", r.status === 409 && r.data.error === "imei_taken", r.data);

  r = await api.put("/inventory/products/" + a55, { name: "Galaxy A55", kind: "accessory" });
  check("تغيير نوع منتج له وحدات مرفوض", r.status === 409 && r.data.error === "kind_locked", r.data);
  r = await api.put("/inventory/products/" + a55, { salePrice: 1050 });
  check("تعديل سعر البيع", r.status === 200 && r.data.product.salePrice === 1050, r.data);

  r = await api.get("/inventory/search?q=111111111111111");
  check("بحث بالـ IMEI", r.status === 200 && r.data.products.length === 1 && r.data.products[0].id === a55, r.data.products && r.data.products.map(p => p.name));
  r = await api.get("/inventory/search?q=anker");
  check("بحث جزء من الاسم", r.status === 200 && r.data.products.some(p => p.id === charger), r.data.products && r.data.products.map(p => p.name));
  r = await api.get("/inventory/search?q=BAR-100");
  check("بحث بالباركود", r.status === 200 && r.data.products.some(p => p.id === charger), r.data.products && r.data.products.map(p => p.name));

  r = await api.post("/inventory/products/" + a55 + "/units", { imei: "111111111111113" });
  check("إضافة وحدة IMEI", r.status === 201 && r.data.unit.status === "in_stock", r.data);
  r = await api.get("/inventory/products/" + a55 + "/units");
  check("قائمة الوحدات", r.status === 200 && r.data.units.length === 3 && r.data.units.every(u => !u.invoiceNo), r.data.units && r.data.units.length);
  r = await api.post("/inventory/products/" + charger + "/units", { imei: "X" });
  check("إضافة وحدة لغير الهاتف مرفوضة", r.status === 400, r.status);

  r = await api.post("/inventory/products/" + charger + "/adjust", { direction: "in", qty: 5, note: "تسوية+" });
  check("تسوية كمية +5", r.status === 200 && r.data.product.qty === 15, r.data);
  r = await api.post("/inventory/products/" + charger + "/adjust", { direction: "out", qty: 200 });
  check("خصم أكثر من الرصيد مرفوض", r.status === 400, r.status);

  r = await api.post("/inventory/products", { name: "منتج للحذف", kind: "accessory" });
  const delProd = r.data.product.id;
  r = await api.del("/inventory/products/" + delProd);
  check("حذف منتج بدون حركة", r.status === 200, r.data);
  r = await api.post("/inventory/products", { name: "منتج برصيد لا يُحذف", kind: "accessory", qty: 2 });
  const delProd2 = r.data.product.id;
  r = await api.del("/inventory/products/" + delProd2);
  check("حذف منتج له حركة افتتاحية مرفوض", r.status === 409 && r.data.error === "product_in_use", r.data);
  r = await api.del("/inventory/products/" + charger);
  check("حذف منتج له حركة مرفوض", r.status === 409 && r.data.error === "product_in_use", r.data);
  r = await api.put("/inventory/products/" + charger, { active: false });
  check("أرشفة منتج", r.status === 200 && r.data.product.active === false, r.data);
  r = await api.put("/inventory/products/" + charger, { active: true });
  check("إلغاء الأرشفة", r.status === 200 && r.data.product.active === true, r.data);

  /* ═══════════ المشتريات ═══════════ */
  group("المشتريات");
  r = await api.post("/purchases", { items: [
    { productId: charger, qty: 10, unitCost: 22 },
    { newProduct: { name: "Galaxy A56", categoryId: catPhone, kind: "phone", salePrice: 1200, minStock: 1 }, qty: 2, unitCost: 900, imeis: ["222222222222221", "222222222222222"] }
  ], paid: true, notes: "توريد أول" });
  check("فاتورة شراء (صنف موجود + منتج جديد)", r.status === 201 && /^PUR-/.test(r.data.purchase.purchaseNo), r.data);
  const pur1 = r.data.purchase;
  /* الشاحن: 10@20 + تسوية +5@20 = 15×20، ثم شراء 10@22 → 20.8 */
  check("إجمالي الشراء 2020 (220 شاحن + 1800 هاتفان)", near(pur1.total, 2020), pur1.total);

  r = await api.get("/bootstrap");
  const a56 = r.data.products.find(p => p.name === "Galaxy A56");
  check("منتج جديد أُنشئ من الشراء", !!a56 && a56.qty === 2 && near(a56.purchasePrice, 900), a56 && { qty: a56.qty, avg: a56.purchasePrice });
  const ch = r.data.products.find(p => p.id === charger);
  check("متوسط التكلفة المرجح (15×20 + 10×22)/25 = 20.8", ch.qty === 25 && near(ch.purchasePrice, 20.8), { qty: ch.qty, avg: ch.purchasePrice });

  r = await api.post("/purchases", { items: [{ productId: charger, qty: 3, unitCost: 30, imeis: ["X1"] }], paid: false });
  check("IMEIs مع منتج غير هاتف تُهمل", r.status === 201, r.data);
  const pur2 = r.data.purchase;
  r = await api.post("/purchases", { items: [{ newProduct: { name: "غطاء شفاف", categoryId: catAcc, kind: "phone", salePrice: 15 }, qty: 2, unitCost: 5, imeis: ["A", "B", "C"] }] });
  check("عدد IMEIs أكبر من الكمية مرفوض", r.status === 400 && r.data.error === "imeis_mismatch", r.data);

  /* ═══════════ المبيعات ═══════════ */
  group("فواتير البيع");
  r = await api.get("/inventory/products/" + a56.id + "/units");
  if (!r.data.units) { console.log("  !! units GET failed:", r.status, JSON.stringify(r.data).slice(0, 200), "a56=", a56); }
  const a56Units = (r.data.units || []).filter(u => u.status === "in_stock");
  check("وحدات A56 المتوفرة", a56Units.length === 2, a56Units.length);

  r = await api.post("/sales", { items: [{ productId: a56.id, qty: 2, wholesale: 900, selling: 1150, unitIds: [a56Units[0].id, a56Units[1].id] }], payment: "cash" });
  check("بيع هاتفين بالوحدات", r.status === 201 && /^INV-/.test(r.data.sale.invoice), r.data);
  const inv1 = r.data.sale;
  check("ريح الهاتفين 500", near(inv1.profit, 500), inv1.profit);

  r = await api.get("/inventory/products/" + a56.id + "/units");
  const soldUnit = r.data.units.find(u => u.id === a56Units[0].id);
  check("الوحدة صارت مبيعة ومرتبطة بفاتورة", soldUnit.status === "sold" && soldUnit.invoiceNo === inv1.invoice, soldUnit);

  r = await api.post("/sales", { items: [{ productId: charger, qty: 4, wholesale: 21, selling: 35 }], payment: "card", discount: 6 });
  check("بيع بطاقة مع خصم", r.status === 201 && near(r.data.sale.total, 134), r.data);
  const inv2 = r.data.sale;

  r = await api.post("/sales", { items: [{ name: "خدمة نقل بيانات", qty: 1, wholesale: 0, selling: 60 }], payment: "unpaid", debtorName: "سالم" });
  check("صنف حر غير خالص", r.status === 201 && r.data.sale.debtorName === "سالم", r.data);
  const inv3 = r.data.sale;

  r = await api.post("/sales", { items: [{ productId: charger, qty: 999, wholesale: 21, selling: 35 }], payment: "cash" });
  check("كمية أكبر من المخزون مرفوضة", r.status === 400 && r.data.error === "stock_insufficient", r.data);
  r = await api.post("/sales", { items: [{ productId: a55, qty: 2, wholesale: 800, selling: 1000 }], payment: "cash" });
  check("بيع هاتف بدون تحديد وحدات (اختيار تلقائي)", r.status === 201, r.data);
  const inv4 = r.data.sale;
  r = await api.post("/sales", { items: [{ productId: a55, qty: 2, wholesale: 800, selling: 1000, unitIds: [a56Units[0].id] }] });
  check("وحدة من منتج آخر مرفوضة", r.status === 400 || r.status === 409, r.status);
  r = await api.post("/sales", { items: [{ productId: charger, qty: 1, wholesale: 21, selling: 35 }], payment: "crypto" });
  check("طريقة دفع غير معروفة مرفوضة", r.status === 400 && r.data.error === "payment_invalid", r.data);
  r = await api.post("/sales", { items: [{ productId: charger, qty: 1, wholesale: 21, selling: 100 }], payment: "cash", discount: 500 });
  check("خصم أكبر من الإجمالي يُقصّ إلى الإجمالي", r.status === 201 && near(r.data.sale.discount, 100) && near(r.data.sale.total, 0), r.data.sale && { d: r.data.sale.discount, t: r.data.sale.total });
  const invDisc = r.data.sale;

  /* تعديل فاتورة */
  r = await api.put("/sales/" + inv2.id, { items: [{ productId: charger, qty: 2, wholesale: 21, selling: 35 }], payment: "cash", discount: 0 });
  check("تعديل فاتورة (4→2 صنف، بطاقة→نقد)", r.status === 200 && near(r.data.sale.total, 70) && r.data.sale.payment === "cash", r.data);
  const inv2b = r.data.sale;

  /* ═══════════ المرتجعات والإلغاء ═══════════ */
  group("المرتجعات والإلغاء");
  r = await api.post("/sales/" + inv1.id + "/returns", { returns: [{ itemId: inv1.items[0].id, qty: 1 }], reason: "به عيب" });
  check("إرجاع هاتف واحد", r.status === 201, r.data);
  r = await api.get("/inventory/products/" + a56.id + "/units");
  const backUnit = r.data.units.find(u => u.id === a56Units[1].id);
  check("الوحدة المُرجعة in_stock مجددًا", backUnit.status === "in_stock" || backUnit.status === "returned_in", backUnit.status);
  r = await api.get("/bootstrap");
  const inv1b = r.data.invoices.find(i => i.id === inv1.id);
  check("أثر المرتجع على الفاتورة", near(inv1b.refunded, 1150) && near(inv1b.effTotal, 1150), { r: inv1b.refunded, e: inv1b.effTotal });

  r = await api.post("/sales/" + inv1.id + "/returns", { returns: [{ itemId: inv1.items[0].id, qty: 99 }] });
  check("إرجاع أكثر من المتبقي مرفوض", r.status === 400, r.status);
  r = await api.put("/sales/" + inv1.id, { items: [{ productId: a56.id, qty: 1, wholesale: 900, selling: 1150 }], payment: "cash" });
  check("تعديل فاتورة لها مرتجعات مرفوض", r.status === 409 && r.data.error === "invoice_has_returns", r.data);

  r = await api.post("/sales/" + inv3.id + "/cancel");
  check("إلغاء فاتورة", r.status === 200, r.data);
  r = await api.post("/sales/" + inv3.id + "/cancel");
  check("إلغاء ملغاة مرفوض", r.status === 409, r.status);
  r = await api.get("/bootstrap");
  check("الملغاة لا تدخل الإجماليات", r.data.grand.sales >= inv1b.effTotal + inv2b.total + 0 /*inv4*/ - 1, r.data.grand);

  r = await api.post("/sales", { items: [{ productId: charger, qty: 1, wholesale: 21, selling: 30 }], payment: "cash" });
  const inv5 = r.data.sale;
  r = await api.del("/sales/" + inv5.id);
  check("حذف فاتورة نهائيًا", r.status === 200, r.data);
  r = await api.get("/bootstrap");
  check("الفاتورة المحذوفة اختفت", !r.data.invoices.some(i => i.id === inv5.id));

  /* ═══════════ المصروفات ═══════════ */
  group("المصروفات");
  r = await api.post("/expenses", { category: "rent", amount: 300, notes: "إيجار الشهر" });
  check("تسجيل مصروف", r.status === 201, r.data);
  const exp1 = r.data.expense;
  r = await api.post("/expenses", { category: "food", amount: 10 });
  check("تصنيف غير مسموح مرفوض", r.status === 400, r.status);
  r = await api.put("/expenses/" + exp1.id, { category: "electricity", amount: 250 });
  check("تعديل مصروف", r.status === 200 && r.data.expense.category === "electricity", r.data);
  r = await api.post("/expenses", { category: "other", amount: 50 });
  const exp2 = r.data.expense;
  r = await api.del("/expenses/" + exp2.id);
  check("حذف مصروف", r.status === 200, r.data);

  /* ═══════════ الصندوق ═══════════ */
  group("الصندوق");
  r = await api.post("/cashbox/deposit", { amount: 2000, note: "إيداع" });
  check("إيداع", r.status === 201, r.data);
  r = await api.post("/cashbox/withdraw", { amount: 100, note: "سحب" });
  check("سحب", r.status === 201, r.data);
  r = await api.post("/cashbox/withdraw", { amount: 999999, note: "أكثر من الرصيد" });
  check("سحب أكثر من الرصيد مرفوض", r.status === 400 && r.data.error === "insufficient_cash", r.data);
  r = await api.post("/cashbox/withdraw", { amount: 2000000 });
  check("مبلغ خارج النطاق مرفوض", r.status === 400 && r.data.error === "amount_invalid", r.data);
  r = await api.get("/cashbox");
  check("رصيد الصندوق", r.status === 200 && typeof r.data.balance === "number" && r.data.movements.length > 0, r.data.balance);
  const balanceBefore = r.data.balance;
  const manual = r.data.movements.find(m => m.category === "deposit");
  r = await api.del("/cashbox/movements/" + manual.id);
  check("حذف حركة إيداع يدوية", r.status === 200, r.data);
  r = await api.get("/cashbox");
  check("الحذف عدّل الرصيد", near(r.data.balance, balanceBefore - manual.amount, 0.01), { before: balanceBefore, del: manual.amount, after: r.data.balance });
  r = await api.get("/cashbox");
  const saleMove = r.data.movements.find(m => m.category === "sale");
  r = await api.del("/cashbox/movements/" + saleMove.id);
  check("حذف حركة بيع مرفوض", r.status === 400 || r.status === 409, r.status);

  /* ═══════════ الجرد والحركة ═══════════ */
  group("الجرد وحركة المخزون");
  r = await api.get("/bootstrap");
  const chQty = r.data.products.find(p => p.id === charger).qty;
  r = await api.post("/inventory/stocktakes", { note: "جرد تجريبي", lines: [
    { productId: charger, countedQty: chQty - 1 },
    { productId: a55, countedQty: 0 }
  ]});
  check("تنفيذ جرد", r.status === 201, r.data);
  r = await api.get("/bootstrap");
  check("الجرد عدّل الكمية", r.data.products.find(p => p.id === charger).qty === chQty - 1);
  r = await api.get("/inventory/movements?productId=" + charger);
  check("سجل الحركة", r.status === 200 && r.data.movements.some(m => m.reason === "adjustment"), r.data.movements && r.data.movements.length);
  r = await api.get("/inventory/movements?reason=purchase");
  check("فلترة الحركة بالسبب", r.status === 200 && r.data.movements.every(m => m.reason === "purchase"), r.data.movements && r.data.movements.length);
  r = await api.get("/inventory/stocktakes");
  check("قائمة الجرد", r.status === 200 && r.data.stocktakes.length === 1, r.data.stocktakes && r.data.stocktakes.length);

  /* ═══════════ التقارير ═══════════ */
  group("التقارير");
  r = await api.get("/reports/dashboard");
  check("لوحة التحكم", r.status === 200 && r.data.today && r.data.inventory && r.data.grand, r.status);
  check("today.cash عدد (إصلاح cashFlow)", typeof r.data.today.cash === "number", typeof r.data.today.cash);
  check("today.cashIn عدد", typeof r.data.today.cashIn === "number", typeof r.data.today.cashIn);
  check("عمليات أخيرة", Array.isArray(r.data.recentInvoices) && Array.isArray(r.data.recentPurchases), true);
  r = await api.get("/reports/sales?group=day");
  check("مبيعات باليوم", r.status === 200 && r.data.rows.length >= 1, r.data.rows && r.data.rows.length);
  r = await api.get("/reports/sales?group=product");
  check("مبيعات بالمنتج", r.status === 200 && r.data.rows.every(x => x.productId), r.data.rows && r.data.rows.length);
  r = await api.get("/reports/sales?group=method");
  check("مبيعات بالطريقة", r.status === 200 && r.data.rows.length >= 1, r.data.rows);
  r = await api.get("/reports/pnl");
  check("الأرباح والخسائر", r.status === 200 && r.data.sales && r.data.expenses && typeof r.data.netProfit === "number", r.data);
  check("pnl: صافي = ربح − مصروفات", near(r.data.netProfit, r.data.sales.profit - r.data.expenses.total, 0.02), r.data.netProfit);
  r = await api.get("/reports/inventory");
  check("تقرير المخزون", r.status === 200 && r.data.value && Array.isArray(r.data.lowStock), r.data.value);

  /* ═══════════ إغلاق اليوم ═══════════ */
  group("إغلاق اليوم وتجميده");
  r = await api.get("/cashbox");
  const balBeforeClose = r.data.balance;
  r = await api.post("/days/" + dayId + "/close");
  check("إغلاق اليوم", r.status === 200 && r.data.cashBalanceAtClose !== null, r.data);
  r = await api.post("/days/" + dayId + "/close");
  check("إغلاق يوم مغلق مرفوض", r.status === 409, r.status);
  r = await api.post("/sales", { items: [{ name: "بعد الإغلاق", qty: 1, wholesale: 0, selling: 5 }], payment: "cash" });
  check("بيع بعد الإغلاق مرفوض", r.status === 409 && r.data.error === "no_open_day", r.data);
  r = await api.get("/days/" + dayId);
  check("حزمة اليوم مجمّدة", r.data.frozen === true && r.data.sales.length > 0 && r.data.cashMovements.length > 0, { s: r.data.sales.length, c: r.data.cashMovements.length });
  check("رصيد الإغلاق مطابق", near(r.data.cashBalanceAtClose, balBeforeClose, 0.01), { close: r.data.cashBalanceAtClose, live: balBeforeClose });
  const closedTotals = r.data.totals;
  check("totals.cash عدد بعد التجميد", typeof closedTotals.cash === "number", typeof closedTotals.cash);
  check("totals.cashFlow كائن", closedTotals.cashFlow && typeof closedTotals.cashFlow.in === "number", closedTotals.cashFlow);
  r = await api.post("/days", { date: today });
  check("إعادة فتح نفس التاريخ مرفوضة", r.status === 409 && r.data.error === "day_exists", r.data);

  /* ═══════════ الإعدادات وطرق الدفع ═══════════ */
  group("الإعدادات");
  r = await api.put("/settings", { shopName: "محل الاختبار", currency: "د.ل", shopPhone: "0910000000", defaultMinStock: 4 });
  check("حفظ إعدادات المحل", r.status === 200 && r.data.settings.shop_name === "محل الاختبار" && r.data.settings.default_min_stock === 4, r.data.settings);
  r = await api.put("/payment-methods", { code: "unpaid", active: false });
  check("تعطيل «غير خالص»", r.status === 200 && r.data.method.active === false, r.data);
  r = await api.put("/payment-methods", { code: "cash", active: false });
  check("تعطيل النقد مرفوض (مثبّت)", r.status === 400, r.data);
  r = await api.get("/payment-methods");
  check("قراءة الطرق", r.status === 200 && r.data.methods.length === 3, r.data.methods && r.data.methods.length);
  r = await api.put("/payment-methods", { code: "unpaid", active: true });

  /* ═══════════ النسخ الاحتياطي ═══════════ */
  group("النسخ الاحتياطي والاسترجاع");
  r = await api.get("/backup");
  check("تنزيل نسخة", r.status === 200 && r.data.data && Array.isArray(r.data.data.invoices), r.data.data && Object.keys(r.data.data).length);
  const backup = r.data.data;
  const invoiceCount = backup.invoices.length;
  check("النسخة فيها فواتير", invoiceCount >= 4, invoiceCount);
  r = await api.post("/backup/restore", { confirm: "RESTORE", data: { garbage: true } });
  check("استرجاع ملف تالف مرفوض", r.status === 400 && r.data.error === "backup_invalid", r.data);
  r = await api.del("/data", { confirm: "DELETE" });
  check("تصفير قبل الاسترجاع", r.status === 200);
  r = await api.post("/backup/restore", { confirm: "RESTORE", data: backup });
  check("استرجاع النسخة", r.status === 200, r.data);
  r = await api.get("/bootstrap");
  check("الفواتير رجعت", r.data.invoices.length === invoiceCount, { got: r.data.invoices.length, want: invoiceCount });
  check("الأيام رجعت (لا يوجد يوم مفتوح)", r.data.days.every(d => d.status === "closed"), r.data.days && r.data.days.length);
  r = await api.get("/cashbox");
  check("الرصيد رجع", near(r.data.balance, balBeforeClose, 0.01), { got: r.data.balance, want: balBeforeClose });

  /* ═══════════ bootstrap النهائي ═══════════ */
  group("الإقلاع النهائي");
  r = await api.get("/bootstrap");
  const b = r.data;
  check("شكل bootstrap", b.user && b.settings && Array.isArray(b.days) && Array.isArray(b.invoices) &&
    Array.isArray(b.purchases) && Array.isArray(b.products) && Array.isArray(b.categories) &&
    Array.isArray(b.notes) && typeof b.cashBalance === "number" && b.grand, true);
  check("الفواتير تحمل بنودها", b.invoices.every(i => Array.isArray(i.items)), true);
  check("المنتجات فيها active/kind", b.products.every(p => typeof p.active === "boolean" && (p.kind === "phone" || p.kind === "accessory")), true);

  console.log("\n══════════════════════════════");
  console.log("نجح: " + pass + " · فشل: " + fail);
  if (fail) process.exit(1);
})().catch(e => { console.error("CRASH:", e); process.exit(1); });
