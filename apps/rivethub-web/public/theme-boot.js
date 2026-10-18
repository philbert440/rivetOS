// Pre-paint theme boot for index.html. A separate file, not an inline
// script: the desktop shell serves the bundle under a CSP of script-src
// 'self', which blocks inline scripts, so the boot never ran there and the
// first frame used whatever tokens the stylesheet defaults to.
// Pre-paint theme boot — mirrors src/lib/theme.ts (rivethub.theme =
// light | dark | system | omarchy; unset follows a saved Omarchy
// palette when there is one, else system) so the first frame already
// has the right token set; stores/theme.ts re-applies and tracks
// changes. Omarchy tokens arrive a frame later from the store.
;(function () {
  var pref = localStorage.getItem('rivethub.theme')
  if (pref !== 'light' && pref !== 'dark' && pref !== 'system' && pref !== 'omarchy') {
    pref = localStorage.getItem('rivethub.omarchy-theme') ? 'omarchy' : 'system'
  }
  var dark
  var themeColor
  if (pref === 'omarchy') {
    try {
      var snap = JSON.parse(localStorage.getItem('rivethub.omarchy-theme') || 'null')
      var colors = snap && snap.colors
      var mode = colors && colors.mode
      if (mode === 'light' || mode === 'dark') {
        dark = mode === 'dark'
      } else {
        dark = window.matchMedia('(prefers-color-scheme: dark)').matches
      }
      var bg = colors && colors.background
      if (typeof bg === 'string' && /^#[0-9a-f]{6}$/i.test(bg)) {
        themeColor = bg
      }
    } catch (e) {
      dark = window.matchMedia('(prefers-color-scheme: dark)').matches
    }
  } else {
    dark =
      pref === 'dark' ||
      (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  }
  // Explicit Light/Dark render the rounded Material style; System and
  // Omarchy keep classic (lib/theme.ts uiStyleFor).
  var material = pref === 'light' || pref === 'dark'
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  document.documentElement.dataset.style = material ? 'material' : 'classic'
  var canvas = material ? (dark ? '#0f1512' : '#e9f0eb') : dark ? '#0d1117' : '#f6f4ee'
  document
    .querySelector('meta[name="theme-color"]')
    .setAttribute('content', themeColor || canvas)
})()
