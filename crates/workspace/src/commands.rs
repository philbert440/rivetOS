#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommandDef {
    pub name: &'static str,
    pub description: &'static str,
    pub args: Option<&'static str>,
}

pub const COMMAND_REGISTRY: &[CommandDef] = &[
    CommandDef {
        name: "stop",
        description: "Stop the current turn",
        args: None,
    },
    CommandDef {
        name: "interrupt",
        description: "Stop and send a new message",
        args: Some("<message>"),
    },
    CommandDef {
        name: "steer",
        description: "Inject guidance into active turn",
        args: Some("<message>"),
    },
    CommandDef {
        name: "new",
        description: "Start a fresh session",
        args: None,
    },
    CommandDef {
        name: "status",
        description: "Show runtime status",
        args: None,
    },
    CommandDef {
        name: "model",
        description: "View or change provider model",
        args: Some("[provider] [model]"),
    },
    CommandDef {
        name: "think",
        description: "Set thinking level",
        args: Some("off|low|medium|high"),
    },
    CommandDef {
        name: "reasoning",
        description: "Toggle reasoning visibility",
        args: None,
    },
    CommandDef {
        name: "tools",
        description: "Toggle tool call visibility",
        args: None,
    },
    CommandDef {
        name: "context",
        description: "Show context window stats",
        args: None,
    },
    CommandDef {
        name: "memory",
        description: "Show memory system health & stats",
        args: None,
    },
    CommandDef {
        name: "clear",
        description: "Clear queued messages",
        args: None,
    },
    CommandDef {
        name: "start",
        description: "Show welcome message",
        args: None,
    },
    CommandDef {
        name: "help",
        description: "Show available commands",
        args: None,
    },
];

pub fn is_known_command(name: &str) -> bool {
    COMMAND_REGISTRY.iter().any(|command| command.name == name)
}

#[cfg(test)]
mod tests {
    use super::{COMMAND_REGISTRY, is_known_command};

    #[test]
    fn registry_matches_the_typescript_descriptors() {
        let names: Vec<&str> = COMMAND_REGISTRY
            .iter()
            .map(|command| command.name)
            .collect();
        assert_eq!(
            names,
            [
                "stop",
                "interrupt",
                "steer",
                "new",
                "status",
                "model",
                "think",
                "reasoning",
                "tools",
                "context",
                "memory",
                "clear",
                "start",
                "help",
            ]
        );
        let think = COMMAND_REGISTRY
            .iter()
            .find(|command| command.name == "think")
            .unwrap();
        assert_eq!(think.args, Some("off|low|medium|high"));
        assert_eq!(
            COMMAND_REGISTRY
                .iter()
                .find(|command| command.name == "model")
                .unwrap()
                .args,
            Some("[provider] [model]")
        );
        assert!(is_known_command("help"));
        assert!(!is_known_command("unknown"));
        assert!(!is_known_command(""));
    }
}
