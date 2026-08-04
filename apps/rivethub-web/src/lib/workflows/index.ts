export type {
  CapabilityMode,
  NodeKind,
  PortDirection,
  PortKind,
  ValidationIssue,
  ValidationSeverity,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowPort,
} from './types.js'

export { normalizeWorkflow } from './normalize.js'
export { isValidWorkflow, validateWorkflow } from './validate.js'
export {
  NODE_HEIGHT,
  NODE_WIDTH,
  edgePaths,
  graphBounds,
  nodeCenter,
  portAnchor,
  type EdgePath,
} from './layout.js'
export { PR_REVIEW_GATE, WIKI_RECOMPILE, getWorkflow, listWorkflows } from './fixtures.js'

/** IR v2 (nested DAG + validation) — see `./v2/VALIDATION.md` */
export * as workflowsV2 from './v2/index.js'
