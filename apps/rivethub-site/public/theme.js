/* Loaded only by the main site; Omarchy keeps its own theme controls. */
(() => {
  const key = 'rivethub.site.appearance';
  const system = matchMedia('(prefers-color-scheme: dark)');
  let preference = 'system';
  try { const saved = localStorage.getItem(key); if (['light', 'dark'].includes(saved)) preference = saved; } catch {}
  function apply() {
    const theme = preference === 'system' ? (system.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#14211b' : '#f7f6f0');
  }
  apply();
  system.addEventListener('change', apply);
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-theme-control]').forEach(control => { control.hidden = false; });
    document.querySelectorAll('[data-theme-select]').forEach(select => {
      select.value = preference;
      select.addEventListener('change', () => {
        preference = select.value;
        try { localStorage.setItem(key, preference); } catch {}
        apply();
      });
    });
  });
})();
