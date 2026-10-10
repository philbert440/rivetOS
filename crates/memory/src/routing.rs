use crate::error::StoreError;
use crate::store::{
    BrowseFilter, CaptureBatch, CaptureOptions, CaptureResult, HealthReport, HistoryMessage,
    IngestInput, IngestOutput, MemoryEntry, MemoryStore, SearchOptions, StatsReport, ToolDescriptor,
};
use serde_json::{Map, Value};

pub fn user_from_session_key(session_id: &str) -> Option<&str> {
    if session_id.starts_with("task:") {
        return None;
    }
    let idx = session_id.rfind(':')?;
    if idx + 1 >= session_id.len() {
        return None;
    }
    Some(&session_id[idx + 1..])
}

pub enum StoreHandle<S> {
    Live(S),
    Blocked(String),
}

impl<S> StoreHandle<S> {
    fn refuse(&self) -> Option<StoreError> {
        match self {
            Self::Blocked(id) => Some(StoreError::Unavailable(format!(
                "memory for user \"{id}\" is unavailable (store failed to initialize)"
            ))),
            Self::Live(_) => None,
        }
    }
}

pub struct RoutingMemory<S> {
    pub main: StoreHandle<S>,
    pub by_user: Vec<(String, StoreHandle<S>)>,
}

impl<S> RoutingMemory<S> {
    fn for_user(&self, user_id: Option<&str>) -> Result<&StoreHandle<S>, StoreError> {
        let handle = match user_id {
            None => &self.main,
            Some(id) => self
                .by_user
                .iter()
                .find(|(key, _)| key == id)
                .map(|(_, handle)| handle)
                .unwrap_or(&self.main),
        };
        if let Some(err) = handle.refuse() {
            return Err(err);
        }
        Ok(handle)
    }

    fn live<'a>(&'a self, handle: &'a StoreHandle<S>) -> Result<&'a S, StoreError> {
        match handle {
            StoreHandle::Live(store) => Ok(store),
            StoreHandle::Blocked(id) => Err(StoreError::Unavailable(format!(
                "memory for user \"{id}\" is unavailable (store failed to initialize)"
            ))),
        }
    }
}

impl<S: MemoryStore + Send + Sync> MemoryStore for RoutingMemory<S> {
    async fn append(&self, entry: &MemoryEntry) -> Result<String, StoreError> {
        let handle = self.for_user(user_from_session_key(&entry.session_id))?;
        self.live(handle)?.append(entry).await
    }

    async fn search(&self, query: &str, options: &SearchOptions) -> Result<Value, StoreError> {
        let handle = self.for_user(options.user_id.as_deref())?;
        self.live(handle)?.search(query, options).await
    }

    async fn get_context_for_turn(
        &self,
        query: &str,
        agent: &str,
        user_id: Option<&str>,
    ) -> Result<String, StoreError> {
        let handle = self.for_user(user_id)?;
        self.live(handle)?.get_context_for_turn(query, agent, user_id).await
    }

    async fn get_session_history(
        &self,
        session_id: &str,
        limit: Option<i64>,
    ) -> Result<Vec<HistoryMessage>, StoreError> {
        let handle = self.for_user(user_from_session_key(session_id))?;
        self.live(handle)?.get_session_history(session_id, limit).await
    }

    async fn get_task_history(
        &self,
        task_id: &str,
        limit: Option<i64>,
    ) -> Result<Vec<HistoryMessage>, StoreError> {
        match &self.main {
            StoreHandle::Live(store) => store.get_task_history(task_id, limit).await,
            StoreHandle::Blocked(_) => Ok(Vec::new()),
        }
    }

    async fn save_session_settings(
        &self,
        session_id: &str,
        settings: &Map<String, Value>,
    ) -> Result<(), StoreError> {
        let handle = self.for_user(user_from_session_key(session_id))?;
        self.live(handle)?.save_session_settings(session_id, settings).await
    }

    async fn load_session_settings(
        &self,
        session_id: &str,
    ) -> Result<Option<Map<String, Value>>, StoreError> {
        let handle = self.for_user(user_from_session_key(session_id))?;
        self.live(handle)?.load_session_settings(session_id).await
    }

    async fn capture(
        &self,
        batch: &CaptureBatch,
        options: &CaptureOptions,
    ) -> Result<CaptureResult, StoreError> {
        self.live(&self.main)?.capture(batch, options).await
    }

    async fn browse(&self, filter: &BrowseFilter) -> Result<Value, StoreError> {
        self.live(&self.main)?.browse(filter).await
    }

    async fn stats(&self) -> Result<StatsReport, StoreError> {
        self.live(&self.main)?.stats().await
    }

    async fn health(&self, owner: bool) -> Result<HealthReport, StoreError> {
        self.live(&self.main)?.health(owner).await
    }

    fn tools(&self) -> Vec<ToolDescriptor> {
        match &self.main {
            StoreHandle::Live(store) => store.tools(),
            StoreHandle::Blocked(_) => Vec::new(),
        }
    }

    async fn tags(&self) -> Result<(), StoreError> {
        self.live(&self.main)?.tags().await
    }

    fn wiki(&self) -> Option<String> {
        match &self.main {
            StoreHandle::Live(store) => store.wiki(),
            StoreHandle::Blocked(_) => None,
        }
    }

    async fn ingest_session(&self, input: &IngestInput) -> Result<IngestOutput, StoreError> {
        let handle = self.for_user(user_from_session_key(&input.session_id))?;
        self.live(handle)?.ingest_session(input).await
    }

    async fn get_full(&self, id: &str) -> Result<String, StoreError> {
        self.live(&self.main)?.get_full(id).await
    }
}
