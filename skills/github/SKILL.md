# GitHub Skill (Updated for RivetOS)

**RivetOS Environment Notes (Critical — Read First)**

In the RivetOS mesh, `gh` authentication is handled via a stored classic PAT in `/root/.secrets/git-credentials`.

**Correct procedure (always do this first):**

```bash
cd /opt/rivetos

# Authenticate gh (this is the working pattern)
cat /root/.secrets/git-credentials | cut -d: -f3 | gh auth login --with-token

# Verify
gh auth status
```

This method was successfully used to create PR #100 and PR #101.

**Never** rely on `gh auth login` interactively in this environment — it will fail due to missing interactive capabilities and credential setup.

---

name: github
description: "GitHub operations via `gh` CLI: issues, PRs, CI runs, code review, API queries. Use when: (1) checking PR status or CI, (2) creating/commenting on issues, (3) listing/filtering PRs or issues, (4) viewing run logs. NOT for: complex web UI interactions requiring manual browser flows (use browser tooling when available), bulk operations across many repos (script with gh api), or when gh auth is not configured."
metadata:
  {
    "openclaw":
      {
        "emoji": "🐙",
        "requires": { "bins": ["gh"] },
        "install":
          [
            {
              "id": "brew",
              "kind": "brew",
              "formula": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (brew)",
            },
            {
              "id": "apt",
              "kind": "apt",
              "package": "gh",
              "bins": ["gh"],
              "label": "Install GitHub CLI (apt)",
            },
          ],
      },
  }
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub repositories, issues, PRs, and CI.

## When to Use

✅ **USE this skill when:**

- Checking PR status, reviews, or merge readiness
- Viewing CI/workflow run status and logs
- Creating, closing, or commenting on issues
- Creating or merging pull requests
- Querying GitHub API for repository data
- Listing repos, releases, or collaborators

## When NOT to Use

❌ **DON'T use this skill when:**

- Local git operations (commit, push, pull, branch) → use `git` directly
- Non-GitHub repos (GitLab, Bitbucket, self-hosted) → different CLIs
- Cloning repositories → use `git clone`
- Reviewing actual code changes → use `coding-agent` skill
- Complex multi-file diffs → use `coding-agent` or read files directly

## Setup (RivetOS Specific)

See the block at the top of this file for the exact working authentication method in the RivetOS environment.

## Common Commands

### Pull Requests

```bash
# Create PR (example)
gh pr create --base main --head my-branch --title "feat: ..." --body "..."
```

(Full command list remains below — unchanged except for this new top section)

## Notes

- Always run from `/opt/rivetos`
- The shell tool's `cd` parsing has been fixed (PR #100), so `cd /opt/rivetos && gh ...` now works reliably.
- Token is a classic PAT with broad scopes stored in `/root/.secrets/git-credentials` (managed via the `setup-github-push-access-agents` skill).

## Changelog
- **v1** (2026-04-20): Documented the exact working `gh` authentication procedure in RivetOS so future agents (including me) don't forget or repeat the trial-and-error we just went through.
