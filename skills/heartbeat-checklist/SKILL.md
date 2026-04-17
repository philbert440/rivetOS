---
name: heartbeat-checklist
description: Default heartbeat behavior and checklist for proactive checks during heartbeats.
---
# HEARTBEAT Checklist

This skill defines the default behavior for heartbeat polls.

**Default Prompt:** Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.

**Current State:**
- No HEARTBEAT.md file in /opt/rivetos/workspace/
- Therefore, follow default: nothing needs attention.

**Proactive Checks Allowed (none active until HEARTBEAT.md created):**
- None. Do not check calendar, email, weather, memory maintenance, or projects unless explicitly listed in a HEARTBEAT.md file.

**To Activate Checks:**
Create HEARTBEAT.md with a short list like:
- Check gws for urgent emails
- Check calendar for next 24h
- Run weather for Laurel MD if daytime
- Compact memory if unsummarized > 300

Only do exactly what is written. Keep the file small.

Last updated: 2026-04-17
This skill created to document current default.