use agents::{
    AgentPreset, COLOR_HEX, EFFORT_TOKEN, HARNESS_KNOWN, HarnessPatch, INVALID_JSON, JsNumber,
    ModelList, ModelListLookup, NODE_IMMUTABLE, SortPatch, ValidateCtx, validate_create,
    validate_patch,
};
use serde_json::{Value, json};

fn context<'a>(
    models: ModelListLookup<'a>,
    allow: Option<&'a dyn Fn(&str) -> bool>,
) -> ValidateCtx<'a> {
    ValidateCtx {
        node_name: "node-f",
        directory_root: "/home/agents",
        home: "/home/user",
        shared_dir: Some("/home/shared"),
        allow_harness: allow,
        model_list: models,
    }
}

fn existing() -> AgentPreset {
    AgentPreset {
        id: "a".to_string(),
        name: "Legacy".to_string(),
        color: String::new(),
        harness_id: None,
        model: "gpt-4o".to_string(),
        effort: "medium".to_string(),
        system_prompt: String::new(),
        node: Some("node-f".to_string()),
        directory: Some("/home/agents/legacy".to_string()),
        shared_link: Some(true),
        node_base_url: Some(String::new()),
        sort_order: None,
        created_at: JsNumber::from(1),
        updated_at: JsNumber::from(1),
        document: None,
    }
}

fn codex_list(strict: bool) -> impl Fn(&str) -> Option<ModelList> {
    move |harness| {
        if harness == "codex" {
            Some(ModelList {
                ids: vec!["gpt-6-astra".to_string(), "gpt-5.5".to_string()],
                strict,
                source: if strict {
                    "config".to_string()
                } else {
                    "discovered".to_string()
                },
            })
        } else {
            Some(ModelList {
                ids: Vec::new(),
                strict: false,
                source: "static".to_string(),
            })
        }
    }
}

#[test]
fn create_stamps_this_node_and_rejects_a_foreign_one() {
    let ctx = context(None, None);
    let created = validate_create(&json!({"name": "Bare"}), &ctx).unwrap();
    assert_eq!(created.input.node, "node-f");
    assert_eq!(created.input.node_base_url.as_deref(), Some(""));
    assert_eq!(created.input.directory, "/home/agents/bare");
    assert_eq!(created.input.effort.as_deref(), Some("medium"));
    let err = validate_create(&json!({"name": "x", "node": "node-e"}), &ctx).unwrap_err();
    assert_eq!(err.status, 400);
    assert_eq!(
        err.error,
        "agent must be created on its hosting node (node-f)"
    );
}

#[test]
fn create_vets_models_and_exempts_the_codex_default() {
    let strict = codex_list(true);
    let ctx = context(Some(&strict), None);
    let err = validate_create(
        &json!({"name": "A", "harnessId": "codex", "model": "gpt-4o"}),
        &ctx,
    )
    .unwrap_err();
    assert_eq!(err.status, 400);
    assert_eq!(
        err.error,
        "model \"gpt-4o\" is not on the codex model list (config)"
    );
    assert!(
        validate_create(
            &json!({"name": "D", "harnessId": "codex", "model": "default"}),
            &ctx
        )
        .is_ok()
    );
    assert!(
        validate_create(
            &json!({"name": "B", "harnessId": "codex", "model": "gpt-5.5"}),
            &ctx
        )
        .is_ok()
    );
    let loose = codex_list(false);
    let loose_ctx = context(Some(&loose), None);
    let warned = validate_create(
        &json!({"name": "A", "harnessId": "codex", "model": "gpt-4o"}),
        &loose_ctx,
    )
    .unwrap();
    assert_eq!(warned.warnings.len(), 1);
    assert!(warned.warnings[0].contains("not on the codex model list (discovered)"));
    assert!(warned.warnings[0].contains("—"));
    assert!(
        validate_create(
            &json!({"name": "A", "harnessId": "cursor", "model": "anything"}),
            &ctx
        )
        .is_ok()
    );
    assert!(validate_create(&json!({"name": "B", "model": "anything"}), &ctx).is_ok());
}

#[test]
fn patch_vets_only_a_changed_pair_and_ignores_node_base_url() {
    let strict = codex_list(true);
    let ctx = context(Some(&strict), None);
    let mut row = existing();
    row.harness_id = Some("codex".to_string());
    row.model = "gpt-5.5".to_string();
    let err = validate_patch(&json!({"model": "gpt-4o"}), &row, &ctx).unwrap_err();
    assert_eq!(err.status, 400);
    assert!(validate_patch(&json!({"model": "gpt-6-astra"}), &row, &ctx).is_ok());
    assert!(
        validate_patch(
            &json!({"harnessId": "cursor", "model": "whatever"}),
            &row,
            &ctx
        )
        .is_ok()
    );
    row.harness_id = Some("cursor".to_string());
    row.model = "whatever".to_string();
    let err = validate_patch(&json!({"harnessId": "codex"}), &row, &ctx).unwrap_err();
    assert_eq!(err.status, 400);
    assert!(validate_patch(&json!({"name": "Renamed"}), &row, &ctx).is_ok());

    let mut legacy = existing();
    assert!(
        validate_patch(
            &json!({"name": "Legacy 2", "model": "gpt-4o", "color": "#112233"}),
            &legacy,
            &ctx
        )
        .is_ok()
    );
    let err = validate_patch(
        &json!({"harnessId": "codex", "model": "gpt-4o"}),
        &legacy,
        &ctx,
    )
    .unwrap_err();
    assert_eq!(err.status, 400);
    legacy.harness_id = Some("codex".to_string());
    legacy.model = "gpt-5.5".to_string();
    let round = validate_patch(
        &json!({"name": "Legacy 3", "harnessId": "codex", "model": "gpt-5.5"}),
        &legacy,
        &ctx,
    )
    .unwrap();
    assert!(round.warnings.is_empty());
    let ignored =
        validate_patch(&json!({"nodeBaseUrl": "http://127.0.0.1:9"}), &legacy, &ctx).unwrap();
    assert!(ignored.patch.node_base_url.is_none());
}

#[test]
fn patch_node_sort_order_directory_and_foreign_placement() {
    let ctx = context(None, None);
    let row = existing();
    let err = validate_patch(&json!({"node": "node-e"}), &row, &ctx).unwrap_err();
    assert_eq!(err.status, 400);
    assert_eq!(err.error, NODE_IMMUTABLE);
    let ordered = validate_patch(&json!({"sortOrder": 0}), &row, &ctx).unwrap();
    assert_eq!(ordered.patch.sort_order, SortPatch::Set(0));
    let cleared = validate_patch(&json!({"sortOrder": null}), &row, &ctx).unwrap();
    assert_eq!(cleared.patch.sort_order, SortPatch::Clear);
    for bad in [
        json!(-1),
        json!(1.5),
        json!(1_000_001),
        json!("2"),
        json!(true),
    ] {
        let err = validate_patch(&json!({"sortOrder": bad}), &row, &ctx).unwrap_err();
        assert_eq!(err.status, 400);
        assert_eq!(err.error, "sortOrder must be an integer 0-1000000 or null");
    }
    let err = validate_patch(&json!({"color": "red"}), &row, &ctx).unwrap_err();
    assert_eq!(err.error, COLOR_HEX);
    let err = validate_patch(&json!({"effort": "has space"}), &row, &ctx).unwrap_err();
    assert_eq!(err.error, EFFORT_TOKEN);
    let err = validate_patch(&json!({"harnessId": "nope"}), &row, &ctx).unwrap_err();
    assert_eq!(err.error, HARNESS_KNOWN);
    let err = validate_patch(&json!({"directory": "../etc"}), &row, &ctx).unwrap_err();
    assert_eq!(err.status, 400);
    let home = validate_patch(&json!({"directory": "~/x"}), &row, &ctx).unwrap();
    assert_eq!(home.patch.directory.as_deref(), Some("/home/user/x"));
    assert!(home.materialize);
    let err = validate_patch(&json!({"directory": "/tmp/../etc"}), &row, &ctx).unwrap_err();
    assert_eq!(err.status, 400);
    let err = validate_patch(&json!({"directory": "~/../x"}), &row, &ctx).unwrap_err();
    assert_eq!(err.status, 400);
    let mut foreign = existing();
    foreign.node = Some("node-e".to_string());
    let err = validate_patch(&json!({"directory": "/srv/other"}), &foreign, &ctx).unwrap_err();
    assert_eq!(err.status, 409);
    assert_eq!(err.error, "agent \"Legacy\" is hosted on node-e");
    let kept = validate_patch(&json!({"name": "Renamed"}), &foreign, &ctx).unwrap();
    assert!(!kept.materialize);
    assert_eq!(kept.patch.name.as_deref(), Some("Renamed"));
    let same = validate_patch(
        &json!({"directory": "/home/agents/legacy", "sharedLink": true}),
        &foreign,
        &ctx,
    )
    .unwrap();
    assert!(!same.materialize);
    assert!(validate_create(&json!([]), &ctx).unwrap_err().error == INVALID_JSON);
    let allow = |id: &str| id != "codex";
    let blocked = context(None, Some(&allow));
    let err = validate_create(&json!({"name": "A", "harnessId": "codex"}), &blocked).unwrap_err();
    assert_eq!(err.status, 403);
    assert_eq!(err.harness_id.as_deref(), Some("codex"));
    let cleared = validate_patch(
        &Value::Object(serde_json::Map::from_iter([(
            "harnessId".to_string(),
            Value::Null,
        )])),
        &row,
        &ctx,
    )
    .unwrap();
    assert_eq!(cleared.patch.harness, HarnessPatch::Clear);
}
