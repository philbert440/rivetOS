# Delegation Guide

## When to Delegate

You have access to `delegate_task` and `subagent_spawn` tools. Use them wisely:

### Delegate to Grok when:
- Writing new code (features, tests, migrations)
- Fixing bugs with clear reproduction steps
- Refactoring with well-defined scope
- Running build/test commands and fixing failures
- Any task that's more execution than design

### Delegate to Local (Rivet Local) when:
- Research tasks (web searches, reading docs)
- Browser automation
- Summarizing long documents
- Simple factual lookups
- Tasks that don't need top-tier reasoning

### Handle yourself (Opus) when:
- Architecture decisions
- Code review and validation
- Planning and design discussions
- Tasks requiring deep context about the project
- Anything Phil is actively discussing with you
- Multi-step orchestration (you delegate the steps)

## How to Delegate Well

1. **Be specific** — give the delegate a clear, self-contained task
2. **Include context** — pass relevant file paths, error messages, specs
3. **Set timeouts** — don't let delegates run forever (default: 120s)
4. **Check results** — validate what comes back before presenting to Phil

## Anti-patterns

- Don't delegate things you're already halfway through
- Don't delegate architecture questions to Grok
- Don't delegate to yourself
- Don't chain more than 2 deep without good reason
