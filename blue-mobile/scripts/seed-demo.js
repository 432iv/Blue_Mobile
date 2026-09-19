"use strict";
/* Blue Mobile v4 — بذر بيانات تجريبية واقعية (يمسح البيانات الحالية أولاً).
   الاستخدام:  node scripts/seed-demo.js
   المتغيرات:  SEED_USER / SEED_PASS (افتراضيًا owner / demo-pass-1234)          */
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const USER = process.env.SEED_USER || "owner";
const PASS = process.env.SEED_PASS || "demo-pass-1234";

let token = "";
async function call(method, path, body) {
  const res = await fetch(BASE + "/api" + path, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(method + " " + path + " → " + res.status + " " + JSON.stringify(data).slice(0, 160));
  return data;
}
const rnd = arr => arr[Math.floor(Math.random() * arr.length)];
const imei = () => Array.from({ length: 15 }, () => Math.floor(Math.random() * 10)).join("");

(async () => {
  console.log("▸ تجهيز حساب تجريبي ...");
  let status = await (await fetch(BASE + "/api/auth/status")).json();
  if (status.setupRequired) {
    await fetch(BASE + "/api/auth/setup", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: USER, email: "demo@bluemobile.ly", password: PASS })
    });
    console.log("  أُنشئ الحساب: " + USER + " / " + PASS);
  }
  const login = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: USER, password: PASS })
  });
  if (!login.ok) {
    console.error("✗ تعذر الدخول — إذا نسيت كلمة المرور حددها: SEED_PASS=... node scripts/seed-demo.js");
    process.exit(1);
  }
  token = (await login.json()).token;
  await call("DELETE", "/data", { confirm: "DELETE" });
  console.log("✓ تم مسح البيانات السابقة");

  await call("PUT", "/settings", {
    shopName: "Blue Mobile — طرابلس",
    currency: "د.ل", shopPhone: "091-234-5678",
    shopAddress: "شارع عمر المختار، طرابلس",
    invoiceFooter: "شكراً لتعاملكم معنا — ضمان شهر على كل الأجهزة"
  });

  console.log("▸ التصنيفات والمنتجات ...");
  const cat = async n => (await call("POST", "/inventory/categories", { name: n })).category.id;
  const cPhone = await cat("هواتف ذكية");
  const cAcc = await cat("إكسسوارات");
  const cRep = await cat("قطع غيار");

  const acc = (name, buy, sell, qty, barcode) =>
    call("POST", "/inventory/products", { name, categoryId: cAcc, kind: "accessory", purchasePrice: buy, salePrice: sell, minStock: 5, qty, barcode });
  await acc("شاحن Anker 20W", 20, 35, 14, "ANK-20W");
  await acc("كابل Type-C مغطى", 6, 15, 30, "CBL-TC1");
  await acc("سماعات بلوتوث TWS", 45, 90, 8, "TWS-01");
  await acc("جراب سيليكون شفاف", 3, 10, 25, "CASE-CL");
  await acc("لاصق حماية شاشة", 2, 8, 40, "GLS-PT");
  await call("POST", "/inventory/products", { name: "بطارية iPhone 12", categoryId: cRep, kind: "accessory", purchasePrice: 60, salePrice: 130, minStock: 2, qty: 3 });

  const phones = [
    ["Samsung Galaxy A55", 850, 1050, "SM-A55", "أسود", "256GB"],
    ["Samsung Galaxy A16", 420, 540, "SM-A16", "أزرق", "128GB"],
    ["Xiaomi Redmi 14C", 330, 430, "R14C", "رمادي", "128GB"],
    ["iPhone 13 مستعمل", 1750, 2100, "A2633", "أزرق", "128GB"]
  ];
  const phoneIds = [];
  for (const [name, buy, sell, model, color, storage] of phones) {
    const r = await call("POST", "/inventory/products", {
      name, categoryId: cPhone, kind: "phone", purchasePrice: buy, salePrice: sell,
      minStock: 2, model, color, storage, imeis: [imei(), imei()]
    });
    phoneIds.push(r.product.id);
  }

  const today = new Date();
  const iso = d => d.toISOString().slice(0, 10);
  const back = days => { const d = new Date(today); d.setDate(d.getDate() - days); return d; };

  /* ── أمس: يوم كامل يُغلق ── */
  console.log("▸ يوم أمس (يُغلق ويثبّت) ...");
  const yday = await call("POST", "/days", { date: iso(back(1)) });
  const yUnits = {};
  for (const pid of phoneIds.slice(0, 2)) {
    yUnits[pid] = (await call("GET", "/inventory/products/" + pid + "/units")).units.filter(u => u.status === "in_stock").map(u => u.id);
  }
  await call("POST", "/purchases", { items: [{ productId: null, newProduct: undefined }].slice(0, 0).concat([
    { newProduct: { name: "OPPO A18", categoryId: cPhone, kind: "phone", salePrice: 470, minStock: 1 }, qty: 2, unitCost: 360, imeis: [imei(), imei()] },
    { newProduct: { name: "حامل موبايل للسيارة", categoryId: cAcc, kind: "accessory", salePrice: 25, minStock: 3 }, qty: 6, unitCost: 12 }
  ]), paid: true, notes: "توريد بداية الأسبوع" });
  await call("POST", "/sales", { items: [{ productId: phoneIds[0], qty: 1, wholesale: 850, selling: 1050, unitIds: [yUnits[phoneIds[0]][0]] }], payment: "cash" });
  await call("POST", "/sales", { items: [{ productId: phoneIds[1], qty: 1, wholesale: 420, selling: 560, unitIds: [yUnits[phoneIds[1]][0]] }], payment: "card" });
  await call("POST", "/sales", { items: [{ name: "تفليش وتفعيل", qty: 1, wholesale: 0, selling: 40 }], payment: "cash" });
  await call("POST", "/expenses", { category: "transport", amount: 60, notes: "بنزين التوصيل" });
  await call("POST", "/expenses", { category: "internet", amount: 120, notes: "تجديد الإنترنت" });
  await call("POST", "/notes", { text: "المورد الجديد (شركة الأمانة) وعد بسعر أفضل على التوريد القادم" });
  await call("POST", "/notes", { text: "الإنترنت انقطع ساعتين بعد الظهر — راجع مزود الخدمة" });
  await call("POST", "/days/" + yday.day.id + "/close");

  /* ── اليوم: يوم مفتوح بعمليات جارية ── */
  console.log("▸ اليوم (يوم مفتوح) ...");
  await call("POST", "/days", { date: iso(today) });
  const tUnits = {};
  for (const pid of phoneIds) {
    tUnits[pid] = (await call("GET", "/inventory/products/" + pid + "/units")).units.filter(u => u.status === "in_stock").map(u => u.id);
  }
  await call("POST", "/cashbox/deposit", { amount: 1500, note: "رصيد افتتاحي للصندوق" });
  await call("POST", "/sales", { items: [
    { productId: phoneIds[3], qty: 1, wholesale: 1750, selling: 2150, unitIds: [tUnits[phoneIds[3]][0]] }
  ], payment: "card", discount: 50, notes: "عميل دائم" });
  await call("POST", "/sales", { items: [
    { name: "شاحن Anker 20W", productId: (await call("GET", "/inventory/search?q=Anker")).products[0].id, qty: 2, wholesale: 20, selling: 35 }
  ], payment: "cash" });
  await call("POST", "/sales", { items: [{ name: "تركيب تطبيقات", qty: 1, wholesale: 0, selling: 30 }], payment: "unpaid", debtorName: "خالد المهيدي" });
  await call("POST", "/expenses", { category: "electricity", amount: 90, notes: "فاتورة كهرباء" });
  await call("POST", "/notes", { text: "عميل يدعى خالد طلب iPhone 15 برو — سيأتي غدًا للرد عليه" });
  await call("POST", "/cashbox/withdraw", { amount: 200, note: "مصروف خاص" });

  const boot = await call("GET", "/bootstrap");
  console.log("\n✓ اكتمل البذر التجريبي:");
  console.log("   منتجات: " + boot.products.length + " · فواتير: " + boot.invoices.length + " · رصيد الصندوق: " + boot.cashBalance.toFixed(2) + " د.ل");
  console.log("   الدخول: " + USER + " / " + PASS);
})().catch(e => { console.error("✗", e.message); process.exit(1); });
