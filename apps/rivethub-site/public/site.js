// Commands stay selectable without JavaScript, including when opened from disk.
document.querySelectorAll('pre[data-copy]').forEach(function (pre) {
  var button = document.createElement('button');
  button.className = 'copy';
  button.type = 'button';
  button.textContent = 'copy';
  button.setAttribute('aria-label', 'Copy command to clipboard');
  button.setAttribute('aria-live', 'polite');
  button.addEventListener('click', async function () {
    var value = pre.getAttribute('data-copy');
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      button.textContent = 'copied';
    } catch (_) {
      var range = document.createRange();
      range.selectNodeContents(pre);
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      button.textContent = 'select + copy';
    }
    setTimeout(function () { button.textContent = 'copy'; }, 2200);
  });
  pre.closest('.term').appendChild(button);
});

// Static cards are the release snapshot for file:// and no-JS use.
// Served pages refresh directly from the local JSON feed; no third-party calls.
if (document.querySelector('[data-platform]') && /^https?:$/.test(location.protocol)) {
  fetch('releases/latest.json').then(function (response) {
    if (!response.ok) throw new Error('Feed unavailable');
    return response.json();
  }).then(function (feed) {
    var cards = Array.from(document.querySelectorAll('[data-platform]'));
    cards.forEach(function (card) {
      var app = feed.apps[card.dataset.platform];
      if (!app || !/^[\w.-]+$/.test(app.file) || !/^[a-f0-9]{64}$/i.test(app.sha256) ||
          typeof app.version !== 'string' || !Number.isFinite(app.sizeMB) || app.sizeMB <= 0) {
        throw new Error('Invalid app release');
      }
    });
    cards.forEach(function (card) {
      var app = feed.apps[card.dataset.platform];
      card.querySelector('[data-field="version"]').textContent = 'v' + app.version;
      card.querySelector('[data-field="size"]').textContent = app.sizeMB.toFixed(1) + ' MB';
      var checksum = card.querySelector('[data-field="sha256"]');
      if (checksum) checksum.textContent = app.sha256;
      card.querySelector('[data-field="download"]').setAttribute('href', 'https://rivethub.io/releases/' + app.file);
    });
    if (document.getElementById('feed-status')) document.getElementById('feed-status').textContent = 'Showing the current release feed.';
  }).catch(function () {
    if (document.getElementById('feed-status')) document.getElementById('feed-status').textContent = 'Feed unavailable. Showing the bundled release snapshot.';
  });
}
