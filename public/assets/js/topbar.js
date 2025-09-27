// ====== Topbar (MANDUBO) ======
(function () {
  const CFG = window.__APP_CONFIG__ || {};
  const APP_NAME = window.__APP_NAME__ || 'MANDUBO';
  const isProd = CFG.NODE_ENV === 'production';

  // ---------- CSS ----------
  const css = `
  :root{--tb-h:56px}
  .topbar{position:sticky;top:0;inset-inline:0;height:var(--tb-h);background:#fff;border-bottom:1px solid #eee;
          display:flex;align-items:center;justify-content:space-between;padding:0 10px;z-index:1000}
  .brand{font-weight:700;font-size:16px;color:var(--brand,#0f73ff);letter-spacing:.03em}
  .actions{display:flex;gap:8px}
  .icon-btn{appearance:none;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:10px;padding:8px;min-width:40px;
            display:inline-flex;align-items:center;justify-content:center}
  .icon-btn:active{transform:scale(.98)}
  .icon-btn svg{width:20px;height:20px;fill:#111}
  .menu{position:fixed;inset-inline-end:10px;top:calc(var(--tb-h) + 8px);background:#fff;border:1px solid #e5e7eb;border-radius:12px;
        box-shadow:0 12px 30px rgba(0,0,0,.08);padding:8px;width:min(320px,92vw);display:none;z-index:1001}
  .menu.show{display:block}
  .menu .item{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:10px;cursor:pointer}
  .menu .item:hover{background:#f8fafc}
  .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;align-items:center;justify-content:center;z-index:1002}
  .modal-bg.show{display:flex}
  .modal{width:min(520px,92vw);background:#fff;border-radius:16px;padding:16px}
  .row{display:flex;align-items:center;justify-content:space-between;padding:8px 0}
  .hint{color:#666;font-size:13px}
  .switch{position:relative;width:44px;height:26px;background:#e5e7eb;border-radius:999px;cursor:pointer}
  .switch::after{content:"";position:absolute;top:3px;inset-inline-start:3px;width:20px;height:20px;background:#fff;border-radius:50%;transition:.2s}
  .switch.on{background:#0f73ff}
  .switch.on::after{inset-inline-start:21px}
  `;
  const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);

  // ---------- SVG ----------
  const I = {
    history: '<svg viewBox="0 0 24 24"><path d="M13 3a9 9 0 1 1-6.36 2.64L4 7v6h6l-2.24-2.24A6 6 0 1 0 13 5v2h-2V3h2z"/></svg>',
    profile: '<svg viewBox="0 0 24 24"><path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z"/></svg>',
    settings:'<svg viewBox="0 0 24 24"><path d="M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm9 4a7.9 7.9 0 0 0-.14-1.5l2.09-1.63-2-3.46-2.54 1a8.08 8.08 0 0 0-2.61-1.52L13.5 2h-3L9.2 3.89a8.08 8.08 0 0 0-2.61 1.52l-2.54-1-2 3.46L4.14 10.5A7.9 7.9 0 0 0 4 12c0 .51.05 1 .14 1.5L2.05 15.1l2 3.46 2.54-1a8.08 8.08 0 0 0 2.61 1.52L10.5 22h3l1.3-1.89a8.08 8.08 0 0 0 2.61-1.52l2.54 1 2-3.46-2.09-1.63c.09-.5.14-.99.14-1.5z"/></svg>',
    more:    '<svg viewBox="0 0 24 24"><path d="M6 12a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0zm8 0a2 2 0 1 1-4 0 2 2 0 0 1 4 0z"/></svg>',
    star:    '<svg viewBox="0 0 24 24"><path d="M12 17.3 6 21l1.9-6.5L2 9.2l6.6-.5L12 2l3.4 6.7 6.6.5-5.9 5.3L18 21z"/></svg>',
    card:    '<svg viewBox="0 0 24 24"><path d="M2 6h20v12H2zM2 9h20"/></svg>',
    share:   '<svg viewBox="0 0 24 24"><path d="M18 8a3 3 0 1 0-2.83-2H9a3 3 0 1 0 0 6h6.17A3 3 0 1 0 18 8z"/></svg>',
    help:    '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 .001 20.001A10 10 0 0 0 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1 .45-1.75 1.17-2.47l1.24-1.26a1.99 1.99 0 1 0-3.41-1.41H8a4 4 0 1 1 7.07 2.39z"/></svg>',
    info:    '<svg viewBox="0 0 24 24"><path d="M11 7h2v2h-2zm0 4h2v6h-2z"/><circle cx="12" cy="12" r="10" fill="none" stroke="#111"/></svg>',
    logout:  '<svg viewBox="0 0 24 24"><path d="M16 17l5-5-5-5v3H9v4h7v3zM4 4h8V2H2v20h10v-2H4z"/></svg>'
  };

  // ---------- Header ----------
  const header = document.createElement('header');
  header.className = 'topbar';
  header.dir = 'rtl';
  header.innerHTML = `
    <div class="brand" aria-label="${APP_NAME}" data-i18n="brand">${APP_NAME}</div>
    <nav class="actions" aria-label="أوامر سريعة">
      <button id="tb-history" class="icon-btn" title="سجل الطلبات" aria-label="سجل الطلبات" data-i18n-title="menu_history">${I.history}</button>
      <button id="tb-profile" class="icon-btn" title="الملف الشخصي" aria-label="الملف الشخصي" data-i18n-title="menu_profile">${I.profile}</button>
      <button id="tb-settings" class="icon-btn" title="الإعدادات" aria-label="الإعدادات" data-i18n-title="menu_settings">${I.settings}</button>
      <button id="tb-more" class="icon-btn" title="المزيد" aria-label="المزيد" data-i18n-title="menu_more">${I.more}</button>
    </nav>
  `;
  document.body.prepend(header);

  // ---------- Overflow Menu ----------
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.dir = 'rtl';
  menu.innerHTML = `
    <div class="item" id="mi-saved">${I.star}<span>العناوين المحفوظة</span></div>
    <div class="item" id="mi-pay">${I.card}<span>طرق الدفع</span></div>
    <div class="item" id="mi-share">${I.share}<span>مشاركة رابط التتبّع</span></div>
    <div class="item" id="mi-help">${I.help}<span>مساعدة</span></div>
    <div class="item" id="mi-about">${I.info}<span>عن التطبيق</span></div>
    <div class="item" id="mi-lang">
      <span style="margin-inline-end:8px">🌐</span>
      <span data-i18n="menu_language">اللغة</span>
      <div style="margin-inline-start:auto;display:flex;gap:6px;align-items:center">
        <label><input type="radio" name="lang" value="ar"> <span data-i18n="lang_ar">العربية</span></label>
        <label><input type="radio" name="lang" value="en"> <span data-i18n="lang_en">English</span></label>
      </div>
    </div>
    <div class="item" id="mi-logout">${I.logout}<span data-i18n="menu_logout">تسجيل الخروج</span></div>
  `;
  document.body.appendChild(menu);

  // ---------- Settings Modal ----------
  const modalBg = document.createElement('div');
  modalBg.className = 'modal-bg';
  modalBg.innerHTML = `
    <div class="modal" dir="rtl">
      <h3 style="margin:0 0 6px">الإعدادات</h3>
      <p class="hint">هذه الإعدادات محفوظة محليًا على جهازك.</p>
      <div class="row"><span>الوضع الداكن</span><div id="sw-dark" class="switch"></div></div>
      <div class="row"><span>تكبير تلقائي للمسار</span><div id="sw-fit" class="switch"></div></div>
      <div class="row"><span>سلاسة تتبّع السائق</span><div id="sw-smooth" class="switch"></div></div>
      <div class="row"><span>إشعارات المتصفح</span><div id="sw-notif" class="switch"></div></div>
      <div class="hint">وحدات القياس: <select id="sel-unit"><option value="km">كيلومتر</option><option value="mi">Mile</option></select></div>
      <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end">
        <button id="btnCloseSet" class="icon-btn">إغلاق</button>
        <button id="btnSaveSet" class="icon-btn" style="background:#0f73ff;color:#fff;border-color:#0f73ff">حفظ</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalBg);

  // ---------- State ----------
  const S = JSON.parse(localStorage.getItem('appSettings')||'{}');
  function setSwitch(id, v){ const el=document.getElementById(id); if(v) el.classList.add('on'); else el.classList.remove('on'); }
  function getSwitch(id){ return document.getElementById(id).classList.contains('on'); }
  function applySettings(){
    document.documentElement.classList.toggle('dark', !!S.dark);
    window.appSettings = {
      autoFit: !!S.fit,
      smooth: !!S.smooth,
      unit: S.unit || 'km',
      notifications: !!S.notif
    };
  }
  // init defaults
  setSwitch('sw-dark',   !!S.dark);
  setSwitch('sw-fit',    S.fit!==false); // true by default
  setSwitch('sw-smooth', S.smooth!==false); // true by default
  setSwitch('sw-notif',  !!S.notif);
  document.getElementById('sel-unit').value = S.unit || 'km';
  applySettings();

  // ---------- Events ----------
  // toggles
  ['sw-dark','sw-fit','sw-smooth','sw-notif'].forEach(id=>{
    document.getElementById(id).addEventListener('click', e=> e.currentTarget.classList.toggle('on'));
  });

  document.getElementById('tb-history').onclick = ()=> location.href='/orders_history.html';
  document.getElementById('tb-profile').onclick = ()=> location.href='/profile.html';
  document.getElementById('tb-settings').onclick = ()=> modalBg.classList.add('show');
  document.getElementById('btnCloseSet').onclick = ()=> modalBg.classList.remove('show');
  document.getElementById('btnSaveSet').onclick = ()=>{
    S.dark   = getSwitch('sw-dark');
    S.fit    = getSwitch('sw-fit');
    S.smooth = getSwitch('sw-smooth');
    S.notif  = getSwitch('sw-notif');
    S.unit   = document.getElementById('sel-unit').value;
    localStorage.setItem('appSettings', JSON.stringify(S));
    applySettings();
    modalBg.classList.remove('show');
  };

  // overflow menu
  document.getElementById('tb-more').onclick = ()=>{
    menu.classList.toggle('show');
  };
  document.addEventListener('click', (e)=>{
    if(!menu.contains(e.target) && e.target.id!=='tb-more') menu.classList.remove('show');
  });

  // menu items
  document.getElementById('mi-saved').onclick = ()=> alert('العناوين المحفوظة: افتح نافذة لإدارة العناوين (إضافة/حذف).');
  document.getElementById('mi-pay').onclick   = ()=> alert('طرق الدفع: افتح نافذة لربط بطاقة/محفظة عبر Paymob (قريبًا).');
  document.getElementById('mi-share').onclick = ()=>{
    if(window.currentPublicTrackUrl){ navigator.clipboard.writeText(window.currentPublicTrackUrl); alert('تم نسخ رابط التتبّع'); }
    else{ alert('لا يوجد طلب نشط لمشاركته الآن.'); }
  };
  document.getElementById('mi-help').onclick  = ()=> alert('مساعدة: الأسئلة الشائعة/واتساب الدعم.');
  document.getElementById('mi-about').onclick = ()=> alert(`عن التطبيق: ${APP_NAME} v1.0.0`);
  document.getElementById('mi-logout').onclick= ()=>{
    localStorage.removeItem('authToken');
    location.href='/index.html';
  };

  // لو تبغى تُطبّق الوضع الداكن مباشرة عند الإقلاع
  if(S.dark) document.documentElement.classList.add('dark');

})();

// i18n init and bindings for topbar labels
if (window.i18n) {
  window.i18n.init();
  const radios = document.querySelectorAll('input[name="lang"]');
  if (radios.length) {
    const cur = window.i18n.get();
    radios.forEach(radio => {
      if (radio.value === cur) radio.checked = true;
      radio.onchange = () => {
        window.i18n.set(radio.value);
        location.reload();
      };
    });
  }
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = window.i18n.t(key);
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) {
      const translated = window.i18n.t(key);
      el.title = translated;
      el.setAttribute('aria-label', translated);
    }
  });
}
