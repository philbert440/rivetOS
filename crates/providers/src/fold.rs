#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FoldContent {
    Text(String),
    Parts(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoldMessage<T> {
    pub role: String,
    pub content: FoldContent,
    pub data: Option<T>,
}

pub fn split_and_fold_system<T: Clone>(
    messages: &[FoldMessage<T>],
) -> (String, Vec<FoldMessage<T>>) {
    let mut system = String::new();
    let mut seen_non_system = false;
    let mut rest = Vec::new();
    for message in messages {
        if message.role == "system" {
            let text = fold_text(&message.content);
            if !seen_non_system {
                if !system.is_empty() {
                    system.push_str("\n\n");
                }
                system.push_str(&text);
                continue;
            }
            let notice = if text.is_empty() {
                "[SYSTEM NOTICE]\n(empty system message)".to_string()
            } else {
                format!("[SYSTEM NOTICE]\n{text}")
            };
            rest.push(FoldMessage {
                role: "user".to_string(),
                content: FoldContent::Text(notice),
                data: None,
            });
            continue;
        }
        seen_non_system = true;
        rest.push(message.clone());
    }
    (system, rest)
}

fn fold_text(content: &FoldContent) -> String {
    match content {
        FoldContent::Text(text) => text.clone(),
        FoldContent::Parts(parts) => parts.concat(),
    }
}

#[cfg(test)]
mod tests {
    use super::{FoldContent, FoldMessage, split_and_fold_system};

    fn text(role: &str, body: &str) -> FoldMessage<()> {
        FoldMessage {
            role: role.to_string(),
            content: FoldContent::Text(body.to_string()),
            data: None,
        }
    }

    #[test]
    fn leading_system_run_is_concatenated() {
        let input = vec![
            text("system", "one"),
            text("system", "two"),
            text("user", "hi"),
        ];
        let (system, rest) = split_and_fold_system(&input);
        assert_eq!(system, "one\ntwo".replace('\n', "\n\n"));
        assert_eq!(rest, vec![text("user", "hi")]);
        assert_eq!(input[0].role, "system");
    }

    #[test]
    fn mid_system_folds_into_a_notice() {
        let input = vec![
            text("system", "lead"),
            text("user", "hi"),
            text("system", "later"),
            text("assistant", "ok"),
        ];
        let (system, rest) = split_and_fold_system(&input);
        assert_eq!(system, "lead");
        assert_eq!(
            rest,
            vec![
                text("user", "hi"),
                text("user", "[SYSTEM NOTICE]\nlater"),
                text("assistant", "ok"),
            ]
        );
    }

    #[test]
    fn empty_mid_system_uses_the_empty_notice() {
        let input = vec![text("user", "hi"), text("system", "")];
        let (system, rest) = split_and_fold_system(&input);
        assert_eq!(system, "");
        assert_eq!(
            rest,
            vec![
                text("user", "hi"),
                text("user", "[SYSTEM NOTICE]\n(empty system message)"),
            ]
        );
    }

    #[test]
    fn parts_are_joined_without_a_separator() {
        let input = vec![FoldMessage {
            role: "system".to_string(),
            content: FoldContent::Parts(vec!["a".to_string(), "b".to_string()]),
            data: Some(7u8),
        }];
        let (system, rest) = split_and_fold_system(&input);
        assert_eq!(system, "ab");
        assert!(rest.is_empty());
        assert_eq!(input[0].data, Some(7));
    }
}
