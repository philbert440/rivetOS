use serde_json::{Map, Value};

use crate::error::WikiParseError;
use crate::model::{
    ArticlePatchMode, SourceSpan, SummaryCap, WikiArticlePatch, WikiArticleSection, WikiCitation,
    WikiFrontmatter, WikiHistoryEntry, WikiPage, WikiPatch, WikiSection, WikiSource,
};
use crate::slug::{extract_wiki_links, normalize_slug};
use crate::text::{
    is_js_whitespace, js_last_index_of, js_len, js_prefix, js_slice, js_sort, js_trim, js_trim_end,
    split_utf16, utc_day,
};
use crate::yaml_doc::{emit_yaml, parse_yaml_value};

pub const SUMMARY_SHRINK_FLOOR: f64 = 0.6;
pub const SUMMARY_MAX_CHARS: usize = 2400;
pub const SEARCH_ARTICLE_EXCERPT_CHARS: usize = 1200;
pub const ALIASES_MAX: usize = 32;
pub const TAGS_MAX: usize = 24;
pub const ENTITIES_MAX: usize = 32;
pub const RELATED_MAX: usize = 48;
pub const SOURCES_MAX: usize = 64;
pub const HISTORY_MAX: usize = 48;
pub const CITATIONS_MAX: usize = 40;

const KNOWN_META: &[&str] = &[
    "title",
    "slug",
    "aliases",
    "tags",
    "entities",
    "related",
    "last_verified",
    "sources",
];

pub fn parse_wiki_page(input: &str) -> Result<WikiPage, WikiParseError> {
    let markdown = input.replace("\r\n", "\n");
    let Some((yaml, body)) = split_frontmatter(&markdown) else {
        return Err(WikiParseError::new("missing YAML frontmatter"));
    };
    let value = parse_yaml_value(yaml)?;
    let Value::Object(raw) = value else {
        return Err(WikiParseError::new("frontmatter not a map"));
    };
    let mut meta = normalize_meta(&raw)?;
    let (preamble, sections) = split_sections(body);
    let summary = sections
        .iter()
        .find(|section| same_heading(&section.heading, "summary"))
        .or_else(|| {
            sections
                .iter()
                .find(|section| same_heading(&section.heading, "current state"))
        });
    let article = sections
        .iter()
        .find(|section| same_heading(&section.heading, "article"));
    let see_also_sec = sections
        .iter()
        .find(|section| same_heading(&section.heading, "see also"));
    let history = sections
        .iter()
        .find(|section| same_heading(&section.heading, "history"));
    let citations = sections
        .iter()
        .find(|section| same_heading(&section.heading, "citations"));
    let extra_sections: Vec<WikiSection> = sections
        .iter()
        .filter(|section| !is_core_heading(&section.heading))
        .map(|section| WikiSection {
            heading: section.heading.clone(),
            body: js_trim(&section.body).to_string(),
        })
        .collect();
    let see_from = see_also_sec
        .map(|section| parse_see_also(&section.body))
        .unwrap_or_default();
    let see_also = union_slices(&[&meta.related, &see_from]);
    meta.related = union_slices(&[&meta.related, &see_also]);
    let preamble = {
        let trimmed = js_trim(&preamble);
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    Ok(WikiPage {
        meta,
        current_state: js_trim(summary.map(|section| section.body.as_str()).unwrap_or("")).to_string(),
        article: js_trim(article.map(|section| section.body.as_str()).unwrap_or("")).to_string(),
        history: history
            .map(|section| parse_history(&section.body))
            .unwrap_or_default(),
        citations: citations
            .map(|section| parse_citations(&section.body))
            .unwrap_or_default(),
        see_also,
        preamble,
        extra_sections,
    })
}

pub fn serialize_wiki_page(page: &WikiPage) -> String {
    let related = cap_list(
        &union_slices(&[&page.meta.related, &page.see_also])
            .into_iter()
            .filter(|slug| slug != &page.meta.slug)
            .collect::<Vec<_>>(),
        RELATED_MAX,
    );
    let yaml = js_trim_end(&emit_yaml(&Value::Object(frontmatter_value(page, &related)))).to_string();
    let mut parts = Vec::new();
    parts.push(format!("---\n{yaml}\n---"));
    if let Some(preamble) = &page.preamble {
        if !preamble.is_empty() {
            parts.push(String::new());
            parts.push(preamble.clone());
        }
    }
    parts.push(String::new());
    parts.push("## Summary".to_string());
    parts.push(String::new());
    parts.push(js_trim(&demote_h2_headings(&page.current_state)).to_string());
    parts.push(article_block(&page.article));
    parts.push(see_also_block(&related));
    parts.push(String::new());
    parts.push("## History".to_string());
    parts.push(String::new());
    parts.push(js_trim_end(&history_block(&cap_list(&page.history, HISTORY_MAX))).to_string());
    parts.push(citation_block(&cap_list(&page.citations, CITATIONS_MAX)));
    for section in &page.extra_sections {
        parts.push(String::new());
        parts.push(format!("## {}", section.heading));
        parts.push(String::new());
        parts.push(section.body.clone());
    }
    parts.push(String::new());
    parts.join("\n")
}

pub fn apply_patch(existing: Option<&WikiPage>, patch: &WikiPatch) -> WikiPage {
    let slug = normalize_slug(&patch.slug);
    let mut page = if let Some(existing) = existing {
        existing.clone()
    } else {
        let title = match &patch.title {
            Some(title) => title.clone(),
            None => slug.clone(),
        };
        blank_page(title, slug.clone())
    };
    if let Some(title) = &patch.title {
        if !title.is_empty() {
            page.meta.title = title.clone();
        }
    }
    page.meta.aliases = union_slices(&[&page.meta.aliases, &patch.add_aliases]);
    page.meta.tags = union_slices(&[&page.meta.tags, &patch.add_tags]);
    page.meta.entities = union_slices(&[&page.meta.entities, &patch.add_entities]);
    let related_adds: Vec<String> = patch
        .add_related
        .iter()
        .map(|item| normalize_slug(item))
        .filter(|item| !item.is_empty())
        .collect();
    page.meta.related = union_slices(&[&page.meta.related, &related_adds]);
    page.meta.last_verified = Some(patch.verified_at.clone());
    for source in &patch.add_sources {
        let key = source_identity(source);
        let dup = page
            .meta
            .sources
            .iter()
            .any(|have| have.kind == source.kind && source_identity(have) == key);
        if !dup {
            page.meta.sources.push(source.clone());
        }
    }
    let day = js_prefix(&patch.verified_at, 10);
    if let Some(delta) = &patch.summary_delta {
        if !js_trim(delta).is_empty() {
            let folded = demote_h2_headings(js_trim(delta));
            page.current_state = merge_summary_text(&page.current_state, &folded);
        }
    }
    if let Some(incoming) = &patch.current_state {
        let incoming_trim = js_trim(incoming);
        if incoming_trim != js_trim(&page.current_state) {
            let next = demote_h2_headings(incoming_trim);
            let prev = js_trim(&page.current_state).to_string();
            let would_shrink = !prev.is_empty()
                && !next.is_empty()
                && (js_len(&next) as f64) < (js_len(&prev) as f64) * SUMMARY_SHRINK_FLOOR
                && !patch.allow_shrink;
            if would_shrink {
                if js_len(&prev) < SUMMARY_MAX_CHARS {
                    page.current_state = merge_summary_text(&prev, &next);
                } else {
                    page.history.insert(
                        0,
                        WikiHistoryEntry {
                            date: day.clone(),
                            title: "Summary thrash refused (v7 cap)".to_string(),
                            body: next,
                        },
                    );
                }
            } else if next != prev {
                if !prev.is_empty() {
                    page.history.insert(
                        0,
                        WikiHistoryEntry {
                            date: day.clone(),
                            title: "Superseded current state".to_string(),
                            body: prev,
                        },
                    );
                }
                page.current_state = next;
            }
        }
    }
    let capped = cap_summary(&page.current_state, SUMMARY_MAX_CHARS);
    page.current_state = capped.kept;
    if !capped.overflow.is_empty() {
        page.history.insert(
            0,
            WikiHistoryEntry {
                date: day.clone(),
                title: "Summary overflow (v7 cap)".to_string(),
                body: capped.overflow,
            },
        );
    }
    if let Some(incoming) = &patch.article {
        let next = demote_h2_headings(js_trim(incoming));
        if next != js_trim(&page.article) {
            if !js_trim(&page.article).is_empty() && next != js_trim(&page.article) {
                page.history.insert(
                    0,
                    WikiHistoryEntry {
                        date: day.clone(),
                        title: "Superseded article".to_string(),
                        body: js_trim(&page.article).to_string(),
                    },
                );
            }
            page.article = next;
        }
    }
    if !patch.article_patches.is_empty() {
        let demoted: Vec<WikiArticlePatch> = patch
            .article_patches
            .iter()
            .map(|item| WikiArticlePatch {
                heading: item.heading.clone(),
                mode: item.mode,
                body: demote_h2_headings(&item.body),
            })
            .collect();
        page.article = apply_article_patches(&page.article, &demoted);
    }
    if let Some(entry) = &patch.history_entry {
        let body = js_trim(&demote_h2_headings(&entry.body)).to_string();
        let dup = page.history.iter().any(|have| {
            have.date == entry.date && have.title == entry.title && js_trim(&have.body) == body
        });
        if !dup {
            page.history.insert(
                0,
                WikiHistoryEntry {
                    date: entry.date.clone(),
                    title: entry.title.clone(),
                    body,
                },
            );
        }
    }
    for citation in &patch.add_citations {
        if citation.summary_id.is_empty() {
            continue;
        }
        if page
            .citations
            .iter()
            .any(|have| have.summary_id == citation.summary_id)
        {
            continue;
        }
        page.citations.insert(
            0,
            WikiCitation {
                summary_id: citation.summary_id.clone(),
                date: present(citation.date.clone()),
                kind: present(citation.kind.clone()),
                note: present(citation.note.clone()),
            },
        );
    }
    let links = extract_wiki_links(&format!("{}\n{}", page.current_state, page.article))
        .into_iter()
        .filter(|link| link != &slug)
        .collect::<Vec<_>>();
    page.meta.related = union_slices(&[&page.meta.related, &links])
        .into_iter()
        .filter(|link| link != &slug)
        .collect();
    page.see_also = union_slices(&[&page.see_also, &page.meta.related])
        .into_iter()
        .filter(|link| link != &slug)
        .collect();
    cap_frontmatter_lists(&mut page);
    page
}

pub fn merge_pages(canonical: &WikiPage, losers: &[WikiPage]) -> WikiPage {
    let mut out = canonical.clone();
    for loser in losers {
        if loser.meta.slug == out.meta.slug {
            continue;
        }
        let mut alias_adds = vec![loser.meta.slug.clone()];
        alias_adds.extend(loser.meta.aliases.iter().cloned());
        alias_adds.push(loser.meta.title.clone());
        out.meta.aliases = union_slices(&[&out.meta.aliases, &alias_adds]);
        out.meta.tags = union_slices(&[&out.meta.tags, &loser.meta.tags]);
        out.meta.entities = union_slices(&[&out.meta.entities, &loser.meta.entities]);
        out.meta.related = union_slices(&[
            &out.meta.related,
            &loser.meta.related,
            &loser.see_also,
        ]);
        for source in &loser.meta.sources {
            let key = source_identity(source);
            let dup = out
                .meta
                .sources
                .iter()
                .any(|have| have.kind == source.kind && source_identity(have) == key);
            if !dup {
                out.meta.sources.push(source.clone());
            }
        }
        let loser_state = js_trim(&loser.current_state);
        if js_trim(&out.current_state).is_empty() && !loser_state.is_empty() {
            out.current_state = loser_state.to_string();
        } else if !loser_state.is_empty()
            && loser_state != js_trim(&out.current_state)
            && (js_len(&loser.current_state) as f64) > (js_len(&out.current_state) as f64) * 1.25
        {
            out.history.insert(
                0,
                WikiHistoryEntry {
                    date: stamp_day(out.meta.last_verified.as_deref()),
                    title: "Superseded current state (consolidation)".to_string(),
                    body: js_trim(&out.current_state).to_string(),
                },
            );
            out.current_state = loser_state.to_string();
        } else if !loser_state.is_empty() && loser_state != js_trim(&out.current_state) {
            out.history.insert(
                0,
                WikiHistoryEntry {
                    date: stamp_day(loser.meta.last_verified.as_deref()),
                    title: format!("Merged from {}", loser.meta.slug),
                    body: loser_state.to_string(),
                },
            );
            out.current_state = merge_summary_text(&out.current_state, loser_state);
        }
        let loser_article = js_trim(&loser.article).to_string();
        if !loser_article.is_empty() {
            if js_trim(&out.article).is_empty() {
                out.article = demote_h2_headings(&loser_article);
            } else if loser_article != js_trim(&out.article) {
                if (js_len(&loser_article) as f64) > (js_len(&out.article) as f64) * 1.25 {
                    out.history.insert(
                        0,
                        WikiHistoryEntry {
                            date: stamp_day(out.meta.last_verified.as_deref()),
                            title: "Superseded article (consolidation)".to_string(),
                            body: js_trim(&out.article).to_string(),
                        },
                    );
                    out.article = demote_h2_headings(&loser_article);
                } else {
                    out.article =
                        merge_article_bodies(&out.article, &demote_h2_headings(&loser_article));
                }
            }
        }
        for entry in &loser.history {
            let body = js_trim(&entry.body).to_string();
            let dup = out.history.iter().any(|have| {
                have.date == entry.date && have.title == entry.title && js_trim(&have.body) == body
            });
            if !dup {
                out.history.push(WikiHistoryEntry {
                    date: entry.date.clone(),
                    title: entry.title.clone(),
                    body,
                });
            }
        }
        for citation in &loser.citations {
            if !out
                .citations
                .iter()
                .any(|have| have.summary_id == citation.summary_id)
            {
                out.citations.push(citation.clone());
            }
        }
    }
    out.history.sort_by(|left, right| right.date.cmp(&left.date));
    let capped = cap_summary(&out.current_state, SUMMARY_MAX_CHARS);
    out.current_state = capped.kept;
    if !capped.overflow.is_empty() {
        out.history.insert(
            0,
            WikiHistoryEntry {
                date: stamp_day(out.meta.last_verified.as_deref()),
                title: "Summary overflow (v7 cap)".to_string(),
                body: capped.overflow,
            },
        );
    }
    let links = extract_wiki_links(&format!("{}\n{}", out.current_state, out.article))
        .into_iter()
        .filter(|link| link != &out.meta.slug)
        .collect::<Vec<_>>();
    out.meta.related = union_slices(&[&out.meta.related, &links])
        .into_iter()
        .filter(|link| link != &out.meta.slug)
        .collect();
    out.see_also = union_slices(&[&out.see_also, &out.meta.related])
        .into_iter()
        .filter(|link| link != &out.meta.slug)
        .collect();
    cap_frontmatter_lists(&mut out);
    out
}

pub fn merge_summary_text(existing: &str, delta: &str) -> String {
    let left = js_trim(existing);
    let right = js_trim(delta);
    if right.is_empty() {
        return left.to_string();
    }
    if left.is_empty() || left == right || left.contains(right) {
        return if left.is_empty() {
            right.to_string()
        } else {
            left.to_string()
        };
    }
    if right.contains(left) && js_len(right) > js_len(left) {
        return right.to_string();
    }
    format!("{left}\n\n{right}")
}

pub fn cap_summary(text: &str, max_chars: usize) -> SummaryCap {
    let trimmed = js_trim(text);
    if js_len(trimmed) <= max_chars {
        return SummaryCap {
            kept: trimmed.to_string(),
            overflow: String::new(),
        };
    }
    let mut cut = max_chars;
    if let Some(newline) = js_last_index_of(trimmed, "\n\n", max_chars) {
        if (newline as f64) > (max_chars as f64) * 0.5 {
            cut = newline;
        }
    }
    let (kept, rest) = split_utf16(trimmed, cut);
    SummaryCap {
        kept: js_trim_end(kept).to_string(),
        overflow: js_trim(rest).to_string(),
    }
}

pub fn demote_h2_headings(markdown: &str) -> String {
    let mut in_fence = false;
    let mut lines = Vec::new();
    for line in markdown.split('\n') {
        if js_trim(line).starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence && is_bare_h2(line) {
            lines.push(format!("#{line}"));
        } else {
            lines.push(line.to_string());
        }
    }
    lines.join("\n")
}

pub fn build_wiki_search_text(page: &WikiPage) -> String {
    let article = js_slice(js_trim(&page.article), 0, SEARCH_ARTICLE_EXCERPT_CHARS);
    let aliases = cap_list(&page.meta.aliases, ALIASES_MAX).join(" ");
    let related = cap_list(&page.meta.related, RELATED_MAX).join(" ");
    let joined = [
        page.meta.title.as_str(),
        aliases.as_str(),
        page.current_state.as_str(),
        article.as_str(),
        related.as_str(),
    ]
    .join(" ");
    js_prefix(&joined, 8_000)
}

pub fn cap_list<T: Clone>(list: &[T], max: usize) -> Vec<T> {
    if list.len() <= max {
        list.to_vec()
    } else {
        list[..max].to_vec()
    }
}

pub fn cap_tail<T: Clone>(list: &[T], max: usize) -> Vec<T> {
    if list.is_empty() || list.len() <= max {
        list.to_vec()
    } else {
        let start = list.len() - max;
        list[start..].to_vec()
    }
}

pub fn cap_frontmatter_lists(page: &mut WikiPage) {
    page.meta.aliases = cap_list(&page.meta.aliases, ALIASES_MAX);
    page.meta.tags = cap_list(&page.meta.tags, TAGS_MAX);
    page.meta.entities = cap_list(&page.meta.entities, ENTITIES_MAX);
    page.meta.related = cap_list(&page.meta.related, RELATED_MAX);
    page.see_also = cap_list(&page.see_also, RELATED_MAX);
    page.meta.sources = cap_tail(&page.meta.sources, SOURCES_MAX);
    page.history = cap_list(&page.history, HISTORY_MAX);
    page.citations = cap_list(&page.citations, CITATIONS_MAX);
}

pub fn split_article_sections(article: &str) -> (String, Vec<WikiArticleSection>) {
    let text = article.replace("\r\n", "\n");
    let mut sections = Vec::new();
    let mut lead = String::new();
    let mut heading: Option<String> = None;
    let mut buf: Vec<String> = Vec::new();
    let mut in_fence = false;
    let flush = |heading: &mut Option<String>, buf: &mut Vec<String>, lead: &mut String, sections: &mut Vec<WikiArticleSection>| {
        if let Some(heading) = heading.take() {
            sections.push(WikiArticleSection {
                heading,
                body: js_trim(&buf.join("\n")).to_string(),
            });
        } else {
            *lead = js_trim(&buf.join("\n")).to_string();
        }
        buf.clear();
    };
    for line in text.split('\n') {
        if js_trim(line).starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence {
            if let Some(title) = h3_title(line) {
                flush(&mut heading, &mut buf, &mut lead, &mut sections);
                heading = Some(js_trim(title).to_string());
                continue;
            }
        }
        buf.push(line.to_string());
    }
    flush(&mut heading, &mut buf, &mut lead, &mut sections);
    (lead, sections)
}

pub fn join_article_sections(lead: &str, sections: &[WikiArticleSection]) -> String {
    let mut parts = Vec::new();
    if !js_trim(lead).is_empty() {
        parts.push(js_trim(lead).to_string());
    }
    for section in sections {
        parts.push(format!(
            "### {}\n\n{}",
            section.heading,
            js_trim(&section.body)
        ));
    }
    js_trim(&parts.join("\n\n")).to_string()
}

pub fn apply_article_patches(article: &str, patches: &[WikiArticlePatch]) -> String {
    let (lead, mut sections) = split_article_sections(article);
    for patch in patches {
        let heading = js_trim(&patch.heading);
        if heading.is_empty() {
            continue;
        }
        let body = js_trim(&patch.body);
        if body.is_empty() {
            continue;
        }
        let index = sections
            .iter()
            .position(|section| same_heading(&section.heading, heading));
        if let Some(index) = index {
            if patch.mode == ArticlePatchMode::Replace {
                sections[index].body = body.to_string();
            } else {
                let prev = sections[index].body.clone();
                sections[index].body = if js_trim(&prev).is_empty() || prev.contains(body) {
                    if prev.is_empty() {
                        body.to_string()
                    } else {
                        prev
                    }
                } else {
                    format!("{}\n\n{body}", js_trim(&prev))
                };
            }
        } else {
            sections.push(WikiArticleSection {
                heading: heading.to_string(),
                body: body.to_string(),
            });
        }
    }
    join_article_sections(&lead, &sections)
}

pub fn merge_article_bodies(left: &str, right: &str) -> String {
    let (left_lead, left_sections) = split_article_sections(left);
    let (right_lead, right_sections) = split_article_sections(right);
    let lead = merge_summary_text(&left_lead, &right_lead);
    let mut order = Vec::new();
    let mut bodies: Vec<WikiArticleSection> = Vec::new();
    for section in left_sections {
        let key = section.heading.to_lowercase();
        order.push(key);
        bodies.push(section);
    }
    for section in right_sections {
        let key = section.heading.to_lowercase();
        if let Some(index) = order.iter().position(|have| have == &key) {
            let incoming_len = js_len(&section.body);
            let incoming = js_trim(&section.body).to_string();
            let prev_body = bodies[index].body.clone();
            let prev_heading = bodies[index].heading.clone();
            if !incoming.is_empty() && !prev_body.contains(&incoming) {
                let body = if js_trim(&prev_body).is_empty() {
                    incoming
                } else if (incoming_len as f64) > (js_len(&prev_body) as f64) * 1.25 {
                    incoming
                } else {
                    format!("{}\n\n{incoming}", js_trim(&prev_body))
                };
                bodies[index] = WikiArticleSection {
                    heading: prev_heading,
                    body,
                };
            }
        } else {
            order.push(key);
            bodies.push(section);
        }
    }
    join_article_sections(&lead, &bodies)
}

pub fn parse_see_also(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in body.split('\n') {
        let trimmed = js_trim(line);
        if let Some(slug) = first_wiki_slug(trimmed) {
            if !slug.is_empty() && seen.insert(slug.clone()) {
                out.push(slug);
            }
            continue;
        }
        if let Some(slug) = bare_slug_bullet(trimmed) {
            if !slug.is_empty() && seen.insert(slug.clone()) {
                out.push(slug);
            }
        }
    }
    out
}

pub fn parse_citations(body: &str) -> Vec<WikiCitation> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in body.split('\n') {
        let trimmed = js_trim(line);
        if let Some(cells) = table_cells(trimmed) {
            let date_cell = js_trim(cells[0]);
            let squashed: String = date_cell
                .chars()
                .filter(|ch| !is_js_whitespace(*ch))
                .collect();
            if date_cell.eq_ignore_ascii_case("date")
                || (!squashed.is_empty() && squashed.chars().all(|ch| ch == '-'))
            {
                continue;
            }
            let sum_cell = js_trim(cells[2]);
            let Some(summary_id) = find_loose_id(sum_cell).or_else(|| find_ticked_id(sum_cell)) else {
                continue;
            };
            if !seen.insert(summary_id.clone()) {
                continue;
            }
            let date = if is_ymd(date_cell) {
                Some(date_cell.to_string())
            } else {
                None
            };
            let kind_cell = js_trim(cells[1]);
            let kind = if kind_cell.is_empty() || kind_cell.eq_ignore_ascii_case("kind") {
                None
            } else {
                Some(kind_cell.to_string())
            };
            let note_cell = js_trim(cells[3]);
            let note = if note_cell.is_empty() {
                None
            } else {
                Some(note_cell.to_string())
            };
            out.push(WikiCitation {
                summary_id,
                date,
                kind,
                note,
            });
            continue;
        }
        if !(trimmed.starts_with('-') || trimmed.starts_with('*')) {
            continue;
        }
        let Some(summary_id) = find_ticked_id(trimmed).or_else(|| find_bounded_id(trimmed)) else {
            continue;
        };
        if !seen.insert(summary_id.clone()) {
            continue;
        }
        let date = find_ymd(trimmed);
        let kind = find_kind_word(trimmed);
        let note = citation_note(trimmed);
        out.push(WikiCitation {
            summary_id,
            date,
            kind,
            note,
        });
    }
    out
}

struct RawSection {
    heading: String,
    body: String,
}

fn blank_page(title: String, slug: String) -> WikiPage {
    WikiPage {
        meta: WikiFrontmatter {
            title,
            slug,
            aliases: Vec::new(),
            tags: Vec::new(),
            entities: Vec::new(),
            related: Vec::new(),
            last_verified: None,
            sources: Vec::new(),
            extra: None,
        },
        current_state: String::new(),
        article: String::new(),
        history: Vec::new(),
        citations: Vec::new(),
        see_also: Vec::new(),
        preamble: None,
        extra_sections: Vec::new(),
    }
}

fn present(value: Option<String>) -> Option<String> {
    match value {
        Some(text) if !text.is_empty() => Some(text),
        _ => None,
    }
}

fn stamp_day(stamp: Option<&str>) -> String {
    if let Some(stamp) = stamp {
        js_prefix(stamp, 10)
    } else {
        utc_day()
    }
}

fn source_identity(source: &WikiSource) -> (Option<String>, String) {
    let mut ids = source.ids.clone();
    js_sort(&mut ids);
    let value = protocol::js::JsValue::Array(
        ids.into_iter()
            .map(|id| protocol::js::JsValue::from_text(&id))
            .collect(),
    );
    (source.kind.clone(), protocol::js::stringify(&value))
}

fn split_frontmatter(markdown: &str) -> Option<(&str, &str)> {
    let rest = markdown.strip_prefix("---\n")?;
    let close = rest.find("\n---")?;
    let yaml = &rest[..close];
    let mut after = close + "\n---".len();
    if rest[after..].starts_with('\n') {
        after += 1;
    }
    Some((yaml, &rest[after..]))
}

fn normalize_meta(raw: &Map<String, Value>) -> Result<WikiFrontmatter, WikiParseError> {
    let title = match raw.get("title") {
        Some(Value::String(title)) if !js_trim(title).is_empty() => title.clone(),
        _ => return Err(WikiParseError::new("title required")),
    };
    let slug = match raw.get("slug") {
        Some(Value::String(slug)) if !js_trim(slug).is_empty() => normalize_slug(slug),
        _ => return Err(WikiParseError::new("slug required")),
    };
    let mut extra = Map::new();
    for (key, value) in raw {
        if !KNOWN_META.contains(&key.as_str()) {
            extra.insert(key.clone(), value.clone());
        }
    }
    Ok(WikiFrontmatter {
        title,
        slug,
        aliases: str_list(raw.get("aliases")),
        tags: str_list(raw.get("tags")),
        entities: str_list(raw.get("entities")),
        related: str_list(raw.get("related"))
            .into_iter()
            .map(|item| normalize_slug(&item))
            .filter(|item| !item.is_empty())
            .collect(),
        last_verified: match raw.get("last_verified") {
            Some(Value::String(stamp)) => Some(stamp.clone()),
            _ => None,
        },
        sources: sources_of(raw.get("sources")),
        extra: if extra.is_empty() { None } else { Some(extra) },
    })
}

fn str_list(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect()
}

fn sources_of(value: Option<&Value>) -> Vec<WikiSource> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let Value::Object(map) = item else {
                return None;
            };
            source_from_map(map)
        })
        .collect()
}

fn source_from_map(map: &Map<String, Value>) -> Option<WikiSource> {
    let Value::Array(raw_ids) = map.get("ids")? else {
        return None;
    };
    let ids = raw_ids
        .iter()
        .filter_map(|item| item.as_str().map(str::to_string))
        .collect();
    let kind = match map.get("kind") {
        Some(Value::String(kind)) => Some(kind.clone()),
        _ => None,
    };
    let conversation_id = match map.get("conversationId") {
        Some(Value::String(id)) => Some(id.clone()),
        _ => None,
    };
    let span = match map.get("span") {
        Some(Value::Object(obj)) if obj.len() == 2 => {
            match (
                obj.get("earliest").and_then(Value::as_str),
                obj.get("latest").and_then(Value::as_str),
            ) {
                (Some(earliest), Some(latest)) => Some(SourceSpan {
                    earliest: earliest.to_string(),
                    latest: latest.to_string(),
                }),
                _ => None,
            }
        }
        _ => None,
    };
    let mut extra = Map::new();
    for (key, value) in map {
        let skip = key == "ids"
            || (key == "kind" && kind.is_some())
            || (key == "conversationId" && conversation_id.is_some())
            || (key == "span" && span.is_some());
        if skip {
            continue;
        }
        extra.insert(key.clone(), value.clone());
    }
    Some(WikiSource {
        kind,
        ids,
        conversation_id,
        span,
        extra,
    })
}

fn frontmatter_value(page: &WikiPage, related: &[String]) -> Map<String, Value> {
    let mut meta = Map::new();
    if let Some(extra) = &page.meta.extra {
        for (key, value) in extra {
            meta.insert(key.clone(), value.clone());
        }
    }
    meta.insert("title".to_string(), Value::String(page.meta.title.clone()));
    meta.insert("slug".to_string(), Value::String(page.meta.slug.clone()));
    meta.insert(
        "aliases".to_string(),
        string_array(&cap_list(&page.meta.aliases, ALIASES_MAX)),
    );
    meta.insert(
        "tags".to_string(),
        string_array(&cap_list(&page.meta.tags, TAGS_MAX)),
    );
    meta.insert(
        "entities".to_string(),
        string_array(&cap_list(&page.meta.entities, ENTITIES_MAX)),
    );
    meta.insert("related".to_string(), string_array(related));
    if let Some(stamp) = &page.meta.last_verified {
        if !stamp.is_empty() {
            meta.insert("last_verified".to_string(), Value::String(stamp.clone()));
        }
    }
    let sources = cap_tail(&page.meta.sources, SOURCES_MAX);
    meta.insert(
        "sources".to_string(),
        Value::Array(sources.iter().map(source_to_value).collect()),
    );
    meta
}

fn source_to_value(source: &WikiSource) -> Value {
    let mut map = Map::new();
    if let Some(kind) = &source.kind {
        map.insert("kind".to_string(), Value::String(kind.clone()));
    }
    map.insert("ids".to_string(), string_array(&source.ids));
    if let Some(id) = &source.conversation_id {
        map.insert("conversationId".to_string(), Value::String(id.clone()));
    }
    if let Some(span) = &source.span {
        let mut span_map = Map::new();
        span_map.insert(
            "earliest".to_string(),
            Value::String(span.earliest.clone()),
        );
        span_map.insert("latest".to_string(), Value::String(span.latest.clone()));
        map.insert("span".to_string(), Value::Object(span_map));
    }
    for (key, value) in &source.extra {
        map.insert(key.clone(), value.clone());
    }
    Value::Object(map)
}

fn string_array(items: &[String]) -> Value {
    Value::Array(items.iter().cloned().map(Value::String).collect())
}

fn article_block(article: &str) -> String {
    let article = js_trim(&demote_h2_headings(article));
    if article.is_empty() {
        String::new()
    } else {
        format!("\n## Article\n\n{article}\n")
    }
}

fn see_also_block(related: &[String]) -> String {
    if related.is_empty() {
        return String::new();
    }
    let mut lines = vec![String::new(), "## See also".to_string(), String::new()];
    for slug in related {
        lines.push(format!("- [[{slug}]]"));
    }
    lines.push(String::new());
    lines.join("\n")
}

fn history_block(history: &[WikiHistoryEntry]) -> String {
    history
        .iter()
        .map(|entry| {
            let title = if entry.title.is_empty() {
                String::new()
            } else {
                format!(" — {}", entry.title)
            };
            let body = js_trim(&demote_h2_headings(&entry.body));
            format!("### {}{title}\n\n{body}\n", entry.date)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn citation_block(citations: &[WikiCitation]) -> String {
    if citations.is_empty() {
        return String::new();
    }
    let mut lines = vec![
        String::new(),
        "## Citations".to_string(),
        String::new(),
        "| Date | Kind | Summary | Note |".to_string(),
        "|------|------|---------|------|".to_string(),
    ];
    for citation in citations {
        let date = citation.date.clone().unwrap_or_default();
        let kind = citation
            .kind
            .clone()
            .unwrap_or_else(|| "leaf".to_string());
        let note = citation.note.clone().unwrap_or_default().replace('|', "\\|");
        lines.push(format!(
            "| {date} | {kind} | `{}` | {note} |",
            citation.summary_id
        ));
    }
    lines.push(String::new());
    lines.join("\n")
}

fn union_slices(lists: &[&[String]]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for list in lists {
        for item in *list {
            if js_trim(item).is_empty() || !seen.insert(item.clone()) {
                continue;
            }
            out.push(item.clone());
        }
    }
    out
}

fn same_heading(heading: &str, name: &str) -> bool {
    heading.to_lowercase() == name.to_lowercase()
}

fn is_core_heading(heading: &str) -> bool {
    matches!(
        heading.to_lowercase().as_str(),
        "current state" | "summary" | "article" | "see also" | "history" | "citations"
    )
}

fn split_sections(body: &str) -> (String, Vec<RawSection>) {
    let mut sections = Vec::new();
    let mut pre = Vec::new();
    let mut heading: Option<String> = None;
    let mut buf = Vec::new();
    let mut in_fence = false;
    for line in body.split('\n') {
        if js_trim(line).starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence {
            if let Some(title) = h2_title(line) {
                if let Some(previous) = heading.take() {
                    sections.push(RawSection {
                        heading: previous,
                        body: buf.join("\n"),
                    });
                }
                heading = Some(js_trim(title).to_string());
                buf.clear();
                continue;
            }
        }
        if heading.is_some() {
            buf.push(line.to_string());
        } else {
            pre.push(line.to_string());
        }
    }
    if let Some(previous) = heading {
        sections.push(RawSection {
            heading: previous,
            body: buf.join("\n"),
        });
    }
    (pre.join("\n"), sections)
}

fn h2_title(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("## ")?;
    if rest.is_empty() {
        None
    } else {
        Some(rest)
    }
}

fn h3_title(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("### ")?;
    if rest.is_empty() {
        None
    } else {
        Some(rest)
    }
}

fn is_bare_h2(line: &str) -> bool {
    let Some(rest) = line.strip_prefix("## ") else {
        return false;
    };
    !rest.starts_with('#')
}

fn parse_history(body: &str) -> Vec<WikiHistoryEntry> {
    let mut entries = Vec::new();
    let mut current: Option<(String, String)> = None;
    let mut buf = Vec::new();
    let mut in_fence = false;
    for line in body.split('\n') {
        if js_trim(line).starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence {
            if let Some((date, title)) = history_heading(line) {
                if let Some((date, title)) = current.take() {
                    entries.push(WikiHistoryEntry {
                        date,
                        title,
                        body: js_trim(&buf.join("\n")).to_string(),
                    });
                }
                current = Some((date, title));
                buf.clear();
                continue;
            }
        }
        if current.is_some() {
            buf.push(line.to_string());
        }
    }
    if let Some((date, title)) = current {
        entries.push(WikiHistoryEntry {
            date,
            title,
            body: js_trim(&buf.join("\n")).to_string(),
        });
    }
    entries
}

fn history_heading(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("### ")?;
    if rest.len() < 10 || !rest.is_char_boundary(10) || !is_ymd(&rest[..10]) {
        return None;
    }
    let date = rest[..10].to_string();
    let after = &rest[10..];
    if after.is_empty() {
        return Some((date, String::new()));
    }
    let title = history_title(after)?;
    Some((date, title))
}

fn history_title(after: &str) -> Option<String> {
    let chars: Vec<char> = after.chars().collect();
    let mut index = 0usize;
    let mut saw_space = false;
    while index < chars.len() && is_js_whitespace(chars[index]) {
        saw_space = true;
        index += 1;
    }
    if !saw_space || index >= chars.len() || !matches!(chars[index], '—' | '–' | '-') {
        return None;
    }
    index += 1;
    let mut saw_space = false;
    while index < chars.len() && is_js_whitespace(chars[index]) {
        saw_space = true;
        index += 1;
    }
    if !saw_space {
        return None;
    }
    Some(chars[index..].iter().collect())
}

fn is_ymd(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

fn first_wiki_slug(line: &str) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut index = 0usize;
    while index + 1 < chars.len() {
        if chars[index] == '[' && chars[index + 1] == '[' {
            let start = index + 2;
            let mut end = start;
            while end < chars.len() && (chars[end].is_ascii_alphanumeric() || chars[end] == '-') {
                end += 1;
            }
            if end > start && end + 1 < chars.len() && chars[end] == ']' && chars[end + 1] == ']' {
                let raw: String = chars[start..end].iter().collect();
                return Some(normalize_slug(&raw));
            }
        }
        index += 1;
    }
    None
}

fn bare_slug_bullet(line: &str) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    if chars.is_empty() || !matches!(chars[0], '-' | '*') {
        return None;
    }
    let mut index = 1usize;
    let mut saw_space = false;
    while index < chars.len() && is_js_whitespace(chars[index]) {
        saw_space = true;
        index += 1;
    }
    if !saw_space {
        return None;
    }
    let start = index;
    while index < chars.len() && (chars[index].is_ascii_alphanumeric() || chars[index] == '-') {
        index += 1;
    }
    if index == start {
        return None;
    }
    while index < chars.len() && is_js_whitespace(chars[index]) {
        index += 1;
    }
    if index != chars.len() {
        return None;
    }
    let raw: String = chars[start..]
        .iter()
        .copied()
        .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
        .collect();
    Some(normalize_slug(&raw))
}

fn table_cells(line: &str) -> Option<[&str; 4]> {
    if !line.starts_with('|') || !line.ends_with('|') || line.len() < 2 {
        return None;
    }
    let inner = &line[1..line.len() - 1];
    let mut parts = Vec::new();
    for part in inner.split('|') {
        parts.push(part);
        if parts.len() > 4 {
            return None;
        }
    }
    if parts.len() != 4 || parts[0].is_empty() || parts[1].is_empty() || parts[2].is_empty() {
        return None;
    }
    Some([parts[0], parts[1], parts[2], parts[3]])
}

fn is_id_char(ch: char) -> bool {
    ch.is_ascii_hexdigit() || ch == '-'
}

fn find_ticked_id(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        if chars[index] == '`' && index + 37 < chars.len() && chars[index + 37] == '`' {
            let mid = &chars[index + 1..index + 37];
            if mid.iter().copied().all(is_id_char) {
                return Some(mid.iter().collect::<String>().to_lowercase());
            }
        }
        index += 1;
    }
    None
}

fn find_loose_id(text: &str) -> Option<String> {
    if let Some(id) = find_ticked_id(text) {
        return Some(id);
    }
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;
    while index + 36 <= chars.len() {
        if chars[index..index + 36].iter().copied().all(is_id_char) {
            return Some(
                chars[index..index + 36]
                    .iter()
                    .collect::<String>()
                    .to_lowercase(),
            );
        }
        index += 1;
    }
    None
}

fn find_bounded_id(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;
    while index + 36 <= chars.len() {
        if chars[index..index + 36].iter().copied().all(is_id_char)
            && word_boundary(&chars, index)
            && word_boundary(&chars, index + 36)
        {
            return Some(
                chars[index..index + 36]
                    .iter()
                    .collect::<String>()
                    .to_lowercase(),
            );
        }
        index += 1;
    }
    None
}

fn find_ymd(text: &str) -> Option<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;
    while index + 10 <= chars.len() {
        let slice: String = chars[index..index + 10].iter().collect();
        if is_ymd(&slice) && word_boundary(&chars, index) && word_boundary(&chars, index + 10) {
            return Some(slice);
        }
        index += 1;
    }
    None
}

fn find_kind_word(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut index = 0usize;
    while index < chars.len() {
        for word in ["leaf", "branch", "root"] {
            let word_chars: Vec<char> = word.chars().collect();
            if index + word_chars.len() <= chars.len()
                && chars[index..index + word_chars.len()] == word_chars[..]
                && word_boundary(&chars, index)
                && word_boundary(&chars, index + word_chars.len())
            {
                return Some(word.to_string());
            }
        }
        index += 1;
    }
    None
}

fn citation_note(line: &str) -> Option<String> {
    let chars: Vec<char> = line.chars().collect();
    for index in 0..chars.len() {
        if !matches!(chars[index], '—' | '–' | '-') {
            continue;
        }
        let mut next = index + 1;
        let mut saw_space = false;
        while next < chars.len() && is_js_whitespace(chars[next]) {
            saw_space = true;
            next += 1;
        }
        if !saw_space || next >= chars.len() {
            continue;
        }
        let note: String = chars[next..].iter().collect();
        let note = js_trim(&note);
        if note.is_empty() {
            return None;
        }
        return Some(note.to_string());
    }
    None
}

fn word_boundary(chars: &[char], index: usize) -> bool {
    let left = index > 0 && is_js_word(chars[index - 1]);
    let right = index < chars.len() && is_js_word(chars[index]);
    left != right
}

fn is_js_word(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}
