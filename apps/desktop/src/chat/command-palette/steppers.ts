/**
 * Pure helpers for the actions palette: the per-action arg schemas,
 * shell-style arg quoting, and the friendly-label humanizer. No React,
 * no IPC — kept dependency-free so the palette container and the args
 * form can both pull from one place.
 */

import type { ArgStep } from './types';

/** Args schemas for known multi-arg actions. Adding more is one entry. */
const COMMAND_STEPPERS: Record<string, ReadonlyArray<ArgStep>> = {
  'vault set': [
    { label: 'Vault key', placeholder: 'OPENAI_API_KEY', help: 'The env-var name the agent looks up.' },
    { label: 'Value', placeholder: 'sk-…', secret: true, help: 'Stored encrypted in the vault.' },
  ],
  'vault remove': [{ label: 'Vault key', placeholder: 'OPENAI_API_KEY' }],
  'vault get': [{ label: 'Vault key', placeholder: 'OPENAI_API_KEY' }],
  'provider use': [{ label: 'Provider name', placeholder: 'anthropic' }],
  'mode use': [{ label: 'Mode name', placeholder: 'tool-use' }],
};

export function stepsForCommand(commandName: string): ReadonlyArray<ArgStep> {
  const exact = COMMAND_STEPPERS[commandName];
  if (exact) return exact;
  for (const [k, v] of Object.entries(COMMAND_STEPPERS)) {
    if (commandName.startsWith(`${k} `) || k.startsWith(`${commandName} `)) return v;
  }
  return [];
}

export function quote(v: string): string {
  if (/^[A-Za-z0-9_\-./@]+$/.test(v)) return v;
  return `"${v.replace(/"/g, '\\"')}"`;
}

/** Convert "vault set" / "mode use" → "Vault set" / "Mode use" for
 *  the user-facing label. The runner registers these with terminal
 *  syntax that doesn't read well in a friendly action picker. */
export function humanize(name: string): string {
  return name
    .split(' ')
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}
