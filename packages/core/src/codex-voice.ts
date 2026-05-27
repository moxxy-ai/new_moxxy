import type { ClientSession, RequirementCheck, RequirementIssue, Transcriber } from '@moxxy/sdk';

export const CODEX_TRANSCRIBER_NAME = 'openai-codex-transcribe';
export const CODEX_VOICE_PROVIDER_NAME = 'openai-codex';
export const CODEX_AUTH_RUNTIME_NAME = 'auth:provider:openai-codex';

export function checkCodexTranscriptionReady(session: ClientSession): RequirementCheck {
  const check = session.requirements.check([
    { kind: 'transcriber', name: CODEX_TRANSCRIBER_NAME },
    { kind: 'provider', name: CODEX_VOICE_PROVIDER_NAME, state: 'active' },
    { kind: 'runtime', name: CODEX_AUTH_RUNTIME_NAME, state: 'ready' },
  ]);
  const activeName = session.transcribers.getActiveName();
  if (!activeName || activeName === CODEX_TRANSCRIBER_NAME) return check;

  const conflict: RequirementIssue = {
    requirement: {
      kind: 'transcriber',
      name: CODEX_TRANSCRIBER_NAME,
      state: 'active',
      hint: `Switch active transcriber to ${CODEX_TRANSCRIBER_NAME}.`,
    },
    code: 'inactive',
    message: `Required active transcriber ${CODEX_TRANSCRIBER_NAME}; active is ${activeName}`,
    hint: `Switch active transcriber to ${CODEX_TRANSCRIBER_NAME}.`,
  };
  return {
    ready: false,
    issues: [conflict, ...check.issues],
  };
}

export function resolveCodexTranscriber(session: ClientSession): Transcriber {
  const activeName = session.transcribers.getActiveName();
  if (activeName && activeName !== CODEX_TRANSCRIBER_NAME) {
    throw new Error(`Codex voice requires active transcriber ${CODEX_TRANSCRIBER_NAME}.`);
  }
  if (activeName === CODEX_TRANSCRIBER_NAME) return session.transcribers.getActive();
  if (session.transcribers.has(CODEX_TRANSCRIBER_NAME)) {
    return session.transcribers.setActive(CODEX_TRANSCRIBER_NAME);
  }
  throw new Error(
    `No speech-to-text backend is registered. Run \`moxxy login openai-codex\` and restart with the Codex STT plugin enabled.`,
  );
}

export function formatCodexTranscriptionReadiness(check: RequirementCheck): string {
  const issue = check.issues.find((i) => !i.requirement.optional) ?? check.issues[0];
  if (!issue) return 'Codex voice is unavailable';
  if (issue.requirement.kind === 'provider' && issue.requirement.name === CODEX_VOICE_PROVIDER_NAME) {
    return 'Codex voice requires active provider openai-codex';
  }
  if (issue.requirement.kind === 'runtime' && issue.requirement.name === CODEX_AUTH_RUNTIME_NAME) {
    return 'Run moxxy login openai-codex to enable Codex voice';
  }
  if (issue.requirement.kind === 'transcriber' && issue.code === 'inactive') {
    return `Codex voice requires active transcriber ${CODEX_TRANSCRIBER_NAME}`;
  }
  return issue.hint ?? issue.message;
}
