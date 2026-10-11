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

pub fn safe_pg_type(text: &str) -> bool {
    !text.is_empty()
        && text.len() < 200
        && !text.contains("--")
        && text.chars().all(|ch| {
            ch.is_ascii_alphanumeric() || matches!(ch, ' ' | '_' | '(' | ')' | ',' | '.' | '"')
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_ident_doubles_quotes() {
        assert_eq!(quote_ident("public"), "\"public\"");
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }

    #[test]
    fn pg_types_from_format_type_are_accepted() {
        assert!(safe_pg_type("bigint"));
        assert!(safe_pg_type("timestamp with time zone"));
        assert!(safe_pg_type("character varying(32)"));
        assert!(safe_pg_type("numeric(10,2)"));
        assert!(safe_pg_type("vector(3)"));
        assert!(!safe_pg_type("int;drop"));
        assert!(!safe_pg_type(""));
    }
}
