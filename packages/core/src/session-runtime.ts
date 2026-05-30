import type {
  AppContext,
  ApprovalResolver,
  CacheStrategyDef,
  CompactorDef,
  ElisionSettings,
  HookDispatcher,
  LLMProvider,
  ModeDef,
  PermissionResolver,
  PluginHostHandle,
  SessionId,
  SkillRegistry,
  TurnId,
} from '@moxxy/sdk';

import type { EventLog } from './events/log.js';
// The concrete `Session` carries core's own richer tool registry (extra
// methods the SDK surface doesn't model); use it here so consumers like
// `buildFilteredToolRegistry` keep type-checking.
import type { ToolRegistry } from './registries/tools.js';

/**
 * The slice of the concrete `Session` that the turn driver (`run-turn.ts`)
 * and the subagent runtime (`subagents/spawn.ts`, `subagents/events.ts`)
 * actually consume. Those modules depend on *this* interface rather than
 * importing the `Session` class directly.
 *
 * Why: `session.ts` value-imports `runTurn`, so if `run-turn.ts` (and the
 * subagent modules it pulls in) imported the `Session` class back, the
 * package would have an import cycle — flagged by `pnpm check:deps` because
 * dependency-cruiser tracks type-only edges (`tsPreCompilationDeps`). Routing
 * through this leaf contract keeps the value graph a DAG
 * (`session → run-turn → subagents → spawn → events`) with no edges pointing
 * back at `session.ts`.
 *
 * `Session implements SessionRuntime`, so the contract can't silently drift
 * from the class it abstracts.
 */
export interface SessionRuntime {
  readonly id: SessionId;
  readonly log: EventLog;
  readonly signal: AbortSignal;
  readonly tools: ToolRegistry;
  readonly skills: SkillRegistry;
  readonly providers: { getActive(): LLMProvider };
  readonly modes: {
    getActive(): ModeDef;
    list(): ReadonlyArray<ModeDef>;
    /** Post-turn mode hand-off (BMAD → tool-use). Throws on an unknown name;
     *  run-turn guards the call. */
    setActive(name: string): void;
  };
  readonly compactors: { getActive(): CompactorDef | null };
  readonly cacheStrategies: { getActive(): CacheStrategyDef | null };
  readonly resolver: PermissionResolver;
  readonly approvalResolver: ApprovalResolver | null;
  readonly elisionSettings: ElisionSettings | null;
  readonly lazyTools: boolean;
  readonly dispatcher: HookDispatcher;
  readonly pluginHost: PluginHostHandle;
  startTurn(): { turnId: TurnId };
  appContext(): AppContext;
}
