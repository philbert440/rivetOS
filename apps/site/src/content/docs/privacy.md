---
title: Privacy
description: You run RivetOS on your own hardware. The runtime does not phone home. The marketing sites record anonymous pageviews.
sidebar:
  hidden: true
---

**The short version: you run RivetOS on your own hardware and choose your own models. The runtime does not phone home. The marketing sites record anonymous pageviews.**

## Marketing sites

rivetos.dev and [rivethub.io](https://rivethub.io/privacy.html) are static marketing and documentation sites. When a PostHog project key is configured at build time, they record pageviews — which page was opened, and when the visitor leaves — so we can see which docs and landing pages are useful. rivethub.io also records a small set of named install-CTA clicks (`cta_setup_agent`, `cta_install_local`, `cta_install_server`, `path_local`, `path_datahub`, `cta_cloud`) with the page path only. There is no RivetOS account, and we do not collect names, emails, form fields, or other account data on these sites. Anonymous visitors are not turned into marketing profiles. There is no session recording.

This is website analytics only. It is not RivetOS runtime telemetry, and it is not enabled in the Hub desktop or Android apps.

## The runtime does not phone home

RivetOS itself is software you install and run on your own infrastructure. There is no RivetOS account, no runtime telemetry, and no central server that sees your agents, conversations, or memory.

## Your data stays where you put it

Memory, conversation history, secrets, and config live on **your** machines: your containers, your database, your filesystem. We never see them, because there's no "we" in the loop.

## Models and providers are your choice

You decide which providers RivetOS talks to. Point it at a cloud provider (Anthropic, OpenAI, xAI, Google, …) and your prompts and data go to that provider under *their* privacy terms. Review them. Run fully local models on your own hardware and nothing leaves your network. Your privacy is determined by the models and providers you choose and how you configure them.

## Third parties

Any channels or tools you connect, such as web search or MCP servers, are governed by their own privacy policies. RivetOS is the plumbing; what you plug into it is up to you.

In short: the marketing sites may record anonymous pageviews. The runtime is built so you keep control of everything it sees.
