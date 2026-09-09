// Progressive enhancement: without JS every example and platform remains readable.
function connectChoices(buttonSelector, panelSelector, buttonKey, panelKey) {
  const buttons = [...document.querySelectorAll(buttonSelector)];
  const panels = [...document.querySelectorAll(panelSelector)];
  if (!buttons.length || !panels.length) return;
  function select(button) {
    buttons.forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    panels.forEach(panel => { panel.hidden = panel.dataset[panelKey] !== button.dataset[buttonKey]; });
  }
  buttons.forEach(button => button.addEventListener('click', () => select(button)));
  select(buttons[0]);
}
connectChoices('[data-scene]', '[data-panel]', 'scene', 'panel');
connectChoices('[data-platform-choice]', '[data-install-panel]', 'platformChoice', 'installPanel');
