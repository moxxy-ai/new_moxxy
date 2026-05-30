import type {
  MoxxyRequirement,
  RequirementCheck,
  RequirementIssue,
  RequirementKind,
  RequirementState,
  AgentDef,
  ChannelDef,
  CommandDef,
  CompactorDef,
  ModeDef,
  ProviderDef,
  ToolDef,
  TranscriberDef,
} from '@moxxy/sdk';

export interface RequirementChecker {
  check(requirements: ReadonlyArray<MoxxyRequirement> | undefined): RequirementCheck;
}

export interface RequirementRegistryOptions {
  readonly tools: {
    get(name: string): ToolDef | undefined;
  };
  readonly providers: {
    list(): ReadonlyArray<ProviderDef>;
    getActiveName(): string | null;
  };
  readonly modes: {
    list(): ReadonlyArray<ModeDef>;
    getActive(): ModeDef;
  };
  readonly compactors: {
    list(): ReadonlyArray<CompactorDef>;
    getActive(): CompactorDef | null;
  };
  readonly channels: {
    get(name: string): ChannelDef | undefined;
  };
  readonly agents: {
    get(name: string): AgentDef | undefined;
  };
  readonly commands: {
    get(name: string): CommandDef | undefined;
  };
  readonly transcribers: {
    list(): ReadonlyArray<TranscriberDef>;
    getActiveName(): string | null;
  };
}

export function formatRequirementIssues(check: RequirementCheck): string {
  return check.issues
    .filter((issue) => !issue.requirement.optional)
    .map((issue) => issue.message)
    .join('; ');
}

interface RegisteredPlugin {
  readonly name: string;
  readonly version: string;
}

interface TargetInfo {
  readonly kind: RequirementKind;
  readonly name: string;
  readonly version?: string;
  readonly active: boolean;
}

export class RequirementRegistry {
  private readonly runtime = new Map<string, RequirementState>();
  private readonly plugins = new Map<string, RegisteredPlugin>();

  constructor(private readonly opts: RequirementRegistryOptions) {}

  registerPlugin(name: string, version: string): void {
    this.plugins.set(name, { name, version });
  }

  unregisterPlugin(name: string): void {
    this.plugins.delete(name);
  }

  setRuntime(name: string, state: RequirementState = 'ready'): void {
    this.runtime.set(name, state);
  }

  clearRuntime(name: string): void {
    this.runtime.delete(name);
  }

  check(requirements: ReadonlyArray<MoxxyRequirement> | undefined): RequirementCheck {
    const issues: RequirementIssue[] = [];
    for (const requirement of requirements ?? []) {
      const issue = this.checkOne(requirement);
      if (issue) issues.push(issue);
    }
    const blocking = issues.filter((issue) => !issue.requirement.optional);
    return { ready: blocking.length === 0, issues };
  }

  /**
   * Convenience: check whether a single named target is present and (if
   * its kind has an active/inactive distinction) currently active.
   * Equivalent to `check([{ kind, name, state: 'active' }])`.
   */
  isReady(kind: RequirementKind, name: string): RequirementCheck {
    return this.check([{ kind, name, state: 'active' }]);
  }

  private checkOne(requirement: MoxxyRequirement): RequirementIssue | null {
    if (requirement.kind === 'runtime') return this.checkRuntime(requirement);

    const target = this.targetInfo(requirement.kind, requirement.name);
    if (!target) {
      return issue(requirement, 'missing', `Required ${label(requirement.kind)} is not registered: ${requirement.name}`);
    }

    if (requirement.version && target.version !== requirement.version) {
      return issue(
        requirement,
        'version_mismatch',
        `Required ${label(requirement.kind)} has version ${target.version ?? '(unknown)'}, expected ${requirement.version}: ${requirement.name}`,
      );
    }

    const state = requirement.state ?? 'registered';
    if ((state === 'active' || state === 'ready') && !target.active) {
      return issue(requirement, 'inactive', `Required ${label(requirement.kind)} is not active: ${requirement.name}`);
    }

    return null;
  }

  private checkRuntime(requirement: MoxxyRequirement): RequirementIssue | null {
    const state = requirement.state ?? 'ready';
    const actual = this.runtime.get(requirement.name);
    if (actual !== state) {
      return issue(requirement, 'not_ready', `Required runtime is not ready: ${requirement.name}`);
    }
    return null;
  }

  private targetInfo(kind: RequirementKind, name: string): TargetInfo | null {
    switch (kind) {
      case 'plugin': {
        const plugin = this.plugins.get(name);
        return plugin ? { kind, name, version: plugin.version, active: true } : null;
      }
      case 'provider': {
        const def = this.opts.providers.list().find((p) => p.name === name);
        return def
          ? { kind, name, active: this.opts.providers.getActiveName() === name }
          : null;
      }
      case 'tool': {
        const def = this.opts.tools.get(name);
        return def ? { kind, name, active: true } : null;
      }
      case 'transcriber': {
        const def = this.opts.transcribers.list().find((t) => t.name === name);
        return def
          ? { kind, name, active: this.opts.transcribers.getActiveName() === name }
          : null;
      }
      case 'mode': {
        const def = this.opts.modes.list().find((m) => m.name === name);
        return def ? { kind, name, active: activeModeName(this.opts.modes) === name } : null;
      }
      case 'compactor': {
        const def = this.opts.compactors.list().find((c) => c.name === name);
        return def ? { kind, name, active: this.opts.compactors.getActive()?.name === name } : null;
      }
      case 'channel': {
        const def = this.opts.channels.get(name);
        return def ? { kind, name, active: true } : null;
      }
      case 'agent': {
        const def = this.opts.agents.get(name);
        return def ? { kind, name, active: true } : null;
      }
      case 'command': {
        const def = this.opts.commands.get(name);
        return def ? { kind, name, active: true } : null;
      }
      case 'runtime':
        return null;
    }
  }
}

function issue(
  requirement: MoxxyRequirement,
  code: RequirementIssue['code'],
  message: string,
): RequirementIssue {
  return {
    requirement,
    code,
    message,
    ...(requirement.hint ? { hint: requirement.hint } : {}),
  };
}

function label(kind: RequirementKind): string {
  return kind;
}

function activeModeName(modes: RequirementRegistryOptions['modes']): string | null {
  try {
    return modes.getActive().name;
  } catch {
    return null;
  }
}
