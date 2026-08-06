/**
 * @rivetos/workflows — document model, step SDK, journal-replay engine, start API.
 *
 * Product SoT: /rivet-shared/plans/workflows-product-v1.md (rev 3)
 */

// Types
export type {
  Field,
  FieldType,
  OutlineStep,
  WorkflowBudgets,
  WorkflowManifest,
  LoadedWorkflow,
  AgentDef,
  AgentConfig,
  StartedBy,
  StartedByType,
  ParentRef,
  RunStatus,
  Run,
  StepKind,
  JournalEntryType,
  JournalEntry,
  JournalEntryBase,
  RunStartedEntry,
  RunFinishedEntry,
  StepStartedEntry,
  StepFinishedEntry,
  StepFailedEntry,
  GateOpenedEntry,
  GateResolvedEntry,
  ManifestWarnEntry,
  CaseState,
} from './types.js'
export { makeStepId } from './types.js'

// Errors
export {
  WorkflowSuspension,
  WorkflowKilled,
  ContractValidationError,
  UnknownCallNamespaceError,
  WorkflowNotFoundError,
  RunNotFoundError,
  StepTimeoutError,
  RunTimeoutError,
  isWorkflowSuspension,
  isWorkflowKilled,
  type ContractValidationIssue,
} from './errors.js'

// Config
export {
  DEFAULT_CASE_DIR_ROOT,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_MAX_RUN_RUNTIME_MS,
  resolveCaseDirRoot,
  resolveStepTimeoutMs,
  resolveMaxRunRuntimeMs,
  type EngineConfig,
} from './config.js'

// Manifest / loader
export {
  parseManifest,
  loadManifestFile,
  validateInputContract,
  validateStartInput,
} from './manifest.js'
export { loadWorkflowDir, resolveWorkflowDir } from './loader.js'

// Journal / case
export {
  JOURNAL_FILENAME,
  journalPath,
  ensureJournal,
  appendJournal,
  readJournal,
  nowIso,
  findCachedStepResult,
  isOpenGate,
  maxSeqForLabel,
} from './journal.js'
export {
  CASE_FILENAME,
  casePath,
  writeCase,
  readCase,
  updateCase,
  mergeFields,
  updateRun,
  childCaseDir,
} from './case.js'

// Executors
export {
  MockExecutorRegistry,
  LocalExecutorRegistry,
  type AgentExecuteOpts,
  type RunExecuteOpts,
  type AgentExecutor,
  type RunExecutor,
  type ExecutorRegistry,
  type MockAgentHandler,
  type MockRunHandler,
  type MockExecutorRegistryOptions,
} from './executors.js'

// Call registry
export {
  NamespacedCallRegistry,
  createCallRegistry,
  parseCallRef,
  type CallContext,
  type CallResolver,
  type CallRegistry,
} from './registry.js'

// Step SDK
export {
  createStepRuntime,
  type Step,
  type AgentStepOpts,
  type RunStepOpts,
  type HumanStepOpts,
  type StepRuntimeOptions,
} from './step.js'

// Engine
export {
  WorkflowEngine,
  type RunScript,
  type RunScriptContext,
  type StartRunOptions,
  type StartRunResult,
  type ResumeRunOptions,
} from './engine.js'

// Scaffold
export { scaffoldWorkflow, type ScaffoldOptions, type ScaffoldResult } from './scaffold.js'

// Determinism
export { checkRunScriptDeterminism, type DeterminismFinding } from './determinism.js'
