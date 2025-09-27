(function(){
  window.i18n = (function(){
    const DEF = 'ar';
    const storeKey = 'appLang';
    const dict = {
      ar: {
        brand: 'MANDUBO',
        menu_history: 'سجل الطلبات',
        menu_settings:'الإعدادات',
        menu_more: 'المزيد',
        menu_profile:'الملف الشخصي',
        menu_language:'اللغة',
        menu_logout:'تسجيل الخروج',
        lang_ar:'العربية', lang_en:'English',
        profile_title:'الملف الشخصي',
        save:'حفظ', cancel:'رجوع',
        pass_section:'تغيير كلمة المرور',
        current_password:'كلمة المرور الحالية',
        new_password:'كلمة مرور جديدة',
        confirm_password:'تأكيد كلمة المرور',
        change_password:'تغيير كلمة المرور',
        password_strength:'قوة كلمة المرور',
        forgot_password:'هل نسيت كلمة المرور؟',
        login:'تسجيل الدخول',
        create_password:'إنشاء كلمة المرور',
        request_route:'عرض المسار'
      },
      en: {
        brand: 'MANDUBO',
        menu_history: 'Orders History',
        menu_settings:'Settings',
        menu_more: 'More',
        menu_profile:'Profile',
        menu_language:'Language',
        menu_logout:'Logout',
        lang_ar:'Arabic', lang_en:'English',
        profile_title:'Profile',
        save:'Save', cancel:'Back',
        pass_section:'Change Password',
        current_password:'Current password',
        new_password:'New password',
        confirm_password:'Confirm password',
        change_password:'Change password',
        password_strength:'Password strength',
        forgot_password:'Forgot password?',
        login:'Login',
        create_password:'Create password',
        request_route:'Show Route'
      }
    };

    function get(){ return localStorage.getItem(storeKey) || DEF; }
    function set(lang){
      const L = (lang==='en' ? 'en' : 'ar');
      localStorage.setItem(storeKey, L);
      document.documentElement.lang = L;
      document.documentElement.dir  = (L==='en' ? 'ltr' : 'rtl');
      apply();
    }
    function t(key){ const L=get(); return (dict[L] && dict[L][key]) || key; }
    function apply(){
      document.querySelectorAll('[data-i18n]').forEach(el=>{
        const key = el.getAttribute('data-i18n');
        if(key) el.textContent = t(key);
      });
      document.querySelectorAll('[data-i18n-ph]').forEach(el=>{
        const key = el.getAttribute('data-i18n-ph');
        if(key) el.placeholder = t(key);
      });
    }
    function init(){
      const current = get();
      document.documentElement.lang = current;
      document.documentElement.dir = (current==='en' ? 'ltr' : 'rtl');
      apply();
    }
    return { t, set, get, init, apply };
  })();
})();
