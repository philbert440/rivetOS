import { canonicalUrl, familySite, LEGACY_DOCS, REPO_URL } from './family.mjs';
import { familyBarHtml } from './chrome.mjs';
import { attr, escapeHtml } from './html.mjs';

const COPY_SCRIPT = `<script>
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
  (pre.closest('.term') || pre.parentElement).appendChild(button);
});
</script>`;

export function renderPage({ siteId, path, title, description, navId, body }) {
  const site = familySite(siteId);
  const url = canonicalUrl(site, path);
  const ogImage = `${site.origin}/social-preview.png`;
  const nav = site.localNav
    .map((item) => {
      const current = item.href === navId || (navId === '/' && item.href === '/');
      const href = item.href === '/' ? 'index.html' : item.href.replace(/^\//, '');
      return `<a href="${attr(href)}"${current ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`;
    })
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${attr(description)}">
  <meta name="theme-color" content="#f4f3eb">
  <link rel="canonical" href="${attr(url)}">
  <link rel="icon" type="image/png" href="favicon.png">
  <link rel="stylesheet" href="family.css">
  <link rel="stylesheet" href="family-site.css">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="${attr(site.title)}">
  <meta property="og:title" content="${attr(title)}">
  <meta property="og:description" content="${attr(description)}">
  <meta property="og:url" content="${attr(url)}">
  <meta property="og:image" content="${attr(ogImage)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${attr(title)}">
  <meta name="twitter:description" content="${attr(description)}">
  <meta name="twitter:image" content="${attr(ogImage)}">
  <script src="theme.js"></script>
</head>
<body class="family-site family-site-${attr(site.id)}">
<a class="skip-link" href="#main">Skip to content</a>
${familyBarHtml(site.id)}
<header class="site-header">
  <div class="wrap header-inner">
    <a class="wordmark" href="index.html"><img class="brand-mark" src="robot.png" width="28" height="32" alt="">${escapeHtml(site.title)}</a>
    <nav class="site-nav" aria-label="Section">${nav}</nav>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-inner">
    <p>${escapeHtml(site.description)}</p>
    <nav aria-label="Footer">
      <a href="${attr(familySite('io').origin)}/">${escapeHtml(familySite('io').label)}</a>
      <a href="${attr(familySite('org').origin)}/">${escapeHtml(familySite('org').label)}</a>
      <a href="${attr(familySite('dev').origin)}/">${escapeHtml(familySite('dev').label)}</a>
      <a href="${attr(LEGACY_DOCS.origin)}/">${escapeHtml(LEGACY_DOCS.label)}</a>
      <a href="${attr(REPO_URL)}">GitHub</a>
    </nav>
    <div class="theme-control" data-theme-control hidden>
      <label>Appearance
        <select aria-label="Site appearance" data-theme-select>
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </div>
  </div>
</footer>
${COPY_SCRIPT}
</body>
</html>
`;
}

export function renderSitemap(site, paths) {
  const urls = paths
    .map((path) => `  <url><loc>${escapeHtml(canonicalUrl(site, path))}</loc></url>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

export function renderRobots(site) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${site.origin}/sitemap.xml\n`;
}

export function commandBlock(command) {
  return `<div class="term"><pre tabindex="0" data-copy="${attr(command)}"><code><span class="ps">$ </span>${escapeHtml(command)}</code></pre></div>`;
}

export function sourceNote(label, href) {
  return `<p class="source">From <a href="${attr(href)}">${escapeHtml(label)}</a>.</p>`;
}

export function badge(kind, text) {
  return `<span class="badge badge-${attr(kind)}">${escapeHtml(text)}</span>`;
}
