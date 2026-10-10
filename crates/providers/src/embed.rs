use serde_json::{Map, Value};

pub const EMBEDDING_COLUMN_DIMS: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmbedWireShape {
    Openai,
    Native,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbedWireParse {
    Shape(EmbedWireShape),
    Error(&'static str),
}

pub struct EmbedRequest {
    pub url: String,
    pub body: Value,
}

pub fn build_embed_request(
    endpoint: &str,
    shape: EmbedWireShape,
    model: &str,
    input: &[String],
) -> EmbedRequest {
    let base = endpoint.trim_end_matches('/');
    let texts: Vec<Value> = input.iter().cloned().map(Value::from).collect();
    match shape {
        EmbedWireShape::Native => {
            let mut body = Map::new();
            body.insert("model".to_string(), Value::from(model));
            body.insert("texts".to_string(), Value::Array(texts.clone()));
            body.insert("input".to_string(), Value::Array(texts));
            EmbedRequest {
                url: base.to_string(),
                body: Value::Object(body),
            }
        }
        EmbedWireShape::Openai => {
            let mut body = Map::new();
            body.insert("model".to_string(), Value::from(model));
            body.insert("input".to_string(), Value::Array(texts));
            EmbedRequest {
                url: format!("{base}/v1/embeddings"),
                body: Value::Object(body),
            }
        }
    }
}

pub fn parse_embed_response(data: &Value, expected_count: usize) -> Vec<Option<Vec<f64>>> {
    let mut vectors = vec![None; expected_count];
    let Some(object) = data.as_object() else {
        return vectors;
    };
    if let Some(rows) = object.get("data").and_then(Value::as_array) {
        for item in rows {
            let Some(row) = item.as_object() else {
                continue;
            };
            let index = row.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
            if index >= vectors.len() {
                continue;
            }
            if let Some(embedding) = finite_numbers(row.get("embedding")) {
                vectors[index] = Some(embedding);
            }
        }
        return vectors;
    }
    let native = object.get("embeddings").or_else(|| object.get("vectors"));
    if let Some(rows) = native.and_then(Value::as_array) {
        for (index, row) in rows.iter().take(vectors.len()).enumerate() {
            if let Some(embedding) = finite_numbers(Some(row)) {
                vectors[index] = Some(embedding);
            }
        }
    }
    vectors
}

fn finite_numbers(value: Option<&Value>) -> Option<Vec<f64>> {
    let array = value?.as_array()?;
    if array.is_empty() {
        return None;
    }
    let mut out = Vec::with_capacity(array.len());
    for item in array {
        let number = item.as_f64()?;
        if !number.is_finite() {
            return None;
        }
        out.push(number);
    }
    Some(out)
}

pub fn normalize_embed_vector(
    vec: Option<&[f64]>,
    expected_dims: Option<usize>,
    truncate_dims: Option<usize>,
) -> Option<Vec<f64>> {
    let vec = vec?;
    if let Some(expected) = expected_dims {
        return if vec.len() == expected {
            Some(vec.to_vec())
        } else {
            None
        };
    }
    if let Some(truncate) = truncate_dims {
        if vec.len() > truncate {
            return Some(vec[..truncate].to_vec());
        }
    }
    Some(vec.to_vec())
}

pub fn parse_embed_wire_shape(raw: Option<&str>) -> EmbedWireParse {
    match raw {
        None | Some("") => EmbedWireParse::Shape(EmbedWireShape::Openai),
        Some("openai") => EmbedWireParse::Shape(EmbedWireShape::Openai),
        Some("native") => EmbedWireParse::Shape(EmbedWireShape::Native),
        Some(_) => EmbedWireParse::Error("embed_wire_shape must be \"openai\" or \"native\""),
    }
}
