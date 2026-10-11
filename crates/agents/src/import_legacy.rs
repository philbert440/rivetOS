use std::path::Path;

use protocol::js::{JsString, js_slice_units, js_trim_units};

use crate::error::PresetError;
use crate::file_store::FileAgentPresetStore;
use crate::preset::{AgentPreset, AgentPresetInput, AgentRegistryBackend};
use crate::store::{AgentPresetStore, system_now_ms};
use crate::validate::{default_directory_for, resolve_fs, validate_directory_str};

pub struct UnresolvedAgent {
    pub id: String,
    pub name: String,
}

pub struct ImportLegacyAgentsResult {
    pub imported: u64,
    pub skipped: u64,
    pub renamed: u64,
    pub renamed_to: Option<String>,
    pub reason: Option<String>,
    pub rows: Option<Vec<AgentPreset>>,
    pub unresolved: Option<Vec<UnresolvedAgent>>,
}

pub struct ImportLegacyAgentsArgs<'a> {
    pub file: &'a str,
    pub store: &'a dyn AgentPresetStore,
    pub node: &'a str,
    pub directory_root: &'a str,
    pub log: Option<&'a (dyn Fn(&str) + Send + Sync)>,
}

pub async fn import_legacy_agents_json(
    args: ImportLegacyAgentsArgs<'_>,
) -> Result<ImportLegacyAgentsResult, PresetError> {
    let file = args.file.to_string();
    if !path_exists(&file).await? {
        return Ok(empty_result());
    }
    if args.store.backend() == AgentRegistryBackend::File
        && let Some(store_file) = args.store.file()
        && resolve_fs(&store_file) == resolve_fs(&file)
    {
        return Ok(ImportLegacyAgentsResult {
            imported: 0,
            skipped: 0,
            renamed: 0,
            renamed_to: None,
            reason: Some("store is the source file".to_string()),
            rows: None,
            unresolved: None,
        });
    }
    let legacy = FileAgentPresetStore::new(file.clone());
    let rows = legacy.list(None).await?;
    let mut imported = 0u64;
    let mut skipped = 0u64;
    let mut renamed = 0u64;
    let mut imported_rows = Vec::new();
    let mut unresolved = Vec::new();
    for row in rows {
        let outcome = import_one(&args, &row).await?;
        match outcome {
            OneImport::Imported {
                preset,
                was_renamed,
            } => {
                if was_renamed {
                    renamed += 1;
                }
                imported_rows.push(*preset);
                imported += 1;
            }
            OneImport::Skipped => skipped += 1,
            OneImport::Unresolved { id, name } => unresolved.push(UnresolvedAgent { id, name }),
        }
    }
    log(
        args.log,
        &format!("legacy agents import: imported={imported} skipped={skipped} renamed={renamed}"),
    );
    let mut outcome = ImportLegacyAgentsResult {
        imported,
        skipped,
        renamed,
        renamed_to: None,
        reason: None,
        rows: Some(imported_rows),
        unresolved: if unresolved.is_empty() {
            None
        } else {
            Some(unresolved)
        },
    };
    if !path_exists(&file).await? {
        log(
            args.log,
            &format!("legacy agents file {file} was quarantined and not renamed to .imported"),
        );
        return Ok(outcome);
    }
    if outcome.unresolved.is_some() {
        let count = outcome
            .unresolved
            .as_ref()
            .map(|rows| rows.len())
            .unwrap_or(0);
        log(
            args.log,
            &format!(
                "legacy agents file {file} left in place; {count} row(s) could not be imported"
            ),
        );
        return Ok(outcome);
    }
    let renamed_to = format!("{file}.imported-{}", system_now_ms());
    let dest = renamed_to.clone();
    let source = file.clone();
    tokio::task::spawn_blocking(move || std::fs::rename(&source, &dest))
        .await
        .map_err(|err| PresetError::message(err.to_string()))??;
    outcome.renamed_to = Some(renamed_to);
    Ok(outcome)
}

enum OneImport {
    Imported {
        preset: Box<AgentPreset>,
        was_renamed: bool,
    },
    Skipped,
    Unresolved {
        id: String,
        name: String,
    },
}

async fn import_one(
    args: &ImportLegacyAgentsArgs<'_>,
    row: &AgentPreset,
) -> Result<OneImport, PresetError> {
    let validated = row
        .directory
        .as_ref()
        .and_then(|directory| validate_directory_str(Some(directory.to_utf8())));
    let directory = match validated {
        Some(directory) => JsString::from_text(&directory),
        None => {
            let directory = default_directory_for(args.directory_root, row.name.to_utf8());
            log(
                args.log,
                &format!(
                    "legacy agent {} ({}): directory missing or invalid; using {directory}",
                    row.id, row.name
                ),
            );
            JsString::from_text(&directory)
        }
    };
    let base = JsString::from_units(js_trim_units(row.name.units()).to_vec());
    let id_suffix = JsString::from_units(js_slice_units(row.id.units(), Some(0.0), Some(8.0)));
    let mut candidates = vec![
        base.clone(),
        extend_units(base.units(), &format!(" ({})", args.node)),
    ];
    for index in 2..=19 {
        candidates.push(extend_units(
            base.units(),
            &format!(" ({} {index})", args.node),
        ));
    }
    let mut suffix_name = base.units().to_vec();
    suffix_name.extend(format!(" ({} ", args.node).encode_utf16());
    suffix_name.extend(id_suffix.units().iter().copied());
    suffix_name.push(u16::from(b')'));
    candidates.push(JsString::from_units(suffix_name));
    for (attempt, candidate) in candidates.iter().enumerate() {
        let input = AgentPresetInput {
            name: candidate.clone(),
            color: Some(row.color.clone()),
            harness_id: row.harness_id.clone(),
            model: Some(row.model.clone()),
            effort: Some(row.effort.clone()),
            system_prompt: Some(row.system_prompt.clone()),
            node: JsString::from_text(args.node),
            directory: directory.clone(),
            shared_link: row.shared_link,
            node_base_url: row.node_base_url.clone(),
            id: Some(row.id.clone()),
            created_at: row.created_at.as_i64(),
            source: None,
        };
        match args.store.create(input).await {
            Ok(created) => {
                if attempt > 0 {
                    log(
                        args.log,
                        &format!(
                            "imported legacy agent {} ({base}) as \"{}\" after a name conflict",
                            row.id, created.name
                        ),
                    );
                }
                return Ok(OneImport::Imported {
                    preset: Box::new(created),
                    was_renamed: attempt > 0,
                });
            }
            Err(err) if err.is_conflict() => {
                if err.is_id_conflict() {
                    log(
                        args.log,
                        &format!("skipped legacy agent {} ({}): {err}", row.id, row.name),
                    );
                    return Ok(OneImport::Skipped);
                }
                log(
                    args.log,
                    &format!("legacy agent {} ({base}) name conflict: {err}", row.id),
                );
            }
            Err(err) => return Err(err),
        }
    }
    log(
        args.log,
        &format!(
            "legacy agent {} ({base}) was not imported; source file left in place",
            row.id
        ),
    );
    Ok(OneImport::Unresolved {
        id: row.id.to_utf8().to_string(),
        name: base.to_utf8().to_string(),
    })
}

fn extend_units(base: &[u16], extra: &str) -> JsString {
    let mut units = base.to_vec();
    units.extend(extra.encode_utf16());
    JsString::from_units(units)
}

fn empty_result() -> ImportLegacyAgentsResult {
    ImportLegacyAgentsResult {
        imported: 0,
        skipped: 0,
        renamed: 0,
        renamed_to: None,
        reason: None,
        rows: None,
        unresolved: None,
    }
}

fn log(logger: Option<&(dyn Fn(&str) + Send + Sync)>, message: &str) {
    if let Some(logger) = logger {
        logger(message);
    }
}

async fn path_exists(file: &str) -> Result<bool, PresetError> {
    let file = file.to_string();
    tokio::task::spawn_blocking(move || Path::new(&file).exists())
        .await
        .map_err(|err| PresetError::message(err.to_string()))
}
