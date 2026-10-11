use wiki::{
    ALIASES_MAX, ArticlePatchMode, CITATIONS_MAX, ENTITIES_MAX, HISTORY_MAX, PatchAction,
    RELATED_MAX, SOURCES_MAX, SUMMARY_MAX_CHARS, TAGS_MAX, WIKI_READ_VERBATIM_MAX_CHARS,
    WikiArticlePatch, WikiCitation, WikiFrontmatter, WikiHistoryEntry, WikiIndexEntry,
    WikiIndexResponse, WikiPage, WikiPageResponse, WikiPatch, WikiSource, apply_article_patches,
    apply_patch, build_wiki_search_text, cap_list, cap_summary, cap_tail, cluster_slugs_by_stem,
    demote_h2_headings, entities_overlap, extract_wiki_links, find_stem_match, format_wiki_read,
    is_read_slug, is_slug_variant, merge_article_bodies, merge_pages, normalize_slug,
    parse_wiki_page, prefer_canonical_slug, read_slug_error, serialize_wiki_page,
    slug_token_prefix,
};

const SAMPLE: &str = "---\ntitle: Release Checklist\nslug: release-checklist\naliases:\n  - task-engine\ntags:\n  - sample\nentities:\n  - project:sample\nlast_verified: 2026-07-06T18:00:00Z\nsources:\n  - kind: summary\n    ids:\n      - 8f3a0000-0000-0000-0000-000000000001\n    conversationId: c1d20000-0000-0000-0000-000000000002\n---\n\n## Current state\n\nsample-jobs is the only orchestration engine. Gateway lives on :8080.\n\n## History\n\n### 2026-07-06 — Phase 1 cutover shipped\n\n- Legacy tables archived in 0003.\n- **Provenance:** summary 8f3a\u{2026}\n\n### 2026-05-20 — Design locked\n\n- SampleRunner contract in @example/types.\n";

fn page() -> WikiPage {
    parse_wiki_page(SAMPLE).expect("sample")
}

fn patch(action: PatchAction, slug: &str, verified_at: &str) -> WikiPatch {
    WikiPatch::new(action, slug, verified_at)
}

#[test]
fn parses_frontmatter_current_state_and_dated_history() {
    let page = page();
    assert_eq!(page.meta.slug, "release-checklist");
    assert_eq!(page.meta.aliases, vec!["task-engine"]);
    assert_eq!(page.meta.sources[0].ids().len(), 1);
    assert!(page.current_state.contains("only orchestration engine"));
    assert_eq!(page.history.len(), 2);
    assert_eq!(page.history[0].date, "2026-07-06");
    assert_eq!(page.history[0].title, "Phase 1 cutover shipped");
    assert!(page.history[1].body.contains("SampleRunner"));
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
    let mut created_patch = patch(
        PatchAction::Create,
        "Example Topic!",
        "2026-07-07T00:00:00Z",
    );
    created_patch.title = Some("Example Topic".to_string());
    created_patch.current_state = Some("v1 state".to_string());
    let created = apply_patch(None, &created_patch);
    assert_eq!(created.meta.slug, "example-topic");
    assert_eq!(created.current_state, "v1 state");
    assert!(created.history.is_empty());

    let mut updated_patch = patch(PatchAction::Update, "example-topic", "2026-07-08T00:00:00Z");
    updated_patch.current_state = Some("v2 state".to_string());
    updated_patch.history_entry = Some(WikiHistoryEntry {
        date: "2026-07-08".to_string(),
        title: "Cutover".to_string(),
        body: "- moved to v2".into(),
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
    update.current_state = Some(base.current_state.to_string());
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
        "release-checklist",
        "2026-07-09T00:00:00Z",
    );
    update.add_aliases = vec!["task-engine".to_string(), "sample-jobs".to_string()];
    update.add_tags = vec!["infrastructure".to_string()];
    let patched = apply_patch(Some(&page()), &update);
    assert_eq!(patched.meta.aliases, vec!["task-engine", "sample-jobs"]);
    assert_eq!(patched.meta.tags, vec!["sample", "infrastructure"]);
}

#[test]
fn caps_identity_lists_after_union() {
    let mut update = patch(
        PatchAction::Update,
        "release-checklist",
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
    assert_eq!(patched.meta.tags[0], "sample");
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
        parse_wiki_page(&SAMPLE.replace("slug: release-checklist", "slug: sample-jobs-shard"))
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
            .any(|alias| alias == "sample-jobs-shard")
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
            body: format!("- note {index}").into(),
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
    assert!(round.meta.sources[0].ids()[0].contains(&padded(40)));
    assert!(
        round
            .meta
            .sources
            .last()
            .expect("last")
            .ids()
            .first()
            .expect("id")
            .contains(&padded(SOURCES_MAX + 39))
    );
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
        "release-checklist",
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
        extra
            .get("touched_by")
            .as_ref()
            .and_then(wiki::Passthrough::as_str),
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

const GARDEN: &str = "---\ntitle: Garden Notes\nslug: node-alpha\naliases: []\ntags: []\nentities: []\nrelated:\n  - node-a\nsources: []\n---\n\n## Summary\n\nLead paragraph about the model.\n\n## Article\n\n### Configuration\n\nRuns on [[node-a]].\n\n### Operations\n\nservice on :8080.\n\n## See also\n\n- [[host-2]]\n- [[sample-link]]\n\n## History\n\n### 2026-07-01 — First note\n\n- hello\n";

#[test]
fn parses_summary_article_and_see_also() {
    let parsed = parse_wiki_page(GARDEN).expect("garden");
    assert!(parsed.current_state.contains("Lead paragraph"));
    assert!(parsed.article.contains("### Configuration"));
    for slug in ["node-a", "host-2", "sample-link"] {
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
        "{} standing facts about the task engine and sample-jobs.",
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
                body: "Lives with [[host-1]].".to_string(),
            },
        ],
    );
    assert!(art.contains("### Role"));
    assert!(art.contains("### Hosts"));
    let mut update = patch(
        PatchAction::Update,
        "release-checklist",
        "2026-07-12T00:00:00Z",
    );
    update.article_patches = vec![WikiArticlePatch {
        heading: "Hosts".to_string(),
        mode: ArticlePatchMode::Merge,
        body: "Lives with [[host-1]].".to_string(),
    }];
    update.add_related = vec!["sample-jobs".to_string()];
    let patched = apply_patch(Some(&page()), &update);
    assert!(patched.article.contains("host-1"));
    assert!(patched.see_also.iter().any(|slug| slug == "host-1"));
    assert!(patched.see_also.iter().any(|slug| slug == "sample-jobs"));
    assert!(
        extract_wiki_links(&patched.article)
            .iter()
            .any(|slug| slug == "host-1")
    );
}

#[test]
fn demotes_article_headings_and_caps_summary_growth() {
    let demoted = demote_h2_headings("### Role\n\nA.\n\n## Configuration\n\nPort 8080.");
    assert!(demoted.contains("### Configuration"));
    assert!(!demoted.contains("\n## Configuration"));
    let mut update = patch(
        PatchAction::Update,
        "release-checklist",
        "2026-07-12T00:00:00Z",
    );
    update.article = Some(
        "### Role\n\nA thing.\n\n## Configuration\n\nPort 8080.\n\n### Ops\n\nRestart.".to_string(),
    );
    let patched = apply_patch(Some(&page()), &update);
    let round = parse_wiki_page(&serialize_wiki_page(&patched)).expect("round");
    assert!(round.article.contains("### Configuration"));
    assert!(round.article.contains("Port 8080"));
    assert!(round.article.contains("### Ops"));

    let fat = "Lead. ".repeat(SUMMARY_MAX_CHARS.div_ceil(6));
    let mut grown = patch(
        PatchAction::Update,
        "release-checklist",
        "2026-07-13T00:00:00Z",
    );
    grown.current_state = Some(fat);
    grown.allow_shrink = true;
    let mut current = apply_patch(Some(&page()), &grown);
    assert!(current.current_state.len() <= SUMMARY_MAX_CHARS);
    for index in 0..12 {
        let mut thrash = patch(
            PatchAction::Update,
            "release-checklist",
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
        "release-checklist",
        "2026-07-12T00:00:00Z",
    );
    update.article = Some("See [[release-checklist]] and [[host-1]].".to_string());
    update.add_related = vec!["Raw Host!".to_string(), "host-1".to_string()];
    let patched = apply_patch(Some(&page()), &update);
    assert!(
        !patched
            .see_also
            .iter()
            .any(|slug| slug == "release-checklist")
    );
    assert!(patched.see_also.iter().any(|slug| slug == "host-1"));
    assert!(patched.see_also.iter().any(|slug| slug == "raw-host"));
}

#[test]
fn demotes_headings_inside_history_entries() {
    let mut update = patch(
        PatchAction::Update,
        "release-checklist",
        "2026-07-27T00:00:00Z",
    );
    update.history_entry = Some(WikiHistoryEntry {
        date: "2026-07-27".to_string(),
        title: "Ops note".to_string(),
        body: "- did a thing\n\n## Configuration\n\nleaked out of history".into(),
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
        body: "- did a thing\n\n## Configuration\n\nleaked out of history".into(),
    };
    let mut once_patch = patch(
        PatchAction::Update,
        "release-checklist",
        "2026-07-27T00:00:00Z",
    );
    once_patch.history_entry = Some(entry.clone());
    let once = apply_patch(Some(&page()), &once_patch);
    let stored = parse_wiki_page(&serialize_wiki_page(&once)).expect("stored");
    let mut twice_patch = patch(
        PatchAction::Update,
        "release-checklist",
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
        current_state: "Old lead.".into(),
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
        body: "Runs on [[node-a]].".to_string(),
    }];
    update.add_related = vec!["host-1".to_string()];
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
    assert!(patched.see_also.iter().any(|slug| slug == "host-1"));
    assert!(patched.see_also.iter().any(|slug| slug == "node-a"));
    let round = parse_wiki_page(&serialize_wiki_page(&patched)).expect("round");
    assert!(round.article.contains("Runs on"));
}

#[test]
fn serialize_demotes_stray_headings_outside_apply_patch() {
    let canonical = page();
    let mut loser =
        parse_wiki_page(&SAMPLE.replace("slug: release-checklist", "slug: sample-jobs-shard"))
            .expect("loser");
    loser.history = vec![WikiHistoryEntry {
        date: "2026-07-01".to_string(),
        title: "legacy".to_string(),
        body: "- x\n\n## Stray\n\nescaped".into(),
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
    hand.current_state = "Lead.\n\n## Stray\n\nescaped from the lead".into();
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
    assert_eq!(normalize_slug("  Release Checklist! "), "release-checklist");
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
    assert!(is_slug_variant("node-alpha", "node-alpha-awq-grid-search"));
    assert!(is_slug_variant("node-alpha-awq", "node-alpha"));
    assert!(!is_slug_variant("node-alpha", "example-topic"));
    assert!(is_slug_variant("topic-memory", "topic-memory-wiki"));
    assert_eq!(
        prefer_canonical_slug("node-alpha-awq", "node-alpha"),
        "node-alpha"
    );
    assert_eq!(
        prefer_canonical_slug("node-alpha", "node-alpha-awq"),
        "node-alpha"
    );
}

#[test]
fn find_stem_match_returns_the_shortest_parent() {
    let existing = [
        "node-alpha-benchmarking",
        "node-alpha-awq-grid-search",
        "example-topic",
        "node-alpha",
    ];
    assert_eq!(
        find_stem_match("node-alpha-awq-grid-search", &existing).as_deref(),
        Some("node-alpha")
    );
    assert_eq!(
        find_stem_match("node-alpha", &existing).as_deref(),
        Some("node-alpha")
    );
    assert_eq!(find_stem_match("totally-unrelated", &existing), None);
}

#[test]
fn cluster_slugs_group_three_token_names() {
    let groups = cluster_slugs_by_stem(&[
        "node-alpha-awq",
        "node-alpha-bench",
        "example-topic",
        "topic-memory-wiki",
        "topic-memory-plugin",
    ]);
    let mut stems = group(&groups, "node-alpha");
    stems.sort();
    assert_eq!(stems, vec!["node-alpha-awq", "node-alpha-bench"]);
    let mut memory = group(&groups, "topic-memory");
    memory.sort();
    assert_eq!(memory, vec!["topic-memory-plugin", "topic-memory-wiki"]);
    assert_eq!(group(&groups, "example-topic"), vec!["example-topic"]);
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
        &["model:node-alpha"],
        &["host:node-a", "model:node-alpha"]
    ));
    assert!(!entities_overlap(&["a"], &["b"]));
    assert!(!entities_overlap(&[], &["a"]));
    assert_eq!(slug_token_prefix("node-alpha-awq-grid", 2), "node-alpha");
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
    assert!(read_slug_error("example-topic").is_none());
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
        "---\ntitle: Example Topic\nslug: example-topic\naliases:\n{alias_block}\ntags:\n  - sample\nlast_verified: 2026-08-21T00:00:00Z\n---\n\n## Summary\n\nExample Topic is a sample reference page.\n\n## Article\n\n{article}\n\n## See also\n\n- [[sample-store]]\n- [[sample-tool]]\n\n## History\n\n### 2026-08-21 — Daily job\n\n- noted oversized page\n\n{history}\n## Citations\n\n| Date | Kind | Summary | Note |\n|------|------|---------|------|\n| 2026-08-21 | leaf | `aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa` | note |\n"
    )
}

const SMALL: &str = "---\ntitle: Example Topic\nslug: example-topic\n---\n\n## Current state\n\nnode-a notes.\n\n## History\n\n### 2026-07-01 — Setup\n\n- racked\n";

#[test]
fn small_pages_stay_verbatim() {
    let out = format_wiki_read(SMALL, "example-topic", None);
    assert_eq!(out, SMALL);
    assert!(out.contains("## Current state"));
    assert!(out.contains("### 2026-07-01 — Setup"));
    assert_eq!(
        format_wiki_read(SMALL, "example-topic", Some("full")),
        SMALL
    );
}

#[test]
fn oversized_default_view_leads_with_summary() {
    let md = fat_page(3_000, "The mesh runs on port 3000 with mTLS.", 0);
    assert!(md.len() > WIKI_READ_VERBATIM_MAX_CHARS);
    assert!(md.find("alias-0").expect("alias") < md.find("## Summary").expect("summary"));
    let out = format_wiki_read(&md, "example-topic", None);
    assert!(out.len() < WIKI_READ_VERBATIM_MAX_CHARS);
    assert!(out.contains("⚠ Oversized wiki page \"example-topic\""));
    assert!(out.contains("## Summary"));
    assert!(out.contains("Example Topic is a sample reference page"));
    assert!(out.contains("## Article"));
    assert!(out.contains("The mesh runs on port 3000"));
    assert!(out.contains("[[sample-store]]"));
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
        "example-topic",
        Some("full"),
    );
    assert!(out.contains("section=full refused"));
    assert!(out.contains("## Summary"));
    assert!(out.contains("Example Topic is a sample reference page"));
    assert!(!out.contains("- alias-0"));
}

#[test]
fn section_slices_an_oversized_page() {
    let md = fat_page(3_000, "The mesh runs on port 3000 with mTLS.", 12);
    let summary = format_wiki_read(&md, "example-topic", Some("summary"));
    assert!(summary.contains("section=summary"));
    assert!(summary.contains("Example Topic is a sample reference page"));
    assert!(!summary.contains("## Article"));
    let article = format_wiki_read(&md, "example-topic", Some("article"));
    assert!(article.contains("section=article"));
    assert!(article.contains("The mesh runs on port 3000"));
    let history = format_wiki_read(&md, "example-topic", Some("history"));
    assert!(history.contains("section=history"));
    assert!(history.contains("### 2026-08-21 — Daily job"));
    assert!(history.contains("### 2026-07-01 — Extra 0"));
    let aliases = format_wiki_read(&md, "example-topic", Some("aliases"));
    assert!(aliases.contains("section=aliases"));
    assert!(aliases.contains("- alias-0"));
    assert!(aliases.contains("- alias-199"));
    assert!(!aliases.contains("- alias-200"));
    assert!(aliases.contains("2,800 more"));
    let citations = format_wiki_read(&md, "example-topic", Some("citations"));
    assert!(citations.contains("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"));
    assert!(citations.contains("| Date | Kind | Summary | Note |"));
}

#[test]
fn long_article_is_capped_in_the_encyclopedia_view() {
    let article = format!("{}{}", "paragraph\n\n".repeat(4), "x".repeat(12_000));
    let out = format_wiki_read(&fat_page(3_000, &article, 0), "example-topic", None);
    assert!(out.contains("more chars — wiki_read slug=example-topic section=article"));
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
        (
            "release-checklist",
            include_str!("fixtures/release-checklist.md"),
        ),
        ("garden-notes", include_str!("fixtures/garden-notes.md")),
        ("example-topic", include_str!("fixtures/example-topic.md")),
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
            slug: "example-topic".to_string(),
            title: "Example Topic".to_string(),
            tags: vec!["draft".to_string()],
            entities: Vec::new(),
            updated_at: "2026-07-01T00:00:00Z".to_string(),
            excerpt: "node-a".to_string(),
        }],
        total: 1.into(),
    };
    assert_eq!(
        serde_json::to_string(&index).expect("index"),
        r#"{"topics":[{"slug":"example-topic","title":"Example Topic","tags":["draft"],"entities":[],"updatedAt":"2026-07-01T00:00:00Z","excerpt":"node-a"}],"total":1}"#
    );
    let page = WikiPageResponse {
        slug: "example-topic".to_string(),
        title: "Example Topic".to_string(),
        aliases: Vec::new(),
        tags: Vec::new(),
        entities: Vec::new(),
        current_state: "node-a".to_string(),
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
        r##"{"slug":"example-topic","title":"Example Topic","aliases":[],"tags":[],"entities":[],"currentState":"node-a","history":[],"citations":[],"markdown":"#","sources":[],"gitSha":null,"updatedAt":"2026-07-01T00:00:00Z"}"##
    );
}

#[test]
fn duplicate_article_headings_keep_the_first_position_and_last_body() {
    let left = "### Setup\n\nOld\n\n### Setup\n\nCurrent";
    let right = "### Setup\n\nNew";
    assert_eq!(
        merge_article_bodies(left, right),
        "### Setup\n\nCurrent\n\nNew"
    );
    let mut canonical = page();
    canonical.article = left.to_string();
    let mut loser = page();
    loser.meta.slug = "other-page".to_string();
    loser.article = right.to_string();
    let merged = merge_pages(&canonical, &[loser]);
    assert_eq!(merged.article.matches("### Setup").count(), 1);
    assert!(merged.article.contains("Current"));
    assert!(merged.article.contains("New"));
    assert!(!merged.article.contains("Old"));
}

#[test]
fn source_objects_keep_original_order_and_unknown_keys() {
    let markdown = "---\ntitle: Order\nslug: order\nsources:\n  - note: kept\n    ids:\n      - a\n      - 7\n    kind: summary\n---\n\n## Summary\n\nLead.\n";
    let parsed = parse_wiki_page(markdown).expect("order");
    assert_eq!(parsed.meta.sources[0].ids(), vec!["a".to_string()]);
    let again = serialize_wiki_page(&parsed);
    assert!(
        again.contains("note: kept\n    ids:\n      - a\n      - 7\n    kind: summary\n"),
        "{again}"
    );
    let round = parse_wiki_page(&again).expect("round");
    assert_eq!(serialize_wiki_page(&round), again);
}

#[test]
fn summary_cap_keeps_an_unpaired_surrogate() {
    let text = format!("{}😀", "a".repeat(2399));
    let capped = cap_summary(&text, 2400);
    assert_eq!(capped.kept.units().last().copied(), Some(0xD83D));
    assert_eq!(capped.overflow.units().first().copied(), Some(0xDE00));
    let kept = serde_json::to_string(&capped.kept).expect("kept");
    let overflow = serde_json::to_string(&capped.overflow).expect("overflow");
    assert!(kept.contains("\\ud83d"), "{kept}");
    assert!(overflow.contains("\\ude00"), "{overflow}");
    assert!(!kept.contains("\\ufffd"), "{kept}");
    assert!(!overflow.contains("\\ufffd"), "{overflow}");
}

#[test]
fn encyclopedia_article_keeps_a_split_surrogate() {
    let article = format!("{}😀more", "b".repeat(7999));
    let out = format_wiki_read(&fat_page(3_000, &article, 0), "example-topic", None);
    assert!(out.units().contains(&0xD83D));
    let json = serde_json::to_string(&out).expect("json");
    assert!(json.contains("\\ud83d"), "{json}");
    assert!(!json.contains("\\ufffd"), "{json}");
    assert!(out.contains("…[5 more chars — wiki_read slug=example-topic section=article]"));
}

#[test]
fn integer_index_keys_precede_other_properties() {
    let markdown = "---\n\"10\": later\n\"2\": earlier\nnote: kept\ntitle: Order\nslug: order\n---\n\n## Summary\n\nLead.\n";
    let parsed = parse_wiki_page(markdown).expect("order");
    let yaml = serialize_wiki_page(&parsed);
    let two = yaml.find("\"2\":").expect("key 2");
    let ten = yaml.find("\"10\":").expect("key 10");
    let note = yaml.find("note:").expect("note");
    let title = yaml.find("title:").expect("title");
    assert!(two < ten && ten < note && note < title, "{yaml}");
    let raw = r#"{"10":"a","note":"n","2":"b","ids":["id1"]}"#;
    let source: WikiSource = serde_json::from_str(raw).expect("source");
    assert_eq!(
        serde_json::to_string(&source).expect("json"),
        r#"{"2":"b","10":"a","note":"n","ids":["id1"]}"#
    );
}

#[test]
fn source_edits_reach_the_serialized_page() {
    let mut source = WikiSource::summary(vec!["old-id".to_string()]);
    source.set_ids(vec!["id1".to_string()]);
    source.set_conversation_id("conversation");
    let mut update = patch(PatchAction::Update, "order", "2026-07-01T00:00:00Z");
    update.add_sources.push(source);
    let page = apply_patch(None, &update);
    let yaml = serialize_wiki_page(&page);
    assert!(
        yaml.contains("kind: summary\n    ids:\n      - id1\n    conversationId: conversation\n"),
        "{yaml}"
    );
    assert!(!yaml.contains("old-id"), "{yaml}");
    assert_eq!(page.meta.sources[0].conversation_id(), Some("conversation"));
    assert_eq!(page.meta.sources[0].ids(), vec!["id1".to_string()]);
}

#[test]
fn json_patch_sources_keep_original_properties() {
    let patch_json = r#"{"action":"update","slug":"order","verifiedAt":"2026-10-10T00:00:00.000Z","addSources":[{"conversationId":"c1","kind":"summary","ids":["id1"],"note":"imported"}]}"#;
    let update: WikiPatch = serde_json::from_str(patch_json).expect("patch");
    assert_eq!(
        serde_json::to_string(&update.add_sources[0]).expect("source"),
        r#"{"conversationId":"c1","kind":"summary","ids":["id1"],"note":"imported"}"#
    );
    let page = apply_patch(None, &update);
    let yaml = serialize_wiki_page(&page);
    assert!(
        yaml.contains(
            "conversationId: c1\n    kind: summary\n    ids:\n      - id1\n    note: imported\n"
        ),
        "{yaml}"
    );
    let round = parse_wiki_page(&yaml).expect("round");
    assert_eq!(
        serde_json::to_string(&round.meta.sources[0]).expect("round source"),
        r#"{"conversationId":"c1","kind":"summary","ids":["id1"],"note":"imported"}"#
    );
}

#[test]
fn nonfinite_frontmatter_survives_parse_and_serialize() {
    let markdown = "---\nmetric: .inf\nnested:\n  gap: .nan\n  low: -.inf\nquoted: \".nan\"\nzero: -0.0\ntitle: T\nslug: t\n---\n\n## Summary\n\nLead.\n";
    let parsed = parse_wiki_page(markdown).expect("page");
    let extra = parsed.meta.extra.as_ref().expect("extra");
    assert_eq!(
        extra
            .get("metric")
            .as_ref()
            .and_then(wiki::Passthrough::as_f64),
        Some(f64::INFINITY)
    );
    assert!(
        extra
            .get("nested")
            .and_then(|value| value.get("gap"))
            .as_ref()
            .and_then(wiki::Passthrough::as_f64)
            .expect("nan")
            .is_nan()
    );
    assert_eq!(
        extra
            .get("nested")
            .and_then(|value| value.get("low"))
            .as_ref()
            .and_then(wiki::Passthrough::as_f64),
        Some(f64::NEG_INFINITY)
    );
    assert_eq!(
        extra
            .get("quoted")
            .as_ref()
            .and_then(wiki::Passthrough::as_str),
        Some(".nan")
    );
    let zero = extra
        .get("zero")
        .as_ref()
        .and_then(wiki::Passthrough::as_f64)
        .expect("zero");
    assert!(zero == 0.0 && zero.is_sign_negative());
    let yaml = serialize_wiki_page(&parsed);
    assert!(yaml.contains("metric: .inf\n"), "{yaml}");
    assert!(yaml.contains("gap: .nan\n"), "{yaml}");
    assert!(yaml.contains("low: -.inf\n"), "{yaml}");
    assert!(yaml.contains("quoted: \".nan\"\n"), "{yaml}");
    assert!(yaml.contains("zero: -0\n"), "{yaml}");
    let round = parse_wiki_page(&yaml).expect("round");
    assert_eq!(round.meta.extra, parsed.meta.extra);
    assert_eq!(serialize_wiki_page(&round), yaml);
}

#[test]
fn malformed_yaml_keeps_the_typescript_prefix() {
    let markdown =
        "---\ntitle: Broken\nslug: broken\naliases: [unfinished\n---\n\n## Summary\n\nLead.\n";
    let err = parse_wiki_page(markdown).expect_err("yaml");
    let text = err.to_string();
    assert!(text.starts_with("invalid wiki page: "), "{text}");
    assert!(text.len() > "invalid wiki page: ".len(), "{text}");
    let read = format_wiki_read(markdown, "broken", None);
    assert!(
        read.starts_with("⚠ Page \"broken\" is malformed (invalid wiki page: "),
        "{read}"
    );
    assert!(read.contains("— raw content follows; the next extractor pass will re-structure it."));
    assert!(read.contains("Lead."));
}
