protocol::wire_enum! {
    pub enum Activity {
        Idle => "idle",
        Thinking => "thinking",
        SearchingWeb => "searching_web",
        EditingCode => "editing_code",
        RunningCommand => "running_command",
        WritingPlan => "writing_plan",
        Listening => "listening",
        Speaking => "speaking",
        Sleeping => "sleeping",
    }
}

pub const ACTIVITIES: [Activity; 9] = Activity::ALL;

pub fn tool_activity(name: &str) -> Activity {
    let lowered = name.to_lowercase();
    if lowered.contains("websearch")
        || lowered.contains("webfetch")
        || lowered.contains("web_search")
        || lowered.contains("web_fetch")
        || lowered.contains("internet_search")
    {
        return Activity::SearchingWeb;
    }
    if lowered == "edit"
        || lowered == "write"
        || lowered == "notebookedit"
        || lowered.contains("applypatch")
    {
        return Activity::EditingCode;
    }
    if lowered == "taskcreate"
        || lowered == "taskupdate"
        || lowered == "exitplanmode"
        || lowered == "enterplanmode"
    {
        return Activity::WritingPlan;
    }
    if lowered == "read" || lowered == "grep" || lowered == "glob" {
        return Activity::Thinking;
    }
    if lowered == "bash"
        || lowered == "run_terminal_cmd"
        || lowered == "shell"
        || lowered.contains("terminal")
    {
        return Activity::EditingCode;
    }
    Activity::RunningCommand
}
