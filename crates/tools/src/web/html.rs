use regex::Regex;

use crate::textutil::js_trim;

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
        |caps| format!("\n```\n{}\n```\n", group(caps, 1)),
    );
    content = replace_capture(&content, r"(?i)<pre[^>]*>([\s\S]*?)</pre>", |caps| {
        format!("\n```\n{}\n```\n", group(caps, 1))
    });
    content = replace_capture(&content, r"(?i)<code[^>]*>([\s\S]*?)</code>", |caps| {
        format!("`{}`", group(caps, 1))
    });
    content = replace_capture(&content, r"(?i)<h1[^>]*>([\s\S]*?)</h1>", |caps| {
        format!("\n# {}\n", group(caps, 1))
    });
    content = replace_capture(&content, r"(?i)<h2[^>]*>([\s\S]*?)</h2>", |caps| {
        format!("\n## {}\n", group(caps, 1))
    });
    content = replace_capture(&content, r"(?i)<h3[^>]*>([\s\S]*?)</h3>", |caps| {
        format!("\n### {}\n", group(caps, 1))
    });
    content = replace_capture(&content, r"(?i)<h4[^>]*>([\s\S]*?)</h4>", |caps| {
        format!("\n#### {}\n", group(caps, 1))
    });
    content = replace_capture(&content, r"(?i)<h5[^>]*>([\s\S]*?)</h5>", |caps| {
        format!("\n##### {}\n", group(caps, 1))
    });
    content = replace_capture(&content, r"(?i)<h6[^>]*>([\s\S]*?)</h6>", |caps| {
        format!("\n###### {}\n", group(caps, 1))
    });
    content = replace_capture(
        &content,
        r#"(?i)<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)</a>"#,
        |caps| format!("[{}]({})", group(caps, 2), group(caps, 1)),
    );
    content = replace_capture(&content, r"(?i)<li[^>]*>([\s\S]*?)</li>", |caps| {
        format!("- {}\n", group(caps, 1))
    });
    content = replace(&content, r"(?i)</?[ou]l[^>]*>", "\n");
    content = replace_capture(&content, r"(?i)<p[^>]*>([\s\S]*?)</p>", |caps| {
        format!("\n\n{}\n\n", group(caps, 1))
    });
    content = replace(&content, r"(?i)<br\s*/?>", "\n");
    content = replace(&content, r"(?i)<hr\s*/?>", "\n---\n");
    content = replace_capture(
        &content,
        r"(?i)<(?:strong|b)[^>]*>([\s\S]*?)</(?:strong|b)>",
        |caps| format!("**{}**", group(caps, 1)),
    );
    content = replace_capture(
        &content,
        r"(?i)<(?:em|i)[^>]*>([\s\S]*?)</(?:em|i)>",
        |caps| format!("*{}*", group(caps, 1)),
    );
    content = replace(&content, r"<[^>]+>", "");
    content = decode_entities(&content);
    content = replace(&content, r"\n{3,}", "\n\n");
    content = replace(&content, r"[ \t]+", " ");
    content = replace(&content, r"(?m)^ +", "");
    js_trim(&content).to_string()
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
    result = replace_capture(&result, r"&#(\d+);", |caps| {
        let code = group(caps, 1).parse::<u64>().unwrap_or(0);
        from_char_code(code)
    });
    replace_capture(&result, r"&#x([0-9a-fA-F]+);", |caps| {
        let code = u64::from_str_radix(&group(caps, 1), 16).unwrap_or(0);
        from_char_code(code)
    })
}

fn from_char_code(code: u64) -> String {
    let unit = (code & 0xFFFF) as u16;
    String::from_utf16_lossy(&[unit])
}

fn group(caps: &regex::Captures<'_>, index: usize) -> String {
    caps.get(index)
        .map(|item| item.as_str())
        .unwrap_or("")
        .to_string()
}

fn replace(text: &str, pattern: &str, replacement: &str) -> String {
    let Ok(regex) = Regex::new(pattern) else {
        return text.to_string();
    };
    regex.replace_all(text, replacement).into_owned()
}

fn replace_capture<F>(text: &str, pattern: &str, replacer: F) -> String
where
    F: FnMut(&regex::Captures<'_>) -> String,
{
    let Ok(regex) = Regex::new(pattern) else {
        return text.to_string();
    };
    regex.replace_all(text, replacer).into_owned()
}

fn first_capture(text: &str, pattern: &str) -> Option<String> {
    let regex = Regex::new(pattern).ok()?;
    regex
        .captures(text)
        .and_then(|caps| caps.get(1).map(|item| item.as_str().to_string()))
}
