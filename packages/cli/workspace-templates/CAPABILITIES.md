# CAPABILITIES.md — Tools, Skills, Infrastructure

Quick reference for what this Rivet instance can do.

## Built-in Tools

The RivetOS runtime provides these tools by default:

- **shell** — execute shell commands with safety checks
- **file_read / file_write / file_edit** — file operations
- **search_glob / search_grep** — find files and content
- **web_search / web_fetch** — internet search and page fetch
- **memory_search / memory_browse / memory_stats** — query persistent memory
- **ask_user / todo** — interaction + task tracking
- **subagent_spawn / subagent_status / subagent_send / subagent_list / subagent_kill** — child sessions
- **delegate_task** — hand a task to another agent (local or mesh)
- **coding_pipeline** — build → review → validate loop
- **compact_context** — summarize conversation history
- **skill_list / skill_manage** — discover and manage skills

## Skills

Skills are reusable workflows and knowledge loaded on demand. See `skill_list` for what's currently available; they live under `skills/` in this workspace or in `/opt/rivetos/skills/`.

To use a skill, check its `SKILL.md` for instructions. Skills are matched to your tasks automatically by keyword.

## Infrastructure

_(fill in environment-specific details as they become relevant — what services are running, what databases exist, what network boundaries to respect)_

## MCP Servers

_(any Model Context Protocol servers configured — what tools they expose)_

## Channels

_(Discord, Telegram, voice, etc. — which ones are active for this instance)_

## Providers

_(which LLM providers are configured — see `config.yaml` → `providers:`)_
