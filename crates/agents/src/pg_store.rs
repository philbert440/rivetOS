use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use chrono::{DateTime, Utc};
use protocol::JsNumber;
use protocol::js::JsString;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};

use crate::error::{MIGRATION_0018, PresetError};
use crate::preset::{
    AgentPreset, AgentPresetInput, AgentPresetPatch, AgentRegistryBackend, HarnessPatch,
    PresetColumns, SortPatch, catalog_pairs, migrate_fields, preset_from_columns,
    require_agent_name,
};
use crate::store::{
    AgentPresetStore, BoxFuture, find_preset_by_handle, preset_from_create, sort_presets,
    system_now_ms,
};

const QUERY_TIMEOUT: Duration = Duration::from_secs(10);

enum SqlArg {
    Text(String),
    Int8(i64),
    Bool(bool),
    Time(DateTime<Utc>),
    NullText,
    NullInt,
}

struct Binder {
    args: Vec<SqlArg>,
}

impl Binder {
    fn new() -> Self {
        Self { args: Vec::new() }
    }

    fn push(&mut self, arg: SqlArg) -> String {
        let cast = match &arg {
            SqlArg::Text(_) | SqlArg::NullText => "text",
            SqlArg::NullInt => "int4",
            SqlArg::Int8(_) => "int8",
            SqlArg::Bool(_) => "bool",
            SqlArg::Time(_) => "timestamptz",
        };
        self.args.push(arg);
        format!("${}::{cast}", self.args.len())
    }

    fn text(&mut self, value: &str) -> String {
        self.push(SqlArg::Text(value.to_string()))
    }

    fn int4_from_i64(&mut self, value: i64) -> String {
        let slot = self.push(SqlArg::Int8(value));
        format!("({slot})::int4")
    }

    fn boolean(&mut self, value: bool) -> String {
        self.push(SqlArg::Bool(value))
    }

    fn time(&mut self, value: DateTime<Utc>) -> String {
        self.push(SqlArg::Time(value))
    }

    fn null_text(&mut self) -> String {
        self.push(SqlArg::NullText)
    }

    fn null_int(&mut self) -> String {
        self.push(SqlArg::NullInt)
    }
}

struct MigratedSql {
    harness: String,
    model: String,
}

fn harness_from_model_sql(model_expr: &str, binder: &mut Binder) -> String {
    let pairs = catalog_pairs();
    let rows = pairs
        .iter()
        .map(|(model, harness)| format!("({}, {})", binder.text(model), binder.text(harness)))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "(SELECT v.harness FROM (VALUES {rows}) AS v(catalog_model, harness) WHERE v.catalog_model = {model_expr})"
    )
}

fn read_migrated(binder: &mut Binder) -> MigratedSql {
    let mapped = harness_from_model_sql("model", binder);
    MigratedSql {
        harness: format!("CASE WHEN harness_id IS NULL THEN {mapped} ELSE harness_id END"),
        model: format!(
            "CASE WHEN harness_id IS NULL AND ({mapped}) IS NOT NULL THEN '' ELSE model END"
        ),
    }
}

fn push_set(sets: &mut Vec<String>, column: &str, placeholder: &str) {
    sets.push(format!("{column} = {placeholder}"));
}

fn push_harness_sets(sets: &mut Vec<String>, binder: &mut Binder, patch: &AgentPresetPatch) {
    match (&patch.harness, &patch.model) {
        (HarnessPatch::Clear, Some(model)) => {
            let migrated = migrate_fields(model.to_utf8(), None);
            push_set(sets, "model", &binder.text(&migrated.model));
            match &migrated.harness_id {
                Some(id) => push_set(sets, "harness_id", &binder.text(id)),
                None => push_set(sets, "harness_id", &binder.null_text()),
            }
        }
        (HarnessPatch::Clear, None) => {
            let migrated = read_migrated(binder);
            let mapped = harness_from_model_sql(&format!("({})", migrated.model), binder);
            sets.push(format!("harness_id = {mapped}"));
            sets.push(format!(
                "model = CASE WHEN ({mapped}) IS NOT NULL THEN '' ELSE ({}) END",
                migrated.model
            ));
        }
        (HarnessPatch::Set(id), model) => {
            push_set(sets, "harness_id", &binder.text(id));
            if let Some(model) = model {
                push_set(sets, "model", &binder.text(model.to_utf8()));
            } else {
                let migrated = read_migrated(binder);
                sets.push(format!("model = ({})", migrated.model));
            }
        }
        (HarnessPatch::Unchanged, Some(model)) => {
            let migrated = read_migrated(binder);
            let patch_model = binder.text(model.to_utf8());
            let mapped = harness_from_model_sql(&patch_model, binder);
            sets.push(format!(
                "harness_id = COALESCE(({}), {mapped})",
                migrated.harness
            ));
            sets.push(format!(
                "model = CASE WHEN ({}) IS NOT NULL THEN {patch_model} WHEN ({mapped}) IS NOT NULL THEN '' ELSE {patch_model} END",
                migrated.harness
            ));
        }
        (HarnessPatch::Unchanged, None) => {}
    }
}

fn update_statement(
    id: &str,
    patch: &AgentPresetPatch,
    now: i64,
) -> Result<(String, Vec<SqlArg>), PresetError> {
    let mut sets = Vec::new();
    let mut binder = Binder::new();
    if let Some(name) = &patch.name {
        let name = require_agent_name(name)?;
        push_set(&mut sets, "name", &binder.text(name.to_utf8()));
    }
    if let Some(color) = &patch.color {
        push_set(&mut sets, "color", &binder.text(color.to_utf8()));
    }
    if let Some(effort) = &patch.effort {
        push_set(&mut sets, "effort", &binder.text(effort.to_utf8()));
    }
    if let Some(system_prompt) = &patch.system_prompt {
        push_set(
            &mut sets,
            "system_prompt",
            &binder.text(system_prompt.to_utf8()),
        );
    }
    if let Some(directory) = &patch.directory {
        push_set(&mut sets, "directory", &binder.text(directory.to_utf8()));
    }
    if let Some(shared_link) = patch.shared_link {
        push_set(&mut sets, "shared_link", &binder.boolean(shared_link));
    }
    match patch.sort_order {
        SortPatch::Unchanged => {}
        SortPatch::Clear => push_set(&mut sets, "sort_order", &binder.null_int()),
        SortPatch::Set(value) => {
            push_set(&mut sets, "sort_order", &binder.int4_from_i64(value));
        }
    }
    if let Some(url) = &patch.node_base_url {
        push_set(&mut sets, "node_base_url", &binder.text(url.to_utf8()));
    }
    push_harness_sets(&mut sets, &mut binder, patch);
    let when = millis_to_time(now)?;
    push_set(&mut sets, "updated_at", &binder.time(when));
    let id_param = binder.text(id);
    let sql = format!(
        "UPDATE ros_agent_presets SET {} WHERE id = {id_param} RETURNING *",
        sets.join(", ")
    );
    Ok((sql, binder.args))
}

fn millis_to_time(ms: i64) -> Result<DateTime<Utc>, PresetError> {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .ok_or_else(|| PresetError::message(format!("invalid preset timestamp: {ms}")))
}

fn epoch_from_time(time: DateTime<Utc>) -> JsNumber {
    JsNumber::from(time.timestamp_millis())
}

fn parse_constraint(message: &str) -> Option<String> {
    let marker = "constraint \"";
    let start = message.find(marker)? + marker.len();
    let rest = &message[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_string())
}

fn map_db(err: sqlx::Error) -> PresetError {
    if let sqlx::Error::Database(db) = &err {
        if db.code().as_deref() == Some("23505") {
            let constraint = db
                .constraint()
                .map(str::to_string)
                .or_else(|| parse_constraint(db.message()));
            let message = match constraint {
                Some(name) => {
                    format!("agent preset conflicts with an existing id or name ({name})")
                }
                None => "agent preset conflicts with an existing id or name".to_string(),
            };
            return PresetError::conflict(message);
        }
        if db.code().as_deref() == Some("42703") && db.message().contains("sort_order") {
            return PresetError::migration_required(MIGRATION_0018);
        }
    }
    PresetError::message(err.to_string())
}

fn row_to_preset(row: &sqlx::postgres::PgRow) -> Result<AgentPreset, PresetError> {
    let harness: Option<String> = row.try_get("harness_id").map_err(map_db)?;
    let model: String = row.try_get("model").map_err(map_db)?;
    let sort_order = match row.try_get::<Option<i32>, _>("sort_order") {
        Ok(value) => value.map(i64::from),
        Err(sqlx::Error::ColumnNotFound(_)) => None,
        Err(err) => return Err(map_db(err)),
    };
    let created: DateTime<Utc> = row.try_get("created_at").map_err(map_db)?;
    let updated: DateTime<Utc> = row.try_get("updated_at").map_err(map_db)?;
    let id: String = row.try_get("id").map_err(map_db)?;
    let name: String = row.try_get("name").map_err(map_db)?;
    let color: String = row.try_get("color").map_err(map_db)?;
    let effort: String = row.try_get("effort").map_err(map_db)?;
    let system_prompt: String = row.try_get("system_prompt").map_err(map_db)?;
    let node: String = row.try_get("node").map_err(map_db)?;
    let directory: String = row.try_get("directory").map_err(map_db)?;
    let node_base_url: String = row.try_get("node_base_url").map_err(map_db)?;
    preset_from_columns(PresetColumns {
        id: &id,
        name: &name,
        color: &color,
        model: &model,
        effort: &effort,
        system_prompt: &system_prompt,
        node: &node,
        directory: &directory,
        shared_link: row.try_get("shared_link").map_err(map_db)?,
        node_base_url: &node_base_url,
        created_at: epoch_from_time(created),
        updated_at: epoch_from_time(updated),
        sort_order,
        harness_id: harness.as_deref(),
    })
}

async fn fetch_all(
    pool: &PgPool,
    sql: &str,
    args: &[SqlArg],
) -> Result<Vec<sqlx::postgres::PgRow>, PresetError> {
    let mut query = sqlx::query(sqlx::AssertSqlSafe(sql));
    for arg in args {
        query = match arg {
            SqlArg::Text(value) => query.bind(value.clone()),
            SqlArg::Int8(value) => query.bind(*value),
            SqlArg::Bool(value) => query.bind(*value),
            SqlArg::Time(value) => query.bind(*value),
            SqlArg::NullText => query.bind(None::<String>),
            SqlArg::NullInt => query.bind(None::<i32>),
        };
    }
    let pending = query.fetch_all(pool);
    match tokio::time::timeout(QUERY_TIMEOUT, pending).await {
        Ok(Ok(rows)) => Ok(rows),
        Ok(Err(err)) => Err(map_db(err)),
        Err(_) => Err(PresetError::message("preset query timed out after 10000ms")),
    }
}

pub struct PgAgentPresetStore {
    pool: PgPool,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    ready: AtomicBool,
}

impl PgAgentPresetStore {
    pub fn new(pool: PgPool, now: Option<Arc<dyn Fn() -> i64 + Send + Sync>>) -> Self {
        Self {
            pool,
            now: now.unwrap_or_else(|| Arc::new(system_now_ms)),
            ready: AtomicBool::new(false),
        }
    }

    pub fn pool(&self) -> &PgPool {
        &self.pool
    }

    pub async fn connect(url: &str) -> Result<Self, PresetError> {
        let pool = PgPoolOptions::new()
            .max_connections(4)
            .acquire_timeout(QUERY_TIMEOUT)
            .after_connect(|conn, _meta| {
                Box::pin(async move {
                    sqlx::query("SET statement_timeout = '10s'")
                        .execute(&mut *conn)
                        .await?;
                    Ok(())
                })
            })
            .connect(url)
            .await
            .map_err(|err| PresetError::message(err.to_string()))?;
        Ok(Self::new(pool, None))
    }
}

impl AgentPresetStore for PgAgentPresetStore {
    fn backend(&self) -> AgentRegistryBackend {
        AgentRegistryBackend::Postgres
    }

    fn file(&self) -> Option<String> {
        None
    }

    fn is_ready(&self) -> BoxFuture<'_, Result<bool, PresetError>> {
        Box::pin(async move {
            if self.ready.load(Ordering::SeqCst) {
                return Ok(true);
            }
            let rows = fetch_all(
                &self.pool,
                "SELECT to_regclass('ros_agent_presets')::text AS reg",
                &[],
            )
            .await?;
            let ok = rows.first().is_some_and(|row| {
                row.try_get::<Option<String>, _>("reg")
                    .ok()
                    .flatten()
                    .is_some()
            });
            if ok {
                self.ready.store(true, Ordering::SeqCst);
            }
            Ok(ok)
        })
    }

    fn list(&self, node: Option<&str>) -> BoxFuture<'_, Result<Vec<AgentPreset>, PresetError>> {
        let node = node.map(str::to_string);
        Box::pin(async move {
            let args = vec![match &node {
                Some(value) => SqlArg::Text(value.clone()),
                None => SqlArg::NullText,
            }];
            let rows = fetch_all(
                &self.pool,
                "SELECT * FROM ros_agent_presets WHERE ($1::text IS NULL OR node = $1::text) ORDER BY created_at ASC, id ASC",
                &args,
            )
            .await?;
            let mut presets = Vec::new();
            for row in &rows {
                presets.push(row_to_preset(row)?);
            }
            Ok(sort_presets(presets))
        })
    }

    fn get(&self, id: &str) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let id = id.to_string();
        Box::pin(async move {
            let args = vec![SqlArg::Text(id)];
            let rows = fetch_all(
                &self.pool,
                "SELECT * FROM ros_agent_presets WHERE id = $1::text",
                &args,
            )
            .await?;
            match rows.first() {
                Some(row) => Ok(Some(row_to_preset(row)?)),
                None => Ok(None),
            }
        })
    }

    fn find_by_handle(
        &self,
        handle: &JsString,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let needle = JsString::from_units(protocol::js::js_trim_units(handle.units()).to_vec());
        let sql_text = needle.to_utf8().to_string();
        Box::pin(async move {
            let args = vec![SqlArg::Text(sql_text)];
            let rows = fetch_all(
                &self.pool,
                "SELECT * FROM ros_agent_presets WHERE id = $1::text OR name = $1::text OR lower(name) = lower($1::text)",
                &args,
            )
            .await?;
            let mut presets = Vec::new();
            for row in &rows {
                presets.push(row_to_preset(row)?);
            }
            Ok(find_preset_by_handle(&presets, &needle).cloned())
        })
    }

    fn create(&self, input: AgentPresetInput) -> BoxFuture<'_, Result<AgentPreset, PresetError>> {
        let now = Arc::clone(&self.now);
        Box::pin(async move {
            let preset = preset_from_create(&input, &uuid::Uuid::new_v4().to_string(), now())?;
            let node = preset.node.clone().ok_or_else(|| {
                PresetError::message("agent preset node and directory are required")
            })?;
            let directory = preset.directory.clone().ok_or_else(|| {
                PresetError::message("agent preset node and directory are required")
            })?;
            let created = millis_to_time(
                preset
                    .created_at
                    .as_i64()
                    .ok_or_else(|| PresetError::message("invalid preset timestamp"))?,
            )?;
            let updated = millis_to_time(
                preset
                    .updated_at
                    .as_i64()
                    .ok_or_else(|| PresetError::message("invalid preset timestamp"))?,
            )?;
            let args = vec![
                SqlArg::Text(preset.id.to_utf8().to_string()),
                SqlArg::Text(preset.name.to_utf8().to_string()),
                SqlArg::Text(preset.color.to_utf8().to_string()),
                match &preset.harness_id {
                    Some(id) => SqlArg::Text(id.to_utf8().to_string()),
                    None => SqlArg::NullText,
                },
                SqlArg::Text(preset.model.to_utf8().to_string()),
                SqlArg::Text(preset.effort.to_utf8().to_string()),
                SqlArg::Text(preset.system_prompt.to_utf8().to_string()),
                SqlArg::Text(node.to_utf8().to_string()),
                SqlArg::Text(directory.to_utf8().to_string()),
                SqlArg::Bool(preset.shared_link.unwrap_or(true)),
                SqlArg::Text(
                    preset
                        .node_base_url
                        .as_ref()
                        .map(protocol::js::JsString::to_utf8)
                        .unwrap_or("")
                        .to_string(),
                ),
                SqlArg::Time(created),
                SqlArg::Time(updated),
            ];
            let rows = fetch_all(
                &self.pool,
                "INSERT INTO ros_agent_presets (
                    id, name, color, harness_id, model, effort, system_prompt,
                    node, directory, shared_link, node_base_url, created_at, updated_at
                 ) VALUES (
                    $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
                    $8::text, $9::text, $10::bool, $11::text, $12::timestamptz, $13::timestamptz
                 )
                 RETURNING *",
                &args,
            )
            .await?;
            let row = rows
                .first()
                .ok_or_else(|| PresetError::message("insert returned no row"))?;
            row_to_preset(row)
        })
    }

    fn update(
        &self,
        id: &str,
        patch: AgentPresetPatch,
    ) -> BoxFuture<'_, Result<Option<AgentPreset>, PresetError>> {
        let id = id.to_string();
        let now = Arc::clone(&self.now);
        Box::pin(async move {
            let (sql, args) = update_statement(&id, &patch, now())?;
            let rows = fetch_all(&self.pool, &sql, &args).await?;
            match rows.first() {
                Some(row) => Ok(Some(row_to_preset(row)?)),
                None => Ok(None),
            }
        })
    }

    fn delete(&self, id: &str) -> BoxFuture<'_, Result<bool, PresetError>> {
        let id = id.to_string();
        Box::pin(async move {
            let args = vec![SqlArg::Text(id)];
            let rows = fetch_all(
                &self.pool,
                "DELETE FROM ros_agent_presets WHERE id = $1::text RETURNING id",
                &args,
            )
            .await?;
            Ok(!rows.is_empty())
        })
    }
}

#[cfg(test)]
fn max_placeholder(sql: &str) -> usize {
    let bytes = sql.as_bytes();
    let mut index = 0;
    let mut max = 0;
    while index < bytes.len() {
        if bytes[index] == b'$' {
            index += 1;
            let start = index;
            while index < bytes.len() && bytes[index].is_ascii_digit() {
                index += 1;
            }
            if let Ok(value) = sql[start..index].parse::<usize>() {
                max = max.max(value);
            }
        } else {
            index += 1;
        }
    }
    max
}

#[cfg(test)]
fn count_token(sql: &str, token: &str) -> usize {
    sql.match_indices(token).count()
}

#[cfg(test)]
mod tests {
    use super::{count_token, max_placeholder, update_statement};
    use crate::preset::{AgentPresetPatch, HarnessPatch};

    #[test]
    fn clear_harness_reuses_one_values_list() {
        let patch = AgentPresetPatch {
            harness: HarnessPatch::Clear,
            ..AgentPresetPatch::default()
        };
        let (sql, args) = update_statement("id-1", &patch, 1_700_000_000_000).unwrap();
        assert_eq!(max_placeholder(&sql), args.len());
        assert!(sql.contains("CASE WHEN harness_id IS NULL"));
        assert!(count_token(&sql, "$1") >= 2);
    }

    #[test]
    fn oversized_sort_order_is_a_database_cast() {
        let patch = AgentPresetPatch {
            sort_order: crate::preset::SortPatch::Set(i64::from(i32::MAX) + 1),
            ..AgentPresetPatch::default()
        };
        let (sql, args) = update_statement("id-1", &patch, 1_700_000_000_000).unwrap();
        assert_eq!(max_placeholder(&sql), args.len());
        assert!(sql.contains("::int8"));
        assert!(sql.contains("::int4"));
        assert!(!sql.contains("sortOrder must be an integer"));
    }

    #[test]
    fn model_only_reuses_the_old_row_fragment() {
        let patch = AgentPresetPatch {
            model: Some("opus".into()),
            ..AgentPresetPatch::default()
        };
        let (sql, args) = update_statement("id-1", &patch, 1_700_000_000_000).unwrap();
        assert_eq!(max_placeholder(&sql), args.len());
        assert!(sql.contains("CASE WHEN harness_id IS NULL"));
        assert!(count_token(&sql, "$1") >= 2);
        assert!(!sql.contains("sort_order"));
    }
}
