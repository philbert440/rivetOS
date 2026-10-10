pub fn filter_pglite_dump(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut in_copy = false;
    for line in sql.split_inclusive('\n') {
        if in_copy {
            out.push_str(line);
            if is_copy_end(line) {
                in_copy = false;
            }
            continue;
        }
        if is_copy_from_stdin(line) {
            in_copy = true;
            out.push_str(line);
            continue;
        }
        if is_psql_meta(line) || is_transaction_timeout(line) {
            continue;
        }
        out.push_str(line);
    }
    out
}

pub fn quote_ident(ident: &str) -> String {
    let mut out = String::from("\"");
    for ch in ident.chars() {
        if ch == '"' {
            out.push_str("\"\"");
        } else {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

fn is_copy_from_stdin(line: &str) -> bool {
    let lower = line.trim_start().to_ascii_lowercase();
    lower.starts_with("copy ") && lower.contains("from stdin")
}

fn is_copy_end(line: &str) -> bool {
    line.trim_end_matches(['\r', '\n']) == "\\."
}

fn is_psql_meta(line: &str) -> bool {
    line.trim_start().starts_with('\\')
}

fn is_transaction_timeout(line: &str) -> bool {
    let lower = line.trim_start().to_ascii_lowercase();
    lower.starts_with("set transaction_timeout")
        || lower.starts_with("select pg_catalog.set_config('transaction_timeout'")
        || lower.starts_with("select pg_catalog.set_config(\"transaction_timeout\"")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_pg18_meta_and_keeps_rows_and_copy_data() {
        let sql = "\
\\restrict token\n\
SET transaction_timeout = 0;\n\
SELECT pg_catalog.set_config('transaction_timeout', '0', false);\n\
SET client_encoding = 'UTF8';\n\
INSERT INTO t VALUES (1);\n\
COPY t FROM stdin;\n\
\\restrict not-meta\n\
\\.\n\
\\unrestrict token\n";
        let filtered = filter_pglite_dump(sql);
        assert!(!filtered.contains("\\restrict token"));
        assert!(!filtered.contains("\\unrestrict"));
        assert!(!filtered.contains("transaction_timeout"));
        assert!(filtered.contains("SET client_encoding = 'UTF8';"));
        assert!(filtered.contains("INSERT INTO t VALUES (1);"));
        assert!(filtered.contains("\\restrict not-meta"));
        assert!(filtered.contains("\\.\n"));
    }

    #[test]
    fn quote_ident_doubles_quotes() {
        assert_eq!(quote_ident("public"), "\"public\"");
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }
}
