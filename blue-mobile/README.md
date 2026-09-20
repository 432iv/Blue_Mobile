# Blue Mobile v4 — منظومة إدارة محل الهواتف والإكسسوارات

نظام متكامل لإدارة محل موبايلات: **فواتير بيع ومرتجعات · مخزون بهواتف تتتبع برقم IMEI ·
مشتريات بمتوسط تكلفة مرجّح · مصروفات · صندوق نقدي · تقارير وأرباح وخسائر · إغلاق يومية مجمّدة**.

**Frontend → Backend API → PostgreSQL**، بحساب واحد فقط. كل شيء يُحفظ في قاعدة البيانات —
جهازان يدخلان نفس الحساب يريان نفس البيانات لحظيًا. المتصفح لا يحتفظ إلا برمز الجلسة
وتفضيلات الواجهة.

---

## 1. المعمارية

```
Blue-Mobile.html      واجهة كاملة في ملف واحد (Glass UI · عربية RTL · داكن/فاتح)
        │  fetch() + جلسة Bearer/cookie
        ▼
server/index.js       Express API (يقدّم الواجهة أيضًا)
        │  pg Pool
        ▼
PostgreSQL            قاعدة واحدة — كل بيانات المنظومة (22 جدولًا)
```

| المسار | الوظيفة |
|---|---|
| `Blue-Mobile.html` | الواجهة كاملة بدون خطوة بناء |
| `server/index.js` | تجميع التطبيق، ترويسات الأمان، بوابة المصادقة، معالج الأخطاء |
| `server/config.js` | قراءة البيئة — لا أسرار في المصدر |
| `server/db.js` | `pg` Pool + `query()`/`tx()` |
| `server/migrate.js` | مشغّل المهاجرات (متابَع في `schema_migrations`) |
| `server/lib/ledger.js` | منطق الدفتر: إجماليات اليوم، حركة الصندوق والمخزون، لقطة الإغلاق |
| `server/lib/map.js` | تحويل صفوف القاعدة إلى أشكال الواجهة |
| `server/routes/` | auth · sales · inventory · purchases · expenses · cashbox · days · reports · notes · data |

## 2. التشغيل

```bash
cp .env.example .env    # عدّل DATABASE_URL و SESSION_SECRET (مطلوبان)
npm install
npm run migrate         # ينشئ/يحدّث المخطط — آمن للإعادة
npm run dev             # Postgres + المهاجرات + خادم بإعادة تشغيل تلقائية
# أو: npm start          # http://localhost:3000
```

أوامر مساعدة:

```bash
npm run seed            # بيانات تجريبية واقعية (تمسح الحالية — الحساب يبقى)
npm run wipe            # تصفير كل البيانات (WIPE_PASS=... لتحديد كلمة المرور)
npm test                # 110 فحص API
npm run test:e2e        # 42 فحص متصفح حقيقي (يحتاج Playwright)
npm run screens         # لقطات شاشة لكل الصفحات → screens/
```

أنشئ سرًا حقيقيًا للجلسات:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**أول تشغيل:** تظهر شاشة *الإعداد الأول* وتطلب اسم مستخدم وبريدًا وكلمة مرور — هذا هو
الحساب الوحيد. بعدها لا يظهر إلا تسجيل الدخول (`409 account_exists` لأي محاولة ثانية).

## 3. الوحدات

- **المبيعات** — فواتير `INV-xxxxx` متعددة الأصناف: منتجات مخزون أو أصناف حرة، خصم،
  طرق دفع (نقد/بطاقة/غير خالص باسم المدين)، هواتف تُباع **باختيار وحدة IMEI محددة**.
  تعديل وإلغاء وإرجاع كلي أو جزئي — كلها تُسوّي المخزون والصندوق تلقائيًا. طباعة فاتورة A4.
- **المخزون** — منتجات (هاتف/إكسسوار)، تصنيفات، باركود، صور، وحدات IMEI وحالتها
  (موجود/مبيع/مُرجع)، سجل حركة كامل (شراء/بيع/مرتجع/تسوية)، **جرد** بفروقات تُطبَّق بنقرة،
  بحث فوري بالاسم/الباركود/IMEI.
- **المشتريات** — فواتير `PUR-xxxxx`، أصناف موجودة أو **إنشاء منتج جديد inline**،
  تسجيل IMEIs للتوريد، متوسط تكلفة مرجّح، مدفوعة (تُخصم من الصندوق) أو آجلة.
- **المصروفات** — أنواع ثابتة (إيجار/كهرباء/إنترنت/نقل/صيانة/أخرى) مربوطة بالصندوق واليوم.
- **الصندوق** — رصيد نقدي مباشر = مقبوضات − مدفوعات، إيداع/سحب يدوي، سجل حركة مصنّف،
  ورقة اليومية بإجمالياتها.
- **التقارير** — أيام مغلقة بلقطة **مجمّدة** عند الإغلاق (لا تتغير أبدًا)، تقرير مبيعات
  (باليوم/المنتج/طريقة الدفع)، أرباح وخسائر، تقرير مخزون (القيمة/النواقص/الأكثر مبيعًا/الراكد).
- **الإعدادات** — بيانات المحل والشعار (تظهر في الفواتير)، العملة، الحد الأدنى الافتراضي،
  تفعيل طرق الدفع، نسخ احتياطي/استرجاع JSON، مظهر داكن/فاتح، **وضع البيع السريع بالباركود**.
- **البيع السريع بالباركود (v4.1)** — قارئ باركود USB/Bluetooth (Keyboard Wedge) يعمل من
  أي صفحة دون فتح المبيعات أو الضغط على زر. مسح باركود يفتح صفحة المبيعات تلقائيًا،
  يضيف المنتج للفاتورة الجارية (أو يزيد كميته إن كان مضافًا)، ويحسب الربح والإجمالي فورًا.
  باركود غير مسجَّل → نافذة "المنتج غير موجود" (إضافة/بحث يدوي/إلغاء). منتج مخزونه صفر →
  تنبيه واضح دون منع الإضافة اليدوية اللاحقة (السلوك الأصلي لمنع بيع مخزون سالب محفوظ كما هو).
  يمكن تعطيله بالكامل من الإعدادات. البيع اليدوي (بحث بالاسم) يعمل جنبًا إلى جنب دون أي تغيير.

## 4. قاعدة البيانات (مختصر)

`users · sessions · settings · payment_methods · categories · products · phone_units ·
invoices · invoice_items · sale_returns · purchases · purchase_items · expenses ·
cash_movements · stock_movements · stocktakes · stocktake_items · days · day_summaries ·
notes · product_names`

- الفواتير والأصناف تحمل أعمدة `GENERATED ALWAYS` للإجماليات — الحساب لا ينحرف عن الواجهة.
- **قواعد لا تُخترق:** رقم IMEI فريد (وحدة لكل جهاز) · وحدة الهاتف تُبيع مرة واحدة ·
  الكمية لا تنزل تحت الصفر · الخصم لا يتجاوز الإجمالي · يوم واحد لكل تاريخ · يوم مفتوح واحد.
- إلغاء/حذف عملية **يعكس** كل آثارها (مخزون + صندوق)؛ الإغلاق يخزّن لقطة JSON في
  `day_summaries` تبقى صحيحة حتى لو حُذفت العمليات لاحقًا.
- متوسط التكلفة مرجّح: `الكمية القديمة × سعرها + الجديدة × سعرها ÷ الإجمالي`.

## 5. الـ API

كل المسارات تحت `/api` وما عدا `/api/auth/*` و`/api/health` تتطلب جلسة (401 بدونها).

| المجموعة | المسارات |
|---|---|
| المصادقة | `GET auth/status` · `POST auth/setup|login|logout|password` |
| الأيام | `GET days` · `GET days/current` · `POST days` · `GET days/:id` · `POST days/:id/close` · `DELETE days/:id` |
| المبيعات | `GET sales` · `POST sales` · `PUT sales/:id` · `DELETE sales/:id` · `POST sales/:id/cancel` · `POST sales/:id/returns` |
| المخزون | `GET|POST inventory/products` · `PUT|DELETE inventory/products/:id` · `POST inventory/products/:id/adjust` · `GET|POST inventory/products/:id/units` · `GET inventory/search` · `GET inventory/movements` · `POST|GET inventory/categories` · `POST|GET inventory/stocktakes` |
| المشتريات | `GET|POST purchases` · `GET|PUT|DELETE purchases/:id` · `POST purchases/:id/cancel` |
| المصروفات | `GET|POST expenses` · `PUT|DELETE expenses/:id` |
| الصندوق | `GET cashbox` · `POST cashbox/deposit|withdraw` · `DELETE cashbox/movements/:id` |
| التقارير | `GET reports/dashboard` · `GET reports/sales?from&to&group=day\|product\|method` · `GET reports/pnl` · `GET reports/inventory` |
| الحساب | `GET bootstrap` · `GET|PUT settings` · `GET|PUT payment-methods` · `GET backup` · `POST backup/restore` · `POST import` · `DELETE data` |

العمليات تُرفض على يوم مغلق (`409 day_closed`) وبدون يوم مفتوح (`409 no_open_day`)،
والقراءة تعمل دائمًا — الإغلاق يقفل ولا يحذف.

## 6. الاختبارات

```bash
npm test                    # 110 فحص — المنطق الكامل عبر الـ API
npm run test:e2e            # 42 فحص — متصفح كروميوم حقيقي على الواجهة
NODE_PATH=/tmp/bmtest/node_modules npm run test:e2e   # إذا كان playwright مثبتًا خارج المشروع
```

تغطية الـ API: المصادقة والحماية · أيام العمل وتضاربها · منتجات ووحدات IMEI
(التكرار/قفل النوع/البحث) · مشتريات بمتوسط مرجّح ومنتجات inline · فواتير بكل حالاتها
(خصم/وحدات/تعديل/إرجاع/إلغاء/حذف) · مصروفات · صندوق ورصيده · جرد وتسويات · تقارير ·
نسخ احتياطي/استرجاع كامل الدورة · شكل bootstrap.

تغطية المتصفح: الدخول ورسائل الخطأ · بدء اليوم · إضافة إكسسوار وهاتف IMEI · درج المنتج ·
بيع ببحث المنتج والتعبئة التلقائية واختيار IMEI · بيع بطاقة بخصم · شراء · مصروف · إيداع ·
التقارير الأربعة · إغلاق اليومية · الإعدادات والمظهر — مع التأكد من **صفر أخطاء JavaScript**.

## 7. ملاحظات تشغيلية

- تصفير البيانات مع إبقاء الحساب: زر *حذف جميع البيانات* في الإعدادات، أو
  `DELETE /api/data` مع `{"confirm":"DELETE"}`، أو `npm run wipe`.
- إعادة ضبط كاملة (يمسح الحساب أيضًا): `psql "$DATABASE_URL" -c "TRUNCATE users CASCADE;"`
- النسخ الاحتياطي JSON يشمل كل الجداول — الاسترجاع يعتملي داخل معاملة واحدة.
- الجلسات تدوم `SESSION_TTL_DAYS` يومًا؛ *تسجيل الخروج* يحذف جلسة السيرفر فيموت التوكن المسروق معها.
- المتصفح يحتفظ فقط بـ `bm_token` و`bm_ui` في `localStorage` — لا بيانات عمل تُكتب على الجهاز.
