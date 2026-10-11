mod error;
mod identity;
mod model;
mod page;
mod read;
mod slug;
mod text;
mod wire;
mod yaml_doc;

pub use error::WikiParseError;
pub use identity::{
    cluster_slugs_by_stem, entities_overlap, find_stem_match, is_slug_variant,
    prefer_canonical_slug, slug_token_prefix,
};
pub use model::{
    ArticlePatchMode, PatchAction, SourceSpan, SummaryCap, WikiArticlePatch, WikiArticleSection,
    WikiCitation, WikiFrontmatter, WikiHistoryEntry, WikiPage, WikiPatch, WikiSection, WikiSource,
};
pub use page::{
    ALIASES_MAX, CITATIONS_MAX, ENTITIES_MAX, HISTORY_MAX, RELATED_MAX,
    SEARCH_ARTICLE_EXCERPT_CHARS, SOURCES_MAX, SUMMARY_MAX_CHARS, SUMMARY_SHRINK_FLOOR, TAGS_MAX,
    apply_article_patches, apply_patch, build_wiki_search_text, cap_frontmatter_lists, cap_list,
    cap_summary, cap_tail, demote_h2_headings, join_article_sections, merge_article_bodies,
    merge_pages, merge_summary_text, parse_citations, parse_see_also, parse_wiki_page,
    serialize_wiki_page, split_article_sections,
};
pub use read::{WIKI_READ_VERBATIM_MAX_CHARS, format_wiki_read};
pub use slug::{extract_wiki_links, is_read_slug, normalize_slug, read_slug_error};
pub use wire::{
    WikiIndexEntry, WikiIndexResponse, WikiPageResponse, WikiSourceKind, WikiSourceRef,
};
