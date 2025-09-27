(function (global) {
  const getConfig = () => global.__APP_CONFIG__ || {};
  const state = {
    toastTimeout: null,
    loadingOverlay: null,
    activeModal: null
  };

  function ensureToastContainer() {
    let container = document.querySelector('[data-ui-toast-container]');
    if (!container) {
      container = document.createElement('div');
      container.setAttribute('data-ui-toast-container', '');
      container.className = 'fixed inset-x-0 top-5 z-[9998] flex justify-center pointer-events-none px-4';
      document.body.appendChild(container);
    }
    return container;
  }

  function hideToast() {
    const container = document.querySelector('[data-ui-toast-container]');
    if (!container) return;
    const toast = container.firstElementChild;
    if (!toast) return;
    toast.classList.add('opacity-0', '-translate-y-2');
    setTimeout(() => {
      if (toast.parentElement) {
        toast.parentElement.removeChild(toast);
      }
    }, 200);
  }

  function showToast(message, type = 'info', duration = 3000) {
    const container = ensureToastContainer();
    hideToast();
    const colorMap = {
      success: 'bg-emerald-500 text-white',
      error: 'bg-rose-500 text-white',
      warning: 'bg-amber-500 text-white',
      info: 'bg-slate-900 text-white'
    };
    const toast = document.createElement('div');
    toast.className = `pointer-events-auto px-4 py-2 rounded-full shadow-lg text-sm font-medium ${
      colorMap[type] || colorMap.info
    } transition transform duration-200`;
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.remove('opacity-0');
    });
    clearTimeout(state.toastTimeout);
    state.toastTimeout = setTimeout(() => hideToast(), duration);
  }

  function showLoadingOverlay(message = 'جارٍ التحميل...') {
    if (state.loadingOverlay) return state.loadingOverlay;
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0 z-[9997] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm';
    overlay.innerHTML = `
      <div class="flex flex-col items-center gap-3 bg-white rounded-2xl px-6 py-5 shadow-xl text-sm text-slate-700">
        <span class="animate-spin rounded-full border-3 border-slate-200 border-t-blue-500 h-10 w-10"></span>
        <p>${message}</p>
      </div>
    `;
    document.body.appendChild(overlay);
    state.loadingOverlay = overlay;
    return overlay;
  }

  function hideLoadingOverlay() {
    if (!state.loadingOverlay) return;
    state.loadingOverlay.classList.add('opacity-0');
    setTimeout(() => {
      if (state.loadingOverlay && state.loadingOverlay.parentElement) {
        state.loadingOverlay.parentElement.removeChild(state.loadingOverlay);
      }
      state.loadingOverlay = null;
    }, 200);
  }

  function setLoading(element, isLoading, loadingText = 'جاري المعالجة...') {
    if (!element) return;
    if (isLoading) {
      if (!element.dataset.originalHtml) {
        element.dataset.originalHtml = element.innerHTML;
      }
      element.disabled = true;
      element.classList.add('opacity-70', 'cursor-not-allowed');
      element.innerHTML = loadingText;
    } else {
      if (element.dataset.originalHtml) {
        element.innerHTML = element.dataset.originalHtml;
        delete element.dataset.originalHtml;
      }
      element.disabled = false;
      element.classList.remove('opacity-70', 'cursor-not-allowed');
    }
  }

  function setElementsDisabled(elements, disabled) {
    const list = Array.isArray(elements) ? elements : [elements];
    list.filter(Boolean).forEach((el) => {
      el.disabled = disabled;
      if (disabled) {
        el.classList.add('opacity-50', 'cursor-not-allowed');
      } else {
        el.classList.remove('opacity-50', 'cursor-not-allowed');
      }
    });
  }

  function closeModal() {
    if (!state.activeModal) return;
    state.activeModal.classList.add('opacity-0');
    setTimeout(() => {
      if (state.activeModal && state.activeModal.parentElement) {
        state.activeModal.parentElement.removeChild(state.activeModal);
      }
      state.activeModal = null;
    }, 200);
  }

  function showModal({
    title = 'تنبيه',
    message = '',
    confirmText = 'تأكيد',
    cancelText = 'إلغاء',
    onConfirm,
    onCancel
  }) {
    closeModal();
    const wrapper = document.createElement('div');
    wrapper.className = 'fixed inset-0 z-[9998] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm';
    wrapper.innerHTML = `
      <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 space-y-4 animate-in fade-in">
        <div class="space-y-2">
          <h3 class="text-lg font-semibold text-slate-800">${title}</h3>
          <p class="text-sm text-slate-600 leading-6">${message}</p>
        </div>
        <div class="flex items-center justify-end gap-2">
          <button type="button" class="px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700" data-modal-cancel>${cancelText}</button>
          <button type="button" class="px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700" data-modal-confirm>${confirmText}</button>
        </div>
      </div>
    `;
    wrapper.addEventListener('click', (event) => {
      if (event.target === wrapper) {
        if (typeof onCancel === 'function') onCancel();
        closeModal();
      }
    });
    wrapper.querySelector('[data-modal-cancel]').addEventListener('click', () => {
      if (typeof onCancel === 'function') onCancel();
      closeModal();
    });
    wrapper.querySelector('[data-modal-confirm]').addEventListener('click', () => {
      if (typeof onConfirm === 'function') onConfirm();
      closeModal();
    });
    document.body.appendChild(wrapper);
    state.activeModal = wrapper;
  }

  function attachDevMenu() {
    const { NODE_ENV } = getConfig();
    if ((NODE_ENV || 'development') === 'production') {
      return;
    }
    if (document.querySelector('[data-dev-menu]')) {
      return;
    }
    const menu = document.createElement('div');
    menu.setAttribute('data-dev-menu', '');
    menu.className = 'fixed bottom-5 right-5 z-[9999] flex flex-wrap items-center gap-2 rounded-2xl bg-slate-900/90 text-white text-sm px-4 py-3 shadow-lg backdrop-blur';
    menu.innerHTML = `
      <span class="font-semibold text-xs uppercase tracking-widest text-blue-200">DEV</span>
      <a class="text-blue-200 hover:text-white transition" href="/index.html">Home</a>
      <span class="opacity-50">|</span>
      <a class="text-blue-200 hover:text-white transition" href="/delivery_app.html">Customer</a>
      <span class="opacity-50">|</span>
      <a class="text-blue-200 hover:text-white transition" href="/driver_app.html">Driver</a>
      <span class="opacity-50">|</span>
      <a class="text-blue-200 hover:text-white transition" href="/admin_panel.html">Admin</a>
      <button type="button" data-dev-mock class="px-2 py-1 rounded-lg bg-emerald-500/90 hover:bg-emerald-500 text-white text-xs">Mock Login</button>
      <button type="button" data-dev-logout class="px-2 py-1 rounded-lg bg-rose-500/90 hover:bg-rose-500 text-white text-xs">Logout</button>
    `;
    menu.querySelector('[data-dev-mock]').addEventListener('click', () => {
      localStorage.setItem('authToken', 'dev-token');
      showToast('تم تعيين توكن تجريبي.', 'success');
    });
    menu.querySelector('[data-dev-logout]').addEventListener('click', () => {
      localStorage.removeItem('authToken');
      showToast('تم حذف التوكن المخزن.', 'info');
    });
    document.body.appendChild(menu);
  }

  function setFormLoading(form, isLoading) {
    if (!form) return;
    const controls = form.querySelectorAll('button, input, select, textarea');
    controls.forEach((control) => {
      control.disabled = isLoading;
      control.classList.toggle('opacity-50', isLoading);
      control.classList.toggle('cursor-not-allowed', isLoading);
    });
  }

  global.UI = {
    showToast,
    hideToast,
    showLoadingOverlay,
    hideLoadingOverlay,
    setLoading,
    setElementsDisabled,
    showModal,
    closeModal,
    attachDevMenu,
    setFormLoading
  };

  document.addEventListener('DOMContentLoaded', () => {
    attachDevMenu();
  });
})(window);
