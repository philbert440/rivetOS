use crate::manager::Skill;

const INTRO: &str = "These are loadable skills for specific domains. When a request matches one — brokerage/investments, bank/net-worth, email, calendar, drive, memory, voice — USE the matching skill (load and invoke it) instead of improvising shell commands or guessing a database schema. Invoking a skill loads its full instructions and tools.";

pub fn catalog_text(skills: &[Skill]) -> Option<String> {
    if skills.is_empty() {
        return None;
    }
    let mut lines = vec!["## Available skills".to_string(), INTRO.to_string()];
    for skill in skills {
        lines.push(format!("- **{}**: {}", skill.name, skill.description));
    }
    Some(lines.join("\n"))
}
