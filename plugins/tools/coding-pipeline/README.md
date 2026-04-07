# @rivetos/tool-coding-pipeline

Autonomous coding pipeline — Grok builds, self-reviews, Opus validates, auto-commits

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Multi-agent coding pipeline that turns a spec into committed code. A builder agent (Grok) writes the code and self-reviews, then a validator agent (Opus) checks the result. If issues are found, the builder fixes and re-loops. On approval, the changes are committed and pushed.

## How it works

1. Opus delegates to Grok with a spec and requirements
2. Grok builds code, reads files, runs tests
3. Grok self-reviews against requirements
4. If issues → Grok fixes and re-loops (up to `maxBuildLoops`)
5. If clean → sends to Opus for validation
6. Opus approves or sends back with findings (up to `maxValidationLoops`)
7. On approval → commit and push

## Features

- **Multi-agent** — uses the sub-agent system for builder ↔ validator communication
- **Self-review loop** — builder catches its own mistakes before validation
- **Configurable agents** — choose which agents build and validate
- **Auto-commit** — optionally commit and push on approval
- **Loop limits** — configurable max iterations to prevent infinite loops

## Installation

```bash
npm install @rivetos/tool-coding-pipeline
```

## Tools provided

- `coding_pipeline` — run the full build → review → validate → commit pipeline

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
