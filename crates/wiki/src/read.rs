use crate::error::WikiParseError;
use crate::model::WikiPage;
use crate::page::parse_wiki_page;
use crate::text::{JsText, fmt_count, fmt_kb};

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

pub fn format_wiki_read(markdown: &str, slug: &str, section: Option<&str>) -> JsText {
    let page = match parse_wiki_page(markdown) {
        Ok(page) => page,
        Err(err) => return format_malformed(markdown, slug, &err),
    };
    let section = section.unwrap_or("");
    let oversized = protocol::js::utf16_len(markdown) > WIKI_READ_VERBATIM_MAX_CHARS;
    if section == "full" {
        if !oversized {
            return JsText::from(markdown);
        }
        return JsText::join(
            &[
                JsText::from(refuse_full_banner(&page, markdown, slug)),
                JsText::from(""),
                format_encyclopedia(&page, markdown, slug, true),
            ],
            "\n",
        );
    }
    if section.is_empty() && !oversized {
        return JsText::from(markdown);
    }
    match section {
        "summary" => format_summary_slice(&page, markdown, slug),
        "article" => format_article_slice(&page, markdown, slug),
        "history" => format_history_slice(&page, markdown, slug),
        "aliases" => JsText::from(format_aliases_slice(&page, markdown, slug)),
        "citations" => JsText::from(format_citations_slice(&page, markdown, slug)),
        _ => format_encyclopedia(&page, markdown, slug, false),
    }
}

fn format_malformed(markdown: &str, slug: &str, err: &WikiParseError) -> JsText {
    let header = format!(
        "⚠ Page \"{slug}\" is malformed ({err}) — raw content follows; the next extractor pass will re-structure it."
    );
    if protocol::js::utf16_len(markdown) <= WIKI_READ_VERBATIM_MAX_CHARS {
        return JsText::from(format!("{header}\n\n{markdown}"));
    }
    JsText::join(
        &[
            JsText::from(header),
            JsText::from(format!(
                "Page is also oversized ({} chars); showing the first {}.",
                fmt_count(protocol::js::utf16_len(markdown)),
                fmt_count(MALFORMED_RAW_CHARS)
            )),
            JsText::from(""),
            cap_text(
                &JsText::from(markdown),
                MALFORMED_RAW_CHARS,
                &format!("wiki_read slug={slug} after the next extractor pass"),
            ),
        ],
        "\n",
    )
}

fn format_encyclopedia(page: &WikiPage, markdown: &str, slug: &str, skip_banner: bool) -> JsText {
    let mut parts = Vec::new();
    if !skip_banner {
        parts.push(JsText::from(oversized_banner(page, markdown, slug)));
    }
    parts.push(JsText::from(compact_header(page, false)));
    parts.push(JsText::from(""));
    parts.push(JsText::from("## Summary"));
    parts.push(JsText::from(""));
    let summary = page.current_state.trimmed();
    parts.push(if summary.is_empty() {
        JsText::from("(empty)")
    } else {
        summary
    });
    let article = JsText::from(protocol::js::js_trim(&page.article));
    if !article.is_empty() {
        parts.push(JsText::from(""));
        parts.push(JsText::from("## Article"));
        parts.push(JsText::from(""));
        parts.push(cap_text(
            &article,
            DEFAULT_ARTICLE_CHARS,
            &format!("wiki_read slug={slug} section=article"),
        ));
    }
    let see_also = unique(&page.see_also);
    if !see_also.is_empty() {
        parts.push(JsText::from(""));
        parts.push(JsText::from("## See also"));
        parts.push(JsText::from(""));
        parts.push(JsText::from(list_preview(
            &see_also,
            DEFAULT_SEE_ALSO,
            &|item| format!("- [[{item}]]"),
            &format!("wiki_read slug={slug} (see-also is not a slice; pick a linked slug)"),
        )));
    }
    let shown = DEFAULT_HISTORY.min(page.history.len());
    parts.push(JsText::from(""));
    parts.push(JsText::from(format!(
        "## Recent history ({shown} of {})",
        fmt_count(page.history.len())
    )));
    parts.push(JsText::from(""));
    parts.push(format_history_entries(page, DEFAULT_HISTORY, slug));
    if !page.citations.is_empty() {
        let shown = DEFAULT_CITATIONS.min(page.citations.len());
        parts.push(JsText::from(""));
        parts.push(JsText::from(format!(
            "## Citations ({shown} of {})",
            fmt_count(page.citations.len())
        )));
        parts.push(JsText::from(""));
        parts.push(JsText::from(format_citation_table(
            page,
            DEFAULT_CITATIONS,
            slug,
        )));
    }
    parts.push(JsText::from(""));
    parts.push(JsText::from(format!(
        "Use section=summary|article|history|aliases|citations for a slice. section=full is refused while the page exceeds {} characters.",
        fmt_count(WIKI_READ_VERBATIM_MAX_CHARS)
    )));
    JsText::join(&parts, "\n")
}

fn format_summary_slice(page: &WikiPage, markdown: &str, slug: &str) -> JsText {
    let summary = page.current_state.trimmed();
    let summary = if summary.is_empty() {
        JsText::from("(empty)")
    } else {
        summary
    };
    JsText::join(
        &[
            JsText::from(slice_banner(page, markdown, slug, "summary")),
            JsText::from(compact_header(page, false)),
            JsText::from(""),
            JsText::from("## Summary"),
            JsText::from(""),
            summary,
        ],
        "\n",
    )
}

fn format_article_slice(page: &WikiPage, markdown: &str, slug: &str) -> JsText {
    let article = JsText::from(protocol::js::js_trim(&page.article));
    let article = if article.is_empty() {
        JsText::from("(empty)")
    } else {
        article
    };
    JsText::join(
        &[
            JsText::from(slice_banner(page, markdown, slug, "article")),
            JsText::from(compact_header(page, false)),
            JsText::from(""),
            JsText::from("## Article"),
            JsText::from(""),
            cap_text(
                &article,
                SECTION_ARTICLE_CHARS,
                &format!("wiki_read slug={slug} section=article (still truncated)"),
            ),
        ],
        "\n",
    )
}

fn format_history_slice(page: &WikiPage, markdown: &str, slug: &str) -> JsText {
    let shown = SECTION_HISTORY.min(page.history.len());
    JsText::join(
        &[
            JsText::from(slice_banner(page, markdown, slug, "history")),
            JsText::from(compact_header(page, false)),
            JsText::from(""),
            JsText::from(format!(
                "## History ({shown} of {}, newest first)",
                fmt_count(page.history.len())
            )),
            JsText::from(""),
            format_history_entries(page, SECTION_HISTORY, slug),
        ],
        "\n",
    )
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
    let prefix = if protocol::js::utf16_len(markdown) > WIKI_READ_VERBATIM_MAX_CHARS {
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
        fmt_kb(protocol::js::utf16_len(markdown)),
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

fn format_history_entries(page: &WikiPage, keep: usize, slug: &str) -> JsText {
    if page.history.is_empty() {
        return JsText::from("(none yet)");
    }
    let take = keep.min(page.history.len());
    let blocks: Vec<JsText> = page.history[..take]
        .iter()
        .map(|entry| {
            let title = if entry.title.is_empty() {
                String::new()
            } else {
                format!(" — {}", entry.title)
            };
            let body = entry.body.trimmed();
            let body = if body.is_empty() {
                JsText::from("(empty)")
            } else {
                body
            };
            let body = cap_text(
                &body,
                HISTORY_BODY_CHARS,
                &format!("wiki_read slug={slug} section=history"),
            );
            JsText::concat(&[JsText::from(format!("### {}{title}\n\n", entry.date)), body])
        })
        .collect();
    let joined = JsText::join(&blocks, "\n\n");
    if page.history.len() > keep {
        JsText::concat(&[
            joined,
            JsText::from(format!(
                "\n\n…[{} older entries — wiki_read slug={slug} section=history]",
                fmt_count(page.history.len() - keep)
            )),
        ])
    } else {
        joined
    }
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

fn cap_text(text: &JsText, max: usize, hint: &str) -> JsText {
    if text.len() <= max {
        return text.clone();
    }
    let mut cut = max;
    if let Some(newline) = text.last_index_of("\n\n", max)
        && (newline as f64) > (max as f64) * 0.5
    {
        cut = newline;
    }
    let kept = text.slice(0, Some(cut)).trimmed_end();
    let omitted = text.len() - kept.len();
    JsText::concat(&[
        kept,
        JsText::from(format!("\n\n…[{} more chars — {hint}]", fmt_count(omitted))),
    ])
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
