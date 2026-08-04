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

export {
  CAPABILITY_MODES,
  NODE_KINDS,
  addEdge,
  addNode,
  addPort,
  createDefaultNode,
  moveNode,
  newEdgeId,
  newNodeId,
  parseToolsField,
  removeEdge,
  removeNode,
  removePort,
  replaceNodePorts,
  updateNode,
  updatePort,
  updateWorkflowMeta,
} from './edit.js'

export {
  CATALOG_STORAGE_KEY,
  createEmptyWorkflow,
  deleteWorkflow,
  getFromCatalog,
  loadCatalog,
  parseCatalog,
  resetCatalogToFixtures,
  resolveCatalog,
  saveCatalog,
  seedCatalog,
  serializeCatalog,
  upsertWorkflow,
  type CatalogResolve,
  type WorkflowCatalog,
} from './catalog.js'

/** IR v2 (nested DAG + validation) — see `./v2/VALIDATION.md` */
export * as workflowsV2 from './v2/index.js'
