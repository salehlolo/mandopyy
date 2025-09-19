# Waslny Delivery Platform

## Local development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a `.env` file (a template is provided in `.env.example`) and adjust the values as needed. All API keys and secrets must live in this file.

3. Start the server:

   ```bash
   npm run dev
   ```

   The server exposes the web apps from the `public/` directory and a JSON API.

> **ملاحظة:** عند فتح الواجهات على جهاز آخر داخل نفس الشبكة المحلية، عدِّل المتغير `API_BASE_URL` في ملف `.env` إلى `http://<IP-PC>:3000` ثم أعد تشغيل الخادم.
