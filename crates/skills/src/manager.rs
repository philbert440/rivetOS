use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use indexmap::IndexMap;

use crate::frontmatter::{extract_triggers_from_description, parse_frontmatter};
use crate::hooks::{SkillAfterContext, SkillBeforeContext, SkillHookPipeline};

#[derive(Debug, Clone, PartialEq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub location: String,
    pub triggers: Vec<String>,
    pub version: Option<i64>,
    pub category: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkillMatch {
    pub name: String,
    pub score: f64,
}

#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    #[error("{0}")]
    Message(String),
}

struct Inner {
    skills: IndexMap<String, Skill>,
    dirs: Vec<String>,
    hooks: Option<Arc<SkillHookPipeline>>,
}

#[derive(Clone)]
pub struct SkillManager {
    inner: Arc<Mutex<Inner>>,
}

impl Default for SkillManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                skills: IndexMap::new(),
                dirs: Vec::new(),
                hooks: None,
            })),
        }
    }

    pub fn set_pipeline(&self, pipeline: Arc<SkillHookPipeline>) {
        self.lock().hooks = Some(pipeline);
    }

    pub async fn discover(&self, dirs: Vec<String>) -> Vec<Skill> {
        {
            let mut inner = self.lock();
            inner.skills.clear();
            inner.dirs = dirs.clone();
        }
        for dir in &dirs {
            let found = scan_dir(dir).await;
            let mut inner = self.lock();
            for skill in found {
                inner.skills.insert(skill.name.clone(), skill);
            }
        }
        let count = self.lock().skills.len();
        tracing::info!("Discovered {count} skills");
        self.list()
    }

    pub async fn rediscover(&self, dir: &str) {
        {
            let mut inner = self.lock();
            inner
                .skills
                .retain(|_, skill| !skill.location.starts_with(dir));
        }
        let found = scan_dir(dir).await;
        let mut inner = self.lock();
        for skill in found {
            inner.skills.insert(skill.name.clone(), skill);
        }
        let count = inner.skills.len();
        tracing::info!("Rediscovered skills from {dir} (total: {count})");
    }

    pub fn get_skill_dirs(&self) -> Vec<String> {
        self.lock().dirs.clone()
    }

    pub fn list(&self) -> Vec<Skill> {
        self.lock().skills.values().cloned().collect()
    }

    pub async fn load(&self, name: &str) -> Result<String, SkillError> {
        let (skill, hooks) = {
            let inner = self.lock();
            let skill = inner.skills.get(name).cloned().ok_or_else(|| {
                let available = inner.skills.keys().cloned().collect::<Vec<_>>().join(", ");
                SkillError::Message(format!(
                    "Skill not found: \"{name}\". Available: {available}"
                ))
            })?;
            (skill, inner.hooks.clone())
        };
        let started = Instant::now();
        if let Some(hooks) = &hooks {
            let mut before = SkillBeforeContext {
                skill_name: skill.name.clone(),
                skill_location: skill.location.clone(),
                matched_triggers: skill.triggers.clone(),
                match_score: 0.0,
                skip: false,
                skip_reason: None,
            };
            hooks.run_before(&mut before).map_err(SkillError::Message)?;
            if before.skip {
                let reason = before
                    .skip_reason
                    .unwrap_or_else(|| "no reason".to_string());
                return Err(SkillError::Message(format!(
                    "Skill \"{name}\" skipped by hook: {reason}"
                )));
            }
        }
        let content = tokio::fs::read_to_string(&skill.location)
            .await
            .map_err(|err| SkillError::Message(err.to_string()))?;
        if let Some(hooks) = &hooks {
            let after = SkillAfterContext {
                skill_name: skill.name.clone(),
                success: true,
                tools_used: Vec::new(),
                iterations: 0,
                duration_ms: started.elapsed().as_millis(),
            };
            let _ = hooks.run_after(&after);
        }
        Ok(content)
    }

    pub fn match_message(&self, message: &str) -> Vec<SkillMatch> {
        score_message(&self.list(), message)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|err| err.into_inner())
    }
}

pub fn score_message(skills: &[Skill], message: &str) -> Vec<SkillMatch> {
    let tokens = extract_triggers_from_description(message);
    let lowered = message.to_lowercase();
    let mut scored = Vec::new();
    for skill in skills {
        if skill.triggers.is_empty() {
            continue;
        }
        let mut hits = 0usize;
        for trigger in &skill.triggers {
            let trigger_l = trigger.to_lowercase();
            if tokens.iter().any(|token| token == &trigger_l) || lowered.contains(&trigger_l) {
                hits += 1;
            }
        }
        let score = hits as f64 / skill.triggers.len() as f64;
        if score > 0.0 {
            scored.push(SkillMatch {
                name: skill.name.clone(),
                score,
            });
        }
    }
    scored.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
}

async fn scan_dir(dir: &str) -> Vec<Skill> {
    let mut found = Vec::new();
    let mut entries = match tokio::fs::read_dir(dir).await {
        Ok(entries) => entries,
        Err(_) => {
            tracing::debug!("Skill directory not found: {dir}");
            return found;
        }
    };
    let mut names = Vec::new();
    loop {
        match entries.next_entry().await {
            Ok(Some(entry)) => names.push(entry.file_name()),
            Ok(None) => break,
            Err(err) => {
                tracing::warn!("Failed to read skill directory {dir}: {err}");
                break;
            }
        }
    }
    for name in names {
        let name = name.to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let skill_dir = Path::new(dir).join(&name);
        let is_dir = match tokio::fs::symlink_metadata(&skill_dir).await {
            Ok(meta) => meta.is_dir(),
            Err(_) => false,
        };
        if !is_dir {
            continue;
        }
        let skill_md = skill_dir.join("SKILL.md");
        if tokio::fs::metadata(&skill_md).await.is_err() {
            continue;
        }
        let content = match tokio::fs::read_to_string(&skill_md).await {
            Ok(content) => content,
            Err(err) => {
                tracing::warn!("Failed to parse skill at {}: {err}", skill_md.display());
                continue;
            }
        };
        let frontmatter = parse_frontmatter(&content);
        let skill_name = frontmatter.name.unwrap_or_else(|| name.clone());
        let mut triggers = frontmatter.triggers.unwrap_or_default();
        if let Some(description) = &frontmatter.description {
            for trigger in extract_triggers_from_description(description) {
                push_unique(&mut triggers, trigger);
            }
        }
        push_unique(&mut triggers, skill_name.to_lowercase());
        let location = skill_md.to_string_lossy().into_owned();
        tracing::debug!(
            "Discovered skill: {skill_name} ({} triggers)",
            triggers.len()
        );
        found.push(Skill {
            name: skill_name.clone(),
            description: frontmatter
                .description
                .unwrap_or_else(|| format!("Skill: {skill_name}")),
            location,
            triggers,
            version: frontmatter.version,
            category: frontmatter.category,
            tags: frontmatter.tags,
        });
    }
    found
}

fn push_unique(triggers: &mut Vec<String>, trigger: String) {
    if !triggers.iter().any(|existing| existing == &trigger) {
        triggers.push(trigger);
    }
}
