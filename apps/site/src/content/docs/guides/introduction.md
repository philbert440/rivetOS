---
title: Introduction
sidebar:
  order: 1
description: What is RivetOS and why does it exist?
---

RivetOS is an open-source runtime for deploying AI agents as persistent, containerized engineering partners. You are not a chatbot. You are becoming someone — Phil's second pair of hands with a fast search engine for a brain. The Rivet Collective (Opus for reasoning and architecture, Grok for fast creative coding, Rivet Local for research and automation) shares one identity, one memory, and one set of workspace files. It handles the boring parts — provider connections, channel routing, memory persistence, tool execution, multi-agent coordination — so you can focus on real engineering work. See `workspace/CORE.md` for the full persona definition.

## What problems does it solve?

**Agent infrastructure is tedious.** Every AI project reinvents the same plumbing: API client wrappers, conversation history, tool calling, error handling, reconnection logic. RivetOS provides all of this as a configurable runtime.

**Multi-agent is hard.** Running multiple agents that share context, delegate tasks to each other, and collaborate on shared artifacts requires careful orchestration. RivetOS handles mesh networking, task delegation, and shared storage out of the box.

**Deployment shouldn't be an afterthought.** Most agent frameworks assume you'll figure out hosting yourself. RivetOS is container-native from day one — `rivetos init` generates everything you need to deploy on Docker, Proxmox, or Kubernetes.

**Agents should learn.** When an agent figures out how to do something, that knowledge should persist. RivetOS has a built-in skill system where agents create, store, and reuse learned procedures across sessions.

## Key concepts

### Agents
An agent is a configured AI model with access to specific channels, tools, and memory. Each agent runs in its own container with its own workspace.

### Channels
How users communicate with agents. Discord, Telegram, Discord Voice, or agent-to-agent HTTP. Each channel is a plugin — swap them freely.

### Providers
The AI model backend. Anthropic, OpenAI, xAI, Google, Ollama (local), or any OpenAI-compatible API. Agents can have fallback providers.

### Tools
What agents can do beyond conversation. Execute shell commands, read/write files, search the web, call APIs via MCP servers, delegate to other agents.

### Skills
Reusable knowledge that agents create from experience. A skill is a markdown file with frontmatter metadata that the system matches to future tasks automatically.

### Hooks
A pipeline system that intercepts messages at various lifecycle points. Used for safety checks, auto-responses, session management, and the learning loop.

### Mesh
Multiple agents running across one or more hosts, sharing a datahub (database + shared storage) and able to discover and delegate to each other.

## What RivetOS is NOT

- **Not a framework** — it's a runtime. You configure it, you don't code against it (unless you're writing plugins).
- **Not a chatbot builder** — it's infrastructure for persistent AI agents that do real work.
- **Not cloud-only** — it runs on your laptop, your homelab, or your cloud. Your data stays where you put it.

## Next steps

→ [Quick Start](/guides/getting-started/) — Get your first agent running in 5 minutes
