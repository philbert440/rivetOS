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
    assert_eq!(outcome.file.extra.get("extraRoot"), Some(&json!(true)));
    assert_eq!(node.extra.get("unknownNodeField"), Some(&json!("ok")));
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
    let outcome =
        assert_record_mesh_file(&value, "/tmp/test-mesh.json", MeshParseOptions::default())
            .unwrap();
    let node = outcome.file.get("a").unwrap();
    assert_eq!(node.name, "a");
    assert_eq!(node.ssh_user.as_deref(), Some("user"));
    assert_eq!(node.install_root.as_deref(), Some("/srv/rivetos"));
    assert_eq!(outcome.file.updated_at.as_f64(), 42.0);
}

#[test]
fn to_json_omits_stack_and_names_the_error() {
    let err = parse("{nope").unwrap_err();
    let value = err.to_json();
    let object = value.as_object().unwrap();
    assert!(object.get("stack").is_none());
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
    let pretty = mesh_file_to_pretty(&outcome.file).unwrap();
    assert!(!pretty.ends_with('\n'));
    assert!(!pretty.contains("sshUser"));
    assert!(!pretty.contains("installRoot"));
    assert!(!pretty.contains("platform"));
    assert!(!pretty.contains("metadata"));
}
