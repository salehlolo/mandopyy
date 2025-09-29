(function(){
  const KEY='appLang';
  if(localStorage.getItem(KEY)) { apply(localStorage.getItem(KEY)); return; }

  const css = `
  .lang-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:99999}
  .lang-card{width:min(420px,92vw);background:#fff;border-radius:16px;padding:18px;border:1px solid #E5E7EB;box-shadow:0 12px 32px rgba(0,0,0,.18);text-align:center}
  .lang-title{font-weight:800;font-size:18px;margin-bottom:8px;color:#0F73FF}
  .lang-sub{color:#6B7280;margin-bottom:12px}
  .lang-row{display:flex;gap:10px;justify-content:center}
  .lang-btn{flex:1;border:1px solid #E5E7EB;background:#fff;border-radius:12px;padding:12px 14px;font-size:16px;cursor:pointer}
  .lang-btn.primary{background:#0F73FF;border-color:#0F73FF;color:#fff}
  `;
  const s=document.createElement('style'); s.textContent=css; document.head.appendChild(s);

  const ov=document.createElement('div'); ov.className='lang-overlay';
  ov.innerHTML = `
    <div class="lang-card">
      <div class="lang-title">MANDUBO</div>
      <div class="lang-sub">اختر لغتك / Choose your language</div>
      <div class="lang-row">
        <button class="lang-btn primary" data-lang="ar">العربية</button>
        <button class="lang-btn" data-lang="en">English</button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  ov.addEventListener('click', (e)=>{
    const btn = e.target.closest('[data-lang]');
    if(!btn) return;
    const lang = btn.getAttribute('data-lang');
    localStorage.setItem(KEY, lang);
    apply(lang);
    ov.remove();
    location.reload();
  });

  function apply(lang){
    document.documentElement.lang = lang;
    document.documentElement.dir  = (lang==='en'?'ltr':'rtl');
  }
})();
