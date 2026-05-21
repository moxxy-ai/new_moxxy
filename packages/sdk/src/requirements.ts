export type RequirementKind =
  | 'plugin'
  | 'provider'
  | 'tool'
  | 'transcriber'
  | 'loop'
  | 'compactor'
  | 'channel'
  | 'agent'
  | 'command'
  | 'runtime';

export type RequirementState = 'registered' | 'active' | 'ready';

export interface MoxxyRequirement {
  readonly kind: RequirementKind;
  readonly name: string;
  readonly state?: RequirementState;
  readonly version?: string;
  readonly optional?: boolean;
  readonly reason?: string;
  readonly hint?: string;
}

export interface RequirementIssue {
  readonly requirement: MoxxyRequirement;
  readonly code: 'missing' | 'inactive' | 'not_ready' | 'version_mismatch';
  readonly message: string;
  readonly hint?: string;
}

export interface RequirementCheck {
  readonly ready: boolean;
  readonly issues: ReadonlyArray<RequirementIssue>;
}
