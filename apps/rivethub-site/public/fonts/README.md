# Self-hosted fonts

`style.css` declares five `@font-face` rules pointing at files in this
directory. The site renders fine on the system-font fallback stack until
these land — drop them in and the brand typography takes over. No CDN is
used at runtime.

## Files to download

All from Google Fonts, **latin subset, woff2 format**, saved with exactly
these names:

| File                        | Family         | Weight | Style  |
|-----------------------------|----------------|--------|--------|
| `dm-sans-400.woff2`         | DM Sans        | 400    | normal |
| `dm-sans-500.woff2`         | DM Sans        | 500    | normal |
| `dm-sans-700.woff2`         | DM Sans        | 700    | normal |
| `jetbrains-mono-400.woff2`  | JetBrains Mono | 400    | normal |
| `jetbrains-mono-700.woff2`  | JetBrains Mono | 700    | normal |

## How to fetch them

Request the css2 API with a woff2-capable User-Agent, then download the
`latin` block's URL from each `@font-face` rule:

```sh
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
curl -fsSL -A "$UA" "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;700&display=swap"
```

Each weight block ends with `unicode-range` for `latin`; save that block's
`src:` woff2 under the matching name above. (The gstatic URLs contain
content hashes — do not rename the local files, the `@font-face` rules in
`style.css` reference the names in the table.)

Both families are OFL-licensed; redistribution of the woff2 files with the
site is permitted.
