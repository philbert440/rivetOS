use std::path::PathBuf;

use crate::error::WorkflowError;
use crate::io_fs::{self, try_exists};
use crate::pathutil::{node_join_paths, path_text};

#[derive(Default)]
pub struct ScaffoldOptions {
    pub dir: Option<PathBuf>,
    pub description: Option<String>,
    pub fixture_test: Option<bool>,
}

#[derive(Debug)]
pub struct ScaffoldResult {
    pub workflow_dir: String,
    pub files: Vec<String>,
}

pub async fn scaffold_workflow(
    name: &str,
    options: ScaffoldOptions,
) -> Result<ScaffoldResult, WorkflowError> {
    if !valid_name(name) {
        return Err(WorkflowError::message(format!(
            "Invalid workflow name \"{name}\": use lowercase letters, numbers, hyphens"
        )));
    }
    let parent = match options.dir {
        Some(dir) => dir,
        None => std::env::current_dir().map_err(|err| {
            WorkflowError::message(format!("failed to read working directory: {err}"))
        })?,
    };
    let workflow_dir = node_join_paths(&parent, name);
    if try_exists(&workflow_dir).await? {
        return Err(WorkflowError::message(format!(
            "Workflow already exists: {}",
            path_text(&workflow_dir)
        )));
    }
    let description = options
        .description
        .unwrap_or_else(|| format!("{name} workflow"));
    let mut files = Vec::new();
    io_fs::create_dir_all(&node_join_paths(&workflow_dir, "agents")).await?;
    io_fs::write_bytes(
        &node_join_paths(&workflow_dir, "workflow.yaml"),
        workflow_yaml(name, &description).as_bytes(),
    )
    .await?;
    files.push("workflow.yaml".to_string());
    io_fs::write_bytes(
        &node_join_paths(&workflow_dir, "run.ts"),
        run_ts(name).as_bytes(),
    )
    .await?;
    files.push("run.ts".to_string());
    io_fs::write_bytes(
        &node_join_paths(&node_join_paths(&workflow_dir, "agents"), "example.md"),
        AGENT_MD.as_bytes(),
    )
    .await?;
    files.push("agents/example.md".to_string());
    if options.fixture_test != Some(false) {
        let test_name = format!("{name}.fixture.test.ts");
        io_fs::write_bytes(
            &node_join_paths(&parent, &test_name),
            fixture_test(name).as_bytes(),
        )
        .await?;
        files.push(test_name);
    }
    Ok(ScaffoldResult {
        workflow_dir: path_text(&workflow_dir),
        files,
    })
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

fn workflow_yaml(name: &str, description: &str) -> String {
    format!(
        "id: {name}\nversion: \"0.1.0\"\nname: {name}\ndescription: {description}\ninput:\n  - name: message\n    type: string\n    required: true\n    description: Input message\noutput:\n  - name: result\n    type: string\n    description: Final result\noutline:\n  - id: greet\n    kind: agent\n    label: Greet\n  - id: approve\n    kind: human\n    label: Approve\nbudgets:\n  maxTokens: 100000\n"
    )
}

fn run_ts(name: &str) -> String {
    format!(
        r#"/**
 * {name} — orchestration script.
 *
 * DETERMINISM RULE: no Date.now(), Math.random(), or I/O outside step.* calls.
 * All nondeterminism must live inside steps (journaled).
 */
import type {{ Step }} from '@rivetos/workflows'

export default async function run(
  step: Step,
  ctx: {{ input: Record<string, unknown> }},
): Promise<void> {{
  const greet = await step.agent('greet', {{
    agent: 'example',
    prompt: `Process: ${{ctx.input.message}}`,
    out: ['result'],
  }})

  const gate = await step.human('approve', {{
    prompt: 'Approve the result?',
    fields: ['approved'],
  }})

  await step.done({{
    result: greet.result ?? greet,
    approved: gate.approved,
  }})
}}
"#
    )
}

const AGENT_MD: &str = "---\ntools: []\n# model: claude-sonnet-4-20250514\n# maxTurns: 8\n---\n\n# Example agent\n\nYou are a helpful workflow agent. Produce a concise result for the given prompt.\n\n## Output\n\nWrite a short string result.\n";

fn fixture_test(name: &str) -> String {
    format!(
        r#"/**
 * Fixture test for workflow "{name}".
 * Point workflowDirs at the scaffolded directory when running.
 */
import {{ describe, it, expect }} from 'vitest'
import {{ mkdtemp }} from 'node:fs/promises'
import {{ join, dirname }} from 'node:path'
import {{ tmpdir }} from 'node:os'
import {{ fileURLToPath }} from 'node:url'
import {{
  WorkflowEngine,
  MockExecutorRegistry,
  loadWorkflowDir,
  type RunScript,
}} from '@rivetos/workflows'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKFLOW_DIR = join(__dirname, '{name}')

const runScript: RunScript = async (step, ctx) => {{
  const greet = await step.agent('greet', {{
    agent: 'example',
    prompt: String(ctx.input.message),
    out: ['result'],
  }})
  const gate = await step.human('approve', {{
    prompt: 'Approve?',
    fields: ['approved'],
  }})
  await step.done({{ result: greet.result, approved: gate.approved }})
}}

describe('workflow {name} fixture', () => {{
  it('suspends at human gate and resumes to done', async () => {{
    const root = await mkdtemp(join(tmpdir(), 'wf-{name}-'))
    const workflow = await loadWorkflowDir(WORKFLOW_DIR)
    const engine = new WorkflowEngine({{
      caseDirRoot: root,
      executors: new MockExecutorRegistry({{
        agent: async () => ({{ result: 'hello' }}),
      }}),
      workflowDirs: {{ [workflow.manifest.id]: WORKFLOW_DIR }},
    }})

    const started = await engine.startRun(
      workflow.manifest.id,
      {{ message: 'hi' }},
      {{ type: 'human', id: 'test' }},
      {{ runScript, workflow }},
    )
    expect(started.suspended).toBe(true)
    expect(started.run.status).toBe('paused_human')

    const resumed = await engine.resumeRun(started.run.id, {{
      gateResponse: {{ approved: true }},
      runScript,
      workflow,
    }})
    expect(resumed.suspended).toBe(false)
    expect(resumed.run.status).toBe('done')
    expect(resumed.run.output?.approved).toBe(true)
  }})
}})
"#
    )
}
