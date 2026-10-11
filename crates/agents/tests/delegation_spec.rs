use agents::{
    ConfigAgentRef, DEFAULT_MAX_CHAIN_DEPTH, DEFAULT_WAIT_MS, DELEGATION_CACHE_TTL_MS,
    DelegationResolver, DelegationTarget, JsString, MESH_REFRESH_TTL_MS, NO_MESH_REGISTRY,
    PresetTaskSpecOptions, ROSTER_READ_BOUND_MS, chain_depth_limit_message, chain_depth_limited,
    gap_message, hosting_node_offline_message, no_harness_message, no_hosting_node_message,
    no_mesh_registry_reach_message, no_shared_queue_message, non_task_effort_message,
    not_runnable_message, preset_chain_depth, preset_chain_too_deep, preset_chain_too_deep_message,
    resolve_delegation_target, unknown_agent_message,
};
mod common;
pub use common::contract::*;
pub use common::*;

#[test]
fn chain_depth_messages_match_both_engines() {
    assert_eq!(DEFAULT_MAX_CHAIN_DEPTH, 3);
    assert!(!chain_depth_limited(2, 3));
    assert!(chain_depth_limited(3, 3));
    assert_eq!(
        chain_depth_limit_message(3, "grok", "reviewer", 3),
        "Delegation chain depth limit reached (3). Chain: grok → reviewer at depth 3. Increase maxChainDepth in config if deeper chains are needed."
    );
    assert_eq!(preset_chain_depth(3), 4);
    assert!(preset_chain_too_deep(4, 3));
    assert!(!preset_chain_too_deep(3, 3));
    let local = preset_chain_too_deep_message(4, 3, "deep", Some("node-f"), "node-f");
    assert!(local.contains("chain too deep"));
    assert!(!local.contains("mesh"));
    let remote = preset_chain_too_deep_message(4, 3, "far", Some("node-g"), "node-f");
    assert!(remote.contains("refusing mesh delegation"));
    assert_eq!(
        remote,
        "Delegation chain too deep (4 > 3) — refusing mesh delegation to far"
    );
}

#[test]
fn resolve_prefers_a_config_id_then_preset_handle_order() {
    let config = [ConfigAgentRef {
        id: "grok".to_string(),
    }];
    let presets = [
        preset("beta", "Alpha"),
        preset("id-b", "beta"),
        preset("reviewer", "reviewer"),
    ];
    assert!(matches!(
        resolve_delegation_target(&JsString::from_text("grok"), &config, &presets),
        Some(DelegationTarget::ConfigAgent { id }) if id == "grok"
    ));
    assert!(matches!(
        resolve_delegation_target(&JsString::from_text("beta"), &config, &presets),
        Some(DelegationTarget::Preset(row)) if row.id.to_utf8() == "beta"
    ));
    assert!(matches!(
        resolve_delegation_target(&JsString::from_text("reviewer"), &[], &presets),
        Some(DelegationTarget::Preset(row)) if row.id.to_utf8() == "reviewer"
    ));
    assert!(
        resolve_delegation_target(&JsString::from_text("missing"), &config, &presets).is_none()
    );
    assert_eq!(
        unknown_agent_message(
            "nonexistent",
            &["grok".to_string()],
            &["reviewer".to_string()]
        ),
        "Unknown agent: nonexistent. Agents you can delegate to: grok, reviewer"
    );
    assert!(unknown_agent_message("nonexistent", &[], &[]).contains("(none reachable)"));
}

#[test]
fn refusal_strings_match_the_preset_engine() {
    assert_eq!(
        no_harness_message("bare"),
        "preset \"bare\" has no harness configured"
    );
    assert_eq!(
        no_hosting_node_message("homeless"),
        "preset \"homeless\" has no hosting node"
    );
    assert_eq!(
        hosting_node_offline_message("node-g"),
        "hosting node \"node-g\" is offline or unknown"
    );
    assert_eq!(
        no_mesh_registry_reach_message("node-g"),
        "no mesh registry; cannot reach node \"node-g\""
    );
    assert_eq!(NO_MESH_REGISTRY, "no mesh registry");
    assert_eq!(
        no_shared_queue_message("reviewer", "node-g"),
        "preset \"reviewer\" lives on node-g; this node has no shared task queue"
    );
    assert_eq!(
        not_runnable_message("reviewer"),
        "preset \"reviewer\" is not runnable"
    );
    assert_eq!(
        gap_message("reviewer", "codex", "node-f", "no executor"),
        "agent \"reviewer\" (codex on node-f): no executor"
    );
    assert_eq!(DEFAULT_WAIT_MS, 1_800_000);
    assert_eq!(MESH_REFRESH_TTL_MS, 30_000);
    assert_eq!(ROSTER_READ_BOUND_MS, 2_000);
    assert_eq!(DELEGATION_CACHE_TTL_MS, 300_000);
}

#[test]
fn preset_task_spec_trims_model_and_omits_blank_effort() {
    let resolver = DelegationResolver::new();
    let mut row = preset("p1", "reviewer");
    row.model = " haiku ".into();
    row.directory = Some("/srv/reviewer".into());
    row.system_prompt = "keep me".into();
    let spec = resolver.preset_task_spec(&row, &PresetTaskSpecOptions::default());
    assert_eq!(
        spec.get("model").and_then(agents::JsValue::as_str),
        Some("haiku")
    );
    assert_eq!(
        spec.as_object()
            .unwrap()
            .keys()
            .map(agents::JsString::to_utf8)
            .collect::<Vec<_>>(),
        [
            "delegation",
            "presetId",
            "presetName",
            "workingDir",
            "sharedLink",
            "excludeTools",
            "model",
            "effort",
            "systemPromptAppend",
        ]
    );
    let mut override_opts = PresetTaskSpecOptions {
        model: Some(" opus ".to_string()),
        model_present: true,
        ..PresetTaskSpecOptions::default()
    };
    assert_eq!(
        resolver
            .preset_task_spec(&row, &override_opts)
            .get("model")
            .and_then(agents::JsValue::as_str),
        Some("opus")
    );
    override_opts.model = Some("   ".to_string());
    assert!(
        resolver
            .preset_task_spec(&row, &override_opts)
            .get("model")
            .is_none()
    );
    row.model = "".into();
    assert!(
        resolver
            .preset_task_spec(&row, &PresetTaskSpecOptions::default())
            .get("model")
            .is_none()
    );
    row.effort = "xhigh".into();
    row.system_prompt = "".into();
    let bare = resolver.preset_task_spec(&row, &PresetTaskSpecOptions::default());
    assert!(bare.get("effort").is_none());
    assert!(bare.get("systemPromptAppend").is_none());
    row.system_prompt = " ".into();
    assert_eq!(
        resolver
            .preset_task_spec(&row, &PresetTaskSpecOptions::default())
            .get("systemPromptAppend")
            .and_then(agents::JsValue::as_str),
        Some(" ")
    );
    row.effort = " low ".into();
    assert_eq!(resolver.task_effort(row.effort.to_utf8()), Some("low"));
    assert_eq!(resolver.task_effort(""), None);
    assert_eq!(resolver.task_effort("   "), None);
    let unique = format!("not-a-task-{}", std::process::id());
    assert!(resolver.note_non_task_effort(&unique));
    assert!(!resolver.note_non_task_effort(&unique));
    assert!(resolver.task_effort(&unique).is_none());
    let other = DelegationResolver::new();
    assert!(other.note_non_task_effort(&unique));
    assert!(non_task_effort_message(&unique).contains("low|medium|high"));
}

#[test]
fn preset_task_spec_omits_delegation_fields_and_keeps_session_ids() {
    let resolver = DelegationResolver::new();
    let mut row = preset("p1", "reviewer");
    row.directory = None;
    row.shared_link = None;
    row.effort = "".into();
    row.system_prompt = "".into();
    let mut opts = PresetTaskSpecOptions {
        delegation: Some(false),
        mesh_from: Some("node-g".to_string()),
        parent_session_id: Some("  claude-code:11111111-1111-4111-8111-111111111111  ".to_string()),
        owner: Some(" coco ".to_string()),
        ..PresetTaskSpecOptions::default()
    };
    let spec = resolver.preset_task_spec(&row, &opts);
    assert!(spec.get("delegation").is_none());
    assert!(spec.get("meshFrom").is_none());
    assert_eq!(
        spec.get("parentSessionId")
            .and_then(agents::JsValue::as_str),
        Some("claude-code:11111111-1111-4111-8111-111111111111")
    );
    assert_eq!(
        spec.get("owner").and_then(agents::JsValue::as_str),
        Some("coco")
    );
    assert!(spec.get("workingDir").is_none());
    assert_eq!(
        spec.get("sharedLink").and_then(agents::JsValue::as_bool),
        Some(true)
    );
    assert_eq!(
        spec.get("excludeTools")
            .and_then(agents::JsValue::as_array)
            .unwrap()[0]
            .as_str(),
        Some("delegate_task")
    );
    opts.delegation = Some(true);
    opts.parent_session_id = Some("   ".to_string());
    opts.owner = None;
    opts.mesh_from = Some(" ".to_string());
    let with_mesh = resolver.preset_task_spec(&row, &opts);
    assert_eq!(
        with_mesh.get("meshFrom").and_then(agents::JsValue::as_str),
        Some(" ")
    );
    assert!(with_mesh.get("parentSessionId").is_none());
}

#[test]
fn preset_task_spec_keeps_a_surrogate_in_the_appended_prompt() {
    let resolver = DelegationResolver::new();
    let mut row = preset("p1", "reviewer");
    row.system_prompt = agents::JsString::from_units(vec![0xD83D]);
    row.effort = "".into();
    let spec = resolver.preset_task_spec(&row, &PresetTaskSpecOptions::default());
    let json = serde_json::to_string(&spec).unwrap();
    assert!(json.contains(r"\ud83d"));
    assert_eq!(
        spec.get("systemPromptAppend")
            .and_then(agents::JsValue::as_js_string)
            .unwrap()
            .units(),
        &[0xD83D]
    );
}
