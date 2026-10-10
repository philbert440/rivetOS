use std::str::FromStr;

use serde::de::{self, Deserializer};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};

use protocol::js::JsValue;

use crate::event::js_from_deserializer;
use crate::ordered::OrderedMap;
use crate::reducer::{
    DenState, RoomState, SessionInfo, initial_room_state, list_sessions, room_from_js,
};
use crate::{JsNumber, PROTOCOL_VERSION};

protocol::wire_enum! {
    pub enum SnapshotType {
        Snapshot => "snapshot",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotFrame {
    pub v: JsNumber,
    pub sessions: Vec<SessionInfo>,
    pub rooms: OrderedMap<RoomState>,
}

impl Serialize for SnapshotFrame {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(4))?;
        map.serialize_entry("type", SnapshotType::Snapshot.as_str())?;
        map.serialize_entry("v", &self.v)?;
        map.serialize_entry("sessions", &self.sessions)?;
        map.serialize_entry("rooms", &self.rooms)?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for SnapshotFrame {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = js_from_deserializer(deserializer)?;
        let obj = value
            .as_object()
            .ok_or_else(|| de::Error::custom("snapshot"))?;
        let kind = obj
            .get("type")
            .and_then(JsValue::as_str)
            .ok_or_else(|| de::Error::custom("type"))?;
        if SnapshotType::from_str(kind).ok().as_ref() != Some(&SnapshotType::Snapshot) {
            return Err(de::Error::custom("type"));
        }
        let version = match obj.get("v") {
            Some(JsValue::Number(number)) => *number,
            _ => return Err(de::Error::custom("v")),
        };
        if version != f64::from(PROTOCOL_VERSION) {
            return Err(de::Error::custom("v"));
        }
        let sessions = sessions_from_js(
            obj.get("sessions")
                .ok_or_else(|| de::Error::custom("sessions"))?,
        )
        .ok_or_else(|| de::Error::custom("sessions"))?;
        let rooms = rooms_from_js(obj.get("rooms").ok_or_else(|| de::Error::custom("rooms"))?)
            .ok_or_else(|| de::Error::custom("rooms"))?;
        Ok(Self {
            v: JsNumber::from(version),
            sessions,
            rooms,
        })
    }
}

fn sessions_from_js(value: &JsValue) -> Option<Vec<SessionInfo>> {
    value.as_array()?.iter().map(session_from_js).collect()
}

fn session_from_js(value: &JsValue) -> Option<SessionInfo> {
    let object = value.as_object()?;
    let harness = match object.get("harness") {
        None | Some(JsValue::Null) => None,
        Some(text) => Some(text.as_str()?.to_string()),
    };
    let last_event_ts = match object.get("lastEventTs") {
        None | Some(JsValue::Null) => None,
        Some(JsValue::Number(number)) if number.is_finite() => Some(JsNumber::from(*number)),
        Some(_) => return None,
    };
    Some(SessionInfo {
        id: object.get("id")?.as_str()?.to_string(),
        name: object.get("name")?.as_str()?.to_string(),
        harness,
        last_event_ts,
    })
}

fn rooms_from_js(value: &JsValue) -> Option<OrderedMap<RoomState>> {
    let mut rooms = OrderedMap::new();
    for (key, room) in value.as_object()?.iter() {
        rooms.insert(key.to_utf8().to_string(), room_from_js(room)?);
    }
    Some(rooms)
}

pub fn snapshot_frame(state: &DenState, session: Option<&str>) -> SnapshotFrame {
    let rooms = match session {
        Some(session) => {
            let mut rooms = OrderedMap::new();
            let room = state
                .rooms
                .get(session)
                .cloned()
                .unwrap_or_else(initial_room_state);
            rooms.insert(session.to_string(), room);
            rooms
        }
        None => state.rooms.clone(),
    };
    SnapshotFrame {
        v: JsNumber::from(PROTOCOL_VERSION),
        sessions: list_sessions(state),
        rooms,
    }
}
