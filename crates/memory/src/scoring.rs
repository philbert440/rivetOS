use std::collections::HashMap;
use std::sync::OnceLock;

use regress::Regex;

pub const DECAY_LAMBDA: f64 = 0.05;
pub const REINFORCEMENT_ALPHA: f64 = 0.01;
pub const REINFORCEMENT_CAP: f64 = 25.0;
pub const W_FTS: f64 = 0.3;
pub const W_SEMANTIC: f64 = 0.3;
pub const W_TEMPORAL: f64 = 0.3;
pub const W_IMPORTANCE: f64 = 0.1;
pub const SUMMARY_IMPORTANCE: f64 = 0.6;
pub const RRF_K_DEFAULT: f64 = 60.0;
pub const HYBRID_POOL_MIN: i64 = 50;
pub const HYBRID_POOL_MAX: i64 = 100;
pub const HYBRID_RRF_K: f64 = 20.0;
pub const GATE_FRACTION: f64 = 0.5;
pub const SUMMARY_FUSION_BONUS: f64 = 1.3;
pub const HYBRID_MIN_CONTENT_LEN: i64 = 40;
pub const MIN_CONTENT_LEN: i64 = HYBRID_MIN_CONTENT_LEN;
pub const CHUNK_POOL_MULTIPLIER: i64 = 4;
pub const CHUNK_POOL_MAX: i64 = 400;
pub const DEFAULT_HNSW_EF_SEARCH: i64 = 100;
pub const MIN_HNSW_EF_SEARCH: i64 = 10;
pub const MAX_HNSW_EF_SEARCH: i64 = 1_000;
pub const TRIGRAM_SIMILARITY_MIN: f64 = 0.3;

pub fn temporal_decay(days_since_access: f64, access_count: f64) -> f64 {
    let reinforced = 1.0 + REINFORCEMENT_ALPHA * access_count.min(REINFORCEMENT_CAP);
    (-DECAY_LAMBDA * days_since_access).exp() * reinforced
}

pub fn importance_for_role(role: &str, has_tool_call: bool) -> f64 {
    if role == "system" {
        return 0.5;
    }
    if has_tool_call {
        return 0.3;
    }
    if role == "user" {
        return 0.7;
    }
    0.6
}

pub fn compute_relevance(
    fts_rank: f64,
    semantic_sim: f64,
    temporal_score: f64,
    importance: f64,
) -> f64 {
    fts_rank * W_FTS
        + semantic_sim * W_SEMANTIC
        + temporal_score * W_TEMPORAL
        + importance * W_IMPORTANCE
}

pub struct Fused<T> {
    pub item: T,
    pub rrf: f64,
}

pub fn reciprocal_rank_fusion<T, K, F>(
    lists: &[Vec<T>],
    mut key_of: F,
    k: f64,
) -> Vec<(K, Fused<T>)>
where
    K: Clone + Eq + std::hash::Hash,
    F: FnMut(&T) -> K,
    T: Clone,
{
    let mut acc: HashMap<K, Fused<T>> = HashMap::new();
    let mut order: Vec<K> = Vec::new();
    for list in lists {
        for (idx, item) in list.iter().enumerate() {
            let key = key_of(item);
            let inc = 1.0 / (k + idx as f64 + 1.0);
            if let Some(cur) = acc.get_mut(&key) {
                cur.rrf += inc;
            } else {
                order.push(key.clone());
                acc.insert(
                    key,
                    Fused {
                        item: item.clone(),
                        rrf: inc,
                    },
                );
            }
        }
    }
    let mut out = Vec::with_capacity(order.len());
    for key in order {
        if let Some(fused) = acc.remove(&key) {
            out.push((key, fused));
        }
    }
    out
}

pub fn hybrid_pool_size(limit: i64) -> i64 {
    HYBRID_POOL_MAX.min(HYBRID_POOL_MIN.max(limit.saturating_mul(3)))
}

pub fn chunk_pool_size(pool: i64) -> i64 {
    CHUNK_POOL_MAX.min(pool.saturating_mul(CHUNK_POOL_MULTIPLIER))
}

pub fn temporal_decay_sql(alias: &str) -> String {
    format!(
        "EXP(-{DECAY_LAMBDA} * EXTRACT(EPOCH FROM (NOW() - {alias}.created_at)) / 86400.0) * (1.0 + {REINFORCEMENT_ALPHA} * LEAST(COALESCE({alias}.access_count, 0), {REINFORCEMENT_CAP}))"
    )
}

pub fn importance_sql(alias: &str) -> String {
    format!(
        "CASE WHEN {alias}.role = 'system' THEN 0.5 WHEN {alias}.tool_name IS NOT NULL THEN 0.3 WHEN {alias}.role = 'user' THEN 0.7 ELSE 0.6 END"
    )
}

pub fn semantic_proxy_sql(alias: &str) -> String {
    format!("LEAST(LENGTH({alias}.content) / 1000.0, 1.0)")
}

pub fn message_quality_sql() -> String {
    format!(
        "(
  (m.role <> 'tool' AND length(btrim(m.content)) >= {MIN_CONTENT_LEN})
  OR
  (m.role = 'tool' AND length(btrim(coalesce(m.tool_result, ''))) >= {MIN_CONTENT_LEN})
)"
    )
}

pub fn summary_quality_sql() -> String {
    format!("length(btrim(s.content)) >= {MIN_CONTENT_LEN}")
}

pub const CHUNK_ARM_PROBE_SQL: &str = "SELECT
    reg IS NOT NULL AS present,
    CASE
      WHEN reg IS NULL THEN false
      ELSE has_table_privilege(current_user, 'ros_message_chunks', 'SELECT')
    END AS granted
  FROM (SELECT to_regclass('ros_message_chunks') AS reg) t";

#[derive(Debug, Clone)]
pub enum LooseNumber {
    Absent,
    Number(f64),
    Text(String),
}

pub fn coerce_number(raw: &LooseNumber) -> Option<f64> {
    match raw {
        LooseNumber::Absent => None,
        LooseNumber::Number(n) => n.is_finite().then_some(*n),
        LooseNumber::Text(text) => {
            let trimmed = protocol::js::js_trim(text);
            if trimmed.is_empty() {
                return None;
            }
            trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
        }
    }
}

fn trunc_toward_zero(n: f64) -> i64 {
    if !n.is_finite() {
        return 0;
    }
    let truncated = n.trunc();
    if truncated >= i64::MAX as f64 {
        i64::MAX
    } else if truncated <= i64::MIN as f64 {
        i64::MIN
    } else {
        truncated as i64
    }
}

fn static_re<'a>(
    slot: &'a OnceLock<Option<Regex>>,
    pattern: &str,
    flags: &str,
) -> Option<&'a Regex> {
    slot.get_or_init(|| Regex::with_flags(pattern, flags).ok())
        .as_ref()
}

fn literal_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    static_re(
        &RE,
        r"\w[./:_@]\w|\d{1,3}(?:\.\d{1,3}){2,}|[a-z]\d|\d[a-z]",
        "i",
    )
}

fn hyphen_re() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    static_re(&RE, r"[^\s][./:-][^\s]", "")
}

pub fn looks_literal(query: &str) -> bool {
    literal_re().is_some_and(|re| re.find(query).is_some())
}

pub fn should_trigram_fallback(query: &str) -> bool {
    if looks_literal(query) {
        return true;
    }
    hyphen_re().is_some_and(|re| re.find(query).is_some())
}

pub fn clamp_hnsw_ef_search(raw: &LooseNumber) -> i64 {
    let Some(n) = coerce_number(raw) else {
        return DEFAULT_HNSW_EF_SEARCH;
    };
    MAX_HNSW_EF_SEARCH.min(MIN_HNSW_EF_SEARCH.max(trunc_toward_zero(n)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_of(item: &(&str, &str)) -> String {
        item.0.to_string()
    }

    #[test]
    fn single_list_is_one_over_k_plus_rank() {
        let a = ("a", "");
        let b = ("b", "");
        let fused = reciprocal_rank_fusion(&[vec![a, b]], key_of, 60.0);
        let map: HashMap<_, _> = fused.into_iter().collect();
        assert!((map["a"].rrf - 1.0 / 61.0).abs() < 1e-10);
        assert!((map["b"].rrf - 1.0 / 62.0).abs() < 1e-10);
    }

    #[test]
    fn accumulates_across_lists() {
        let a = ("a", "");
        let x = ("x", "");
        let fused = reciprocal_rank_fusion(&[vec![a], vec![x, a]], key_of, 60.0);
        let map: HashMap<_, _> = fused.into_iter().collect();
        assert!((map["a"].rrf - (1.0 / 61.0 + 1.0 / 62.0)).abs() < 1e-10);
    }

    #[test]
    fn two_methods_outrank_one_strong_method() {
        let shared = ("shared", "");
        let lonely = ("lonely", "");
        let p = ("p", "");
        let q = ("q", "");
        let fused =
            reciprocal_rank_fusion(&[vec![p, q, shared], vec![lonely, shared]], key_of, 60.0);
        let map: HashMap<_, _> = fused.into_iter().collect();
        assert!(map["shared"].rrf > map["lonely"].rrf);
    }

    #[test]
    fn keeps_the_first_item() {
        let first = ("a", "first");
        let second = ("a", "second");
        let fused = reciprocal_rank_fusion(&[vec![first], vec![second]], key_of, 60.0);
        let map: HashMap<_, _> = fused.into_iter().collect();
        assert_eq!(map["a"].item.1, "first");
    }

    #[test]
    fn smaller_k_sharpens_the_top() {
        let a = ("a", "");
        let b = ("b", "");
        let sharp = reciprocal_rank_fusion(&[vec![a, b]], key_of, 1.0);
        let flat = reciprocal_rank_fusion(&[vec![a, b]], key_of, 1000.0);
        let sharp: HashMap<_, _> = sharp.into_iter().collect();
        let flat: HashMap<_, _> = flat.into_iter().collect();
        let sharp_gap = sharp["a"].rrf - sharp["b"].rrf;
        let flat_gap = flat["a"].rrf - flat["b"].rrf;
        assert!(sharp_gap > flat_gap);
    }

    #[test]
    fn default_k_is_sixty() {
        assert_eq!(RRF_K_DEFAULT, 60.0);
        let a = ("a", "");
        let fused = reciprocal_rank_fusion(&[vec![a]], key_of, RRF_K_DEFAULT);
        let map: HashMap<_, _> = fused.into_iter().collect();
        assert!((map["a"].rrf - 1.0 / 61.0).abs() < 1e-10);
    }

    #[test]
    fn empty_lists_fuse_to_nothing() {
        let empty: Vec<Vec<(&str, &str)>> = Vec::new();
        assert!(reciprocal_rank_fusion(&empty, key_of, 60.0).is_empty());
        let blank: Vec<(&str, &str)> = Vec::new();
        assert!(reciprocal_rank_fusion(&[blank.clone(), blank], key_of, 60.0).is_empty());
    }

    #[test]
    fn importance_orders_user_above_prose_above_tools() {
        assert!(importance_for_role("user", false) >= importance_for_role("assistant", false));
        assert!(importance_for_role("assistant", false) > importance_for_role("assistant", true));
        assert!(importance_for_role("assistant", true) < importance_for_role("user", false));
        assert!(importance_for_role("system", false) == 0.5);
        assert!(importance_for_role("tool", false) == 0.6);
    }

    #[test]
    fn temporal_decay_caps_reinforcement() {
        assert!(temporal_decay(0.0, 0.0) > temporal_decay(30.0, 0.0));
        assert!((temporal_decay(0.0, 0.0) - 1.0).abs() < 1e-10);
        let huge = temporal_decay(0.0, 100_000.0);
        let at_cap = temporal_decay(0.0, 25.0);
        assert!((huge - at_cap).abs() < 1e-10);
        assert!(huge <= 1.25 + 1e-9);
    }

    #[test]
    fn composite_uses_the_weights() {
        let score = compute_relevance(1.0, 1.0, 1.0, 0.7);
        assert!((score - (0.3 + 0.3 + 0.3 + 0.07)).abs() < 1e-12);
    }

    #[test]
    fn pool_bounds_and_fusion_constants() {
        assert_eq!(hybrid_pool_size(1), HYBRID_POOL_MIN);
        assert_eq!(hybrid_pool_size(20), 60);
        assert_eq!(hybrid_pool_size(500), HYBRID_POOL_MAX);
        assert_eq!(HYBRID_RRF_K, 20.0);
        assert_eq!(GATE_FRACTION, 0.5);
        assert_eq!(SUMMARY_FUSION_BONUS, 1.3);
        assert_eq!(HYBRID_MIN_CONTENT_LEN, 40);
        assert_eq!(chunk_pool_size(50), 200);
        assert_eq!(chunk_pool_size(200), CHUNK_POOL_MAX);
    }

    #[test]
    fn sql_fragments_match_the_typescript() {
        assert_eq!(
            temporal_decay_sql("m"),
            "EXP(-0.05 * EXTRACT(EPOCH FROM (NOW() - m.created_at)) / 86400.0) * (1.0 + 0.01 * LEAST(COALESCE(m.access_count, 0), 25))"
        );
        assert_eq!(
            importance_sql("m"),
            "CASE WHEN m.role = 'system' THEN 0.5 WHEN m.tool_name IS NOT NULL THEN 0.3 WHEN m.role = 'user' THEN 0.7 ELSE 0.6 END"
        );
        assert_eq!(
            semantic_proxy_sql("s"),
            "LEAST(LENGTH(s.content) / 1000.0, 1.0)"
        );
        assert!(message_quality_sql().contains("length(btrim(m.content)) >= 40"));
        assert!(CHUNK_ARM_PROBE_SQL.contains("to_regclass('ros_message_chunks')"));
        assert!(CHUNK_ARM_PROBE_SQL.contains("has_table_privilege"));
    }

    #[test]
    fn hnsw_clamp_truncates() {
        assert_eq!(clamp_hnsw_ef_search(&LooseNumber::Absent), 100);
        assert_eq!(clamp_hnsw_ef_search(&LooseNumber::Number(5.0)), 10);
        assert_eq!(clamp_hnsw_ef_search(&LooseNumber::Number(5000.0)), 1000);
        assert_eq!(
            clamp_hnsw_ef_search(&LooseNumber::Text("40".to_string())),
            40
        );
        assert_eq!(
            clamp_hnsw_ef_search(&LooseNumber::Text("40.7".to_string())),
            40
        );
        assert_eq!(
            clamp_hnsw_ef_search(&LooseNumber::Text("nope".to_string())),
            100
        );
        assert_eq!(clamp_hnsw_ef_search(&LooseNumber::Number(0.0)), 10);
        assert_eq!(clamp_hnsw_ef_search(&LooseNumber::Number(-3.0)), 10);
    }

    #[test]
    fn literal_detection_matches_the_two_regexes() {
        for query in [
            "families.app",
            "10.0.0.5",
            "host:8080",
            "src/index.ts",
            "qwen3",
        ] {
            assert!(looks_literal(query), "{query}");
        }
        assert!(looks_literal("qwen3.6-27b-int4"));
        assert!(should_trigram_fallback("qwen3.6-27b-int4"));
        assert!(!looks_literal("state-of-the-art model"));
        assert!(!looks_literal("follow-up on compaction"));
        assert!(should_trigram_fallback("state-of-the-art model"));
        assert!(!looks_literal("what did we decide about memory"));
        assert!(!should_trigram_fallback("what did we decide about memory"));
        assert!(looks_literal("what is families.app?"));
        assert!(should_trigram_fallback("what is families.app?"));
        assert!(!should_trigram_fallback("plain words only"));
    }
}
