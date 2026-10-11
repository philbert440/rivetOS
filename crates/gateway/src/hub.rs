use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use identity::UserContext;
use parking_lot::Mutex;
use serde_json::{Value, json};
use session_events::{
    AgentEvent, AgentEventBody, DenState, RoomState, SessionInfo, forget_session,
    initial_den_state, list_sessions, parse_event_str, reduce_den, snapshot_frame,
};
use tokio::sync::mpsc::Sender;

use crate::session_key::den_join_key;
use crate::session_owners::SessionOwners;

pub const MAX_BUFFERED: u64 = 1024 * 1024;

#[derive(Debug)]
pub enum IngestFail {
    Json,
    Batch,
    Event { index: Option<usize> },
}

pub enum Fanout {
    Text(String),
    Shutdown,
}

struct Viewer {
    id: u64,
    session: Option<String>,
    user: Option<UserContext>,
    tx: Sender<Fanout>,
    buffered: Arc<AtomicU64>,
}

struct Inner {
    state: DenState,
    owners: SessionOwners,
    viewers: Vec<Viewer>,
    evict_gen: HashMap<String, u64>,
    next_viewer: u64,
    evict_seq: u64,
}

#[derive(Clone)]
pub struct Hub {
    inner: Arc<Mutex<Inner>>,
    evict_ttl_ms: i64,
}

impl Hub {
    pub fn open(owners_file: String, evict_ttl_ms: i64) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                state: initial_den_state(),
                owners: SessionOwners::load(owners_file),
                viewers: Vec::new(),
                evict_gen: HashMap::new(),
                next_viewer: 1,
                evict_seq: 1,
            })),
            evict_ttl_ms,
        }
    }

    pub fn room_count(&self) -> usize {
        self.inner.lock().state.rooms.len()
    }

    pub fn sessions(&self, user: Option<&UserContext>) -> Vec<SessionInfo> {
        let inner = self.inner.lock();
        list_sessions(&inner.state)
            .into_iter()
            .filter(|info| visible(&inner.owners, user, &info.id))
            .collect()
    }

    pub fn room(&self, raw_session: &str) -> Option<(String, RoomState)> {
        let id = den_join_key(raw_session);
        let inner = self.inner.lock();
        inner.state.rooms.get(&id).cloned().map(|room| (id, room))
    }

    pub fn known(&self, raw_session: &str) -> bool {
        let id = den_join_key(raw_session);
        self.inner.lock().state.rooms.get(&id).is_some()
    }

    pub fn forbidden(&self, session_id: &str, user: Option<&UserContext>) -> bool {
        let Some(user) = user else {
            return false;
        };
        !self.inner.lock().owners.visible(session_id, user, None)
    }

    pub fn ingest_text(&self, events_batch: bool, body: &str) -> Result<usize, IngestFail> {
        let value = protocol::js::parse(body).map_err(|_| IngestFail::Json)?;
        if events_batch {
            let Some(items) = value.as_array() else {
                return Err(IngestFail::Batch);
            };
            if items.is_empty() || items.len() > 100 {
                return Err(IngestFail::Batch);
            }
            let mut parsed = Vec::with_capacity(items.len());
            for (index, item) in items.iter().enumerate() {
                let text = protocol::js::stringify(item);
                let Some(event) = parse_event_str(&text) else {
                    return Err(IngestFail::Event { index: Some(index) });
                };
                parsed.push(event);
            }
            let count = parsed.len();
            for event in parsed {
                self.apply(event);
            }
            return Ok(count);
        }
        let text = protocol::js::stringify(&value);
        let Some(event) = parse_event_str(&text) else {
            return Err(IngestFail::Event { index: None });
        };
        self.apply(event);
        Ok(1)
    }

    fn apply(&self, event: AgentEvent) {
        let session = event.session().to_string();
        let ended = matches!(event.body(), AgentEventBody::SessionEnd);
        let frame = serde_json::to_string(&event).unwrap_or_default();
        let generation = {
            let mut inner = self.inner.lock();
            let previous = std::mem::replace(&mut inner.state, initial_den_state());
            inner.state = reduce_den(previous, &event);
            inner.evict_seq = inner.evict_seq.wrapping_add(1);
            let generation = inner.evict_seq;
            if ended {
                inner.evict_gen.insert(session.clone(), generation);
            } else {
                inner.evict_gen.remove(&session);
            }
            fanout(&mut inner, &frame, Some(session.as_str()));
            generation
        };
        if ended {
            let ttl = Duration::from_millis(u64::try_from(self.evict_ttl_ms).unwrap_or(0));
            let hub = self.clone();
            let session_key = session;
            tokio::spawn(async move {
                tokio::time::sleep(ttl).await;
                hub.evict_if(&session_key, generation);
            });
        }
    }

    fn evict_if(&self, session: &str, generation: u64) {
        let mut inner = self.inner.lock();
        if inner.evict_gen.get(session).copied() != Some(generation) {
            return;
        }
        inner.evict_gen.remove(session);
        drop_session(&mut inner, session);
    }

    pub fn remove_session(&self, raw_session: &str) -> bool {
        let id = den_join_key(raw_session);
        if id.is_empty() {
            return false;
        }
        let mut inner = self.inner.lock();
        if inner.state.rooms.get(&id).is_none() {
            return false;
        }
        inner.evict_gen.remove(&id);
        drop_session(&mut inner, &id);
        true
    }

    pub fn snapshot_json(&self, raw_session: Option<&str>, user: Option<&UserContext>) -> String {
        let inner = self.inner.lock();
        let resolved = raw_session.map(den_join_key);
        let mut frame = snapshot_frame(&inner.state, resolved.as_deref());
        frame
            .sessions
            .retain(|info| visible(&inner.owners, user, &info.id));
        if resolved.is_none() {
            let owners = &inner.owners;
            frame.rooms.retain(|id, _| visible(owners, user, id));
        }
        serde_json::to_string(&frame).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn local_latest(&self) -> Option<Value> {
        let inner = self.inner.lock();
        let sessions = list_sessions(&inner.state);
        let info = sessions.first()?;
        let room = inner.state.rooms.get(&info.id)?;
        Some(json!({
            "activity": room.activity,
            "title": room.title.to_utf8(),
        }))
    }

    pub fn subscribe(
        &self,
        session: Option<String>,
        user: Option<UserContext>,
        tx: Sender<Fanout>,
        buffered: Arc<AtomicU64>,
    ) -> u64 {
        let mut inner = self.inner.lock();
        let id = inner.next_viewer;
        inner.next_viewer = inner.next_viewer.wrapping_add(1);
        inner.viewers.push(Viewer {
            id,
            session,
            user,
            tx,
            buffered,
        });
        id
    }

    pub fn unsubscribe(&self, id: u64) {
        self.inner.lock().viewers.retain(|viewer| viewer.id != id);
    }

    pub fn close_viewers(&self) {
        let mut inner = self.inner.lock();
        for viewer in inner.viewers.drain(..) {
            let _ = viewer.tx.try_send(Fanout::Shutdown);
        }
    }
}

fn drop_session(inner: &mut Inner, session: &str) {
    forget_session(&mut inner.state, session);
    let frame = json!({
        "type": "session.removed",
        "v": 1,
        "session": session,
    })
    .to_string();
    fanout(inner, &frame, Some(session));
}

fn visible(owners: &SessionOwners, user: Option<&UserContext>, session_id: &str) -> bool {
    match user {
        Some(user) => owners.visible(session_id, user, None),
        None => true,
    }
}

fn fanout(inner: &mut Inner, frame: &str, session: Option<&str>) {
    inner.viewers.retain(|viewer| {
        if let (Some(filter), Some(session)) = (viewer.session.as_deref(), session)
            && filter != session
        {
            return true;
        }
        if let (Some(session), Some(user)) = (session, viewer.user.as_ref())
            && !inner.owners.visible(session, user, None)
        {
            return true;
        }
        let len = u64::try_from(frame.len()).unwrap_or(u64::MAX);
        let queued = viewer.buffered.load(Ordering::Relaxed);
        if queued.saturating_add(len) > MAX_BUFFERED
            || viewer.tx.try_send(Fanout::Text(frame.to_string())).is_err()
        {
            let _ = viewer.tx.try_send(Fanout::Shutdown);
            return false;
        }
        viewer.buffered.fetch_add(len, Ordering::Relaxed);
        true
    });
}

pub fn joined_session(raw: Option<&str>) -> Option<String> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    Some(den_join_key(raw))
}
