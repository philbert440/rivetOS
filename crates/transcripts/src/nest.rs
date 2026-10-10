use std::collections::{HashMap, HashSet};

use crate::turn::SessionRow;

pub const NEST_DEPTH_CAP: usize = 8;
pub const NEST_ANCESTOR_CAP: usize = 8;

#[derive(Clone, Debug, Default)]
pub struct DelegatedLink {
    pub task_id: String,
    pub spawned_session_id: String,
    pub parent_session_id: Option<String>,
    pub parent_task_id: Option<String>,
    pub agent_name: Option<String>,
    pub model: Option<String>,
}

pub fn with_ancestors(ranked: Vec<SessionRow>, limit: usize) -> Vec<SessionRow> {
    let cap = if limit > 0 { limit } else { ranked.len() };
    if cap >= ranked.len() {
        return ranked;
    }
    let kept: Vec<SessionRow> = ranked.iter().take(cap).cloned().collect();
    let pool: HashMap<String, SessionRow> = ranked.iter().map(|row| (row_key(row), row.clone())).collect();
    let mut included: HashSet<String> = kept.iter().map(row_key).collect();
    let mut extras = Vec::new();
    for row in &kept {
        let mut parent_id = row.parent_session_id.clone();
        let mut seen = HashSet::new();
        while let Some(parent) = parent_id.clone() {
            if seen.contains(&parent) || seen.len() >= NEST_ANCESTOR_CAP {
                break;
            }
            seen.insert(parent.clone());
            let key = format!("{}\0{parent}", row.command);
            let Some(ancestor) = pool.get(&key) else {
                break;
            };
            if included.insert(key) {
                extras.push(ancestor.clone());
            }
            parent_id = ancestor.parent_session_id.clone();
        }
    }
    if extras.is_empty() { kept } else { kept.into_iter().chain(extras).collect() }
}

pub fn apply_delegated_nesting(mut sessions: Vec<SessionRow>, links: &[DelegatedLink]) -> Vec<SessionRow> {
    if links.is_empty() {
        return sessions;
    }
    let mut by_task = HashMap::new();
    let mut by_spawned = HashMap::new();
    for link in links {
        if link.task_id.is_empty() || link.spawned_session_id.is_empty() {
            continue;
        }
        by_task.insert(link.task_id.clone(), link);
        by_spawned.insert(link.spawned_session_id.clone(), link);
    }
    let pool: HashSet<String> = sessions.iter().map(|session| session.id.clone()).collect();
    for session in &mut sessions {
        let Some(link) = by_spawned.get(&session.id).copied() else {
            continue;
        };
        session.task_id = Some(link.task_id.clone());
        if session.agent_name.is_none() {
            session.agent_name = link.agent_name.clone();
        }
        if session.model.is_none() {
            session.model = link.model.clone();
        }
        if session.parent_session_id.is_some() {
            continue;
        }
        let Some(parent) = parent_native(link, &by_task) else {
            continue;
        };
        if parent != session.id && pool.contains(&parent) {
            session.parent_session_id = Some(parent);
        }
    }
    sessions
}

fn parent_native(link: &DelegatedLink, by_task: &HashMap<String, &DelegatedLink>) -> Option<String> {
    let depth = chain_depth(link, by_task)?;
    if depth > NEST_DEPTH_CAP {
        return None;
    }
    if let Some(parent_task) = &link.parent_task_id {
        let parent = by_task.get(parent_task)?;
        if parent.spawned_session_id.is_empty() {
            return None;
        }
        return Some(parent.spawned_session_id.clone());
    }
    link.parent_session_id.as_ref().map(|id| native_of(id))
}

fn chain_depth(link: &DelegatedLink, by_task: &HashMap<String, &DelegatedLink>) -> Option<usize> {
    let mut depth = 1_usize;
    let mut cur = link;
    let mut seen = HashSet::new();
    while let Some(parent_task) = &cur.parent_task_id {
        if !seen.insert(cur.task_id.clone()) {
            return None;
        }
        let parent = by_task.get(parent_task)?;
        depth += 1;
        if depth > NEST_DEPTH_CAP {
            return Some(depth);
        }
        cur = parent;
    }
    Some(depth)
}

fn native_of(id: &str) -> String {
    match id.find(':') {
        Some(index) => id[index + 1..].to_string(),
        None => id.to_string(),
    }
}

fn row_key(row: &SessionRow) -> String {
    format!("{}\0{}", row.command, row.id)
}
