import { describe, expect, it } from 'vitest';
import { parseWorkflowYaml, serializeWorkflow, validateWorkflow } from './schema.js';

const VALID = `
name: stock-digest
description: Fetch news, analyze, email.
on:
  schedule: { cron: "0 8 * * 1-5" }
inputs:
  watchlist: { default: ["AAPL"] }
steps:
  - id: fetch_news
    skill: web-research
    input: "headlines"
  - id: analyze
    needs: [fetch_news]
    prompt: "Analyze {{ steps.fetch_news.output }}"
  - id: email
    needs: [analyze]
    when: "{{ steps.analyze.output }} is not empty"
    tool: gmail_send
    args: { to: "me", body: "{{ steps.analyze.output }}" }
`;

describe('workflow schema', () => {
  it('parses a valid workflow and applies defaults', () => {
    const r = parseWorkflowYaml(VALID);
    expect(r.ok).toBe(true);
    const wf = r.workflow!;
    expect(wf.name).toBe('stock-digest');
    expect(wf.version).toBe(1);
    expect(wf.enabled).toBe(true);
    expect(wf.concurrency).toBe(4);
    expect(wf.steps).toHaveLength(3);
    // step-level defaults
    expect(wf.steps[0]!.needs).toEqual([]);
    expect(wf.steps[0]!.onError).toBe('fail');
    expect(wf.steps[0]!.retries).toBe(0);
  });

  it('round-trips through serialize → parse', () => {
    const wf = parseWorkflowYaml(VALID).workflow!;
    const reparsed = parseWorkflowYaml(serializeWorkflow(wf));
    expect(reparsed.ok).toBe(true);
    expect(reparsed.workflow!.name).toBe(wf.name);
    expect(reparsed.workflow!.steps).toHaveLength(3);
  });

  it('rejects a cycle in `needs`', () => {
    const r = validateWorkflow({
      name: 'cyc',
      description: 'x',
      steps: [
        { id: 'a', prompt: 'a', needs: ['b'] },
        { id: 'b', prompt: 'b', needs: ['a'] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/cycle/);
  });

  it('rejects duplicate step ids', () => {
    const r = validateWorkflow({
      name: 'dup',
      description: 'x',
      steps: [
        { id: 'a', prompt: 'a' },
        { id: 'a', prompt: 'a2' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/duplicate step id/);
  });

  it('rejects a step with multiple actions', () => {
    const r = validateWorkflow({
      name: 'multi',
      description: 'x',
      steps: [{ id: 'a', prompt: 'a', skill: 'b' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/multiple actions/);
  });

  it('rejects a step with no action', () => {
    const r = validateWorkflow({
      name: 'none',
      description: 'x',
      steps: [{ id: 'a' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/exactly one action/);
  });

  it('rejects `needs` referencing an unknown step', () => {
    const r = validateWorkflow({
      name: 'unknown-need',
      description: 'x',
      steps: [{ id: 'a', prompt: 'a', needs: ['ghost'] }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/unknown step "ghost"/);
  });

  it('rejects an invalid `when` condition', () => {
    const r = validateWorkflow({
      name: 'bad-when',
      description: 'x',
      steps: [{ id: 'a', prompt: 'a', when: 'this is gibberish' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/invalid `when`/);
  });

  it('rejects a non-slug name', () => {
    const r = validateWorkflow({ name: 'Bad Name!', description: 'x', steps: [{ id: 'a', prompt: 'a' }] });
    expect(r.ok).toBe(false);
  });
});
