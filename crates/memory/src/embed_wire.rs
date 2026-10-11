use serde_json::{Map, Value};

pub const EMBEDDING_COLUMN_DIMS: usize = 1024;
pub const EMBED_TRUNCATE_DIMS: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedWireShape {
    Openai,
    Native,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EmbedRequestParts {
    pub url: String,
    pub body: Value,
}

pub fn build_embed_request(
    endpoint: &str,
    wire: EmbedWireShape,
    model: &str,
    input: &[String],
) -> EmbedRequestParts {
    let base = endpoint.trim_end_matches('/');
    match wire {
        EmbedWireShape::Native => {
            let mut body = Map::new();
            body.insert("model".to_string(), Value::String(model.to_string()));
            body.insert("texts".to_string(), Value::Array(string_array(input)));
            body.insert("input".to_string(), Value::Array(string_array(input)));
            EmbedRequestParts {
                url: base.to_string(),
                body: Value::Object(body),
            }
        }
        EmbedWireShape::Openai => {
            let mut body = Map::new();
            body.insert("model".to_string(), Value::String(model.to_string()));
            body.insert("input".to_string(), Value::Array(string_array(input)));
            EmbedRequestParts {
                url: format!("{base}/v1/embeddings"),
                body: Value::Object(body),
            }
        }
    }
}

fn string_array(input: &[String]) -> Vec<Value> {
    input.iter().cloned().map(Value::String).collect()
}

pub fn parse_embed_response(data: &Value, expected_count: usize) -> Vec<Option<Vec<f64>>> {
    let mut vectors = vec![None; expected_count];
    let Some(obj) = data.as_object() else {
        return vectors;
    };
    if let Some(rows) = obj.get("data").and_then(Value::as_array) {
        for item in rows {
            let Some(row) = item.as_object() else {
                continue;
            };
            let idx = row
                .get("index")
                .and_then(Value::as_f64)
                .filter(|n| n.is_finite() && *n >= 0.0)
                .map(|n| n as usize)
                .unwrap_or(0);
            if idx >= vectors.len() {
                continue;
            }
            if let Some(vec) = finite_numbers(row.get("embedding")) {
                vectors[idx] = Some(vec);
            }
        }
        return vectors;
    }
    let native = obj.get("embeddings").or_else(|| obj.get("vectors"));
    if let Some(rows) = native.and_then(Value::as_array) {
        for (i, item) in rows.iter().take(vectors.len()).enumerate() {
            if let Some(vec) = finite_numbers(Some(item)) {
                vectors[i] = Some(vec);
            }
        }
    }
    vectors
}

fn finite_numbers(value: Option<&Value>) -> Option<Vec<f64>> {
    let items = value?.as_array()?;
    if items.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let n = item.as_f64()?;
        if !n.is_finite() {
            return None;
        }
        out.push(n);
    }
    Some(out)
}

pub fn normalize_embed_vector(
    vec: Option<Vec<f64>>,
    expected_dims: Option<usize>,
    truncate_dims: Option<usize>,
) -> Option<Vec<f64>> {
    let vec = vec?;
    if let Some(expected) = expected_dims {
        return (vec.len() == expected).then_some(vec);
    }
    if let Some(truncate) = truncate_dims
        && vec.len() > truncate
    {
        return Some(vec.into_iter().take(truncate).collect());
    }
    Some(vec)
}

pub fn parse_embed_wire_shape(raw: Option<&str>) -> Result<EmbedWireShape, String> {
    match raw.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(EmbedWireShape::Openai),
        Some("openai") => Ok(EmbedWireShape::Openai),
        Some("native") => Ok(EmbedWireShape::Native),
        Some(_) => Err("embed_wire_shape must be \"openai\" or \"native\"".to_string()),
    }
}

pub fn vector_literal(values: &[f64]) -> String {
    let mut out = String::from("[");
    for (i, value) in values.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(&format!("{value}"));
    }
    out.push(']');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn builds_openai_and_native_bodies() {
        let openai = build_embed_request(
            "http://127.0.0.1:9401/",
            EmbedWireShape::Openai,
            "emb-1",
            &["hello".to_string()],
        );
        assert_eq!(openai.url, "http://127.0.0.1:9401/v1/embeddings");
        assert_eq!(openai.body, json!({"model": "emb-1", "input": ["hello"]}));
        let native = build_embed_request(
            "http://127.0.0.1:9401/embed",
            EmbedWireShape::Native,
            "emb-1",
            &["a".to_string(), "b".to_string()],
        );
        assert_eq!(native.url, "http://127.0.0.1:9401/embed");
        assert_eq!(
            native.body,
            json!({"model": "emb-1", "texts": ["a", "b"], "input": ["a", "b"]})
        );
    }

    #[test]
    fn parses_openai_and_native_vectors() {
        let openai = parse_embed_response(
            &json!({"data": [{"index": 1, "embedding": [0.1, 0.2]}, {"index": 0, "embedding": [0.3, 0.4]}]}),
            2,
        );
        assert_eq!(openai[0].as_deref(), Some(&[0.3, 0.4][..]));
        assert_eq!(openai[1].as_deref(), Some(&[0.1, 0.2][..]));
        let native = parse_embed_response(&json!({"embeddings": [[1.0, 2.0], [3.0, 4.0]]}), 2);
        assert_eq!(native[0].as_deref(), Some(&[1.0, 2.0][..]));
        assert_eq!(native[1].as_deref(), Some(&[3.0, 4.0][..]));
    }

    #[test]
    fn normalizes_expected_and_truncated_widths() {
        assert!(normalize_embed_vector(Some(vec![1.0, 2.0, 3.0, 4.0]), Some(2), None).is_none());
        assert!(normalize_embed_vector(Some(vec![1.0]), Some(2), None).is_none());
        assert_eq!(
            normalize_embed_vector(Some(vec![1.0, 2.0, 3.0]), None, Some(2)).as_deref(),
            Some(&[1.0, 2.0][..])
        );
        assert_eq!(EMBEDDING_COLUMN_DIMS, 1024);
        let exact: Vec<f64> = (0..1024).map(|i| i as f64).collect();
        assert_eq!(
            normalize_embed_vector(Some(exact.clone()), Some(EMBEDDING_COLUMN_DIMS), None),
            Some(exact.clone())
        );
        let mut longer = exact.clone();
        longer.push(99.0);
        assert!(normalize_embed_vector(Some(longer), Some(EMBEDDING_COLUMN_DIMS), None).is_none());
    }

    #[test]
    fn wire_shape_defaults_and_rejects() {
        assert_eq!(
            parse_embed_wire_shape(None).unwrap(),
            EmbedWireShape::Openai
        );
        assert_eq!(
            parse_embed_wire_shape(Some("")).unwrap(),
            EmbedWireShape::Openai
        );
        assert_eq!(
            parse_embed_wire_shape(Some("native")).unwrap(),
            EmbedWireShape::Native
        );
        assert_eq!(
            parse_embed_wire_shape(Some("grpc")).unwrap_err(),
            "embed_wire_shape must be \"openai\" or \"native\""
        );
    }
}
