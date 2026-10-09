#!/usr/bin/env bash
# Kit contract: mesh handoff is list_agents + delegate_task. No curl path.
set -euo pipefail

KIT="$(cd "$(dirname "$0")/.." && pwd -P)"
SKILL="$KIT/skills/mesh-delegate/SKILL.md"
PLAN="$KIT/PLAN-EXPANSION.md"
PLUGIN="$KIT/plugin.json"
CURSOR_PLUGIN="$KIT/.cursor-plugin/plugin.json"
MARKET="$KIT/../../../.cursor-plugin/marketplace.json"
RULE="$KIT/rules/rivethub-member.md"

failed=0
pass() { echo "ok - $1"; }
fail() { echo "not ok - $1" >&2; failed=$((failed + 1)); }

has() {
  local file="$1"
  local needle="$2"
  grep -q -- "$needle" "$file"
}

if [ -f "$SKILL" ] && grep -q '^name: rivethub-mesh-delegate' "$SKILL"; then
  pass "skill present with frontmatter"
else
  fail "skill missing frontmatter name"
fi

if has "$SKILL" 'list_agents' && has "$SKILL" 'delegate_task'; then
  pass "skill names list_agents and delegate_task"
else
  fail "skill must name list_agents and delegate_task"
fi

if grep -qiE 'curl|https?://|/api/tasks' "$SKILL"; then
  fail "skill still documents a curl or raw HTTP path"
else
  pass "skill has no curl or raw HTTP recipe"
fi

if grep -qE '[0-9]{1,3}(\.[0-9]{1,3}){3}' "$SKILL"; then
  fail "skill must not embed IPv4 addresses"
else
  pass "skill has no IPv4 addresses"
fi

if has "$PLAN" 'list_agents' && has "$PLAN" 'delegate_task' && grep -qi 'parked' "$PLAN"; then
  pass "PLAN-EXPANSION names the MCP tools and parks step 3"
else
  fail "PLAN-EXPANSION must name the MCP tools and mark step 3 parked"
fi

if grep -q 'list_agents' "$PLUGIN" && grep -q 'delegate_task' "$PLUGIN" &&
   grep -q 'list_agents' "$CURSOR_PLUGIN" && grep -q 'delegate_task' "$CURSOR_PLUGIN"; then
  pass "plugin manifests name the MCP tools"
else
  fail "plugin manifests must name list_agents and delegate_task"
fi

if grep -q 'list_agents' "$MARKET" && grep -q 'delegate_task' "$MARKET"; then
  pass "marketplace entry names the MCP tools"
else
  fail "marketplace entry must name list_agents and delegate_task"
fi

if has "$RULE" 'list_agents' && has "$RULE" 'delegate_task'; then
  pass "member rule names the MCP tools"
else
  fail "member rule must name list_agents and delegate_task"
fi

if [ "$failed" -ne 0 ]; then
  echo "$failed mesh-delegate test(s) failed" >&2
  exit 1
fi
echo "mesh-delegate.test.sh: all ok"
