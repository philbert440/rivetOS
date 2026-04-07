# @rivetos/tool-file

File read, write, and edit tools for agents

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Gives agents the ability to read, write, and surgically edit files on the host filesystem. Supports line-range reads, automatic directory creation, backups, and exact-match string replacement.

## Tools provided

- **`file_read`** — read file contents with optional line numbers and line-range filtering
- **`file_write`** — write content to a file, creating parent directories as needed, with optional `.bak` backup
- **`file_edit`** — replace an exact string match in a file (fails if the match is ambiguous or missing)

## Features

- **Line-range reads** — fetch specific sections of large files without loading everything
- **Line numbers** — optional line number display for easier reference
- **Auto-mkdir** — parent directories are created automatically on write
- **Backup on write** — optional `.bak` file creation before overwriting
- **Exact-match editing** — safe, predictable edits that fail loudly on ambiguity

## Installation

```bash
npm install @rivetos/tool-file
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
