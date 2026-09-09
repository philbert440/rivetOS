(() => {
  const controls = document.querySelector('.theme-controls');
  const choice = document.querySelector('#theme-choice');
  const data = document.querySelector('#omarchy-palettes');
  if (!controls || !choice || !data) return;
  const themes = JSON.parse(data.textContent);
  let workspace = 'chat';
  let variant = 'expanded';
  const luminance = hex => {
    const rgb = hex.slice(1).match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  };
  const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
  const update = () => {
    const index = themes.findIndex(t => t.id === choice.value);
    const theme = themes[index];
    const c = theme.colors;
    document.querySelectorAll('[data-theme]').forEach(section => {
      section.hidden = section.dataset.theme !== theme.id;
      section.querySelectorAll('figure').forEach(figure => { figure.hidden = figure.dataset.workspace !== workspace || figure.dataset.variant !== variant; });
    });
    controls.querySelectorAll('[data-workspace-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.workspaceChoice === workspace)));
    controls.querySelectorAll('[data-variant-choice]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.variantChoice === variant)));
    document.querySelector('#variant-description').textContent = {expanded: 'Expanded: navigation and conversations open.', collapsed: 'Collapsed: both sidebars collapsed.'}[variant];
    document.querySelector('#theme-position').textContent = `${index + 1} / ${themes.length} · ${theme.name}`;
    if (!c) return;
    const valid = value => /^#[0-9a-f]{6}$/i.test(value || '');
    if (![c.background, c.foreground, c.accent].every(valid)) return;
    const accentText = contrast(c.accent, c.background) >= 4.5 ? c.accent : c.foreground;
    const onAccent = contrast(c.accent, '#000000') > contrast(c.accent, '#ffffff') ? '#000000' : '#ffffff';
    const vars = {'--bg':c.background, '--panel':c.background, '--panel-2':valid(c.selection)?c.selection:c.background, '--fg':c.foreground, '--accent':c.accent, '--accent-hi':accentText, '--on-accent':onAccent, '--link':accentText, '--term-bg':c.background, '--term-bar':c.background, '--term-fg':c.foreground, '--term-accent':accentText};
    Object.entries(vars).forEach(([key,value]) => document.documentElement.style.setProperty(key,value));
    ['background','red','yellow','green','cyan','blue','magenta','foreground'].forEach((key,i) => document.documentElement.style.setProperty(`--swatch-${i}`, valid(c[key]) ? c[key] : c.foreground));
    document.documentElement.style.colorScheme = c.mode === 'light' ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]').content = c.background;
  };
  const step = delta => { choice.selectedIndex = (choice.selectedIndex + delta + themes.length) % themes.length; update(); };
  choice.addEventListener('change', update);
  document.querySelector('#theme-prev').addEventListener('click', () => step(-1));
  document.querySelector('#theme-next').addEventListener('click', () => step(1));
  controls.querySelectorAll('[data-workspace-choice]').forEach(button => button.addEventListener('click', () => { workspace = button.dataset.workspaceChoice; update(); }));
  controls.querySelectorAll('[data-variant-choice]').forEach(button => button.addEventListener('click', () => { variant = button.dataset.variantChoice; update(); }));
  update();
  controls.hidden = false;
})();
