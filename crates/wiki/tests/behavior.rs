use wiki::{
    ALIASES_MAX, ArticlePatchMode, CITATIONS_MAX, ENTITIES_MAX, HISTORY_MAX, PatchAction,
    RELATED_MAX, SOURCES_MAX, SUMMARY_MAX_CHARS, TAGS_MAX, WIKI_READ_VERBATIM_MAX_CHARS,
    WikiArticlePatch, WikiCitation, WikiFrontmatter, WikiHistoryEntry, WikiIndexEntry,
    WikiIndexResponse, WikiPage, WikiPageResponse, WikiPatch, WikiSource, apply_article_patches,
    apply_patch, build_wiki_search_text, cap_list, cap_summary, cap_tail, cluster_slugs_by_stem,
    demote_h2_headings, entities_overlap, extract_wiki_links, find_stem_match, format_wiki_read,
    is_read_slug, is_slug_variant, merge_pages, normalize_slug, parse_wiki_page,
    prefer_canonical_slug, read_slug_error, serialize_wiki_page, slug_token_prefix,
};

const SAMPLE: &str = "---\ntitle: RivetOS Task Engine\nslug: rivetos-task-engine\naliases:\n  - task-engine\ntags:\n  - rivetos\nentities:\n  - project:rivetos\nlast_verified: 2026-07-06T18:00:00Z\nsources:\n  - kind: summary\n    ids:\n      - 8f3a0000-0000-0000-0000-000000000001\n    conversationId: c1d20000-0000-0000-0000-000000000002\n---\n\n## Current state\n\nros_tasks is the only orchestration engine. Gateway lives on :5174.\n\n## History\n\n### 2026-07-06 — Phase 1 cutover shipped\n\n- Legacy tables archived in 0003.\n- **Provenance:** summary 8f3a\u{2026}\n\n### 2026-05-20 — Design locked\n\n- HarnessExecutor contract in @rivetos/types.\n";

fn page() -> WikiPage {
    parse_wiki_page(SAMPLE).expect("sample")
}

fn patch(action: PatchAction, slug: &str, verified_at: &str) -> WikiPatch {
    WikiPatch::new(action, slug, verified_at)
}

#[test]
fn parses_frontmatter_current_state_and_dated_history() {
    let page = page();
    assert_eq!(page.meta.slug, "rivetos-task-engine");
    assert_eq!(page.meta.aliases, vec!["task-engine"]);
    assert_eq!(page.meta.sources[0].ids.len(), 1);
    assert!(page.current_state.contains("only orchestration engine"));
    assert_eq!(page.history.len(), 2);
    assert_eq!(page.history[0].date, "2026-07-06");
    assert_eq!(page.history[0].title, "Phase 1 cutover shipped");
    assert!(page.history[1].body.contains("HarnessExecutor"));
}

#[test]
fn round_trips_stably() {
    let once = serialize_wiki_page(&page());
    let twice = serialize_wiki_page(&parse_wiki_page(&once).expect("once"));
    assert_eq!(twice, once);
}

#[test]
fn rejects_pages_without_frontmatter_title_or_slug() {
    let missing = parse_wiki_page("# no frontmatter").expect_err("frontmatter");
    assert!(missing.to_string().contains("invalid wiki page"));
    let title = parse_wiki_page("---\nslug: x\n---\n").expect_err("title");
    assert!(title.to_string().contains("title"));
    let slug = parse_wiki_page("---\ntitle: x\n---\n").expect_err("slug");
    assert!(slug.to_string().contains("slug"));
}

#[test]
fn create_seeds_a_page_and_update_archives_prior_state() {
    let mut created_patch = patch(PatchAction::Create, "GERTY vLLM!", "2026-07-07T00:00:00Z");
    created_patch.title = Some("GERTY vLLM".to_string());
    created_patch.current_state = Some("v1 state".to_string());
    let created = apply_patch(None, &created_patch);
    assert_eq!(created.meta.slug, "gerty-vllm");
    assert_eq!(created.current_state, "v1 state");
    assert!(created.history.is_empty());

    let mut updated_patch = patch(PatchAction::Update, "gerty-vllm", "2026-07-08T00:00:00Z");
    updated_patch.current_state = Some("v2 state".to_string());
    updated_patch.history_entry = Some(WikiHistoryEntry {
        date: "2026-07-08".to_string(),
        title: "Cutover".to_string(),
        body: "- moved to v2".to_string(),
    });
    let updated = apply_patch(Some(&created), &updated_patch);
    assert_eq!(updated.current_state, "v2 state");
    let titles: Vec<&str> = updated
        .history
        .iter()
        .map(|entry| entry.title.as_str())
        .collect();
    assert!(titles.contains(&"Superseded current state"));
    assert!(titles.contains(&"Cutover"));
    let archived = updated
        .history
        .iter()
        .find(|entry| entry.title == "Superseded current state")
        .expect("archive");
    assert_eq!(archived.body, "v1 state");
}

#[test]
fn identical_state_does_not_archive_and_duplicates_dedupe() {
    let base = page();
    let mut update = patch(PatchAction::Update, &base.meta.slug, "2026-07-09T00:00:00Z");
    update.current_state = Some(base.current_state.clone());
    update.history_entry = Some(WikiHistoryEntry {
        date: "2026-07-06".to_string(),
        title: "Phase 1 cutover shipped".to_string(),
        body: base.history[0].body.clone(),
    });
    update.add_sources = base.meta.sources.clone();
    let patched = apply_patch(Some(&base), &update);
    assert_eq!(patched.history.len(), 2);
    assert_eq!(patched.meta.sources.len(), 1);
    assert_eq!(
        patched.meta.last_verified.as_deref(),
        Some("2026-07-09T00:00:00Z")
    );
}

#[test]
fn unions_aliases_tags_and_entities() {
    let mut update = patch(
        PatchAction::Update,
        "rivetos-task-engine",
        "2026-07-09T00:00:00Z",
    );
    update.add_aliases = vec!["task-engine".to_string(), "ros-tasks".to_string()];
    update.add_tags = vec!["infrastructure".to_string()];
    let patched = apply_patch(Some(&page()), &update);
    assert_eq!(patched.meta.aliases, vec!["task-engine", "ros-tasks"]);
    assert_eq!(patched.meta.tags, vec!["rivetos", "infrastructure"]);
}

#[test]
fn caps_identity_lists_after_union() {
    let mut update = patch(
        PatchAction::Update,
        "rivetos-task-engine",
        "2026-07-09T00:00:00Z",
    );
    update.add_aliases = (0..ALIASES_MAX + 20)
        .map(|index| format!("alias-{index}"))
        .collect();
    update.add_tags = (0..TAGS_MAX + 10)
        .map(|index| format!("tag-{index}"))
        .collect();
    update.add_entities = (0..ENTITIES_MAX + 10)
        .map(|index| format!("ent:{index}"))
        .collect();
    update.add_related = (0..RELATED_MAX + 10)
        .map(|index| format!("rel-{index}"))
        .collect();
    let patched = apply_patch(Some(&page()), &update);
    assert_eq!(patched.meta.aliases.len(), ALIASES_MAX);
    assert_eq!(patched.meta.aliases[0], "task-engine");
    assert_eq!(patched.meta.aliases[1], "alias-0");
    assert!(
        !patched
            .meta
            .aliases
            .contains(&format!("alias-{}", ALIASES_MAX + 5))
    );
    assert_eq!(patched.meta.tags.len(), TAGS_MAX);
    assert_eq!(patched.meta.tags[0], "rivetos");
    assert_eq!(patched.meta.entities.len(), ENTITIES_MAX);
    assert_eq!(patched.meta.related.len(), RELATED_MAX);
    assert_eq!(patched.see_also.len(), RELATED_MAX);
}

#[test]
fn serialize_of_bloated_identity_writes_only_the_ceilings() {
    let mut bloated = page();
    bloated.meta.aliases = (0..200).map(|index| format!("a-{index}")).collect();
    bloated.meta.tags = (0..200).map(|index| format!("t-{index}")).collect();
    bloated.meta.entities = (0..200).map(|index| format!("e-{index}")).collect();
    bloated.meta.related = (0..200).map(|index| format!("r-{index}")).collect();
    bloated.see_also = bloated.meta.related.clone();
    let round = parse_wiki_page(&serialize_wiki_page(&bloated)).expect("round");
    assert_eq!(round.meta.aliases.len(), ALIASES_MAX);
    assert_eq!(round.meta.aliases[0], "a-0");
    assert_eq!(round.meta.tags.len(), TAGS_MAX);
    assert_eq!(round.meta.entities.len(), ENTITIES_MAX);
    assert!(round.meta.related.len() <= RELATED_MAX);
    assert!(round.see_also.len() <= RELATED_MAX);
    assert_eq!(
        serialize_wiki_page(&round),
        serialize_wiki_page(&parse_wiki_page(&serialize_wiki_page(&round)).expect("again"))
    );
}

#[test]
fn merge_pages_caps_identity_lists() {
    let mut canonical = page();
    canonical.meta.aliases = (0..ALIASES_MAX - 2)
        .map(|index| format!("keep-{index}"))
        .collect();
    let mut loser =
        parse_wiki_page(&SAMPLE.replace("slug: rivetos-task-engine", "slug: ros-tasks-shard"))
            .expect("loser");
    loser.meta.aliases = (0..40).map(|index| format!("loser-{index}")).collect();
    loser.meta.title = "Ros Tasks Shard".to_string();
    let merged = merge_pages(&canonical, &[loser]);
    assert!(merged.meta.aliases.len() <= ALIASES_MAX);
    assert_eq!(merged.meta.aliases[0], "keep-0");
    assert!(
        merged
            .meta
            .aliases
            .iter()
            .any(|alias| alias == "ros-tasks-shard")
    );
}

#[test]
fn search_text_omits_overflow_aliases() {
    let mut topic = page();
    topic.meta.aliases = (0..200)
        .map(|index| format!("unique-alias-token-{index}"))
        .collect();
    let text = build_wiki_search_text(&topic);
    assert!(text.contains("unique-alias-token-0"));
    assert!(!text.contains("unique-alias-token-199"));
}

#[test]
fn cap_list_is_a_noop_under_the_ceiling() {
    assert_eq!(cap_list(&["a", "b"], 8), vec!["a", "b"]);
    assert!(cap_list::<&str>(&[], 8).is_empty());
}

#[test]
fn cap_tail_keeps_the_newest_entries() {
    assert_eq!(cap_tail(&["a", "b", "c", "d"], 2), vec!["c", "d"]);
    assert_eq!(cap_tail(&["a", "b"], 8), vec!["a", "b"]);
    assert!(cap_tail::<&str>(&[], 8).is_empty());
}

fn padded(index: usize) -> String {
    format!("{index:012}")
}

#[test]
fn serialize_of_bloated_provenance_writes_only_the_ceilings() {
    let mut bloated = page();
    bloated.meta.sources = (0..SOURCES_MAX + 40)
        .map(|index| {
            WikiSource::summary(vec![format!("00000000-0000-0000-0000-{}", padded(index))])
        })
        .collect();
    bloated.history = (0..HISTORY_MAX + 20)
        .map(|index| WikiHistoryEntry {
            date: format!("2026-08-{:02}", (index % 28) + 1),
            title: format!("entry-{index}"),
            body: format!("- note {index}"),
        })
        .collect();
    bloated.citations = (0..CITATIONS_MAX + 20)
        .map(|index| WikiCitation {
            summary_id: format!("11111111-1111-1111-1111-{}", padded(index)),
            date: Some("2026-08-22".to_string()),
            kind: Some("leaf".to_string()),
            note: None,
        })
        .collect();
    let round = parse_wiki_page(&serialize_wiki_page(&bloated)).expect("round");
    assert_eq!(round.meta.sources.len(), SOURCES_MAX);
    assert!(round.meta.sources[0].ids[0].contains(&padded(40)));
    assert!(round.meta.sources.last().expect("last").ids[0].contains(&padded(SOURCES_MAX + 39)));
    assert_eq!(round.history.len(), HISTORY_MAX);
    assert_eq!(round.history[0].title, "entry-0");
    assert!(!round.history.iter().any(|entry| entry.title == "entry-60"));
    assert_eq!(round.citations.len(), CITATIONS_MAX);
    assert!(round.citations[0].summary_id.ends_with(&padded(0)));
    assert_eq!(
        serialize_wiki_page(&round),
        serialize_wiki_page(&parse_wiki_page(&serialize_wiki_page(&round)).expect("again"))
    );
}

#[test]
fn apply_patch_caps_sources_history_and_citations() {
    let mut update = patch(
        PatchAction::Update,
        "rivetos-task-engine",
        "2026-08-23T00:00:00Z",
    );
    update.add_sources = (0..SOURCES_MAX + 10)
        .map(|index| {
            WikiSource::summary(vec![format!("22222222-2222-2222-2222-{}", padded(index))])
        })
        .collect();
    update.add_citations = (0..CITATIONS_MAX + 10)
        .map(|index| WikiCitation {
            summary_id: format!("33333333-3333-3333-3333-{}", padded(index)),
            date: Some("2026-08-23".to_string()),
            kind: Some("leaf".to_string()),
            note: None,
        })
        .collect();
    let patched = apply_patch(Some(&page()), &update);
    assert!(patched.meta.sources.len() <= SOURCES_MAX);
    assert!(patched.citations.len() <= CITATIONS_MAX);
    assert!(
        patched.citations[0]
            .summary_id
            .ends_with(&padded(CITATIONS_MAX + 9))
    );
}

#[test]
fn crlf_input_and_hyphen_history_headings_parse() {
    let crlf = SAMPLE
        .replace('\n', "\r\n")
        .replace("— Phase 1", "- Phase 1");
    let parsed = parse_wiki_page(&crlf).expect("crlf");
    assert_eq!(parsed.history[0].title, "Phase 1 cutover shipped");
}

#[test]
fn fences_do_not_split_history_or_sections() {
    let md = format!("{SAMPLE}\n```\n### 2020-01-01 — not an entry\n## not a section\n```\n");
    let parsed = parse_wiki_page(&md).expect("fenced");
    assert_eq!(parsed.history.len(), 2);
    assert!(parsed.history[1].body.contains("### 2020-01-01"));
}

#[test]
fn preamble_extra_sections_and_unknown_keys_survive() {
    let md = format!(
        "{}\n## Notes\n\n- hand note\n",
        SAMPLE.replace("last_verified:", "touched_by: human\nlast_verified:")
    );
    let parsed = parse_wiki_page(&md).expect("extra");
    let extra = parsed.meta.extra.clone().expect("extra map");
    assert_eq!(
        extra.get("touched_by").and_then(|value| value.as_str()),
        Some("human")
    );
    assert_eq!(parsed.extra_sections.len(), 1);
    assert_eq!(parsed.extra_sections[0].heading, "Notes");
    assert_eq!(parsed.extra_sections[0].body, "- hand note");
    let round = parse_wiki_page(&serialize_wiki_page(&parsed)).expect("round");
    assert_eq!(round.meta.extra, parsed.meta.extra);
    assert_eq!(round.extra_sections, parsed.extra_sections);
    assert_eq!(serialize_wiki_page(&round), serialize_wiki_page(&parsed));
}

const DECKARD: &str = "---\ntitle: Deckard 40B\nslug: deckard-40b\naliases: []\ntags: []\nentities: []\nrelated:\n  - hv-c\nsources: []\n---\n\n## Summary\n\nLead paragraph about the model.\n\n## Article\n\n### Configuration\n\nRuns on [[hv-c]].\n\n### Operations\n\nvLLM on :8003.\n\n## See also\n\n- [[1cat-vllm]]\n- [[rivetos]]\n\n## History\n\n### 2026-07-01 — First note\n\n- hello\n";

#[test]
fn parses_summary_article_and_see_also() {
    let parsed = parse_wiki_page(DECKARD).expect("deckard");
    assert!(parsed.current_state.contains("Lead paragraph"));
    assert!(parsed.article.contains("### Configuration"));
    for slug in ["hv-c", "1cat-vllm", "rivetos"] {
        assert!(parsed.see_also.iter().any(|item| item == slug));
    }
    let round = parse_wiki_page(&serialize_wiki_page(&parsed)).expect("round");
    assert_eq!(round.current_state, parsed.current_state);
    assert!(round.article.contains("Configuration"));
    let again = serialize_wiki_page(&round);
    assert!(again.contains("## Summary"));
    assert!(!again.contains("## Current state"));
}

#[test]
fn legacy_current_state_parses_as_summary() {
    let parsed = page();
    assert!(parsed.current_state.contains("only orchestration engine"));
    assert!(parsed.article.is_empty());
}

#[test]
fn summary_delta_folds_and_short_rewrite_refuses_shrink() {
    let base = page();
    let long = format!(
        "{} standing facts about the task engine and ros_tasks.",
        "A".repeat(200)
    );
    let mut grow = patch(PatchAction::Update, &base.meta.slug, "2026-07-10T00:00:00Z");
    grow.current_state = Some(long.clone());
    grow.allow_shrink = true;
    let with_long = apply_patch(Some(&base), &grow);
    assert_eq!(with_long.current_state, long);

    let mut thrash = patch(PatchAction::Update, &base.meta.slug, "2026-07-11T00:00:00Z");
    thrash.current_state = Some("tiny blurb".to_string());
    let thrashed = apply_patch(Some(&with_long), &thrash);
    assert!(thrashed.current_state.len() > 100);
    assert!(thrashed.current_state.contains("standing facts"));
    assert!(thrashed.current_state.contains("tiny blurb"));

    let mut delta = patch(PatchAction::Update, &base.meta.slug, "2026-07-12T00:00:00Z");
    delta.summary_delta = Some("Also exposes GET /api/tasks.".to_string());
    let folded = apply_patch(Some(&with_long), &delta);
    assert!(folded.current_state.contains("standing facts"));
    assert!(folded.current_state.contains("GET /api/tasks"));
}

#[test]
fn article_patches_merge_by_heading_and_links_are_harvested() {
    let art = apply_article_patches(
        "",
        &[
            WikiArticlePatch {
                heading: "Role".to_string(),
                mode: ArticlePatchMode::Merge,
                body: "Orchestration engine.".to_string(),
            },
            WikiArticlePatch {
                heading: "Hosts".to_string(),
                mode: ArticlePatchMode::Merge,
                body: "Lives with [[datahub]].".to_string(),
            },
        ],
    );
    assert!(art.contains("### Role"));
    assert!(art.contains("### Hosts"));
    let mut update = patch(
        PatchAction::Update,
        "rivetos-task-engine",
        "2026-07-12T00:00:00Z",
    );
    update.article_patches = vec![WikiArticlePatch {
        heading: "Hosts".to_string(),
        mode: ArticlePatchMode::Merge,
        body: "Lives with [[datahub]].".to_string(),
    }];
    update.add_related = vec!["ros-tasks".to_string()];
    let patched = apply_patch(Some(&page()), &update);
    assert!(patched.article.contains("datahub"));
    assert!(patched.see_also.iter().any(|slug| slug == "datahub"));
    assert!(patched.see_also.iter().any(|slug| slug == "ros-tasks"));
    assert!(
        extract_wiki_links(&patched.article)
            .iter()
            .any(|slug| slug == "datahub")
    );
}

#[test]
fn demotes_article_headings_and_caps_summary_growth() {
    let demoted = demote_h2_headings("### Role\n\nA.\n\n## Configuration\n\nPort 8003.");
    assert!(demoted.contains("### Configuration"));
    assert!(!demoted.contains("\n## Configuration"));
    let mut update = patch(
        PatchAction::Update,
        "rivetos-task-engine",
        "2026-07-12T00:00:00Z",
    );
    update.article = Some(
        "### Role\n\nA thing.\n\n## Configuration\n\nPort 8003.\n\n### Ops\n\nRestart.".to_string(),
    );
    let patched = apply_patch(Some(&page()), &update);
    let round = parse_wiki_page(&serialize_wiki_page(&patched)).expect("round");
    assert!(round.article.contains("### Configuration"));
    assert!(round.article.contains("Port 8003"));
    assert!(round.article.contains("### Ops"));

    let fat = "Lead. ".repeat(SUMMARY_MAX_CHARS.div_ceil(6));
    let mut grown = patch(
        PatchAction::Update,
        "rivetos-task-engine",
        "2026-07-13T00:00:00Z",
    );
    grown.current_state = Some(fat);
    grown.allow_shrink = true;
    let mut current = apply_patch(Some(&page()), &grown);
    assert!(current.current_state.len() <= SUMMARY_MAX_CHARS);
    for index in 0..12 {
        let mut thrash = patch(
            PatchAction::Update,
            "rivetos-task-engine",
            &format!("2026-07-14T{index:02}:00:00.000Z"),
        );
        thrash.current_state = Some(format!("tiny thrash {index}"));
        current = apply_patch(Some(&current), &thrash);
    }
    assert!(current.current_state.len() <= SUMMARY_MAX_CHARS);
    let capped = cap_summary(&"a".repeat(3000), 100);
    assert!(capped.kept.len() <= 100);
    assert!(!capped.overflow.is_empty());
}

#[test]
fn filters_self_links_and_normalizes_related() {
    let mut update = patch(
        PatchAction::Update,
        "rivetos-task-engine",
        "2026-07-12T00:00:00Z",
    );
    update.article = Some("See [[rivetos-task-engine]] and [[datahub]].".to_string());
    update.add_related = vec!["Raw Host!".to_string(), "datahub".to_string()];
    let patched = apply_patch(Some(&page()), &update);
    assert!(
        !patched
            .see_also
            .iter()
            .any(|slug| slug == "rivetos-task-engine")
    );
    assert!(patched.see_also.iter().any(|slug| slug == "datahub"));
    assert!(patched.see_also.iter().any(|slug| slug == "raw-host"));
}

#[test]
fn demotes_headings_inside_history_entries() {
    let mut update = patch(
        PatchAction::Update,
        "rivetos-task-engine",
        "2026-07-27T00:00:00Z",
    );
    update.history_entry = Some(WikiHistoryEntry {
        date: "2026-07-27".to_string(),
        title: "Ops note".to_string(),
        body: "- did a thing\n\n## Configuration\n\nleaked out of history".to_string(),
    });
    let patched = apply_patch(Some(&page()), &update);
    let round = parse_wiki_page(&serialize_wiki_page(&patched)).expect("round");
    let entry = round
        .history
        .iter()
        .find(|item| item.title == "Ops note")
        .expect("ops");
    assert!(entry.body.contains("### Configuration"));
    assert!(entry.body.contains("leaked out of history"));
    assert!(
        !round
            .extra_sections
            .iter()
            .any(|section| section.heading == "Configuration")
    );
}

#[test]
fn reapplying_the_same_history_entry_dedups() {
    let entry = WikiHistoryEntry {
        date: "2026-07-27".to_string(),
        title: "Ops note".to_string(),
        body: "- did a thing\n\n## Configuration\n\nleaked out of history".to_string(),
    };
    let mut once_patch = patch(
        PatchAction::Update,
        "rivetos-task-engine",
        "2026-07-27T00:00:00Z",
    );
    once_patch.history_entry = Some(entry.clone());
    let once = apply_patch(Some(&page()), &once_patch);
    let stored = parse_wiki_page(&serialize_wiki_page(&once)).expect("stored");
    let mut twice_patch = patch(
        PatchAction::Update,
        "rivetos-task-engine",
        "2026-07-28T00:00:00Z",
    );
    twice_patch.history_entry = Some(entry);
    let twice = apply_patch(Some(&stored), &twice_patch);
    assert_eq!(
        twice
            .history
            .iter()
            .filter(|item| item.title == "Ops note")
            .count(),
        1
    );
}

#[test]
fn apply_patch_tolerates_empty_v7_fields() {
    let legacy = WikiPage {
        meta: WikiFrontmatter {
            title: "Legacy".to_string(),
            slug: "legacy".to_string(),
            aliases: Vec::new(),
            tags: Vec::new(),
            entities: Vec::new(),
            related: Vec::new(),
            last_verified: None,
            sources: Vec::new(),
            extra: None,
        },
        current_state: "Old lead.".to_string(),
        article: String::new(),
        history: Vec::new(),
        citations: Vec::new(),
        see_also: Vec::new(),
        preamble: None,
        extra_sections: Vec::new(),
    };
    let mut update = patch(PatchAction::Update, "legacy", "2026-07-27T00:00:00Z");
    update.summary_delta = Some("Now also serves :9000.".to_string());
    update.article_patches = vec![WikiArticlePatch {
        heading: "Role".to_string(),
        mode: ArticlePatchMode::Merge,
        body: "Runs on [[hv-c]].".to_string(),
    }];
    update.add_related = vec!["datahub".to_string()];
    update.add_citations = vec![WikiCitation {
        summary_id: "8f3a0000-0000-0000-0000-000000000009".to_string(),
        date: None,
        kind: None,
        note: None,
    }];
    let patched = apply_patch(Some(&legacy), &update);
    assert!(patched.current_state.contains("Old lead."));
    assert!(patched.current_state.contains(":9000"));
    assert!(patched.article.contains("### Role"));
    assert_eq!(patched.citations.len(), 1);
    assert!(patched.see_also.iter().any(|slug| slug == "datahub"));
    assert!(patched.see_also.iter().any(|slug| slug == "hv-c"));
    let round = parse_wiki_page(&serialize_wiki_page(&patched)).expect("round");
    assert!(round.article.contains("Runs on"));
}

#[test]
fn serialize_demotes_stray_headings_outside_apply_patch() {
    let canonical = page();
    let mut loser =
        parse_wiki_page(&SAMPLE.replace("slug: rivetos-task-engine", "slug: ros-tasks-shard"))
            .expect("loser");
    loser.history = vec![WikiHistoryEntry {
        date: "2026-07-01".to_string(),
        title: "legacy".to_string(),
        body: "- x\n\n## Stray\n\nescaped".to_string(),
    }];
    let merged = merge_pages(&canonical, &[loser]);
    let merged_round = parse_wiki_page(&serialize_wiki_page(&merged)).expect("merged");
    let legacy = merged_round
        .history
        .iter()
        .find(|entry| entry.title == "legacy")
        .expect("legacy");
    assert!(legacy.body.contains("escaped"));
    assert!(
        !merged_round
            .extra_sections
            .iter()
            .any(|section| section.heading == "Stray")
    );

    let mut hand = page();
    hand.current_state = "Lead.\n\n## Stray\n\nescaped from the lead".to_string();
    hand.article = "### Role\n\nA.\n\n## Stray\n\nescaped from the article".to_string();
    let hand_round = parse_wiki_page(&serialize_wiki_page(&hand)).expect("hand");
    assert!(hand_round.current_state.contains("escaped from the lead"));
    assert!(hand_round.article.contains("escaped from the article"));
    assert!(
        !hand_round
            .extra_sections
            .iter()
            .any(|section| section.heading == "Stray")
    );
    assert_eq!(
        serialize_wiki_page(&hand_round),
        serialize_wiki_page(&parse_wiki_page(&serialize_wiki_page(&hand_round)).expect("again"))
    );
}

#[test]
fn normalize_slug_kebab_cases_and_bounds() {
    assert_eq!(
        normalize_slug("  RivetOS Task Engine! "),
        "rivetos-task-engine"
    );
    assert_eq!(normalize_slug("--x--"), "x");
    assert_eq!(normalize_slug(&"a".repeat(120)).len(), 80);
}

#[test]
fn citations_round_trip_and_dedupe() {
    let base = page();
    let mut update = patch(PatchAction::Update, &base.meta.slug, "2026-07-25T00:00:00Z");
    update.add_citations = vec![WikiCitation {
        summary_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_string(),
        date: Some("2026-07-25".to_string()),
        kind: Some("leaf".to_string()),
        note: Some("leaf batch on task engine".to_string()),
    }];
    let patched = apply_patch(Some(&base), &update);
    assert_eq!(patched.citations.len(), 1);
    let md = serialize_wiki_page(&patched);
    assert!(md.contains("## Citations"));
    assert!(md.contains("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
    let round = parse_wiki_page(&md).expect("round");
    assert_eq!(
        round.citations[0].summary_id,
        "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    );
    assert_eq!(round.citations[0].date.as_deref(), Some("2026-07-25"));
    assert_eq!(round.citations[0].kind.as_deref(), Some("leaf"));
    assert_eq!(
        round.citations[0].note.as_deref(),
        Some("leaf batch on task engine")
    );
    let mut again_patch = patch(PatchAction::Update, &base.meta.slug, "2026-07-26T00:00:00Z");
    again_patch.add_citations = vec![
        WikiCitation {
            summary_id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_string(),
            date: None,
            kind: None,
            note: Some("dup".to_string()),
        },
        WikiCitation {
            summary_id: "11111111-2222-3333-4444-555555555555".to_string(),
            date: None,
            kind: Some("leaf".to_string()),
            note: None,
        },
    ];
    let again = apply_patch(Some(&round), &again_patch);
    assert_eq!(again.citations.len(), 2);
}

#[test]
fn slug_variants_prefer_the_shorter_parent() {
    assert!(is_slug_variant(
        "deckard-40b",
        "deckard-40b-awq-grid-search"
    ));
    assert!(is_slug_variant("deckard-40b-awq", "deckard-40b"));
    assert!(!is_slug_variant("deckard-40b", "gerty-vllm"));
    assert!(is_slug_variant("rivetos-memory", "rivetos-memory-wiki"));
    assert_eq!(
        prefer_canonical_slug("deckard-40b-awq", "deckard-40b"),
        "deckard-40b"
    );
    assert_eq!(
        prefer_canonical_slug("deckard-40b", "deckard-40b-awq"),
        "deckard-40b"
    );
}

#[test]
fn find_stem_match_returns_the_shortest_parent() {
    let existing = [
        "deckard-40b-benchmarking",
        "deckard-40b-awq-grid-search",
        "gerty-vllm",
        "deckard-40b",
    ];
    assert_eq!(
        find_stem_match("deckard-40b-awq-grid-search", &existing).as_deref(),
        Some("deckard-40b")
    );
    assert_eq!(
        find_stem_match("deckard-40b", &existing).as_deref(),
        Some("deckard-40b")
    );
    assert_eq!(find_stem_match("totally-unrelated", &existing), None);
}

#[test]
fn cluster_slugs_group_three_token_names() {
    let groups = cluster_slugs_by_stem(&[
        "deckard-40b-awq",
        "deckard-40b-bench",
        "gerty-vllm",
        "rivetos-memory-wiki",
        "rivetos-memory-plugin",
    ]);
    let mut deckard = group(&groups, "deckard-40b");
    deckard.sort();
    assert_eq!(deckard, vec!["deckard-40b-awq", "deckard-40b-bench"]);
    let mut memory = group(&groups, "rivetos-memory");
    memory.sort();
    assert_eq!(memory, vec!["rivetos-memory-plugin", "rivetos-memory-wiki"]);
    assert_eq!(group(&groups, "gerty-vllm"), vec!["gerty-vllm"]);
}

fn group(groups: &[(String, Vec<String>)], key: &str) -> Vec<String> {
    groups
        .iter()
        .find(|(name, _)| name == key)
        .expect(key)
        .1
        .clone()
}

#[test]
fn entities_overlap_and_token_prefix() {
    assert!(entities_overlap(
        &["model:deckard-40b"],
        &["host:hv-c", "model:deckard-40b"]
    ));
    assert!(!entities_overlap(&["a"], &["b"]));
    assert!(!entities_overlap(&[], &["a"]));
    assert_eq!(slug_token_prefix("deckard-40b-awq-grid", 2), "deckard-40b");
    assert_eq!(slug_token_prefix("wiki", 2), "wiki");
}

#[test]
fn read_slug_rejects_path_and_mixed_case() {
    assert_eq!(
        read_slug_error("../etc/passwd").as_deref(),
        Some("Invalid slug \"../etc/passwd\" — lowercase kebab-case only.")
    );
    assert_eq!(
        read_slug_error("Not A Slug").as_deref(),
        Some("Invalid slug \"Not A Slug\" — lowercase kebab-case only.")
    );
    assert!(read_slug_error("gerty").is_none());
    assert!(is_read_slug("-leading-dash"));
    assert!(!is_read_slug(""));
    assert!(!is_read_slug(&"a".repeat(81)));
    assert!(is_read_slug(&"a".repeat(80)));
}

fn fat_page(aliases: usize, article: &str, extra_history: usize) -> String {
    let alias_block = (0..aliases)
        .map(|index| format!("  - alias-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let history = (0..extra_history)
        .map(|index| {
            format!(
                "### 2026-07-{:02} — Extra {index}\n\n- filler {index}\n",
                index + 1
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "---\ntitle: rivetOS\nslug: rivetos\naliases:\n{alias_block}\ntags:\n  - rivetos\nlast_verified: 2026-08-21T00:00:00Z\n---\n\n## Summary\n\nRivetOS is an open-source agent runtime and monorepo.\n\n## Article\n\n{article}\n\n## See also\n\n- [[memory-postgres]]\n- [[stats-tool]]\n\n## History\n\n### 2026-08-21 — Daily job\n\n- noted oversized page\n\n{history}\n## Citations\n\n| Date | Kind | Summary | Note |\n|------|------|---------|------|\n| 2026-08-21 | leaf | `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` | note |\n"
    )
}

const SMALL: &str = "---\ntitle: GERTY\nslug: gerty\n---\n\n## Current state\n\nhv-c lab.\n\n## History\n\n### 2026-07-01 — Setup\n\n- racked\n";

#[test]
fn small_pages_stay_verbatim() {
    let out = format_wiki_read(SMALL, "gerty", None);
    assert_eq!(out, SMALL);
    assert!(out.contains("## Current state"));
    assert!(out.contains("### 2026-07-01 — Setup"));
    assert_eq!(format_wiki_read(SMALL, "gerty", Some("full")), SMALL);
}

#[test]
fn oversized_default_view_leads_with_summary() {
    let md = fat_page(3_000, "The mesh runs on port 3000 with mTLS.", 0);
    assert!(md.len() > WIKI_READ_VERBATIM_MAX_CHARS);
    assert!(md.find("alias-0").expect("alias") < md.find("## Summary").expect("summary"));
    let out = format_wiki_read(&md, "rivetos", None);
    assert!(out.len() < WIKI_READ_VERBATIM_MAX_CHARS);
    assert!(out.contains("⚠ Oversized wiki page \"rivetos\""));
    assert!(out.contains("## Summary"));
    assert!(out.contains("RivetOS is an open-source agent runtime"));
    assert!(out.contains("## Article"));
    assert!(out.contains("The mesh runs on port 3000"));
    assert!(out.contains("[[memory-postgres]]"));
    assert!(out.contains("### 2026-08-21 — Daily job"));
    let summary_at = out.find("## Summary").expect("summary");
    assert!(summary_at > 0);
    assert!(out.find("- alias-0").is_none());
    assert!(out.contains("aliases: 3,000 (showing 8:"));
    assert!(out.contains("section=aliases"));
}

#[test]
fn section_full_is_refused_when_oversized() {
    let out = format_wiki_read(
        &fat_page(3_000, "The mesh runs on port 3000 with mTLS.", 0),
        "rivetos",
        Some("full"),
    );
    assert!(out.contains("section=full refused"));
    assert!(out.contains("## Summary"));
    assert!(out.contains("RivetOS is an open-source agent runtime"));
    assert!(!out.contains("- alias-0"));
}

#[test]
fn section_slices_an_oversized_page() {
    let md = fat_page(3_000, "The mesh runs on port 3000 with mTLS.", 12);
    let summary = format_wiki_read(&md, "rivetos", Some("summary"));
    assert!(summary.contains("section=summary"));
    assert!(summary.contains("RivetOS is an open-source agent runtime"));
    assert!(!summary.contains("## Article"));
    let article = format_wiki_read(&md, "rivetos", Some("article"));
    assert!(article.contains("section=article"));
    assert!(article.contains("The mesh runs on port 3000"));
    let history = format_wiki_read(&md, "rivetos", Some("history"));
    assert!(history.contains("section=history"));
    assert!(history.contains("### 2026-08-21 — Daily job"));
    assert!(history.contains("### 2026-07-01 — Extra 0"));
    let aliases = format_wiki_read(&md, "rivetos", Some("aliases"));
    assert!(aliases.contains("section=aliases"));
    assert!(aliases.contains("- alias-0"));
    assert!(aliases.contains("- alias-199"));
    assert!(!aliases.contains("- alias-200"));
    assert!(aliases.contains("2,800 more"));
    let citations = format_wiki_read(&md, "rivetos", Some("citations"));
    assert!(citations.contains("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
    assert!(citations.contains("| Date | Kind | Summary | Note |"));
}

#[test]
fn long_article_is_capped_in_the_encyclopedia_view() {
    let article = format!("{}{}", "paragraph\n\n".repeat(4), "x".repeat(12_000));
    let out = format_wiki_read(&fat_page(3_000, &article, 0), "rivetos", None);
    assert!(out.contains("more chars — wiki_read slug=rivetos section=article"));
    assert!(out.len() < 20_000);
}

#[test]
fn malformed_pages_are_warned_and_oversized_ones_are_capped() {
    let small = format_wiki_read("no frontmatter here", "broken", None);
    assert!(small.contains("malformed"));
    assert!(small.contains("no frontmatter here"));
    let huge_raw = format!(
        "no frontmatter\n{}",
        "y".repeat(WIKI_READ_VERBATIM_MAX_CHARS + 100)
    );
    let huge = format_wiki_read(&huge_raw, "broken", None);
    assert!(huge.contains("malformed"));
    assert!(huge.contains("also oversized"));
    assert!(huge.len() < huge_raw.len());
    assert!(huge.contains("more chars"));
}

#[test]
fn fixtures_reserialize_byte_for_byte() {
    let fixtures = [
        ("task-engine", include_str!("fixtures/task-engine.md")),
        ("deckard-40b", include_str!("fixtures/deckard-40b.md")),
        ("gerty", include_str!("fixtures/gerty.md")),
        ("notes", include_str!("fixtures/notes.md")),
        ("citations", include_str!("fixtures/citations.md")),
        ("span-source", include_str!("fixtures/span-source.md")),
        ("see-also", include_str!("fixtures/see-also.md")),
        ("article-only", include_str!("fixtures/article-only.md")),
        ("empty-lead", include_str!("fixtures/empty-lead.md")),
        ("multi-history", include_str!("fixtures/multi-history.md")),
    ];
    for (name, markdown) in fixtures {
        let parsed = parse_wiki_page(markdown).unwrap_or_else(|err| panic!("{name}: {err}"));
        let once = serialize_wiki_page(&parsed);
        assert_eq!(once, markdown, "{name}");
        let twice = serialize_wiki_page(&parse_wiki_page(&once).expect(name));
        assert_eq!(twice, once, "{name} stable");
    }
}

#[test]
fn wire_index_total_is_a_json_number_and_git_sha_is_null() {
    let index = WikiIndexResponse {
        topics: vec![WikiIndexEntry {
            slug: "gerty".to_string(),
            title: "GERTY".to_string(),
            tags: vec!["lab".to_string()],
            entities: Vec::new(),
            updated_at: "2026-07-01T00:00:00Z".to_string(),
            excerpt: "hv-c".to_string(),
        }],
        total: 1.into(),
    };
    assert_eq!(
        serde_json::to_string(&index).expect("index"),
        r#"{"topics":[{"slug":"gerty","title":"GERTY","tags":["lab"],"entities":[],"updatedAt":"2026-07-01T00:00:00Z","excerpt":"hv-c"}],"total":1}"#
    );
    let page = WikiPageResponse {
        slug: "gerty".to_string(),
        title: "GERTY".to_string(),
        aliases: Vec::new(),
        tags: Vec::new(),
        entities: Vec::new(),
        current_state: "hv-c".to_string(),
        article: None,
        see_also: None,
        history: Vec::new(),
        citations: Vec::new(),
        markdown: "#".to_string(),
        sources: Vec::new(),
        git_sha: None,
        last_verified: None,
        updated_at: "2026-07-01T00:00:00Z".to_string(),
        related: None,
    };
    assert_eq!(
        serde_json::to_string(&page).expect("page"),
        r##"{"slug":"gerty","title":"GERTY","aliases":[],"tags":[],"entities":[],"currentState":"hv-c","history":[],"citations":[],"markdown":"#","sources":[],"gitSha":null,"updatedAt":"2026-07-01T00:00:00Z"}"##
    );
}
