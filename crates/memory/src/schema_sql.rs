pub struct EmbeddedMigration {
    pub name: &'static str,
    pub sql: &'static str,
}

pub fn embedded_migrations() -> &'static [EmbeddedMigration] {
    &[
        EmbeddedMigration {
            name: "0001_baseline.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0001_baseline.sql"),
        },
        EmbeddedMigration {
            name: "0002_ros_tasks.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0002_ros_tasks.sql"),
        },
        EmbeddedMigration {
            name: "0003_legacy_teardown.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0003_legacy_teardown.sql"),
        },
        EmbeddedMigration {
            name: "0004_task_eval.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0004_task_eval.sql"),
        },
        EmbeddedMigration {
            name: "0005_wiki.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0005_wiki.sql"),
        },
        EmbeddedMigration {
            name: "0006_wiki_durable_topics.sql",
            sql: include_str!(
                "../../../plugins/memory/postgres/src/schema/migrations/0006_wiki_durable_topics.sql"
            ),
        },
        EmbeddedMigration {
            name: "0007_wiki_article.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0007_wiki_article.sql"),
        },
        EmbeddedMigration {
            name: "0008_message_tool_result_search.sql",
            sql: include_str!(
                "../../../plugins/memory/postgres/src/schema/migrations/0008_message_tool_result_search.sql"
            ),
        },
        EmbeddedMigration {
            name: "0009_conversation_session_key_unique.sql",
            sql: include_str!(
                "../../../plugins/memory/postgres/src/schema/migrations/0009_conversation_session_key_unique.sql"
            ),
        },
        EmbeddedMigration {
            name: "0010_conversation_dedup_locked.sql",
            sql: include_str!(
                "../../../plugins/memory/postgres/src/schema/migrations/0010_conversation_dedup_locked.sql"
            ),
        },
        EmbeddedMigration {
            name: "0011_conversation_task_id.sql",
            sql: include_str!(
                "../../../plugins/memory/postgres/src/schema/migrations/0011_conversation_task_id.sql"
            ),
        },
        EmbeddedMigration {
            name: "0012_embed_tool_result.sql",
            sql: include_str!(
                "../../../plugins/memory/postgres/src/schema/migrations/0012_embed_tool_result.sql"
            ),
        },
        EmbeddedMigration {
            name: "0013_owner_user_id.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0013_owner_user_id.sql"),
        },
        EmbeddedMigration {
            name: "0014_chunks.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0014_chunks.sql"),
        },
        EmbeddedMigration {
            name: "0015_embedding_width.sql",
            sql: include_str!(
                "../../../plugins/memory/postgres/src/schema/migrations/0015_embedding_width.sql"
            ),
        },
        EmbeddedMigration {
            name: "0016_defer_embed_enqueue.sql",
            sql: include_str!(
                "../../../plugins/memory/postgres/src/schema/migrations/0016_defer_embed_enqueue.sql"
            ),
        },
        EmbeddedMigration {
            name: "0017_agent_presets.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0017_agent_presets.sql"),
        },
        EmbeddedMigration {
            name: "0018_agent_preset_sort_order.sql",
            sql: include_str!(
                "../../../plugins/memory/postgres/src/schema/migrations/0018_agent_preset_sort_order.sql"
            ),
        },
        EmbeddedMigration {
            name: "0019_tags.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0019_tags.sql"),
        },
        EmbeddedMigration {
            name: "0020_tag_removals.sql",
            sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0020_tag_removals.sql"),
        },
    ]
}
