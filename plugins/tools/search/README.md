# @rivetos/tool-search

File search tools — glob pattern matching and content grep

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Gives agents the ability to search for files by name pattern (glob) and search file contents by regex or string pattern (grep). Essential for navigating codebases, finding configuration, and locating specific content.

## Tools provided

- **`search_glob`** — find files matching a glob pattern (e.g. `**/*.ts`, `src/**/*.test.ts`)
- **`search_grep`** — search file contents by regex or literal string, returning matching lines with file paths and line numbers

## Features

- **Glob patterns** — standard glob syntax with recursive `**` support
- **Regex search** — full regex support for content search
- **Fixed string mode** — literal string matching when regex isn't needed
- **Case-insensitive option** — toggle case sensitivity
- **File filtering** — limit grep to specific file patterns (e.g. `*.ts`)
- **Scoped search** — search from a specific directory or file

## Installation

```bash
npm install @rivetos/tool-search
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
