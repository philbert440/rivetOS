use crate::error::WikiParseError;
use crate::model::WikiPage;
use crate::page::parse_wiki_page;
use crate::text::{fmt_count, fmt_kb, js_last_index_of, js_len, js_trim, js_trim_end, split_utf16};

pub const WIKI_READ_VERBATIM_MAX_CHARS: usize = 24_000;

const DEFAULT_ARTICLE_CHARS: usize = 8_000;
const SECTION_ARTICLE_CHARS: usize = 24_000;
const DEFAULT_HISTORY: usize = 6;
const SECTION_HISTORY: usize = 20;
const HISTORY_BODY_CHARS: usize = 500;
const DEFAULT_ALIASES: usize = 8;
const SECTION_ALIASES: usize = 200;
const DEFAULT_SEE_ALSO: usize = 24;
const DEFAULT_CITATIONS: usize = 8;
const SECTION_CITATIONS: usize = 40;
const DEFAULT_TAGS: usize = 16;
const MALFORMED_RAW_CHARS: usize = 8_000;

pub fn format_wiki_read(markdown: &str, slug: &str, section: Option<&str>) -> String {
    let page = match parse_wiki_page(markdown) {
        Ok(page) => page,
        Err(err) => return format_malformed(markdown, slug, &err),
    };
    let section = section.unwrap_or("");
    let oversized = js_len(markdown) > WIKI_READ_VERBATIM_MAX_CHARS;
    if section == "full" {
        if !oversized {
            return markdown.to_string();
        }
        return [
            refuse_full_banner(&page, markdown, slug),
            String::new(),
            format_encyclopedia(&page, markdown, slug, true),
        ]
        .join("\n");
    }
    if section.is_empty() && !oversized {
        return markdown.to_string();
    }
    match section {
        "summary" => format_summary_slice(&page, markdown, slug),
        "article" => format_article_slice(&page, markdown, slug),
        "history" => format_history_slice(&page, markdown, slug),
        "aliases" => format_aliases_slice(&page, markdown, slug),
        "citations" => format_citations_slice(&page, markdown, slug),
        _ => format_encyclopedia(&page, markdown, slug, false),
    }
}

fn format_malformed(markdown: &str, slug: &str, err: &WikiParseError) -> String {
    let header = format!(
        "⚠ Page \"{slug}\" is malformed ({err}) — raw content follows; the next extractor pass will re-structure it."
    );
    if js_len(markdown) <= WIKI_READ_VERBATIM_MAX_CHARS {
        return format!("{header}\n\n{markdown}");
    }
    [
        header,
        format!(
            "Page is also oversized ({} chars); showing the first {}.",
            fmt_count(js_len(markdown)),
            fmt_count(MALFORMED_RAW_CHARS)
        ),
        String::new(),
        cap_text(
            markdown,
            MALFORMED_RAW_CHARS,
            &format!("wiki_read slug={slug} after the next extractor pass"),
        ),
    ]
    .join("\n")
}

fn format_encyclopedia(page: &WikiPage, markdown: &str, slug: &str, skip_banner: bool) -> String {
    let mut parts = Vec::new();
    if !skip_banner {
        parts.push(oversized_banner(page, markdown, slug));
    }
    parts.push(compact_header(page, false));
    parts.push(String::new());
    parts.push("## Summary".to_string());
    parts.push(String::new());
    let summary = js_trim(&page.current_state);
    parts.push(if summary.is_empty() {
        "(empty)".to_string()
    } else {
        summary.to_string()
    });
    let article = js_trim(&page.article);
    if !article.is_empty() {
        parts.push(String::new());
        parts.push("## Article".to_string());
        parts.push(String::new());
        parts.push(cap_text(
            article,
            DEFAULT_ARTICLE_CHARS,
            &format!("wiki_read slug={slug} section=article"),
        ));
    }
    let see_also = unique(&page.see_also);
    if !see_also.is_empty() {
        parts.push(String::new());
        parts.push("## See also".to_string());
        parts.push(String::new());
        parts.push(list_preview(
            &see_also,
            DEFAULT_SEE_ALSO,
            &|item| format!("- [[{item}]]"),
            &format!("wiki_read slug={slug} (see-also is not a slice; pick a linked slug)"),
        ));
    }
    let shown = DEFAULT_HISTORY.min(page.history.len());
    parts.push(String::new());
    parts.push(format!(
        "## Recent history ({shown} of {})",
        fmt_count(page.history.len())
    ));
    parts.push(String::new());
    parts.push(format_history_entries(page, DEFAULT_HISTORY, slug));
    if !page.citations.is_empty() {
        let shown = DEFAULT_CITATIONS.min(page.citations.len());
        parts.push(String::new());
        parts.push(format!(
            "## Citations ({shown} of {})",
            fmt_count(page.citations.len())
        ));
        parts.push(String::new());
        parts.push(format_citation_table(page, DEFAULT_CITATIONS, slug));
    }
    parts.push(String::new());
    parts.push(format!(
        "Use section=summary|article|history|aliases|citations for a slice. section=full is refused while the page exceeds {} characters.",
        fmt_count(WIKI_READ_VERBATIM_MAX_CHARS)
    ));
    parts.join("\n")
}

fn format_summary_slice(page: &WikiPage, markdown: &str, slug: &str) -> String {
    let summary = js_trim(&page.current_state);
    [
        slice_banner(page, markdown, slug, "summary"),
        compact_header(page, false),
        String::new(),
        "## Summary".to_string(),
        String::new(),
        if summary.is_empty() {
            "(empty)".to_string()
        } else {
            summary.to_string()
        },
    ]
    .join("\n")
}

fn format_article_slice(page: &WikiPage, markdown: &str, slug: &str) -> String {
    let article = js_trim(&page.article);
    let article = if article.is_empty() {
        "(empty)"
    } else {
        article
    };
    [
        slice_banner(page, markdown, slug, "article"),
        compact_header(page, false),
        String::new(),
        "## Article".to_string(),
        String::new(),
        cap_text(
            article,
            SECTION_ARTICLE_CHARS,
            &format!("wiki_read slug={slug} section=article (still truncated)"),
        ),
    ]
    .join("\n")
}

fn format_history_slice(page: &WikiPage, markdown: &str, slug: &str) -> String {
    let shown = SECTION_HISTORY.min(page.history.len());
    [
        slice_banner(page, markdown, slug, "history"),
        compact_header(page, false),
        String::new(),
        format!(
            "## History ({shown} of {}, newest first)",
            fmt_count(page.history.len())
        ),
        String::new(),
        format_history_entries(page, SECTION_HISTORY, slug),
    ]
    .join("\n")
}

fn format_aliases_slice(page: &WikiPage, markdown: &str, slug: &str) -> String {
    let aliases = &page.meta.aliases;
    let shown = SECTION_ALIASES.min(aliases.len());
    let body = if aliases.is_empty() {
        "(none)".to_string()
    } else {
        list_preview(
            aliases,
            SECTION_ALIASES,
            &|item| format!("- {item}"),
            &format!(
                "wiki_read slug={slug} section=aliases (first {} only)",
                fmt_count(SECTION_ALIASES)
            ),
        )
    };
    [
        slice_banner(page, markdown, slug, "aliases"),
        compact_header(page, true),
        String::new(),
        format!("## Aliases ({shown} of {})", fmt_count(aliases.len())),
        String::new(),
        body,
    ]
    .join("\n")
}

fn format_citations_slice(page: &WikiPage, markdown: &str, slug: &str) -> String {
    let shown = SECTION_CITATIONS.min(page.citations.len());
    [
        slice_banner(page, markdown, slug, "citations"),
        compact_header(page, false),
        String::new(),
        format!(
            "## Citations ({shown} of {})",
            fmt_count(page.citations.len())
        ),
        String::new(),
        format_citation_table(page, SECTION_CITATIONS, slug),
    ]
    .join("\n")
}

fn oversized_banner(page: &WikiPage, markdown: &str, slug: &str) -> String {
    [
        format!(
            "⚠ Oversized wiki page \"{slug}\" ({}).",
            page_stats(page, markdown)
        ),
        "The raw file leads with YAML aliases, so MCP/capture truncation hid Summary and Article."
            .to_string(),
        "Showing the encyclopedia view (lead + article + recent history), not the raw file."
            .to_string(),
        String::new(),
    ]
    .join("\n")
}

fn slice_banner(page: &WikiPage, markdown: &str, slug: &str, section: &str) -> String {
    let prefix = if js_len(markdown) > WIKI_READ_VERBATIM_MAX_CHARS {
        format!(
            "⚠ Oversized wiki page \"{slug}\" ({}). ",
            page_stats(page, markdown)
        )
    } else {
        String::new()
    };
    format!("{prefix}section={section}\n")
}

fn refuse_full_banner(page: &WikiPage, markdown: &str, slug: &str) -> String {
    [
        format!(
            "section=full refused for \"{slug}\": page is {} (limit {} characters).",
            page_stats(page, markdown),
            fmt_count(WIKI_READ_VERBATIM_MAX_CHARS)
        ),
        "Dumping the raw file would truncate in MCP/capture before Summary.".to_string(),
        "Encyclopedia view follows. Slice with section=summary|article|history|aliases|citations."
            .to_string(),
    ]
    .join("\n")
}

fn page_stats(page: &WikiPage, markdown: &str) -> String {
    format!(
        "{} KB · {} aliases · {} history · {} citations · {} see-also",
        fmt_kb(js_len(markdown)),
        fmt_count(page.meta.aliases.len()),
        fmt_count(page.history.len()),
        fmt_count(page.citations.len()),
        fmt_count(page.see_also.len())
    )
}

fn compact_header(page: &WikiPage, omit_alias_preview: bool) -> String {
    let mut lines = vec![
        "---".to_string(),
        format!("title: {}", page.meta.title),
        format!("slug: {}", page.meta.slug),
    ];
    if let Some(stamp) = &page.meta.last_verified
        && !stamp.is_empty()
    {
        lines.push(format!("last_verified: {stamp}"));
    }
    if !page.meta.tags.is_empty() {
        let shown = page.meta.tags.len().min(DEFAULT_TAGS);
        let tags = page.meta.tags[..shown].join(", ");
        let extra = if page.meta.tags.len() > DEFAULT_TAGS {
            format!(" (+{})", page.meta.tags.len() - DEFAULT_TAGS)
        } else {
            String::new()
        };
        lines.push(format!("tags: {tags}{extra}"));
    }
    if omit_alias_preview {
        lines.push(format!(
            "aliases_count: {}",
            fmt_count(page.meta.aliases.len())
        ));
    } else {
        lines.push(format!("aliases: {}", alias_preview(&page.meta.aliases)));
    }
    lines.push("---".to_string());
    lines.join("\n")
}

fn alias_preview(aliases: &[String]) -> String {
    if aliases.is_empty() {
        return "0".to_string();
    }
    let shown = aliases.len().min(DEFAULT_ALIASES);
    let listed = aliases[..shown].join(", ");
    if aliases.len() <= DEFAULT_ALIASES {
        format!("{} ({listed})", fmt_count(aliases.len()))
    } else {
        format!(
            "{} (showing {DEFAULT_ALIASES}: {listed}) — section=aliases",
            fmt_count(aliases.len())
        )
    }
}

fn format_history_entries(page: &WikiPage, keep: usize, slug: &str) -> String {
    if page.history.is_empty() {
        return "(none yet)".to_string();
    }
    let take = keep.min(page.history.len());
    let blocks: Vec<String> = page.history[..take]
        .iter()
        .map(|entry| {
            let title = if entry.title.is_empty() {
                String::new()
            } else {
                format!(" — {}", entry.title)
            };
            let body = js_trim(&entry.body);
            let body = if body.is_empty() { "(empty)" } else { body };
            let body = cap_text(
                body,
                HISTORY_BODY_CHARS,
                &format!("wiki_read slug={slug} section=history"),
            );
            format!("### {}{title}\n\n{body}", entry.date)
        })
        .collect();
    let extra = if page.history.len() > keep {
        format!(
            "\n\n…[{} older entries — wiki_read slug={slug} section=history]",
            fmt_count(page.history.len() - keep)
        )
    } else {
        String::new()
    };
    format!("{}{extra}", blocks.join("\n\n"))
}

fn format_citation_table(page: &WikiPage, keep: usize, slug: &str) -> String {
    if page.citations.is_empty() {
        return "(none)".to_string();
    }
    let take = keep.min(page.citations.len());
    let mut rows = vec![
        "| Date | Kind | Summary | Note |".to_string(),
        "|------|------|---------|------|".to_string(),
    ];
    for citation in &page.citations[..take] {
        let date = citation.date.clone().unwrap_or_default();
        let kind = citation.kind.clone().unwrap_or_else(|| "leaf".to_string());
        let note = citation
            .note
            .clone()
            .unwrap_or_default()
            .replace('|', "\\|");
        rows.push(format!(
            "| {date} | {kind} | `{}` | {note} |",
            citation.summary_id
        ));
    }
    let extra = if page.citations.len() > keep {
        format!(
            "\n…[{} more — wiki_read slug={slug} section=citations]",
            fmt_count(page.citations.len() - keep)
        )
    } else {
        String::new()
    };
    format!("{}{extra}", rows.join("\n"))
}

fn list_preview(
    items: &[String],
    keep: usize,
    render: &dyn Fn(&str) -> String,
    more_hint: &str,
) -> String {
    let take = keep.min(items.len());
    let shown: Vec<String> = items[..take].iter().map(|item| render(item)).collect();
    let extra = if items.len() > keep {
        format!("\n…[{} more — {more_hint}]", fmt_count(items.len() - keep))
    } else {
        String::new()
    };
    format!("{}{extra}", shown.join("\n"))
}

fn cap_text(text: &str, max: usize, hint: &str) -> String {
    if js_len(text) <= max {
        return text.to_string();
    }
    let mut cut = max;
    if let Some(newline) = js_last_index_of(text, "\n\n", max)
        && (newline as f64) > (max as f64) * 0.5
    {
        cut = newline;
    }
    let kept = js_trim_end(split_utf16(text, cut).0);
    format!(
        "{kept}\n\n…[{} more chars — {hint}]",
        fmt_count(js_len(text) - js_len(kept))
    )
}

fn unique(items: &[String]) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in items {
        if item.is_empty() || !seen.insert(item.clone()) {
            continue;
        }
        out.push(item.clone());
    }
    out
}
