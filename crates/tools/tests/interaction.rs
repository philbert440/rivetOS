use serde_json::{Value, json};
use tools::{AskUserTool, CancellationToken, TodoTool, Tool, ToolContext, result_text};

async fn run(tool: &impl Tool, args: Value) -> String {
    result_text(
        &tool
            .execute(args, &CancellationToken::new(), &ToolContext::default())
            .await,
    )
    .to_string()
}

fn required(schema: &Value, name: &str) -> bool {
    schema
        .get("required")
        .and_then(Value::as_array)
        .map(|items| items.iter().any(|item| item.as_str() == Some(name)))
        .unwrap_or(false)
}

#[tokio::test]
async fn ask_user_cases() {
    let tool = AskUserTool::new();
    assert_eq!(tool.name(), "ask_user");
    assert!(!tool.description().is_empty());
    assert!(required(&tool.parameters(), "question"));
    assert!(
        run(&tool, json!({"question": "What color do you prefer?"}))
            .await
            .contains("What color do you prefer?")
    );
    let yes = run(
        &tool,
        json!({"question": "Should I deploy to production?", "type": "yes_no"}),
    )
    .await;
    assert!(yes.contains("Should I deploy to production?"));
    assert!(yes.contains("Yes / No"));
    assert!(
        run(
            &tool,
            json!({"question": "Continue?", "type": "yes_no", "default_value": "yes"})
        )
        .await
        .contains("default: yes")
    );
    let choice = run(
        &tool,
        json!({
            "question": "Which framework?",
            "type": "multiple_choice",
            "choices": ["Next.js", "Remix", "Astro"]
        }),
    )
    .await;
    assert!(choice.contains("Which framework?"));
    assert!(choice.contains("1. Next.js"));
    assert!(choice.contains("2. Remix"));
    assert!(choice.contains("3. Astro"));
    let context = run(
        &tool,
        json!({
            "question": "Which database?",
            "context": "You mentioned wanting to self-host."
        }),
    )
    .await;
    assert!(context.contains("Context: You mentioned wanting to self-host."));
    assert!(context.contains("Which database?"));
    assert!(
        run(
            &tool,
            json!({"question": "What port?", "default_value": "3000"})
        )
        .await
        .contains("Default: 3000")
    );
    assert!(
        run(
            &tool,
            json!({
                "question": "Pick one",
                "type": "multiple_choice",
                "choices": ["A", "B", "C"],
                "default_value": "B"
            })
        )
        .await
        .contains("Default: B")
    );
    assert!(run(&tool, json!({"question": ""})).await.contains("Error"));
    assert!(run(&tool, json!({})).await.contains("Error"));
    assert!(
        run(&tool, json!({"question": "   "}))
            .await
            .contains("Error")
    );
    let invalid = run(&tool, json!({"question": "test", "type": "radio"})).await;
    assert!(invalid.contains("Error"));
    assert!(invalid.contains("invalid type"));
    let missing = run(
        &tool,
        json!({"question": "Pick", "type": "multiple_choice"}),
    )
    .await;
    assert!(missing.contains("Error"));
    assert!(missing.contains("at least 2"));
    let one = run(
        &tool,
        json!({"question": "Pick", "type": "multiple_choice", "choices": ["Only one"]}),
    )
    .await;
    assert!(one.contains("Error"));
    assert!(one.contains("at least 2"));
    let free = run(&tool, json!({"question": "How are you?"})).await;
    assert!(!free.contains("Options:"));
    assert!(!free.contains("1."));
}

#[tokio::test]
async fn todo_cases() {
    let tool = TodoTool::new();
    assert_eq!(tool.name(), "todo");
    assert!(!tool.description().is_empty());
    assert_eq!(tool.parameters()["type"], "object");
    assert!(required(&tool.parameters(), "operation"));
    assert_eq!(
        run(&tool, json!({"operation": "list"})).await,
        "No tasks yet."
    );
    assert_eq!(
        run(
            &tool,
            json!({"operation": "add", "task": "Set up database"})
        )
        .await,
        "Added task #1: Set up database"
    );
    let ids = TodoTool::new();
    let _ = run(&ids, json!({"operation": "add", "task": "First"})).await;
    assert_eq!(
        run(&ids, json!({"operation": "add", "task": "Second"})).await,
        "Added task #2: Second"
    );
    let listed = TodoTool::new();
    let _ = run(
        &listed,
        json!({"operation": "add", "task": "Set up database"}),
    )
    .await;
    let _ = run(&listed, json!({"operation": "add", "task": "Build API"})).await;
    let _ = run(&listed, json!({"operation": "add", "task": "Write tests"})).await;
    let _ = run(&listed, json!({"operation": "complete", "id": 1})).await;
    let result = run(&listed, json!({"operation": "list"})).await;
    assert!(result.starts_with("Tasks (1/3 done):"));
    assert!(result.contains("[✅] #1 Set up database"));
    assert!(result.contains("[  ] #2 Build API"));
    assert!(result.contains("[  ] #3 Write tests"));
    let done = TodoTool::new();
    let _ = run(&done, json!({"operation": "add", "task": "Deploy"})).await;
    assert_eq!(
        run(&done, json!({"operation": "complete", "id": 1})).await,
        "Completed task #1: Deploy"
    );
    let updated = TodoTool::new();
    let _ = run(&updated, json!({"operation": "add", "task": "Old text"})).await;
    let result = run(
        &updated,
        json!({"operation": "update", "id": 1, "new_text": "New text"}),
    )
    .await;
    assert!(result.contains("New text"));
    assert!(result.contains("[pending]"));
    let status = TodoTool::new();
    let _ = run(
        &status,
        json!({"operation": "add", "task": "Working on it"}),
    )
    .await;
    assert!(
        run(
            &status,
            json!({"operation": "update", "id": 1, "status": "in_progress"})
        )
        .await
        .contains("[in_progress]")
    );
    let both = TodoTool::new();
    let _ = run(&both, json!({"operation": "add", "task": "Original"})).await;
    let result = run(
        &both,
        json!({"operation": "update", "id": 1, "new_text": "Changed", "status": "done"}),
    )
    .await;
    assert!(result.contains("Changed"));
    assert!(result.contains("[done]"));
    let icon = TodoTool::new();
    let _ = run(
        &icon,
        json!({"operation": "add", "task": "In progress task"}),
    )
    .await;
    let _ = run(
        &icon,
        json!({"operation": "update", "id": 1, "status": "in_progress"}),
    )
    .await;
    assert!(
        run(&icon, json!({"operation": "list"}))
            .await
            .contains("[🔧] #1 In progress task")
    );
    let removed = TodoTool::new();
    let _ = run(&removed, json!({"operation": "add", "task": "Temp"})).await;
    assert_eq!(
        run(&removed, json!({"operation": "remove", "id": 1})).await,
        "Removed task #1"
    );
    assert_eq!(
        run(&removed, json!({"operation": "list"})).await,
        "No tasks yet."
    );
    let stable = TodoTool::new();
    let _ = run(&stable, json!({"operation": "add", "task": "First"})).await;
    let _ = run(&stable, json!({"operation": "add", "task": "Second"})).await;
    let _ = run(&stable, json!({"operation": "remove", "id": 1})).await;
    assert_eq!(
        run(&stable, json!({"operation": "add", "task": "Third"})).await,
        "Added task #3: Third"
    );
    assert!(
        run(&TodoTool::new(), json!({"operation": "add"}))
            .await
            .starts_with("Error")
    );
    assert!(
        run(&TodoTool::new(), json!({"operation": "add", "task": "   "}))
            .await
            .starts_with("Error")
    );
    assert!(
        run(&TodoTool::new(), json!({"operation": "complete", "id": 99}))
            .await
            .contains("not found")
    );
    assert!(
        run(
            &TodoTool::new(),
            json!({"operation": "update", "id": 99, "status": "done"})
        )
        .await
        .contains("not found")
    );
    assert!(
        run(&TodoTool::new(), json!({"operation": "remove", "id": 99}))
            .await
            .contains("not found")
    );
    assert!(
        run(&TodoTool::new(), json!({"operation": "explode"}))
            .await
            .contains("unknown operation")
    );
    assert!(
        run(&TodoTool::new(), json!({"operation": "complete"}))
            .await
            .starts_with("Error")
    );
    let invalid = TodoTool::new();
    let _ = run(&invalid, json!({"operation": "add", "task": "Test"})).await;
    assert!(
        run(
            &invalid,
            json!({"operation": "update", "id": 1, "status": "exploded"})
        )
        .await
        .contains("invalid status")
    );
    let tool1 = TodoTool::new();
    let tool2 = TodoTool::new();
    let _ = run(&tool1, json!({"operation": "add", "task": "Tool 1 task"})).await;
    assert_eq!(
        run(&tool2, json!({"operation": "list"})).await,
        "No tasks yet."
    );
}
