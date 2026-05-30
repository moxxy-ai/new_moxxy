/**
 * `@moxxy/plugin-workflows` — a swappable DAG engine that chains
 * skills/prompts/tools into saved, parameterized, schedulable/event-triggered
 * pipelines. Registered statically by the CLI via `buildWorkflowsPlugin`.
 */

export {
  validateWorkflow,
  parseWorkflowYaml,
  serializeWorkflow,
  workflowSchema,
  SLUG_RE,
  type WorkflowParseResult,
} from './schema.js';

export {
  discoverWorkflows,
  defaultUserWorkflowsDir,
  defaultProjectWorkflowsDir,
  type DiscoveredWorkflow,
  type WorkflowScope,
  type WorkflowLogger,
  type WorkflowLoadOptions,
} from './loader.js';

export {
  WorkflowStore,
  type WorkflowStoreOptions,
  type EditableScope,
} from './store.js';

export {
  renderTemplate,
  renderArgs,
  evalCondition,
  validateCondition,
  ConditionSyntaxError,
  type TemplateScope,
  type RenderOptions,
} from './template.js';

export { dagExecutor, DAG_EXECUTOR_NAME, resumeWorkflowRun } from './executor/dag.js';
export { runWorkflow, defaultRunRecordDir, type RunWorkflowOptions } from './engine.js';
export { WorkflowRunStore, defaultWorkflowRunStore, type WorkflowRunCheckpoint } from './run-store.js';
export {
  buildSystemPrompt,
  draftWorkflow,
  type DraftCatalogEntry,
  type DraftWorkflowOptions,
  type DraftedWorkflow,
} from './draft.js';
export {
  buildWorkflowTools,
  buildRunDeps,
  WORKFLOWS_PLUGIN_NAME,
  type WorkflowToolDeps,
} from './tools.js';
export { buildWorkflowsCommand, type WorkflowCommandDeps } from './command.js';
export { buildWorkflowsPlugin, type BuildWorkflowsPluginOptions } from './plugin.js';
export { BUILTIN_WORKFLOWS_DIR } from './paths.js';
