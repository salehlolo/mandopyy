# Waslny Delivery Platform

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file (a template is provided in `.env.example`) and adjust the values as needed. All API keys and secrets must live in this file.

   Key variables:

   - `JWT_SECRET` – signing key for customer/driver JSON Web Tokens.
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` – optional; when present the server will send OTP codes via Twilio, otherwise it falls back to mock delivery for development.
   - `BASE_URL` / `FRONTEND_URL` – used by the server to build absolute links when required (e.g. external callbacks).
   - `MAP_PROVIDER`, `OSM_ROUTING_URL`, `NOMINATIM_URL` – configure the map stack. Defaults point to Leaflet + open-source OSRM/Nominatim which are suitable for development.
   - `MAPTILER_KEY` / `MAPBOX_TOKEN` – optional production-ready providers if you want to switch to vector tiles or managed routing.
   - `PAY_PROVIDER` – set to `paymob` to enable card payments. Configure `PAYMOB_API_KEY`, `PAYMOB_INTEGRATION_ID_CARD`, `PAYMOB_IFRAME_ID`, `PAYMOB_HMAC_SECRET`, and `PAYMOB_BASE` with your Accept credentials. Optional failover keys exist for Fawry (`FAWRY_*`).
   - `NODE_ENV` – when set to `production` the floating development menu is hidden from all pages.

3. Start the server:

   ```bash
   npm run dev
   ```

   The server exposes the web apps from the `public/` directory and a JSON API.

> **ملاحظة:** عند فتح الواجهات على جهاز آخر داخل نفس الشبكة المحلية، عدِّل المتغير `API_BASE_URL` في ملف `.env` إلى `http://<IP-PC>:3000` ثم أعد تشغيل الخادم.

## واجهات الويب

كل صفحة من الصفحات التالية تعتمد على TailwindCSS عبر CDN بالإضافة إلى مكتبات مساعدة داخلية (`/assets/js/ui.js` و`/assets/js/map.js`).

- `/index.html` — صفحة الهبوط، تسجيل العملاء عبر رمز تحقق OTP بالهاتف مع روابط سريعة لتطبيق السائق والمشرف.
- `/delivery_app.html` — خريطة Leaflet مع تسعير باستخدام OSRM، تأكيد الطلب، وتتبع السائق بسلاسة (Trail محدود 100 نقطة).
- `/driver_app.html` — تسجيل السائق عبر OTP، إرسال بيانات المركبة، التحكم بحالة التوفر، تتبع الموقع والإشعارات اللحظية مع عرض واضح لطريقة الدفع.
- `/admin_panel.html` — لوحة إدارة تعتمد جداول Tailwind وخريطة صغيرة تعرض آخر مواقع المناديب المتاحين، مع أزرار اعتماد/إلغاء اعتماد، بالإضافة إلى جدول لمتابعة الدفعات الإلكترونية (Paymob).
- `/orders_history.html` — صفحة مخصصة لعرض سجل الطلبات للعميل، حالة الدفع، وإظهار التفاصيل عند الطلب.

> **Dev Menu:** يظهر شريط تنقل صغير في أسفل يمين الصفحات في وضع التطوير، ويوفر أزرار Mock Login/Logout وروابط بين الواجهات. يتم تعطيله تلقائيًا إذا كان `NODE_ENV=production`.
