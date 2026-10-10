use schemars::JsonSchema;
use serde_json::Value;

pub fn schema_of<T: JsonSchema>() -> Value {
    serde_json::to_value(schemars::schema_for!(T)).unwrap_or_else(|_| {
        serde_json::json!({
            "type": "object",
            "properties": {}
        })
    })
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

fn property_mut<'a>(schema: &'a mut Value, property: &str) -> Option<&'a mut Value> {
    schema
        .get_mut("properties")
        .and_then(Value::as_object_mut)
        .and_then(|properties| properties.get_mut(property))
}
