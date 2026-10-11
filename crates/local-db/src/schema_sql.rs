pub struct ProductMigration {
    pub name: &'static str,
    pub sql: &'static str,
}

const MIGRATIONS: &[ProductMigration] = &[
    ProductMigration {
        name: "0001_baseline.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0001_baseline.sql"
        ),
    },
    ProductMigration {
        name: "0002_ros_tasks.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0002_ros_tasks.sql"
        ),
    },
    ProductMigration {
        name: "0003_legacy_teardown.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0003_legacy_teardown.sql"
        ),
    },
    ProductMigration {
        name: "0004_task_eval.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0004_task_eval.sql"
        ),
    },
    ProductMigration {
        name: "0005_wiki.sql",
        sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0005_wiki.sql"),
    },
    ProductMigration {
        name: "0006_wiki_durable_topics.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0006_wiki_durable_topics.sql"
        ),
    },
    ProductMigration {
        name: "0007_wiki_article.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0007_wiki_article.sql"
        ),
    },
    ProductMigration {
        name: "0008_message_tool_result_search.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0008_message_tool_result_search.sql"
        ),
    },
    ProductMigration {
        name: "0009_conversation_session_key_unique.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0009_conversation_session_key_unique.sql"
        ),
    },
    ProductMigration {
        name: "0010_conversation_dedup_locked.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0010_conversation_dedup_locked.sql"
        ),
    },
    ProductMigration {
        name: "0011_conversation_task_id.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0011_conversation_task_id.sql"
        ),
    },
    ProductMigration {
        name: "0012_embed_tool_result.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0012_embed_tool_result.sql"
        ),
    },
    ProductMigration {
        name: "0013_owner_user_id.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0013_owner_user_id.sql"
        ),
    },
    ProductMigration {
        name: "0014_chunks.sql",
        sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0014_chunks.sql"),
    },
    ProductMigration {
        name: "0015_embedding_width.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0015_embedding_width.sql"
        ),
    },
    ProductMigration {
        name: "0016_defer_embed_enqueue.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0016_defer_embed_enqueue.sql"
        ),
    },
    ProductMigration {
        name: "0017_agent_presets.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0017_agent_presets.sql"
        ),
    },
    ProductMigration {
        name: "0018_agent_preset_sort_order.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0018_agent_preset_sort_order.sql"
        ),
    },
    ProductMigration {
        name: "0019_tags.sql",
        sql: include_str!("../../../plugins/memory/postgres/src/schema/migrations/0019_tags.sql"),
    },
    ProductMigration {
        name: "0020_tag_removals.sql",
        sql: include_str!(
            "../../../plugins/memory/postgres/src/schema/migrations/0020_tag_removals.sql"
        ),
    },
];

pub const MIGRATIONS_TABLE_SQL: &str = "\
CREATE TABLE IF NOT EXISTS _rivetos_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    checksum    TEXT
)";

pub fn product_migrations() -> &'static [ProductMigration] {
    MIGRATIONS
}

pub fn migration_batch(name: &str, sql: &str) -> String {
    format!(
        "BEGIN;\n{sql}\n;\nINSERT INTO _rivetos_migrations (name) VALUES ({});\nCOMMIT;",
        quote_literal(name)
    )
}

pub fn quote_literal(text: &str) -> String {
    let mut out = String::from("'");
    for ch in text.chars() {
        if ch == '\'' {
            out.push_str("''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn product_migrations_are_the_memory_files_in_order() {
        let names: Vec<&str> = product_migrations()
            .iter()
            .map(|migration| migration.name)
            .collect();
        assert_eq!(names.first().copied(), Some("0001_baseline.sql"));
        assert_eq!(names.last().copied(), Some("0020_tag_removals.sql"));
        assert_eq!(names.len(), 20);
        let mut sorted = names.clone();
        sorted.sort_unstable();
        assert_eq!(names, sorted);
        let baseline = product_migrations()[0].sql;
        assert!(baseline.contains("gen_random_uuid()"));
        assert!(baseline.contains("GENERATED ALWAYS"));
        let wiki = product_migrations()
            .iter()
            .find(|migration| migration.name == "0005_wiki.sql")
            .expect("wiki");
        assert!(wiki.sql.contains("TEXT[]"));
        let tags = product_migrations()
            .iter()
            .find(|migration| migration.name == "0019_tags.sql")
            .expect("tags");
        assert!(tags.sql.contains("TEXT[]"));
    }

    #[test]
    fn migration_batch_quotes_the_name_and_wraps_a_transaction() {
        let sql = migration_batch("a'b.sql", "SELECT 1");
        assert!(sql.starts_with("BEGIN;"));
        assert!(sql.contains("SELECT 1"));
        assert!(sql.contains("VALUES ('a''b.sql')"));
        assert!(sql.trim_end().ends_with("COMMIT;"));
    }
}
