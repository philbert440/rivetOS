use serde_json::{Map, Value};

use super::Issues;
use super::keys;
use super::value::utf16_len;

pub(crate) fn validate_channels(channels: &Map<String, Value>, issues: &mut Issues) {
    for (name, channel_cfg) in channels {
        let path = format!("channels.{name}");
        let Some(channel) = channel_cfg.as_object() else {
            issues.error(&path, format!("Channel \"{name}\" must be an object"));
            continue;
        };
        if name != "agent" {
            issues.warning(
                &path,
                format!("Unknown channel type \"{name}\" — make sure a registrar handles it"),
            );
        } else {
            for key in channel.keys() {
                if !keys::has(keys::KNOWN_CHANNEL_AGENT, key) {
                    issues.warning(
                        format!("{path}.{key}"),
                        format!("Unknown key \"{key}\" for channel type \"{name}\""),
                    );
                }
            }
        }
        if let Some(token) = channel.get("bot_token").and_then(Value::as_str)
            && !token.contains("${")
            && utf16_len(token) > 20
        {
            issues.warning(
                    format!("{path}.bot_token"),
                    format!(
                        "Channel \"{name}\" appears to have a hardcoded bot token — use environment variables instead"
                    ),
                );
        }
    }
}
