const NAMED_ENTITIES: &[(&str, &str)] = &[
    ("&amp;", "&"),
    ("&lt;", "<"),
    ("&gt;", ">"),
    ("&quot;", "\""),
    ("&#39;", "'"),
    ("&apos;", "'"),
    ("&nbsp;", " "),
    ("&mdash;", "—"),
    ("&ndash;", "–"),
    ("&hellip;", "…"),
    ("&laquo;", "«"),
    ("&raquo;", "»"),
    ("&copy;", "©"),
    ("&reg;", "®"),
    ("&trade;", "™"),
];

pub fn extract_markdown(html: &str) -> String {
    let mut content = html.to_string();
    content = replace(&content, r"(?i)<script[^>]*>[\s\S]*?</script>", "");
    content = replace(&content, r"(?i)<style[^>]*>[\s\S]*?</style>", "");
    content = replace(&content, r"(?i)<nav[^>]*>[\s\S]*?</nav>", "");
    content = replace(&content, r"(?i)<footer[^>]*>[\s\S]*?</footer>", "");
    content = replace(&content, r"(?i)<aside[^>]*>[\s\S]*?</aside>", "");
    content = replace(&content, r"(?i)<header[^>]*>[\s\S]*?</header>", "");
    content = prefer_region(&content);
    content = replace_capture(
        &content,
        r"(?i)<pre[^>]*><code[^>]*>([\s\S]*?)</code></pre>",
        |text, found| format!("\n```\n{}\n```\n", group(text, found, 1)),
    );
    content = replace_capture(
        &content,
        r"(?i)<pre[^>]*>([\s\S]*?)</pre>",
        |text, found| format!("\n```\n{}\n```\n", group(text, found, 1)),
    );
    content = replace_capture(
        &content,
        r"(?i)<code[^>]*>([\s\S]*?)</code>",
        |text, found| format!("`{}`", group(text, found, 1)),
    );
    content = replace_capture(&content, r"(?i)<h1[^>]*>([\s\S]*?)</h1>", |text, found| {
        format!("\n# {}\n", group(text, found, 1))
    });
    content = replace_capture(&content, r"(?i)<h2[^>]*>([\s\S]*?)</h2>", |text, found| {
        format!("\n## {}\n", group(text, found, 1))
    });
    content = replace_capture(&content, r"(?i)<h3[^>]*>([\s\S]*?)</h3>", |text, found| {
        format!("\n### {}\n", group(text, found, 1))
    });
    content = replace_capture(&content, r"(?i)<h4[^>]*>([\s\S]*?)</h4>", |text, found| {
        format!("\n#### {}\n", group(text, found, 1))
    });
    content = replace_capture(&content, r"(?i)<h5[^>]*>([\s\S]*?)</h5>", |text, found| {
        format!("\n##### {}\n", group(text, found, 1))
    });
    content = replace_capture(&content, r"(?i)<h6[^>]*>([\s\S]*?)</h6>", |text, found| {
        format!("\n###### {}\n", group(text, found, 1))
    });
    content = replace_capture(
        &content,
        r#"(?i)<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>"#,
        |text, found| format!("[{}]({})", group(text, found, 2), group(text, found, 1)),
    );
    content = replace_capture(&content, r"(?i)<li[^>]*>([\s\S]*?)</li>", |text, found| {
        format!("- {}\n", group(text, found, 1))
    });
    content = replace(&content, r"(?i)</?[ou]l[^>]*>", "\n");
    content = replace_capture(&content, r"(?i)<p[^>]*>([\s\S]*?)</p>", |text, found| {
        format!("\n\n{}\n\n", group(text, found, 1))
    });
    content = replace(&content, r"(?i)<br\s*/?>", "\n");
    content = replace(&content, r"(?i)<hr\s*/?>", "\n---\n");
    content = replace_capture(
        &content,
        r"(?i)<(?:strong|b)[^>]*>([\s\S]*?)</(?:strong|b)>",
        |text, found| format!("**{}**", group(text, found, 1)),
    );
    content = replace_capture(
        &content,
        r"(?i)<(?:em|i)[^>]*>([\s\S]*?)</(?:em|i)>",
        |text, found| format!("*{}*", group(text, found, 1)),
    );
    content = replace(&content, r"<[^>]+>", "");
    content = decode_entities(&content);
    content = replace(&content, r"\n{3,}", "\n\n");
    content = replace(&content, r"[ \t]+", " ");
    content = replace(&content, r"(?m)^ +", "");
    protocol::js::js_trim(&content).to_string()
}

fn prefer_region(content: &str) -> String {
    if let Some(inner) = first_capture(content, r"(?i)<article[^>]*>([\s\S]*?)</article>") {
        return inner;
    }
    if let Some(inner) = first_capture(content, r"(?i)<main[^>]*>([\s\S]*?)</main>") {
        return inner;
    }
    if let Some(inner) = first_capture(content, r"(?i)<body[^>]*>([\s\S]*?)</body>") {
        return inner;
    }
    content.to_string()
}

fn decode_entities(text: &str) -> String {
    let mut result = text.to_string();
    for (entity, ch) in NAMED_ENTITIES {
        result = result.replace(entity, ch);
    }
    result = replace_capture(&result, r"&#(\d+);", |text, found| {
        let code = group(text, found, 1).parse::<u64>().unwrap_or(0);
        from_char_code(code)
    });
    replace_capture(&result, r"&#x([0-9a-fA-F]+);", |text, found| {
        let code = u64::from_str_radix(group(text, found, 1), 16).unwrap_or(0);
        from_char_code(code)
    })
}

fn from_char_code(code: u64) -> String {
    let unit = (code & 0xFFFF) as u16;
    String::from_utf16_lossy(&[unit])
}

fn group<'a>(text: &'a str, matched: &regress::Match, index: usize) -> &'a str {
    crate::reutil::group(text, matched, index)
}

fn replace(text: &str, pattern: &str, replacement: &str) -> String {
    crate::reutil::replace_all(text, pattern, replacement)
}

fn replace_capture<F>(text: &str, pattern: &str, mut replacer: F) -> String
where
    F: FnMut(&str, &regress::Match) -> String,
{
    let Some(regex) = crate::reutil::compile(pattern) else {
        return text.to_string();
    };
    crate::reutil::replace_with(&regex, text, |found| replacer(text, found))
}

fn first_capture(text: &str, pattern: &str) -> Option<String> {
    let regex = crate::reutil::compile(pattern)?;
    let found = regex.find(text)?;
    Some(group(text, &found, 1).to_string())
}
