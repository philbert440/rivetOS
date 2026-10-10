mod common;

use common::{agent_body, assert_has_error, runtime_body, with_base};

macro_rules! err {
    ($name:ident, $yaml:expr, $message:expr) => {
        #[test]
        fn $name() {
            let yaml = $yaml;
            assert_has_error(&yaml, $message);
        }
    };
}

err!(
    root_null,
    "null\n".to_string(),
    "Config must be a YAML object (got object)"
);
err!(
    root_array,
    "[]\n".to_string(),
    "Config must be a YAML object (got object)"
);
err!(
    root_string,
    "hello\n".to_string(),
    "Config must be a YAML object (got string)"
);
err!(
    root_number,
    "1\n".to_string(),
    "Config must be a YAML object (got number)"
);
err!(
    root_bool,
    "true\n".to_string(),
    "Config must be a YAML object (got boolean)"
);

err!(
    missing_runtime,
    "agents:\n  main:\n    provider: anthropic\nproviders:\n  anthropic:\n    model: claude-opus\n"
        .to_string(),
    "Missing required section \"runtime\""
);
err!(
    runtime_not_object,
    "runtime: []\nagents:\n  main:\n    provider: anthropic\nproviders:\n  anthropic:\n    model: claude-opus\n".to_string(),
    "\"runtime\" must be an object"
);
err!(
    missing_agents,
    "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nproviders:\n  anthropic:\n    model: claude-opus\n".to_string(),
    "Missing required section \"agents\" — define at least one agent"
);
err!(
    agents_not_object,
    "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nagents: []\nproviders:\n  anthropic:\n    model: claude-opus\n".to_string(),
    "\"agents\" must be an object mapping agent names to their config"
);
err!(
    missing_providers,
    "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nagents:\n  main:\n    provider: anthropic\n".to_string(),
    "Missing required section \"providers\" — define at least one provider"
);
err!(
    providers_not_object,
    "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nagents:\n  main:\n    provider: anthropic\nproviders: []\n".to_string(),
    "\"providers\" must be an object mapping provider names to their config"
);
err!(
    channels_not_object,
    with_base("channels: []\n"),
    "\"channels\" must be an object"
);
err!(
    memory_not_object,
    with_base("memory: []\n"),
    "\"memory\" must be an object"
);
err!(
    transports_not_object,
    with_base("transports: []\n"),
    "\"transports\" must be an object mapping transport names to their config"
);
err!(
    deployment_not_object,
    with_base("deployment: []\n"),
    "\"deployment\" must be an object"
);
err!(
    mesh_not_object,
    with_base("mesh: []\n"),
    "\"mesh\" must be an object"
);
err!(
    den_not_object,
    with_base("den: []\n"),
    "\"den\" must be an object"
);
err!(
    tasks_not_object,
    with_base("tasks: []\n"),
    "\"tasks\" must be an object"
);
err!(
    workflows_not_object,
    with_base("workflows: []\n"),
    "\"workflows\" must be an object"
);
err!(
    plugins_not_array,
    with_base("plugins: {}\n"),
    "\"plugins\" must be an array of npm package names"
);
err!(
    plugins_empty_entry,
    with_base("plugins: [\"\"]\n"),
    "Each plugins entry must be a non-empty package name string"
);
err!(
    plugins_duplicate,
    with_base("plugins:\n  - pkg\n  - pkg\n"),
    "Duplicate plugin entry \"pkg\""
);
err!(
    channel_not_object,
    with_base("channels:\n  agent: []\n"),
    "Channel \"agent\" must be an object"
);

err!(
    cross_provider,
    "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nagents:\n  main:\n    provider: missing\nproviders:\n  anthropic:\n    model: claude-opus\n".to_string(),
    "Provider \"missing\" referenced by agent \"main\" is not defined in [providers]. Available: anthropic"
);
err!(
    cross_default_agent,
    "runtime:\n  workspace: /tmp/ws\n  default_agent: other\nagents:\n  main:\n    provider: anthropic\nproviders:\n  anthropic:\n    model: claude-opus\n".to_string(),
    "Default agent \"other\" is not defined in [agents]. Available: main"
);
err!(
    cross_heartbeat_agent,
    runtime_body(
        "  workspace: /tmp/ws\n  default_agent: main\n  heartbeats:\n    - agent: ghost\n      schedule: 1h\n      prompt: hi\n"
    ),
    "Heartbeat agent \"ghost\" is not defined in [agents]. Available: main"
);

err!(
    runtime_fallbacks_removed,
    runtime_body("  workspace: /tmp/ws\n  default_agent: main\n  fallbacks: {}\n"),
    "Provider fallback was removed in the AI SDK migration. Remove \"runtime.fallbacks\" from your config."
);
err!(
    runtime_coding_pipeline_removed,
    runtime_body("  workspace: /tmp/ws\n  default_agent: main\n  coding_pipeline: {}\n"),
    "The coding-pipeline plugin was removed. Remove \"runtime.coding_pipeline\"; use delegate_task (and the upcoming task engine) instead."
);
err!(
    workspace_missing,
    runtime_body("  default_agent: main\n"),
    "Missing required field \"runtime.workspace\""
);
err!(
    workspace_not_string,
    runtime_body("  workspace: 1\n  default_agent: main\n"),
    "\"runtime.workspace\" must be a string path"
);
err!(
    default_agent_missing,
    runtime_body("  workspace: /tmp/ws\n"),
    "Missing required field \"runtime.default_agent\""
);
err!(
    default_agent_not_string,
    runtime_body("  workspace: /tmp/ws\n  default_agent: 1\n"),
    "\"runtime.default_agent\" must be a string"
);
err!(
    turn_timeout,
    runtime_body("  workspace: /tmp/ws\n  default_agent: main\n  turn_timeout: 0\n"),
    "\"runtime.turn_timeout\" must be a positive number (seconds)"
);
err!(
    experimental_not_bool,
    runtime_body("  workspace: /tmp/ws\n  default_agent: main\n  experimental: nope\n"),
    "\"runtime.experimental\" must be a boolean"
);
err!(
    skill_dirs_not_array,
    runtime_body("  workspace: /tmp/ws\n  default_agent: main\n  skill_dirs: nope\n"),
    "\"runtime.skill_dirs\" must be an array of paths"
);
err!(
    skill_dirs_entry,
    runtime_body("  workspace: /tmp/ws\n  default_agent: main\n  skill_dirs: [1]\n"),
    "Each skill_dirs entry must be a string path"
);
err!(
    heartbeats_not_array,
    runtime_body("  workspace: /tmp/ws\n  default_agent: main\n  heartbeats: nope\n"),
    "\"runtime.heartbeats\" must be an array"
);
err!(
    heartbeat_not_object,
    runtime_body("  workspace: /tmp/ws\n  default_agent: main\n  heartbeats: [1]\n"),
    "Each heartbeat entry must be an object"
);
err!(
    heartbeat_agent,
    runtime_body(
        "  workspace: /tmp/ws\n  default_agent: main\n  heartbeats:\n    - schedule: 1h\n      prompt: hi\n"
    ),
    "Heartbeat requires a string \"agent\" field"
);
err!(
    heartbeat_schedule,
    runtime_body(
        "  workspace: /tmp/ws\n  default_agent: main\n  heartbeats:\n    - agent: main\n      prompt: hi\n"
    ),
    "Heartbeat requires a \"schedule\" field (e.g., \"30m\", \"1h\")"
);
err!(
    heartbeat_prompt,
    runtime_body(
        "  workspace: /tmp/ws\n  default_agent: main\n  heartbeats:\n    - agent: main\n      schedule: 1h\n"
    ),
    "Heartbeat requires a string \"prompt\" field"
);
err!(
    quiet_hours_not_object,
    runtime_body(
        "  workspace: /tmp/ws\n  default_agent: main\n  heartbeats:\n    - agent: main\n      schedule: 1h\n      prompt: hi\n      quiet_hours: null\n"
    ),
    "\"quiet_hours\" must be an object with \"start\" and \"end\" (0-23)"
);
err!(
    quiet_hours_start,
    runtime_body(
        "  workspace: /tmp/ws\n  default_agent: main\n  heartbeats:\n    - agent: main\n      schedule: 1h\n      prompt: hi\n      quiet_hours:\n        start: 24\n        end: 0\n"
    ),
    "\"quiet_hours.start\" must be a number 0-23"
);
err!(
    quiet_hours_end,
    runtime_body(
        "  workspace: /tmp/ws\n  default_agent: main\n  heartbeats:\n    - agent: main\n      schedule: 1h\n      prompt: hi\n      quiet_hours:\n        start: 0\n        end: -1\n"
    ),
    "\"quiet_hours.end\" must be a number 0-23"
);

err!(
    agents_empty,
    "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nagents: {}\nproviders:\n  anthropic:\n    model: claude-opus\n".to_string(),
    "\"agents\" is empty — define at least one agent"
);
err!(
    agent_not_object,
    "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nagents:\n  main: 1\nproviders:\n  anthropic:\n    model: claude-opus\n".to_string(),
    "Agent \"main\" must be an object"
);
err!(
    agent_fallbacks_removed,
    agent_body("    provider: anthropic\n    fallbacks: []\n"),
    "Per-agent fallback chains were removed in the AI SDK migration. Remove \"fallbacks\" from this agent."
);
err!(
    agent_provider_missing,
    agent_body("    model: claude\n"),
    "Agent \"main\" is missing required field \"provider\""
);
err!(
    agent_provider_not_string,
    agent_body("    provider: 1\n"),
    "Agent \"main\" provider must be a string"
);
err!(
    default_thinking,
    agent_body("    provider: anthropic\n    default_thinking: nope\n"),
    "Agent \"main\" default_thinking must be one of: off, low, medium, high, xhigh (got \"nope\")"
);
err!(
    tools_not_object,
    agent_body("    provider: anthropic\n    tools: nope\n"),
    "Agent \"main\" tools must be an object with optional \"exclude\" and/or \"include\" arrays"
);
err!(
    tools_exclude_not_array,
    agent_body("    provider: anthropic\n    tools:\n      exclude: nope\n"),
    "Agent \"main\" tools.exclude must be an array of tool names"
);
err!(
    tools_include_not_array,
    agent_body("    provider: anthropic\n    tools:\n      include: nope\n"),
    "Agent \"main\" tools.include must be an array of tool names"
);

err!(
    providers_empty,
    "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nagents:\n  main:\n    provider: anthropic\nproviders: {}\n".to_string(),
    "\"providers\" is empty — define at least one provider"
);
err!(
    provider_not_object,
    "runtime:\n  workspace: /tmp/ws\n  default_agent: main\nagents:\n  main:\n    provider: anthropic\nproviders:\n  anthropic: []\n".to_string(),
    "Provider \"anthropic\" must be an object"
);
