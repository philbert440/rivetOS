use crate::error::WikiParseError;
use crate::model::{
    ArticlePatchMode, Passthrough, SummaryCap, WikiArticlePatch, WikiArticleSection, WikiCitation,
    WikiFrontmatter, WikiHistoryEntry, WikiPage, WikiPatch, WikiSection, WikiSource,
};
use crate::slug::{extract_wiki_links, normalize_slug};
use crate::text::{JsText, demote_h2};
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

pub trait WikiMarkdown {
    fn to_markdown_text(&self) -> JsText;
}

impl WikiMarkdown for str {
    fn to_markdown_text(&self) -> JsText {
        JsText::from(self)
    }
}

impl WikiMarkdown for String {
    fn to_markdown_text(&self) -> JsText {
        JsText::from(self.as_str())
    }
}

impl WikiMarkdown for JsText {
    fn to_markdown_text(&self) -> JsText {
        self.clone()
    }
}

impl WikiMarkdown for protocol::js::JsString {
    fn to_markdown_text(&self) -> JsText {
        JsText::from_units(self.units().to_vec())
    }
}

pub fn parse_wiki_page(input: &(impl WikiMarkdown + ?Sized)) -> Result<WikiPage, WikiParseError> {
    let text = input.to_markdown_text();
    match String::from_utf16(text.units()) {
        Ok(markdown) => parse_markdown(&markdown),
        Err(_) => parse_with_units(text.units()),
    }
}

fn parse_markdown(input: &str) -> Result<WikiPage, WikiParseError> {
    let markdown = input.replace("\r\n", "\n");
    let Some((yaml, body)) = split_frontmatter(&markdown) else {
        return Err(WikiParseError::new("missing YAML frontmatter"));
    };
    let value = parse_yaml_value(yaml)?;
    if value.as_object().is_none() {
        return Err(WikiParseError::new("frontmatter not a map"));
    }
    let mut meta = normalize_meta(&value)?;
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
            body: protocol::js::js_trim(&section.body).to_string(),
        })
        .collect();
    let see_from = see_also_sec
        .map(|section| parse_see_also(&section.body))
        .unwrap_or_default();
    let see_also = union_slices(&[&meta.related, &see_from]);
    meta.related = union_slices(&[&meta.related, &see_also]);
    let preamble = {
        let trimmed = protocol::js::js_trim(&preamble);
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    Ok(WikiPage {
        meta,
        current_state: JsText::from(protocol::js::js_trim(
            summary.map(|section| section.body.as_str()).unwrap_or(""),
        )),
        article: protocol::js::js_trim(article.map(|section| section.body.as_str()).unwrap_or(""))
            .to_string(),
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

fn parse_with_units(units: &[u16]) -> Result<WikiPage, WikiParseError> {
    let markdown = normalize_crlf(units);
    let Some((yaml_units, body)) = split_frontmatter_units(&markdown) else {
        return Err(WikiParseError::new("missing YAML frontmatter"));
    };
    let value = parse_yaml_value(&units_as_utf8(yaml_units))?;
    if value.as_object().is_none() {
        return Err(WikiParseError::new("frontmatter not a map"));
    }
    let mut meta = normalize_meta(&value)?;
    let (preamble_units, sections) = split_sections_units(body);
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
            body: protocol::js::js_trim(&units_as_utf8(&section.body)).to_string(),
        })
        .collect();
    let see_from = see_also_sec
        .map(|section| parse_see_also(&units_as_utf8(&section.body)))
        .unwrap_or_default();
    let see_also = union_slices(&[&meta.related, &see_from]);
    meta.related = union_slices(&[&meta.related, &see_also]);
    let preamble_text = units_as_utf8(&preamble_units);
    let preamble = {
        let trimmed = protocol::js::js_trim(&preamble_text);
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    };
    let summary_body = summary
        .map(|section| section.body.clone())
        .unwrap_or_default();
    let article_body = article
        .map(|section| section.body.clone())
        .unwrap_or_default();
    Ok(WikiPage {
        meta,
        current_state: JsText::from_units(protocol::js::js_trim_units(&summary_body).to_vec()),
        article: protocol::js::js_trim(&units_as_utf8(&article_body)).to_string(),
        history: history
            .map(|section| parse_history_units(&section.body))
            .unwrap_or_default(),
        citations: citations
            .map(|section| parse_citations(&units_as_utf8(&section.body)))
            .unwrap_or_default(),
        see_also,
        preamble,
        extra_sections,
    })
}

pub fn serialize_wiki_page(page: &WikiPage) -> JsText {
    let related = cap_list(
        &union_slices(&[&page.meta.related, &page.see_also])
            .into_iter()
            .filter(|slug| slug != &page.meta.slug)
            .collect::<Vec<_>>(),
        RELATED_MAX,
    );
    let yaml_text = emit_yaml(&frontmatter_value(page, &related));
    let yaml = protocol::js::js_trim_end(&yaml_text);
    let mut parts = Vec::new();
    parts.push(JsText::from(format!("---\n{yaml}\n---")));
    if let Some(preamble) = &page.preamble
        && !preamble.is_empty()
    {
        parts.push(JsText::from(""));
        parts.push(JsText::from(preamble.as_str()));
    }
    parts.push(JsText::from(""));
    parts.push(JsText::from("## Summary"));
    parts.push(JsText::from(""));
    parts.push(demote_h2(&page.current_state).trimmed());
    parts.push(JsText::from(article_block(&page.article)));
    parts.push(JsText::from(see_also_block(&related)));
    parts.push(JsText::from(""));
    parts.push(JsText::from("## History"));
    parts.push(JsText::from(""));
    parts.push(history_block(&cap_list(&page.history, HISTORY_MAX)).trimmed_end());
    parts.push(JsText::from(citation_block(&cap_list(
        &page.citations,
        CITATIONS_MAX,
    ))));
    for section in &page.extra_sections {
        parts.push(JsText::from(""));
        parts.push(JsText::from(format!("## {}", section.heading)));
        parts.push(JsText::from(""));
        parts.push(JsText::from(section.body.as_str()));
    }
    parts.push(JsText::from(""));
    JsText::join(&parts, "\n")
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
    if let Some(title) = &patch.title
        && !title.is_empty()
    {
        page.meta.title = title.clone();
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
            .any(|have| have.kind() == source.kind() && source_identity(have) == key);
        if !dup {
            page.meta.sources.push(source.clone());
        }
    }
    let day = stamp_prefix(&patch.verified_at);
    if let Some(delta) = &patch.summary_delta
        && !protocol::js::js_trim(delta).is_empty()
    {
        let folded = demote_h2(&JsText::from(protocol::js::js_trim(delta)));
        page.current_state = merge_summary_text(&page.current_state, &folded);
    }
    if let Some(incoming) = &patch.current_state {
        let incoming_trim = protocol::js::js_trim(incoming);
        let current_trim = page.current_state.trimmed();
        if current_trim != incoming_trim {
            let next = demote_h2(&JsText::from(incoming_trim));
            let prev = current_trim;
            let would_shrink = !prev.is_empty()
                && !next.is_empty()
                && (next.len() as f64) < (prev.len() as f64) * SUMMARY_SHRINK_FLOOR
                && !patch.allow_shrink;
            if would_shrink {
                if prev.len() < SUMMARY_MAX_CHARS {
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
    let capped = cap_units(&page.current_state, SUMMARY_MAX_CHARS);
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
        let next = demote_h2_headings(protocol::js::js_trim(incoming));
        if next != protocol::js::js_trim(&page.article) {
            if !protocol::js::js_trim(&page.article).is_empty()
                && next != protocol::js::js_trim(&page.article)
            {
                page.history.insert(
                    0,
                    WikiHistoryEntry {
                        date: day.clone(),
                        title: "Superseded article".to_string(),
                        body: JsText::from(protocol::js::js_trim(&page.article)),
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
        let body = demote_h2(&entry.body.trimmed());
        let dup = page.history.iter().any(|have| {
            have.date == entry.date && have.title == entry.title && have.body.trimmed() == body
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
        out.meta.related = union_slices(&[&out.meta.related, &loser.meta.related, &loser.see_also]);
        for source in &loser.meta.sources {
            let key = source_identity(source);
            let dup = out
                .meta
                .sources
                .iter()
                .any(|have| have.kind() == source.kind() && source_identity(have) == key);
            if !dup {
                out.meta.sources.push(source.clone());
            }
        }
        let loser_state = loser.current_state.trimmed();
        let current_state = out.current_state.trimmed();
        if current_state.is_empty() && !loser_state.is_empty() {
            out.current_state = loser_state;
        } else if !loser_state.is_empty()
            && loser_state != current_state
            && (loser.current_state.len() as f64) > (out.current_state.len() as f64) * 1.25
        {
            out.history.insert(
                0,
                WikiHistoryEntry {
                    date: stamp_day(out.meta.last_verified.as_deref()),
                    title: "Superseded current state (consolidation)".to_string(),
                    body: current_state,
                },
            );
            out.current_state = loser_state;
        } else if !loser_state.is_empty() && loser_state != current_state {
            out.history.insert(
                0,
                WikiHistoryEntry {
                    date: stamp_day(loser.meta.last_verified.as_deref()),
                    title: format!("Merged from {}", loser.meta.slug),
                    body: loser_state.clone(),
                },
            );
            out.current_state = merge_summary_text(&out.current_state, &loser_state);
        }
        let loser_article = protocol::js::js_trim(&loser.article).to_string();
        if !loser_article.is_empty() {
            if protocol::js::js_trim(&out.article).is_empty() {
                out.article = demote_h2_headings(&loser_article);
            } else if loser_article != protocol::js::js_trim(&out.article) {
                if (protocol::js::utf16_len(&loser_article) as f64)
                    > (protocol::js::utf16_len(&out.article) as f64) * 1.25
                {
                    out.history.insert(
                        0,
                        WikiHistoryEntry {
                            date: stamp_day(out.meta.last_verified.as_deref()),
                            title: "Superseded article (consolidation)".to_string(),
                            body: JsText::from(protocol::js::js_trim(&out.article)),
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
            let body = entry.body.trimmed();
            let dup = out.history.iter().any(|have| {
                have.date == entry.date && have.title == entry.title && have.body.trimmed() == body
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
    out.history
        .sort_by(|left, right| right.date.cmp(&left.date));
    let capped = cap_units(&out.current_state, SUMMARY_MAX_CHARS);
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

pub fn merge_summary_text(existing: &JsText, delta: &JsText) -> JsText {
    let left = existing.trimmed();
    let right = delta.trimmed();
    if right.is_empty() {
        return left;
    }
    if left.is_empty() || left == right || units_contains(left.units(), right.units()) {
        return if left.is_empty() { right } else { left };
    }
    if units_contains(right.units(), left.units()) && right.len() > left.len() {
        return right;
    }
    JsText::join(&[left, right], "\n\n")
}

fn units_contains(hay: &[u16], needle: &[u16]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if needle.len() > hay.len() {
        return false;
    }
    hay.windows(needle.len()).any(|window| window == needle)
}

pub fn cap_summary(text: &str, max_chars: usize) -> SummaryCap {
    cap_units(&JsText::from(text), max_chars)
}

fn cap_units(text: &JsText, max_chars: usize) -> SummaryCap {
    let trimmed = text.trimmed();
    if trimmed.len() <= max_chars {
        return SummaryCap {
            kept: trimmed,
            overflow: JsText::from(""),
        };
    }
    let mut cut = max_chars;
    if let Some(newline) = trimmed.last_index_of("\n\n", max_chars)
        && (newline as f64) > (max_chars as f64) * 0.5
    {
        cut = newline;
    }
    SummaryCap {
        kept: trimmed.slice(0, Some(cut)).trimmed_end(),
        overflow: trimmed.slice(cut, None).trimmed(),
    }
}

pub fn demote_h2_headings(markdown: &str) -> String {
    demote_h2(&JsText::from(markdown)).utf8().to_string()
}

pub fn build_wiki_search_text(page: &WikiPage) -> JsText {
    let article = JsText::from(protocol::js::js_trim(&page.article))
        .slice(0, Some(SEARCH_ARTICLE_EXCERPT_CHARS));
    let aliases = cap_list(&page.meta.aliases, ALIASES_MAX).join(" ");
    let related = cap_list(&page.meta.related, RELATED_MAX).join(" ");
    let joined = JsText::join(
        &[
            JsText::from(page.meta.title.as_str()),
            JsText::from(aliases.as_str()),
            page.current_state.clone(),
            article,
            JsText::from(related.as_str()),
        ],
        " ",
    );
    joined.slice(0, Some(8_000))
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
    let flush = |heading: &mut Option<String>,
                 buf: &mut Vec<String>,
                 lead: &mut String,
                 sections: &mut Vec<WikiArticleSection>| {
        if let Some(heading) = heading.take() {
            sections.push(WikiArticleSection {
                heading,
                body: protocol::js::js_trim(&buf.join("\n")).to_string(),
            });
        } else {
            *lead = protocol::js::js_trim(&buf.join("\n")).to_string();
        }
        buf.clear();
    };
    for line in text.split('\n') {
        if protocol::js::js_trim(line).starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence && let Some(title) = h3_title(line) {
            flush(&mut heading, &mut buf, &mut lead, &mut sections);
            heading = Some(protocol::js::js_trim(title).to_string());
            continue;
        }
        buf.push(line.to_string());
    }
    flush(&mut heading, &mut buf, &mut lead, &mut sections);
    (lead, sections)
}

pub fn join_article_sections(lead: &str, sections: &[WikiArticleSection]) -> String {
    let mut parts = Vec::new();
    if !protocol::js::js_trim(lead).is_empty() {
        parts.push(protocol::js::js_trim(lead).to_string());
    }
    for section in sections {
        parts.push(format!(
            "### {}\n\n{}",
            section.heading,
            protocol::js::js_trim(&section.body)
        ));
    }
    protocol::js::js_trim(&parts.join("\n\n")).to_string()
}

pub fn apply_article_patches(article: &str, patches: &[WikiArticlePatch]) -> String {
    let (lead, mut sections) = split_article_sections(article);
    for patch in patches {
        let heading = protocol::js::js_trim(&patch.heading);
        if heading.is_empty() {
            continue;
        }
        let body = protocol::js::js_trim(&patch.body);
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
                sections[index].body =
                    if protocol::js::js_trim(&prev).is_empty() || prev.contains(body) {
                        if prev.is_empty() {
                            body.to_string()
                        } else {
                            prev
                        }
                    } else {
                        format!("{}\n\n{body}", protocol::js::js_trim(&prev))
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
    let lead = merge_summary_text(
        &JsText::from(left_lead.as_str()),
        &JsText::from(right_lead.as_str()),
    );
    let mut order = Vec::new();
    let mut bodies: Vec<WikiArticleSection> = Vec::new();
    for section in left_sections {
        let key = section.heading.to_lowercase();
        if let Some(index) = order.iter().position(|have| have == &key) {
            bodies[index] = section;
        } else {
            order.push(key);
            bodies.push(section);
        }
    }
    for section in right_sections {
        let key = section.heading.to_lowercase();
        if let Some(index) = order.iter().position(|have| have == &key) {
            let incoming_len = protocol::js::utf16_len(&section.body);
            let incoming = protocol::js::js_trim(&section.body).to_string();
            let prev_body = bodies[index].body.clone();
            let prev_heading = bodies[index].heading.clone();
            if !incoming.is_empty() && !prev_body.contains(&incoming) {
                let replace = protocol::js::js_trim(&prev_body).is_empty()
                    || (incoming_len as f64) > (protocol::js::utf16_len(&prev_body) as f64) * 1.25;
                let body = if replace {
                    incoming
                } else {
                    format!("{}\n\n{incoming}", protocol::js::js_trim(&prev_body))
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
    join_article_sections(lead.utf8(), &bodies)
}

pub fn parse_see_also(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in body.split('\n') {
        let trimmed = protocol::js::js_trim(line);
        if let Some(slug) = first_wiki_slug(trimmed) {
            if !slug.is_empty() && seen.insert(slug.clone()) {
                out.push(slug);
            }
            continue;
        }
        if let Some(slug) = bare_slug_bullet(trimmed)
            && !slug.is_empty()
            && seen.insert(slug.clone())
        {
            out.push(slug);
        }
    }
    out
}

pub fn parse_citations(body: &str) -> Vec<WikiCitation> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in body.split('\n') {
        let trimmed = protocol::js::js_trim(line);
        if let Some(cells) = table_cells(trimmed) {
            let date_cell = protocol::js::js_trim(cells[0]);
            let squashed: String = date_cell
                .chars()
                .filter(|ch| !protocol::js::is_js_whitespace(*ch))
                .collect();
            if date_cell.eq_ignore_ascii_case("date")
                || (!squashed.is_empty() && squashed.chars().all(|ch| ch == '-'))
            {
                continue;
            }
            let sum_cell = protocol::js::js_trim(cells[2]);
            let Some(summary_id) = find_loose_id(sum_cell).or_else(|| find_ticked_id(sum_cell))
            else {
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
            let kind_cell = protocol::js::js_trim(cells[1]);
            let kind = if kind_cell.is_empty() || kind_cell.eq_ignore_ascii_case("kind") {
                None
            } else {
                Some(kind_cell.to_string())
            };
            let note_cell = protocol::js::js_trim(cells[3]);
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
        current_state: JsText::from(""),
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

fn stamp_prefix(stamp: &str) -> String {
    protocol::js::js_slice(stamp, Some(0.0), Some(10.0))
        .to_utf8()
        .to_string()
}

fn stamp_day(stamp: Option<&str>) -> String {
    if let Some(stamp) = stamp {
        stamp_prefix(stamp)
    } else {
        match protocol::js::utc_day(protocol::js::date_now()) {
            Ok(day) => day,
            Err(_) => "1970-01-01".to_string(),
        }
    }
}

fn source_identity(source: &WikiSource) -> (Option<String>, String) {
    let kind = source.kind().map(str::to_string);
    let Some(items) = source
        .raw()
        .js()
        .get("ids")
        .and_then(protocol::js::JsValue::as_array)
    else {
        return (kind, "[]".to_string());
    };
    let mut owned = items.to_vec();
    owned.sort_by_key(js_sort_key);
    (
        kind,
        protocol::js::stringify(&protocol::js::JsValue::Array(owned)),
    )
}

fn js_sort_key(value: &protocol::js::JsValue) -> Vec<u16> {
    protocol::js::js_string(value).units().to_vec()
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

fn split_frontmatter_units(markdown: &[u16]) -> Option<(&[u16], &[u16])> {
    let prefix = (*b"---\n").map(u16::from);
    if !markdown.starts_with(&prefix) {
        return None;
    }
    let rest = &markdown[prefix.len()..];
    let close_mark = (*b"\n---").map(u16::from);
    let close = find_units(rest, &close_mark)?;
    let yaml = &rest[..close];
    let mut after = close + close_mark.len();
    if rest.get(after) == Some(&u16::from(b'\n')) {
        after += 1;
    }
    Some((yaml, &rest[after..]))
}

fn normalize_crlf(units: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(units.len());
    let mut index = 0usize;
    while index < units.len() {
        if units[index] == u16::from(b'\r') && units.get(index + 1) == Some(&u16::from(b'\n')) {
            out.push(u16::from(b'\n'));
            index += 2;
        } else {
            out.push(units[index]);
            index += 1;
        }
    }
    out
}

fn units_as_utf8(units: &[u16]) -> String {
    String::from_utf16(units).unwrap_or_else(|_| {
        char::decode_utf16(units.iter().copied())
            .map(|item| item.unwrap_or('\u{FFFD}'))
            .collect()
    })
}

fn find_units(hay: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    hay.windows(needle.len())
        .position(|window| window == needle)
}

struct UnitSection {
    heading: String,
    body: Vec<u16>,
}

fn split_sections_units(body: &[u16]) -> (Vec<u16>, Vec<UnitSection>) {
    let mut sections = Vec::new();
    let mut pre = Vec::new();
    let mut heading: Option<String> = None;
    let mut buf = Vec::new();
    let mut in_fence = false;
    for line in split_unit_lines(body) {
        let trimmed = protocol::js::js_trim_units(line);
        if units_start(trimmed, "```") {
            in_fence = !in_fence;
        }
        if !in_fence && let Some(title) = h2_title_units(line) {
            if let Some(previous) = heading.take() {
                sections.push(UnitSection {
                    heading: previous,
                    body: join_unit_lines(&buf),
                });
            }
            heading = Some(units_as_utf8(protocol::js::js_trim_units(title)));
            buf.clear();
            continue;
        }
        if heading.is_some() {
            buf.push(line.to_vec());
        } else {
            pre.push(line.to_vec());
        }
    }
    if let Some(previous) = heading {
        sections.push(UnitSection {
            heading: previous,
            body: join_unit_lines(&buf),
        });
    }
    (join_unit_lines(&pre), sections)
}

fn h2_title_units(line: &[u16]) -> Option<&[u16]> {
    let prefix = (*b"## ").map(u16::from);
    if line.starts_with(&prefix) && line.len() > prefix.len() {
        Some(&line[prefix.len()..])
    } else {
        None
    }
}

fn parse_history_units(body: &[u16]) -> Vec<WikiHistoryEntry> {
    let mut entries = Vec::new();
    let mut current: Option<(String, String)> = None;
    let mut buf = Vec::new();
    let mut in_fence = false;
    for line in split_unit_lines(body) {
        let trimmed = protocol::js::js_trim_units(line);
        if units_start(trimmed, "```") {
            in_fence = !in_fence;
        }
        if !in_fence && let Some((date, title)) = history_heading_units(line) {
            if let Some((date, title)) = current.take() {
                entries.push(WikiHistoryEntry {
                    date,
                    title,
                    body: JsText::from_units(
                        protocol::js::js_trim_units(&join_unit_lines(&buf)).to_vec(),
                    ),
                });
            }
            current = Some((date, title));
            buf.clear();
            continue;
        }
        if current.is_some() {
            buf.push(line.to_vec());
        }
    }
    if let Some((date, title)) = current {
        entries.push(WikiHistoryEntry {
            date,
            title,
            body: JsText::from_units(protocol::js::js_trim_units(&join_unit_lines(&buf)).to_vec()),
        });
    }
    entries
}

fn history_heading_units(line: &[u16]) -> Option<(String, String)> {
    let text = String::from_utf16(line).ok()?;
    history_heading(&text)
}

fn units_start(units: &[u16], prefix: &str) -> bool {
    let prefix: Vec<u16> = prefix.encode_utf16().collect();
    units.starts_with(&prefix)
}

fn split_unit_lines(units: &[u16]) -> Vec<&[u16]> {
    let mut lines = Vec::new();
    let mut start = 0usize;
    for (index, unit) in units.iter().enumerate() {
        if *unit == u16::from(b'\n') {
            lines.push(&units[start..index]);
            start = index + 1;
        }
    }
    lines.push(&units[start..]);
    lines
}

fn join_unit_lines(lines: &[Vec<u16>]) -> Vec<u16> {
    let mut out = Vec::new();
    for (index, line) in lines.iter().enumerate() {
        if index > 0 {
            out.push(u16::from(b'\n'));
        }
        out.extend_from_slice(line);
    }
    out
}

fn normalize_meta(raw: &Passthrough) -> Result<WikiFrontmatter, WikiParseError> {
    let title = match raw
        .js()
        .get("title")
        .and_then(protocol::js::JsValue::as_str)
    {
        Some(title) if !protocol::js::js_trim(title).is_empty() => title.to_string(),
        _ => return Err(WikiParseError::new("title required")),
    };
    let slug = match raw.js().get("slug").and_then(protocol::js::JsValue::as_str) {
        Some(slug) if !protocol::js::js_trim(slug).is_empty() => normalize_slug(slug),
        _ => return Err(WikiParseError::new("slug required")),
    };
    let Some(entries) = raw.as_object() else {
        return Err(WikiParseError::new("frontmatter not a map"));
    };
    let mut extra = protocol::js::JsObject::new();
    for (key, value) in entries.iter() {
        let name = key.to_utf8();
        if !KNOWN_META.contains(&name) {
            extra.insert(key.clone(), value.clone());
        }
    }
    Ok(WikiFrontmatter {
        title,
        slug,
        aliases: str_list(raw.js().get("aliases")),
        tags: str_list(raw.js().get("tags")),
        entities: str_list(raw.js().get("entities")),
        related: str_list(raw.js().get("related"))
            .into_iter()
            .map(|item| normalize_slug(&item))
            .filter(|item| !item.is_empty())
            .collect(),
        last_verified: raw
            .js()
            .get("last_verified")
            .and_then(protocol::js::JsValue::as_str)
            .map(str::to_string),
        sources: sources_of(raw.js().get("sources")),
        extra: if extra.is_empty() {
            None
        } else {
            Some(Passthrough::from_object(extra))
        },
    })
}

fn str_list(value: Option<&protocol::js::JsValue>) -> Vec<String> {
    let Some(items) = value.and_then(protocol::js::JsValue::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(protocol::js::JsValue::as_str)
        .map(str::to_string)
        .collect()
}

fn sources_of(value: Option<&protocol::js::JsValue>) -> Vec<WikiSource> {
    let Some(items) = value.and_then(protocol::js::JsValue::as_array) else {
        return Vec::new();
    };
    items.iter().filter_map(WikiSource::from_value).collect()
}

fn frontmatter_value(page: &WikiPage, related: &[String]) -> Passthrough {
    let mut meta = protocol::js::JsObject::new();
    if let Some(extra) = &page.meta.extra
        && let Some(entries) = extra.as_object()
    {
        for (key, value) in entries.iter() {
            meta.insert(key.clone(), value.clone());
        }
    }
    meta.insert("title", Passthrough::string(&page.meta.title).into_js());
    meta.insert("slug", Passthrough::string(&page.meta.slug).into_js());
    meta.insert(
        "aliases",
        string_array(&cap_list(&page.meta.aliases, ALIASES_MAX)).into_js(),
    );
    meta.insert(
        "tags",
        string_array(&cap_list(&page.meta.tags, TAGS_MAX)).into_js(),
    );
    meta.insert(
        "entities",
        string_array(&cap_list(&page.meta.entities, ENTITIES_MAX)).into_js(),
    );
    meta.insert("related", string_array(related).into_js());
    if let Some(stamp) = &page.meta.last_verified
        && !stamp.is_empty()
    {
        meta.insert("last_verified", Passthrough::string(stamp).into_js());
    }
    let sources = cap_tail(&page.meta.sources, SOURCES_MAX);
    meta.insert(
        "sources",
        Passthrough::array(sources.iter().map(|source| source.raw().clone()).collect()).into_js(),
    );
    Passthrough::from_object(meta)
}

fn string_array(items: &[String]) -> Passthrough {
    Passthrough::array(items.iter().map(Passthrough::string).collect())
}

fn article_block(article: &str) -> String {
    let demoted = demote_h2_headings(article);
    let article = protocol::js::js_trim(&demoted);
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

fn history_block(history: &[WikiHistoryEntry]) -> JsText {
    let mut pieces = Vec::new();
    for entry in history {
        let title = if entry.title.is_empty() {
            String::new()
        } else {
            format!(" — {}", entry.title)
        };
        let body = demote_h2(&entry.body).trimmed();
        pieces.push(JsText::concat(&[
            JsText::from(format!("### {}{title}\n\n", entry.date)),
            body,
            JsText::from("\n"),
        ]));
    }
    JsText::join(&pieces, "\n")
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
        let kind = citation.kind.clone().unwrap_or_else(|| "leaf".to_string());
        let note = citation
            .note
            .clone()
            .unwrap_or_default()
            .replace('|', "\\|");
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
            if protocol::js::js_trim(item).is_empty() || !seen.insert(item.clone()) {
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
        if protocol::js::js_trim(line).starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence && let Some(title) = h2_title(line) {
            if let Some(previous) = heading.take() {
                sections.push(RawSection {
                    heading: previous,
                    body: buf.join("\n"),
                });
            }
            heading = Some(protocol::js::js_trim(title).to_string());
            buf.clear();
            continue;
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
    if rest.is_empty() { None } else { Some(rest) }
}

fn h3_title(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("### ")?;
    if rest.is_empty() { None } else { Some(rest) }
}

fn parse_history(body: &str) -> Vec<WikiHistoryEntry> {
    let mut entries = Vec::new();
    let mut current: Option<(String, String)> = None;
    let mut buf = Vec::new();
    let mut in_fence = false;
    for line in body.split('\n') {
        if protocol::js::js_trim(line).starts_with("```") {
            in_fence = !in_fence;
        }
        if !in_fence && let Some((date, title)) = history_heading(line) {
            if let Some((date, title)) = current.take() {
                entries.push(WikiHistoryEntry {
                    date,
                    title,
                    body: JsText::from(protocol::js::js_trim(&buf.join("\n"))),
                });
            }
            current = Some((date, title));
            buf.clear();
            continue;
        }
        if current.is_some() {
            buf.push(line.to_string());
        }
    }
    if let Some((date, title)) = current {
        entries.push(WikiHistoryEntry {
            date,
            title,
            body: JsText::from(protocol::js::js_trim(&buf.join("\n"))),
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
    while index < chars.len() && protocol::js::is_js_whitespace(chars[index]) {
        saw_space = true;
        index += 1;
    }
    if !saw_space || index >= chars.len() || !matches!(chars[index], '—' | '–' | '-') {
        return None;
    }
    index += 1;
    let mut saw_space = false;
    while index < chars.len() && protocol::js::is_js_whitespace(chars[index]) {
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
    while index < chars.len() && protocol::js::is_js_whitespace(chars[index]) {
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
    while index < chars.len() && protocol::js::is_js_whitespace(chars[index]) {
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
        while next < chars.len() && protocol::js::is_js_whitespace(chars[next]) {
            saw_space = true;
            next += 1;
        }
        if !saw_space || next >= chars.len() {
            continue;
        }
        let note: String = chars[next..].iter().collect();
        let note = protocol::js::js_trim(&note);
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

#[cfg(test)]
mod tests {
    use super::source_identity;
    use crate::model::WikiSource;

    #[test]
    fn nested_null_array_id_sorts_like_javascript_tostring() {
        let source: WikiSource = serde_json::from_str(r#"{"ids":["b",[null]]}"#).expect("source");
        let (_, key) = source_identity(&source);
        assert_eq!(key, "[[null],\"b\"]");
    }
}
