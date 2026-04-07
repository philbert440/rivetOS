# @rivetos/tool-interaction

User interaction tools — questions and task tracking

Part of [RivetOS](https://rivetos.dev) — the open-source agent runtime.

## What it does

Provides tools for agents to interact with users during a conversation. Agents can ask clarifying questions (free text, yes/no, or multiple choice) and manage a session-scoped task list for tracking multi-step plans.

## Tools provided

- **`ask_user`** — ask the user a question when clarification, confirmation, or a choice is needed
- **`todo`** — session-scoped task list with add, update, complete, remove, and list operations

## Features

- **Question types** — free text, yes/no, and multiple choice with optional default values
- **Context field** — explain why you're asking so the user has full context
- **Task tracking** — lightweight, session-scoped todo list for multi-step workflows
- **Status management** — tasks can be pending, in progress, or done

## Installation

```bash
npm install @rivetos/tool-interaction
```

## Documentation

See [rivetos.dev](https://rivetos.dev) for full documentation.

## License

MIT
