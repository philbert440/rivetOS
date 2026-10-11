pub struct Regex {
    inner: regress::Regex,
}

pub struct Captures<'a> {
    matched: regress::Match,
    text: &'a str,
}

pub struct Group<'a> {
    text: &'a str,
}

impl Regex {
    pub fn new(pattern: &str) -> Result<Self, regress::Error> {
        let (body, flags) = inline_flags(pattern);
        regress::Regex::with_flags(body, flags).map(|inner| Self { inner })
    }

    pub fn is_match(&self, text: &str) -> bool {
        self.inner.find(text).is_some()
    }

    pub fn captures<'a>(&self, text: &'a str) -> Option<Captures<'a>> {
        self.inner
            .find(text)
            .map(|matched| Captures { matched, text })
    }

    pub fn replace(&self, text: &str, replacement: &str) -> String {
        self.inner.replace(text, replacement)
    }

    pub fn replace_all(&self, text: &str, replacement: &str) -> String {
        self.inner.replace_all(text, replacement)
    }
}

impl<'a> Captures<'a> {
    pub fn get(&self, index: usize) -> Option<Group<'a>> {
        let range = self.matched.group(index)?;
        self.text.get(range).map(|text| Group { text })
    }
}

impl<'a> Group<'a> {
    pub fn as_str(&self) -> &'a str {
        self.text
    }
}

fn inline_flags(pattern: &str) -> (&str, &str) {
    if let Some(body) = pattern.strip_prefix("(?i)") {
        (body, "i")
    } else {
        (pattern, "")
    }
}
