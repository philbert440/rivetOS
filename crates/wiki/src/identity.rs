use crate::slug::normalize_slug;

pub fn is_slug_variant(left: &str, right: &str) -> bool {
    let left = normalize_slug(left);
    let right = normalize_slug(right);
    if left.is_empty() || right.is_empty() || left == right {
        return left == right && !left.is_empty();
    }
    right.starts_with(&format!("{left}-")) || left.starts_with(&format!("{right}-"))
}

pub fn prefer_canonical_slug(left: &str, right: &str) -> String {
    let left = normalize_slug(left);
    let right = normalize_slug(right);
    if left == right {
        return left;
    }
    if is_slug_variant(&left, &right) {
        if left.len() <= right.len() {
            left
        } else {
            right
        }
    } else {
        left
    }
}

pub fn slug_token_prefix(slug: &str, n: usize) -> String {
    let normalized = normalize_slug(slug);
    let parts: Vec<&str> = normalized.split('-').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return String::new();
    }
    let take = n.min(parts.len());
    parts[..take].join("-")
}

pub fn find_stem_match(proposed: &str, existing: &[&str]) -> Option<String> {
    let proposed = normalize_slug(proposed);
    if proposed.is_empty() {
        return None;
    }
    let mut variants: Vec<String> = existing
        .iter()
        .map(|slug| normalize_slug(slug))
        .filter(|slug| !slug.is_empty() && (*slug == proposed || is_slug_variant(slug, &proposed)))
        .collect();
    if variants.is_empty() {
        return None;
    }
    variants.sort_by(|left, right| left.len().cmp(&right.len()).then_with(|| left.cmp(right)));
    variants.into_iter().next()
}

pub fn cluster_slugs_by_stem(slugs: &[&str]) -> Vec<(String, Vec<String>)> {
    let mut keys = Vec::new();
    let mut groups: Vec<Vec<String>> = Vec::new();
    for raw in slugs {
        let slug = normalize_slug(raw);
        if slug.is_empty() {
            continue;
        }
        let parts: Vec<&str> = slug.split('-').filter(|part| !part.is_empty()).collect();
        let key = if parts.len() >= 3 {
            format!("{}-{}", parts[0], parts[1])
        } else {
            slug.clone()
        };
        if let Some(index) = keys.iter().position(|have| have == &key) {
            groups[index].push(slug);
        } else {
            keys.push(key);
            groups.push(vec![slug]);
        }
    }
    keys.into_iter().zip(groups).collect()
}

pub fn entities_overlap(left: &[&str], right: &[&str]) -> bool {
    if left.is_empty() || right.is_empty() {
        return false;
    }
    let seen: std::collections::HashSet<&str> = left.iter().copied().collect();
    right.iter().any(|entity| seen.contains(entity))
}
