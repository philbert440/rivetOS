# @rivetos/tool-shell

Shell command execution with safety categorization

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Lets agents execute shell commands on the host system with built-in safety controls. Commands are automatically categorized as read-only, write, or dangerous, with configurable approval levels for each category.

## Tools provided

- **`shell`** — execute a shell command and return stdout/stderr

## Features

- **Command categorization** — automatic classification into read-only, write, and dangerous categories
- **Configurable approval** — per-category rules: allow, warn, or block
- **Background mode** — run long-running commands without blocking the agent
- **Git-aware safety** — warnings for destructive git operations
- **Working directory** — optional per-command working directory, with session persistence
- **Abort support** — commands can be cancelled via abort signal

## Safety

Commands are categorized automatically:

- **Read** — `ls`, `cat`, `git status`, `find`, etc. — safe by default
- **Write** — `mkdir`, `cp`, `git commit`, `npm install`, etc. — allowed with logging
- **Dangerous** — `rm -rf`, `chmod`, `sudo`, `curl | sh`, etc. — blocked or warned

## Installation

```bash
npm install @rivetos/tool-shell
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
