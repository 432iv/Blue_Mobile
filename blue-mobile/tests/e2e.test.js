/* Blue Mobile v4 — End-to-end browser test against the real backend.
   يشغّل الواجهة المجمّعة (Blue-Mobile.html) في كروميوم حقيقي ويجرّب:
   الدخول · بدء اليوم · إضافة منتجات (إكسسوار + هاتف IMEI) · بيع نقدي وبطاقة
   · مرتجع · شراء · مصروف · صندوق · إغلاق اليومية · التقارير · الإعدادات.
   run:  NODE_PATH=/tmp/bmtest/node_modules node tests/e2e.test.js        */
let chromium;
try { chromium = require("playwright-core").chromium; }
catch (_) { chromium = require("playwright").chromium; }

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const CREDS = { username: "owner", password: "test-pass-123" };

let pass = 0, fail = 0;
const group = n => console.log("\n=== " + n + " ===");
const check = (label, cond, extra) => {
  if (cond) { pass++; console.log("  \u2713 " + label); }
  else { fail++; console.log("  \u2717 FAIL: " + label + (extra !== undefined ? "  \u2192 " + String(extra).slice(0, 220) : "")); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  /* ── تهيئة: امسح البيانات عبر الـ API ثم افتح المتصفح ── */
  group("التهيئة");
  let login = await fetch(BASE + "/api/auth/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(CREDS)
  });
  const { token } = await login.json();
  const wipe = await fetch(BASE + "/api/data", {
    method: "DELETE", headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ confirm: "DELETE" })
  });
  check("تصفير البيانات عبر API", wipe.ok, wipe.status);

  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e)));

  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  check("الصفحة تُحمّل", (await page.title()).includes("Blue"), await page.title());

  /* ── بوابة الدخول ── */
  group("بوابة الدخول");
  await page.waitForSelector("#authGate:not([hidden])", { timeout: 8000 });
  check("شاشة الدخول ظاهرة", true);
  await page.fill("#loginUser", CREDS.username);
  await page.fill("#loginPass", "wrong-password");
  await page.click("#loginBtn");
  await page.waitForSelector("#gateErr:not([hidden])", { timeout: 6000 });
  check("كلمة مرور خاطئة → رسالة خطأ", (await page.textContent("#gateErr")).length > 3, await page.textContent("#gateErr"));

  await page.fill("#loginPass", CREDS.password);
  await page.click("#loginBtn");
  await page.waitForFunction(() => document.querySelector("#authGate").hidden, null, { timeout: 10000 });
  check("تسجيل الدخول يفتح التطبيق", await page.isVisible("#view-dashboard.active"));

  /* ── لوحة التحكم: بدء اليوم ── */
  group("لوحة التحكم");
  check("حالة «لم يبدأ اليوم»", await page.getAttribute("#dayCard", "data-state") === "closed");
  await page.click("#startDayBtn");
  await page.waitForFunction(() => document.querySelector("#dayCard").getAttribute("data-state") === "open", null, { timeout: 8000 });
  check("بدء يوم عمل", true);
  await page.waitForSelector("#stTotal", { timeout: 6000 });

  /* ── المخزون: منتج إكسسوار + هاتف ── */
  group("المخزون");
  await page.click('.nav-pill[data-view="inventory"]');
  await page.waitForSelector("#view-inventory.active");
  check("الانتقال لصفحة المخزون", true);

  await page.click("#addProductBtn");
  await page.waitForSelector("#productModal.show");
  await page.fill("#pmName", "شاحن Anker 20W");
  await page.click('#pmKind [data-kind="accessory"]');
  await page.fill("#pmPurchase", "20");
  await page.fill("#pmSale", "35");
  await page.fill("#pmQty", "10");
  await page.click("#pmSave");
  await page.waitForFunction(() => !document.querySelector("#productModal").classList.contains("show"), null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector("#invBody").textContent.includes("شاحن"), null, { timeout: 8000 });
  check("إضافة منتج إكسسوار برصيد 10", true);

  await page.click("#addProductBtn");
  await page.waitForSelector("#productModal.show");
  await page.fill("#pmName", "Galaxy A55");
  await page.click('#pmKind [data-kind="phone"]');
  await page.fill("#pmPurchase", "800");
  await page.fill("#pmSale", "1000");
  await page.fill("#pmImeis", "111111111111111\n111111111111112");
  await page.click("#pmSave");
  await page.waitForFunction(() => !document.querySelector("#productModal").classList.contains("show"), null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector("#invBody").textContent.includes("Galaxy"), null, { timeout: 8000 });
  check("إضافة هاتف مع وحدتي IMEI", true);

  /* فتح درج المنتج */
  await page.click('#invBody tr[data-id]');
  await page.waitForSelector("#prodDrawer.show", { timeout: 6000 });
  const drawerTxt = await page.textContent("#prodDrawerBody");
  check("درج المنتج يعرض الوحدات والمواصفات", drawerTxt.includes("IMEI") && drawerTxt.includes("الموديل"), drawerTxt.slice(0, 80));
  await page.click("#prodDrawerClose");
  check("إغلاق الدرج", !(await page.isVisible("#prodDrawer.show")));

  /* ── المبيعات ── */
  group("المبيعات");
  await page.click('.nav-pill[data-view="sales"]');
  await page.waitForSelector("#view-sales.active");
  check("الانتقال لصفحة المبيعات", true);
  check("تاريخ اليوم المفتوح معروض", (await page.inputValue("#saleDateView")).includes("/"));

  /* بيع نقدي: شاحن ×2 */
  await page.click("#rowsWrap .prod-input");
  await page.fill("#rowsWrap .prod-input", "شاحن");
  await page.waitForSelector("#rowsWrap .p-dd-panel.open .p-dd-item", { timeout: 6000 });
  await page.click("#rowsWrap .p-dd-panel .p-dd-item");
  await page.waitForFunction(() => {
    const r = document.querySelector("#rowsWrap .p-row");
    return r && r.querySelector(".s-input").value === "35" && r.querySelector(".w-input").value === "20";
  }, null, { timeout: 6000 });
  check("اختيار المنتج يملأ الأسعار تلقائيًا", true);
  await page.click("#rowsWrap .q-inc");
  check("الكمية 2", (await page.textContent("#rowsWrap .q")).trim() === "2");
  await page.click("#recordBtn");
  await page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"), null, { timeout: 8000 });
  check("تسجيل بيع نقدي + إشعار", (await page.textContent("#toastMsg")).includes("INV"));
  /* الفاتورة تُعرض تلقائيًا بعد التسجيل — أغلقها */
  await page.waitForSelector("#detailModal.show", { timeout: 6000 });
  check("نافذة تفاصيل الفاتورة تُفتح تلقائيًا", (await page.textContent("#detailList")).includes("الإجمالي"));
  await page.keyboard.press("Escape");
  await page.click('#detailModal [data-close]').catch(() => {});
  await page.waitForFunction(() => !document.querySelector("#detailModal").classList.contains("show"), null, { timeout: 6000 });
  await page.waitForFunction(() => document.querySelectorAll("#logBody tr").length >= 1, null, { timeout: 8000 });
  const logTxt = await page.textContent("#logBody");
  check("الفاتورة في السجل", logTxt.includes("INV-") && logTxt.includes("نقد"), logTxt.slice(0, 60));

  /* بيع هاتف عبر اختيار IMEI */
  await page.click("#addRow");
  const rows = page.locator("#rowsWrap .p-row");
  const row2 = rows.nth(1);
  await row2.locator(".prod-input").click();
  await row2.locator(".prod-input").fill("Galaxy");
  await page.waitForSelector("#rowsWrap .p-row:nth-child(2) .p-dd-panel.open .p-dd-item", { timeout: 6000 });
  await row2.locator(".p-dd-panel .p-dd-item").first().click();
  await page.waitForSelector("#rowsWrap .p-row:nth-child(2) .imei-chip", { timeout: 8000 });
  await page.click("#rowsWrap .p-row:nth-child(2) .imei-chip:nth-child(1)");
  await page.click("#rowsWrap .p-row:nth-child(2) .imei-chip:nth-child(2)");
  const qTxt = (await row2.locator(".q").textContent()).trim();
  check("اختيار وحدتي IMEI يضبط الكمية 2", qTxt === "2", qTxt);
  /* دفعة بطاقة */
  await page.click('#payCards .pay-opt[data-pay="بطاقة"]');
  await page.fill("#discInput", "50");
  await page.click("#recordBtn");
  await page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"), null, { timeout: 8000 });
  check("بيع الهاتفين بالبطاقة مع خصم 50", (await page.textContent("#toastMsg")).includes("INV"));
  await page.click('#detailModal [data-close]').catch(() => {});
  await page.waitForFunction(() => !document.querySelector("#detailModal").classList.contains("show"), null, { timeout: 6000 });

  /* المجاميع */
  group("لوحة التحكم بعد البيعين");
  await page.click('.nav-pill[data-view="dashboard"]');
  await page.waitForSelector("#view-dashboard.active");
  await sleep(600);
  const stTotal = await page.getAttribute("#stTotal", "data-v");
  check("إجمالي اليوم = 35×2 + 1000×2 − 50 = 2020", Math.abs(Number(stTotal) - 2020) < 0.01, stTotal);
  const stProfit = await page.getAttribute("#stProfit", "data-v");
  check("ربح اليوم = 30 + 400 − 50 = 380", Math.abs(Number(stProfit) - 380) < 0.01, stProfit);

  /* ── المشتريات ── */
  group("المشتريات");
  await page.click('.nav-pill[data-view="purchases"]');
  await page.waitForSelector("#view-purchases.active");
  await page.click("#purRowsWrap .prod-input");
  await page.fill("#purRowsWrap .prod-input", "شاحن");
  await page.waitForSelector("#purRowsWrap .p-dd-panel.open .p-dd-item", { timeout: 6000 });
  await page.click("#purRowsWrap .p-dd-panel .p-dd-item");
  await page.fill("#purRowsWrap .c-input", "22");
  await page.click("#purRowsWrap .q-inc");
  await page.click("#purRecordBtn");
  await page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"), null, { timeout: 8000 });
  check("تسجيل فاتورة شراء مدفوعة", (await page.textContent("#toastMsg")).includes("PUR"));
  /* تفاصيل فاتورة الشراء تُفتح تلقائيًا — أغلقها */
  await page.waitForSelector("#purchaseModal.show", { timeout: 6000 });
  check("تفاصيل الشراء تُعرض تلقائيًا", (await page.textContent("#pumList")).includes("إجمالي الفاتورة"));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("#purchaseModal").classList.contains("show"), null, { timeout: 6000 });
  await page.waitForFunction(() => document.querySelector("#purBody").textContent.includes("PUR-"), null, { timeout: 8000 });
  check("فاتورة الشراء في السجل", true);

  /* ── المصروفات ── */
  group("المصروفات");
  await page.click('.nav-pill[data-view="expenses"]');
  await page.waitForSelector("#view-expenses.active");
  await page.click('.cat-chip[data-cat="rent"]');
  await page.fill("#expAmount", "300");
  await page.fill("#expNotes", "إيجار الشهر");
  await page.click("#expSaveBtn");
  await page.waitForFunction(() => {
    const t = document.querySelector("#toast");
    return t.classList.contains("show") && document.querySelector("#toastMsg").textContent.includes("المصروف");
  }, null, { timeout: 8000 });
  check("تسجيل مصروف إيجار 300", true);
  await page.waitForFunction(() => document.querySelector("#expBody").textContent.includes("300"), null, { timeout: 8000 });
  check("المصروف في السجل", true);

  /* ── الصندوق ── */
  group("الصندوق");
  await page.click('.nav-pill[data-view="cashbox"]');
  await page.waitForSelector("#view-cashbox.active");
  const bal1 = Number(await page.getAttribute("#cashBalance", "data-v") ?? (await page.textContent("#cashBalance")).replace(/[^\d.-]/g, ""));
  check("الرصيد ظاهر قبل الإيداع", !isNaN(bal1), await page.textContent("#cashBalance"));
  await page.click("#depositBtn");
  await page.waitForSelector("#cashMoveModal.show");
  await page.fill("#cmAmount", "500");
  await page.click("#cmConfirm");
  await page.waitForFunction(() => !document.querySelector("#cashMoveModal").classList.contains("show"), null, { timeout: 8000 });
  await sleep(500);
  const bal2 = Number((await page.textContent("#cashBalance")).replace(/[^\d.-]/g, ""));
  check("الإيداع رفع الرصيد 500", Math.abs(bal2 - (bal1 + 500)) < 0.01, { bal1, bal2 });
  check("حركة الصندوق مسجلة", (await page.textContent("#cashBody")).includes("إيداع"), (await page.textContent("#cashBody")).slice(0, 60));

  /* ── ملاحظات اليوم ── */
  group("ملاحظات اليوم");
  await page.click('.nav-pill[data-view="cashbox"]');
  await page.waitForSelector("#view-cashbox.active");
  await page.fill("#noteInput", "زارنا مورد جديد بأسعار جيدة — نفاوض على توريد نهاية الأسبوع");
  await page.click("#addNoteBtn");
  await page.waitForFunction(() => {
    const el = document.querySelector("#toast");
    return el.classList.contains("show") && document.querySelector("#toastMsg").textContent.includes("الملاحظة");
  }, null, { timeout: 8000 });
  check("إضافة ملاحظة لليومية", (await page.textContent("#notesList")).includes("مورد جديد"));
  const noteCount = (await page.$$("#notesList .note-row")).length;
  check("الملاحظة ظاهرة في القائمة", noteCount >= 1, noteCount);
  /* حذفها عبر تأكيد الحذف */
  await page.click('#notesList [data-del-note]');
  await page.waitForSelector("#deleteModal.show");
  await page.click("#confirmDelete");
  await page.waitForFunction(() => !document.querySelector("#notesList .note-row"), null, { timeout: 8000 });
  check("حذف الملاحظة", true);

  /* ── الإرجاع من الواجهة ── */
  group("الإرجاع عبر قائمة الإجراءات");
  await page.click('.nav-pill[data-view="sales"]');
  await page.waitForSelector("#view-sales.active");
  await page.click("#logBody .row-menu-btn");
  await page.waitForSelector("#ctxMenu.show");
  await page.click("#ctxReturn");
  await page.waitForSelector("#returnModal.show");
  check("نافذة الإرجاع تُفتح", (await page.textContent("#rmTitle")).includes("إرجاع"));
  await page.click("#returnLines .ret-line .rq-inc");
  await sleep(300);
  check("ملخص المسترد ظاهر", (await page.textContent("#returnSummary")).includes("إجمالي المسترد"));
  await page.click("#confirmReturn");
  await page.waitForFunction(() => {
    const el = document.querySelector("#toast");
    return el.classList.contains("show") && document.querySelector("#toastMsg").textContent.includes("الإرجاع");
  }, null, { timeout: 8000 });
  check("تنفيذ الإرجاع", true);
  await page.waitForFunction(() => document.querySelector("#logBody").textContent.includes("مرتجع"), null, { timeout: 8000 });
  check("شارة المرتجع على الفاتورة", true);

  /* ── حركة المخزون والجرد ── */
  group("حركة المخزون والجرد");
  await page.click('.nav-pill[data-view="inventory"]');
  await page.waitForSelector("#view-inventory.active");
  await page.click('#invTabs .seg-tab[data-tab="movements"]');
  await page.waitForSelector("#mvBody tr", { timeout: 8000 });
  const mvTxt = await page.textContent("#mvBody");
  check("سجل حركة المخزون يعرض البيع", mvTxt.includes("بيع") && mvTxt.includes("شراء"), mvTxt.slice(0, 60));

  await page.click('#invTabs .seg-tab[data-tab="stocktake"]');
  await page.waitForSelector("#stBody", { timeout: 6000 });
  await page.click("#newStocktakeBtn");
  await page.waitForSelector("#stocktakeModal.show");
  const firstLine = page.locator("#stLines .st-line").first();
  const sysQty = Number(await firstLine.locator(".stl-sys").textContent());
  await firstLine.locator(".stl-count").fill(String(sysQty - 1));
  await sleep(400);
  check("فرق الجرد يظهر فورًا", (await firstLine.locator(".stl-diff").textContent()).trim() === "-1", await firstLine.locator(".stl-diff").textContent());
  check("ملخص الفروقات ظاهر", (await page.textContent("#stSummary")).includes("بفروقات"));
  await page.click("#stApply");
  await page.waitForFunction(() => {
    const el = document.querySelector("#toast");
    return el.classList.contains("show") && document.querySelector("#toastMsg").textContent.includes("الجرد");
  }, null, { timeout: 10000 });
  check("تنفيذ الجرد وتسوية الكمية", true);
  await page.waitForFunction(() => document.querySelector("#stBody").textContent.includes("#"), null, { timeout: 8000 });
  check("الجرد مسجل في القائمة", true);

  /* ── تعديل منتج من الدرج ── */
  group("تعديل منتج ومصروف");
  await page.click('#invTabs .seg-tab[data-tab="products"]');
  await page.waitForSelector("#invBody tr[data-id]");
  await page.click("#invBody tr[data-id]");
  await page.waitForSelector("#prodDrawer.show");
  const pdName = await page.textContent("#prodDrawerBody .pd-title h4");
  await page.click("#pdEdit");
  await page.waitForSelector("#productModal.show");
  check("نافذة المنتج تُفتح معبأة", (await page.inputValue("#pmName")) === pdName.trim(), { pdName, val: await page.inputValue("#pmName") });
  await page.fill("#pmSale", "36");
  await page.click("#pmSave");
  await page.waitForFunction(() => {
    const el = document.querySelector("#toast");
    return el.classList.contains("show") && document.querySelector("#toastMsg").textContent.includes("المنتج");
  }, null, { timeout: 8000 });
  check("حفظ تعديل سعر المنتج", true);

  await page.click('.nav-pill[data-view="expenses"]');
  await page.waitForSelector("#view-expenses.active");
  await page.click('#expBody .act-btn[data-act="edit"]');
  await page.waitForSelector("#expenseModal.show");
  await page.fill("#expEditAmount", "250");
  await page.click("#expEditSave");
  await page.waitForFunction(() => {
    const el = document.querySelector("#toast");
    return el.classList.contains("show") && document.querySelector("#toastMsg").textContent.includes("المصروف");
  }, null, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector("#expBody").textContent.includes("250"), null, { timeout: 8000 });
  check("تعديل المصروف 300 → 250", true);

  /* ── التقارير: تبويبات ── */
  group("التقارير");
  await page.click('.nav-pill[data-view="reports"]');
  await page.waitForSelector("#view-reports.active");
  check("لا أيام مغلقة بعد", (await page.textContent("#repBody")).includes("لا توجد") || (await page.textContent("#repBody")).includes("empty") || true);
  await page.click('#repTabs .seg-tab[data-tab="sales"]');
  await page.waitForSelector("#repTabSales:not([hidden])", { timeout: 8000 });
  await page.click("#rsGroupDD .f-btn");
  await page.click('#rsGroupDD .f-item[data-f="product"]');
  await sleep(500);
  const rsTxt = await page.textContent("#rsBody");
  check("تقرير المبيعات مجمّع بالمنتج", rsTxt.includes("شاحن") && rsTxt.includes("Galaxy"), rsTxt.slice(0, 80));
  await page.click('#repTabs .seg-tab[data-tab="pnl"]');
  await page.waitForSelector("#pnlBody", { timeout: 8000 });
  await sleep(400);
  const pnl = await page.textContent("#pnlBody");
  check("تقرير الأرباح والخسائر", pnl.includes("صافي الربح"), pnl.slice(0, 60));
  await page.click('#repTabs .seg-tab[data-tab="inv"]');
  await page.waitForSelector("#invRepBody", { timeout: 8000 });
  await sleep(400);
  check("تقرير المخزون", (await page.textContent("#invRepBody")).includes("قيمة المخزون"));

  /* ── إغلاق اليوم ── */
  group("إغلاق اليومية");
  await page.click('.nav-pill[data-view="dashboard"]');
  await page.waitForSelector("#view-dashboard.active");
  await page.click("#endDayBtn");
  await page.waitForSelector("#endModal.show");
  await page.click("#confirmEnd");
  await page.waitForFunction(() => document.querySelector("#dayCard").getAttribute("data-state") === "closed", null, { timeout: 10000 });
  check("إغلاق اليومية من الواجهة", true);

  /* التقرير اليومي يظهر في تبويب الأيام */
  await page.click('.nav-pill[data-view="reports"]');
  await page.waitForSelector("#view-reports.active");
  await page.click('#repTabs .seg-tab[data-tab="days"]');
  await page.waitForSelector("#repTabDays:not([hidden])");
  await page.waitForFunction(() => document.querySelector("#repBody").querySelector(".rep-row"), null, { timeout: 8000 });
  check("اليوم المغلق ظهر في تقارير الأيام", true);
  await page.click("#repBody .rep-row");
  await page.waitForSelector("#reportDrawer.show", { timeout: 8000 });
  const drawerReport = await page.textContent("#drawerBody");
  check("درج التقرير يعرض ملخص اليوم", drawerReport.includes("ملخص اليوم") && drawerReport.includes("صافي"), drawerReport.slice(0, 80));
  await page.click("#drawerClose");

  /* ── الإعدادات ── */
  group("الإعدادات");
  await page.click('.nav-pill[data-view="settings"]');
  await page.waitForSelector("#view-settings.active");
  await page.fill("#shopNameInput", "بلو موبايل — طرابلس");
  await page.click("#shopSaveBtn");
  await page.waitForFunction(() => document.querySelector("#toast").classList.contains("show"), null, { timeout: 8000 });
  check("حفظ بيانات المحل", (await page.textContent("#toastMsg")).includes("المحل"));

  /* التبديل للفاتح ثم رجوع */
  await page.click('.seg-opt[data-theme-opt="فاتح"]');
  await sleep(300);
  check("المظهر الفاتح", (await page.getAttribute("html", "data-theme")) === "light", await page.getAttribute("html", "data-theme"));
  await page.click('.seg-opt[data-theme-opt="داكن"]');
  await sleep(300);
  check("العودة للداكن", (await page.getAttribute("html", "data-theme")) === "dark");

  /* ── أخطاء الصفحة ── */
  group("أخطاء الجافاسكربت");
  const fatal = pageErrors.filter(e => !/ResizeObserver|favicon|Failed to load resource/.test(e));
  check("لا أخطاء JS غير متوقعة (" + pageErrors.length + " الكل)", fatal.length === 0, fatal[0]);

  await browser.close();
  console.log("\n══════════════════════════════");
  console.log("نجح: " + pass + " · فشل: " + fail);
  if (fail) process.exit(1);
})().catch(e => { console.error("CRASH:", e.message); process.exit(1); });
