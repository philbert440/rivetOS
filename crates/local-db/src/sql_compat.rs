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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quote_ident_doubles_quotes() {
        assert_eq!(quote_ident("public"), "\"public\"");
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
    }
}
