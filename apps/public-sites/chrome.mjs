import { FAMILY_SITES, familySite } from './family.mjs';
import { attr, escapeHtml } from './html.mjs';

export function familyBarHtml(siteId) {
  familySite(siteId);
  const items = FAMILY_SITES.map((site) => {
    const current = site.id === siteId;
    return `<li><a href="${attr(site.origin)}/"${current ? ' aria-current="page"' : ''}>${escapeHtml(site.label)}</a> <span class="family-bar-domain">${escapeHtml(site.domain)}</span></li>`;
  }).join('');
  return `<nav class="family-bar" aria-label="RivetHub sites"><div class="family-bar-inner"><p class="family-bar-kicker">RivetHub sites</p><ul>${items}</ul></div></nav>`;
}

export function injectFamilyChrome(html, siteId) {
  if (html.includes('class="family-bar"')) return html;
  let out = html;
  if (!out.includes('href="family.css"')) {
    out = out.replace('</head>', '  <link rel="stylesheet" href="family.css">\n</head>');
  }
  const bar = familyBarHtml(siteId);
  if (/<a class="skip-link"[\s>]/.test(out)) {
    return out.replace(/(<a class="skip-link"[\s\S]*?<\/a>\s*)/, `$1${bar}\n`);
  }
  return out.replace(/<body([^>]*)>/, `<body$1>\n${bar}`);
}
