use std::str::FromStr;

use serde::de::{self, Deserializer};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ordered::OrderedMap;
use crate::reducer::{DenState, RoomState, SessionInfo, initial_room_state, list_sessions};
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
        let value = Value::deserialize(deserializer)?;
        let obj = value
            .as_object()
            .ok_or_else(|| de::Error::custom("snapshot"))?;
        let kind = obj
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| de::Error::custom("type"))?;
        if SnapshotType::from_str(kind).ok().as_ref() != Some(&SnapshotType::Snapshot) {
            return Err(de::Error::custom("type"));
        }
        let version = obj
            .get("v")
            .and_then(Value::as_f64)
            .ok_or_else(|| de::Error::custom("v"))?;
        if version != f64::from(PROTOCOL_VERSION) {
            return Err(de::Error::custom("v"));
        }
        let sessions = serde_json::from_value(
            obj.get("sessions")
                .cloned()
                .ok_or_else(|| de::Error::custom("sessions"))?,
        )
        .map_err(de::Error::custom)?;
        let rooms = serde_json::from_value(
            obj.get("rooms")
                .cloned()
                .ok_or_else(|| de::Error::custom("rooms"))?,
        )
        .map_err(de::Error::custom)?;
        Ok(Self {
            v: JsNumber::from(version),
            sessions,
            rooms,
        })
    }
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
