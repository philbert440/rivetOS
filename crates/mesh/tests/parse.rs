use mesh::{
    MeshError, MeshParseError, MeshParseErrorCode, MeshParseOptions, OnInvalidNode,
    assert_record_mesh_file, is_mesh_flat_array_error, mesh_file_to_pretty, parse_mesh_file,
};
use serde_json::{Value, json};

fn parse(raw: &str) -> Result<mesh::ParseOutcome, MeshParseError> {
    parse_mesh_file(raw, "mesh.json", MeshParseOptions::default())
}

fn valid_doc() -> Value {
    json!({
        "version": 1,
        "updatedAt": 42,
        "extraRoot": true,
        "nodes": {
            "a": {
                "id": "a",
                "name": "a",
                "host": "192.0.2.1",
                "port": 3100,
                "status": "online",
                "sshUser": "user",
                "installRoot": "/srv/rivetos",
                "platform": "linux",
                "unknownNodeField": "ok"
            }
        }
    })
}

#[test]
fn accepts_a_valid_record_format_file() {
    let outcome = parse(&valid_doc().to_string()).unwrap();
    let node = outcome.file.get("a").unwrap();
    assert_eq!(outcome.file.version.as_f64(), 1.0);
    assert_eq!(outcome.file.updated_at.as_f64(), 42.0);
    assert_eq!(node.name, "a");
    assert_eq!(node.host, "192.0.2.1");
    assert_eq!(node.port.as_f64(), 3100.0);
    assert_eq!(node.status, "online");
    assert_eq!(node.ssh_user.as_deref(), Some("user"));
    assert_eq!(node.install_root.as_deref(), Some("/srv/rivetos"));
    assert_eq!(node.platform.as_deref(), Some("linux"));
    assert!(node.agents.is_empty());
    assert!(node.providers.is_empty());
    assert!(node.models.is_empty());
    assert!(node.capabilities.is_empty());
}

#[test]
fn preserves_unknown_fields_on_the_root_and_on_nodes() {
    let outcome = parse(&valid_doc().to_string()).unwrap();
    let node = outcome.file.get("a").unwrap();
    assert_eq!(
        outcome
            .file
            .extra
            .get("extraRoot")
            .and_then(protocol::js::JsValue::as_bool),
        Some(true)
    );
    assert_eq!(
        node.extra
            .get("unknownNodeField")
            .and_then(protocol::js::JsValue::as_str),
        Some("ok")
    );
    assert_eq!(node.id, "a");
}

#[test]
fn defaults_missing_node_id_and_name_from_the_record_key() {
    let raw = json!({
        "version": 1,
        "updatedAt": 0,
        "nodes": { "node-a": { "host": "192.0.2.10", "port": 3000, "status": "offline" } }
    });
    let outcome = parse(&raw.to_string()).unwrap();
    let node = outcome.file.get("node-a").unwrap();
    assert_eq!(node.id, "node-a");
    assert_eq!(node.name, "node-a");
    assert!(node.agents.is_empty());
    assert_eq!(node.last_seen.as_f64(), 0.0);
    assert_eq!(node.version, "");
}

#[test]
fn throws_on_pre_capabilities_flat_array() {
    let raw = json!({
        "nodes": [{ "name": "legacy-node", "ip": "192.0.2.1", "role": "primary" }],
        "updatedAt": 1
    })
    .to_string();
    let err =
        parse_mesh_file(&raw, "/tmp/legacy-mesh.json", MeshParseOptions::default()).unwrap_err();
    assert!(err.message().contains("pre-capabilities flat-array"));
    assert!(err.message().contains("/tmp/legacy-mesh.json"));
    assert!(err.message().contains(&mesh::shared_path(&["mesh.json"])));
    assert_eq!(err.code(), MeshParseErrorCode::FlatArray);
    assert_eq!(err.code().as_str(), "MESH_FLAT_ARRAY");
    assert!(err.is_flat_array());
    assert!(is_mesh_flat_array_error(&MeshError::from(err.clone())));
    assert!(err.to_string().contains("pre-capabilities flat-array"));
}

#[test]
fn throws_on_invalid_json() {
    let err = parse_mesh_file("{nope", "/tmp/bad.json", MeshParseOptions::default()).unwrap_err();
    assert_eq!(err.code(), MeshParseErrorCode::JsonInvalid);
    assert_eq!(err.code().as_str(), "MESH_JSON_INVALID");
    assert!(
        err.message()
            .contains("mesh.json at /tmp/bad.json is not valid JSON")
    );
    assert!(err.cause().is_some());
}

#[test]
fn rejects_a_node_that_is_not_an_object() {
    let raw = json!({ "version": 1, "updatedAt": 0, "nodes": { "a": "nope" } }).to_string();
    let err = parse(&raw).unwrap_err();
    assert!(err.message().contains("node \"a\" is not an object"));
}

#[test]
fn rejects_a_node_with_a_non_numeric_port() {
    let raw = json!({
        "version": 1,
        "updatedAt": 0,
        "nodes": { "a": { "host": "h", "port": "3100" } }
    })
    .to_string();
    let err = parse(&raw).unwrap_err();
    assert!(err.message().contains("invalid port"));
}

#[test]
fn rejects_a_node_with_a_non_array_agents_field() {
    let raw = json!({
        "version": 1,
        "updatedAt": 0,
        "nodes": { "a": { "host": "h", "port": 1, "agents": "opus" } }
    })
    .to_string();
    let err = parse(&raw).unwrap_err();
    assert!(err.message().contains("invalid agents"));
}

#[test]
fn rejects_a_node_with_a_non_object_metadata_field() {
    let raw = json!({
        "version": 1,
        "updatedAt": 0,
        "nodes": { "a": { "host": "h", "port": 1, "metadata": ["nope"] } }
    })
    .to_string();
    let err = parse(&raw).unwrap_err();
    assert!(err.message().contains("invalid metadata"));
}

#[test]
fn skips_null_node_entries() {
    let raw = json!({
        "version": 1,
        "updatedAt": 7,
        "nodes": { "a": null, "b": { "host": "h", "port": 1 } }
    })
    .to_string();
    let outcome = parse(&raw).unwrap();
    assert!(outcome.file.get("a").is_none());
    assert_eq!(outcome.file.get("b").unwrap().host, "h");
    assert_eq!(outcome.file.updated_at.as_f64(), 7.0);
}

#[test]
fn null_nodes_is_a_shape_error() {
    let err = parse(r#"{"version":1,"updatedAt":0,"nodes":null}"#).unwrap_err();
    assert_eq!(err.code(), MeshParseErrorCode::InvalidShape);
    assert!(
        err.message()
            .contains("nodes must be an object keyed by node id")
    );
}

#[test]
fn skip_omits_a_bad_node_and_warns_once_with_its_id() {
    let raw = json!({
        "version": 1,
        "updatedAt": 0,
        "nodes": {
            "good": { "host": "h", "port": 1 },
            "bad": { "host": "h", "port": "3100" }
        }
    })
    .to_string();
    let outcome = parse_mesh_file(
        &raw,
        "mesh.json",
        MeshParseOptions {
            on_invalid_node: OnInvalidNode::Skip,
        },
    )
    .unwrap();
    assert_eq!(outcome.file.get("good").unwrap().port.as_f64(), 1.0);
    assert!(outcome.file.get("bad").is_none());
    assert_eq!(outcome.warnings.len(), 1);
    assert!(outcome.warnings[0].contains("\"bad\""));
}

#[test]
fn throw_is_the_default_for_a_bad_node() {
    let raw = json!({
        "version": 1,
        "updatedAt": 0,
        "nodes": {
            "good": { "host": "h", "port": 1 },
            "bad": { "host": "h", "port": "3100" }
        }
    })
    .to_string();
    let err = parse(&raw).unwrap_err();
    assert!(err.message().contains("invalid port"));
}

#[test]
fn skip_still_throws_on_flat_array() {
    let raw = json!({
        "nodes": [{ "name": "legacy-node", "ip": "192.0.2.1" }],
        "updatedAt": 1
    })
    .to_string();
    let err = parse_mesh_file(
        &raw,
        "/tmp/legacy-mesh.json",
        MeshParseOptions {
            on_invalid_node: OnInvalidNode::Skip,
        },
    )
    .unwrap_err();
    assert!(err.message().contains("pre-capabilities flat-array"));
}

#[test]
fn skip_still_throws_on_root_shape_errors() {
    let err = parse_mesh_file(
        &json!({ "nodes": "nope" }).to_string(),
        "mesh.json",
        MeshParseOptions {
            on_invalid_node: OnInvalidNode::Skip,
        },
    )
    .unwrap_err();
    assert!(err.message().contains("nodes must be an object"));
}

#[test]
fn rejects_a_root_that_is_not_an_object() {
    let err = parse("[]").unwrap_err();
    assert_eq!(err.code(), MeshParseErrorCode::InvalidShape);
    assert!(err.message().contains("is not a JSON object"));
}

#[test]
fn assert_record_mesh_file_accepts_an_already_parsed_object() {
    let value = json!({
        "version": 1,
        "updatedAt": 42,
        "nodes": {
            "a": {
                "id": "a",
                "name": "a",
                "host": "192.0.2.1",
                "port": 3100,
                "status": "online",
                "sshUser": "user",
                "installRoot": "/srv/rivetos"
            }
        }
    });
    let parsed = protocol::js::parse(&value.to_string()).unwrap();
    let outcome =
        assert_record_mesh_file(&parsed, "/tmp/test-mesh.json", MeshParseOptions::default())
            .unwrap();
    let node = outcome.file.get("a").unwrap();
    assert_eq!(node.name, "a");
    assert_eq!(node.ssh_user.as_deref(), Some("user"));
    assert_eq!(node.install_root.as_deref(), Some("/srv/rivetos"));
    assert_eq!(outcome.file.updated_at.as_f64(), 42.0);
}

#[test]
fn to_json_names_the_error_and_sets_a_deterministic_stack() {
    let err = parse("{nope").unwrap_err();
    let value = err.to_json();
    let object = value.as_object().unwrap();
    let keys: Vec<_> = object.keys().cloned().collect();
    assert_eq!(
        keys,
        vec![
            "name".to_string(),
            "code".to_string(),
            "message".to_string(),
            "severity".to_string(),
            "retryable".to_string(),
            "timestamp".to_string(),
            "context".to_string(),
            "cause".to_string(),
            "stack".to_string(),
        ]
    );
    assert_eq!(
        object.get("stack").and_then(Value::as_str),
        Some(format!("MeshParseError: {}", err.message()).as_str())
    );
    assert_eq!(
        object.get("name").and_then(Value::as_str),
        Some("MeshParseError")
    );
    assert_eq!(
        object.get("code").and_then(Value::as_str),
        Some("MESH_JSON_INVALID")
    );
    assert_eq!(
        object.get("severity").and_then(Value::as_str),
        Some("fatal")
    );
    assert_eq!(
        object.get("retryable").and_then(Value::as_bool),
        Some(false)
    );
    assert!(object.get("timestamp").and_then(Value::as_f64).is_some());
    assert!(object.get("context").and_then(Value::as_object).is_some());
    assert!(object.get("cause").and_then(Value::as_str).is_some());
}

#[test]
fn pretty_mesh_has_no_trailing_newline_and_omits_absent_operator_fields() {
    let outcome = parse(
        &json!({
            "version": 1,
            "updatedAt": 1,
            "nodes": { "a": { "host": "h", "port": 1, "status": "online" } }
        })
        .to_string(),
    )
    .unwrap();
    let pretty = mesh_file_to_pretty(&outcome.file);
    assert!(!pretty.ends_with('\n'));
    assert!(!pretty.contains("sshUser"));
    assert!(!pretty.contains("installRoot"));
    assert!(!pretty.contains("platform"));
    assert!(!pretty.contains("metadata"));
}

#[test]
fn file_null_operator_is_still_invalid() {
    let err =
        parse(r#"{"version":1,"nodes":{"a":{"id":"a","name":"a","host":"h","sshUser":null}}}"#)
            .unwrap_err();
    assert_eq!(err.code(), MeshParseErrorCode::NodeInvalid);
    assert!(err.message().contains("sshUser"));
}

#[test]
fn saved_key_order_lifts_index_keys_and_passes_js_values_through() {
    let raw = concat!(
        r#"{"version":1,"0":"rootidx","extraRoot":true,"updatedAt":7,"nodes":{"a":{"#,
        r#""9":"idx","unknown":"u","platform":"linux","sshUser":"user","metadata":{"denPort":1.0,"huge":1e400},"#,
        r#""role":"edge","version":"1","registeredAt":3,"lastSeen":2,"status":"online","capabilities":[],"#,
        r#""models":[],"providers":[],"agents":["opus"],"port":3100,"host":"h","name":"a","id":"a","sur":"\ud800"}}}"#
    );
    let outcome = parse(raw).unwrap();
    let pretty = mesh_file_to_pretty(&outcome.file);
    assert!(!pretty.ends_with('\n'));
    assert!(pretty.contains(r"\ud800"));
    let compact = protocol::js::stringify(&protocol::js::parse(&pretty).unwrap());
    let node = concat!(
        r#"{"9":"idx","id":"a","name":"a","host":"h","port":3100,"agents":["opus"],"providers":[],"#,
        r#""models":[],"capabilities":[],"status":"online","lastSeen":2,"registeredAt":3,"version":"1","#,
        r#""role":"edge","metadata":{"denPort":1,"huge":null},"sshUser":"user","platform":"linux","#,
        r#""unknown":"u","sur":"\ud800"}"#
    );
    let expected = format!(
        r#"{{"0":"rootidx","version":1,"nodes":{{"a":{node}}},"updatedAt":7,"extraRoot":true}}"#
    );
    assert_eq!(compact, expected);
}

#[test]
fn unpaired_surrogate_keys_stay_distinct_from_the_replacement_character() {
    let raw = concat!(
        r#"{"version":1,"nodes":{"\ud800":{"id":"a","name":"a","host":"h","\ud800":true,"\ufffd":false},"#,
        r#""\ufffd":{"id":"b","name":"b","host":"h"}},"updatedAt":1,"\ud800":"k","\ufffd":"r"}"#
    );
    let outcome = parse(raw).unwrap();
    let pretty = mesh_file_to_pretty(&outcome.file);
    let parsed = protocol::js::parse(&pretty).unwrap();
    let root = parsed.as_object().unwrap();
    let lone = protocol::js::JsString::from_units(vec![0xD800]);
    let replacement = protocol::js::JsString::from_text("\u{FFFD}");
    assert_eq!(
        root.iter()
            .find(|(key, _)| *key == &lone)
            .and_then(|(_, value)| value.as_str()),
        Some("k")
    );
    assert_eq!(
        root.iter()
            .find(|(key, _)| *key == &replacement)
            .and_then(|(_, value)| value.as_str()),
        Some("r")
    );
    let nodes = root.get("nodes").unwrap().as_object().unwrap();
    let lone_node = nodes
        .iter()
        .find(|(key, _)| *key == &lone)
        .and_then(|(_, value)| value.as_object())
        .unwrap();
    let replacement_node = nodes
        .iter()
        .find(|(key, _)| *key == &replacement)
        .and_then(|(_, value)| value.as_object())
        .unwrap();
    assert_eq!(
        lone_node
            .iter()
            .find(|(key, _)| *key == &lone)
            .and_then(|(_, value)| value.as_bool()),
        Some(true)
    );
    assert_eq!(
        lone_node
            .iter()
            .find(|(key, _)| *key == &replacement)
            .and_then(|(_, value)| value.as_bool()),
        Some(false)
    );
    assert_eq!(
        replacement_node.get("id").and_then(|value| value.as_str()),
        Some("b")
    );
}
