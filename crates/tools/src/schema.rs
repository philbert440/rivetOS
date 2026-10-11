use schemars::JsonSchema;
use serde_json::Value;

pub fn schema_of<T: JsonSchema>() -> Value {
    let mut value = serde_json::to_value(schemars::schema_for!(T)).unwrap_or_else(|_| {
        serde_json::json!({
            "type": "object",
            "properties": {}
        })
    });
    strip_nulls(&mut value);
    if let Some(object) = value.as_object_mut() {
        object.remove("$schema");
        object.remove("title");
    }
    value
}

pub fn set_property_description(schema: &mut Value, property: &str, description: &str) {
    let Some(entry) = property_mut(schema, property) else {
        return;
    };
    if let Some(object) = entry.as_object_mut() {
        object.insert(
            "description".to_string(),
            Value::String(description.to_string()),
        );
    }
}

pub fn set_property_enum(schema: &mut Value, property: &str, values: &[&str]) {
    let Some(entry) = property_mut(schema, property) else {
        return;
    };
    if let Some(object) = entry.as_object_mut() {
        object.insert(
            "enum".to_string(),
            Value::Array(
                values
                    .iter()
                    .map(|value| Value::String((*value).to_string()))
                    .collect(),
            ),
        );
    }
}

#[macro_export]
macro_rules! anchor_schema {
    ($ty:ident { $($field:ident),+ $(,)? }) => {{
        let value = $ty {
            $($field: ::core::default::Default::default(),)+
        };
        let _kept = ( $( value.$field ),+ );
        let _ = _kept;
    }};
}

pub fn set_property_type(schema: &mut Value, property: &str, ty: &str) {
    let Some(entry) = property_mut(schema, property) else {
        return;
    };
    if let Some(object) = entry.as_object_mut() {
        object.insert("type".to_string(), Value::String(ty.to_string()));
        if ty == "integer" {
            object.remove("format");
        }
    }
}

fn strip_nulls(value: &mut Value) {
    let Value::Object(map) = value else {
        if let Value::Array(items) = value {
            for item in items {
                strip_nulls(item);
            }
        }
        return;
    };
    for key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(options)) = map.get_mut(key) {
            for option in options {
                strip_nulls(option);
            }
        }
    }
    collapse_union(map, "anyOf");
    collapse_union(map, "oneOf");
    collapse_type_array(map);
    let keys: Vec<String> = map.keys().cloned().collect();
    for key in keys {
        if key == "anyOf" || key == "oneOf" {
            continue;
        }
        if let Some(child) = map.get_mut(&key) {
            strip_nulls(child);
        }
    }
}

fn collapse_union(map: &mut serde_json::Map<String, Value>, key: &str) {
    let Some(Value::Array(options)) = map.get(key).cloned() else {
        return;
    };
    let kept: Vec<Value> = options
        .into_iter()
        .filter(|option| !is_null_schema(option))
        .collect();
    if kept.len() == 1 {
        map.remove(key);
        if let Some(Value::Object(child)) = kept.into_iter().next() {
            for (child_key, child_value) in child {
                map.entry(child_key).or_insert(child_value);
            }
        }
        collapse_type_array(map);
    } else {
        map.insert(key.to_string(), Value::Array(kept));
    }
}

fn collapse_type_array(map: &mut serde_json::Map<String, Value>) {
    let Some(Value::Array(types)) = map.get("type").cloned() else {
        return;
    };
    let kept: Vec<Value> = types
        .into_iter()
        .filter(|item| item.as_str() != Some("null"))
        .collect();
    match kept.len() {
        0 => {
            map.remove("type");
        }
        1 => {
            if let Some(one) = kept.into_iter().next() {
                map.insert("type".to_string(), one);
            }
        }
        _ => {
            map.insert("type".to_string(), Value::Array(kept));
        }
    }
}

fn is_null_schema(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("null")
}

fn property_mut<'a>(schema: &'a mut Value, property: &str) -> Option<&'a mut Value> {
    schema
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .and_then(|properties| properties.get_mut(property))
}
