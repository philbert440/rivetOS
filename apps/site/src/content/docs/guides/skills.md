---
title: Skills
sidebar:
  order: 5
description: How agents learn, store, and reuse knowledge
---


Skills are reusable knowledge, workflows, and procedures that agents can discover and use. Unlike plugins (which are code), skills are **markdown documents** — anyone can write one without programming.

---

## What is a Skill?

A skill is a directory containing a `SKILL.md` file:

```
skills/
├── weather/
│   └── SKILL.md
├── github/
│   ├── SKILL.md
│   └── references/
│       └── api.md
└── 1password/
    └── SKILL.md
```

The agent discovers skills automatically, matches them to user messages by keyword, and loads the relevant ones into context when needed.

---

## Writing a Skill

### Basic Structure

```markdown
---
name: weather
description: Check current weather and forecasts for any location
triggers: weather, forecast, temperature, rain, snow, wind
version: 1
category: utilities
tags: api, location
---

# Weather Skill

Check weather conditions using the wttr.in API.

## Usage

To check the weather for a location:

\```bash
curl "wttr.in/New+York?format=j1"
\```

## Formatting

Present weather data as:
- Current temperature (°F)
- Conditions (sunny, cloudy, rain, etc.)
- Wind speed and direction
- Forecast for next 3 days

## Notes

- Use `web_fetch` tool with wttr.in for no-API-key weather
- Default to the user's location if known
- Use °F for US users, °C for everyone else
```

### Frontmatter Fields

The YAML frontmatter between `---` delimiters is parsed automatically:

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Skill identifier (lowercase, hyphens). Used in `skill_manage` and `skill_list`. |
| `description` | Yes | One-line description. Shown in skill listings. |
| `triggers` | Yes | Comma-separated keywords for matching user messages. |
| `version` | No | Integer version number. Incremented on edits. |
| `category` | No | Grouping category (e.g., `utilities`, `development`, `api`). |
| `tags` | No | Comma-separated tags for additional categorization. |

### No Frontmatter? No Problem.

If you skip the `---` delimiters, the skill system falls back to:
- **Name** → first markdown heading
- **Description** → first paragraph after the heading
- **Triggers** → extracted from the description text (keywords with stop words removed)

---

## How Skills Are Discovered

On boot, the skill manager scans every directory listed in `runtime.skill_dirs` (defaults to `~/.rivetos/workspace/skills/` if unset). For each subdirectory containing a `SKILL.md`, it parses the frontmatter and registers the skill.

### Configuration

```yaml
runtime:
  skill_dirs:
    - ~/.rivetos/workspace/skills   # User-global skills (default if unset)
    - /rivet-shared/skills          # Team-shared skills (optional)
```

### Discovery Flow

```
Boot
 └── SkillManager.discover(skill_dirs)
      ├── Scan each directory for subdirectories with SKILL.md
      ├── Parse frontmatter (name, description, triggers)
      └── Register in memory
```

---

## How Skills Are Matched

When a user sends a message, the skill system scores each skill against the message content:

1. **Tokenize** the user message into keywords
2. **Compare** against each skill's triggers
3. **Score** based on overlap (number of matching triggers ÷ total triggers)
4. **Load** the top-scoring skill(s) into the agent's context

This happens automatically via the `skill:before` hook. The agent sees the skill content as additional context in its prompt.

---

## Agent Tools for Skills

Agents have two built-in tools for managing skills:

### `skill_list`

Lists all discovered skills with their names, descriptions, and trigger counts.

### `skill_manage`

Full CRUD for skills:

| Action | Description |
|--------|-------------|
| `create` | Create a new skill directory with SKILL.md |
| `edit` | Replace the full SKILL.md content |
| `patch` | Apply FIND/REPLACE blocks to SKILL.md |
| `delete` | Remove a skill directory |
| `retire` | Mark a skill as retired (hidden from matching) |
| `read` | Read SKILL.md content (level 1) or include reference files (level 2) |
| `write_file` | Write a reference file into the skill directory |

### Example: Agent Creates a Skill

```
User: "Remember how to deploy to production — the process we just figured out."

Agent uses skill_manage:
  action: create
  name: production-deploy
  description: Production deployment process for the web app
  content: |
    ---
    name: production-deploy
    description: Step-by-step production deployment process
    triggers: deploy, production, release, ship
    ---
    
    # Production Deploy
    
    1. Run tests: `npm test`
    2. Build: `npm run build`
    3. Tag: `git tag v$(date +%Y%m%d)`
    4. Push: `git push --tags`
    5. Deploy: `docker compose -f compose.prod.yml up -d`
    6. Verify: `curl https://app.example.com/health`
```

---

## Reference Files

Skills can include additional files beyond `SKILL.md`:

```
skills/github/
├── SKILL.md              # Main skill document
└── references/
    ├── api.md            # GitHub API reference
    └── workflows.md      # Common workflow patterns
```

Reference files are loaded when the agent reads the skill at level 2 (`skill_manage` with `level: 2`).

To write a reference file from the agent:

```
Agent uses skill_manage:
  action: write_file
  name: github
  file_path: references/api.md
  file_content: |
    # GitHub API Quick Reference
    ...
```

---

## Skill Lifecycle

### Creating Skills

Skills can be created by:
- **You** — manually create directories with `SKILL.md` files
- **The agent** — via `skill_manage create` during conversation
- **The learning loop** — the review loop can extract patterns into skills automatically

### Versioning

The `version` field in frontmatter is an integer. The `skill_manage edit` and `patch` actions automatically increment it and append a changelog entry:

```markdown
## Changelog

- v3 (2026-04-05): Updated deployment steps for new CI pipeline
- v2 (2026-04-01): Added rollback procedure
- v1 (2026-03-28): Initial version
```

### Deduplication

When creating a skill, the system checks for existing skills with similar names. If a match is found, it suggests editing the existing skill instead. Use `force: true` to bypass this check.

### Security

Skill content is validated before loading:
- No executable code blocks in dangerous languages (unless explicitly allowed)
- No references to paths outside the workspace
- Size limits enforced

---

## Built-In Skills

RivetOS ships with several skills out of the box:

| Skill | Description |
|-------|-------------|
| `1password` | 1Password CLI integration |
| `discord` | Discord bot management |
| `excalidraw` | Diagram creation |
| `gh-issues` | GitHub Issues workflow |
| `github` | GitHub repository operations |
| `gog` | Google Workspace (Docs, Sheets, Calendar) |
| `healthcheck` | System health monitoring |
| `nemotron` | Local embedding model usage |
| `skill-creator` | Meta-skill for creating new skills |
| `stealth-browser` | Headless browser automation |
| `tmux` | Terminal multiplexer management |
| `weather` | Weather lookup |
| `coding-pipeline` | Multi-agent code build/review loop |

---

## Best Practices

1. **Be specific with triggers.** `deploy, production, release` is better than `code, stuff, things`.
2. **Write for the agent, not for humans.** The skill is context the agent reads — include exact commands, API formats, and decision rules.
3. **One concern per skill.** A skill for "GitHub" and a separate skill for "deployment" is better than one mega-skill.
4. **Include examples.** Show the agent exactly what the output should look like.
5. **Update, don't duplicate.** Use `skill_manage edit` to improve existing skills rather than creating overlapping ones.
6. **Use reference files for large content.** Keep SKILL.md focused. Put API docs, long references, and templates in `references/`.
