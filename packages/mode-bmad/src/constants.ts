import { asPluginId } from '@moxxy/sdk';

export const BMAD_MODE_NAME = 'bmad';

export const BMAD_PLUGIN_ID = asPluginId('@moxxy/mode-bmad');

/** Maximum redraft cycles allowed per phase before the loop bails. */
export const MAX_REDRAFTS_PER_PHASE = 3;

/** Refuse to execute plans with more stories than this — guards against runaways. */
export const MAX_STORIES = 12;

export type PhaseId = 'analysis' | 'planning' | 'solutioning';

export interface PhaseSpec {
  readonly id: PhaseId;
  readonly title: string;
  readonly persona: string;
  readonly system: string;
  readonly approvalTitle: string;
  readonly approvalKind: string;
  /** Max output tokens for the artifact — phases are short by design. */
  readonly maxTokens: number;
}

export interface Artifacts {
  analysis: string;
  planning: string;
  stories: ReadonlyArray<string>;
  solutioning: string;
}
