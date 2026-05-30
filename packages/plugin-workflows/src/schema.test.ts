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

  it('accepts and preserves UI layout metadata for the visual builder', () => {
    const r = parseWorkflowYaml(`
name: visual-flow
description: Edited in the Office workflow builder.
ui:
  layout:
    nodes:
      fetch:
        x: 120
        y: 80
      summarize:
        x: 420
        y: 160
    viewport:
      x: -40
      y: 12
      zoom: 0.85
steps:
  - id: fetch
    tool: web_fetch
    args: { url: "https://example.test" }
  - id: summarize
    needs: [fetch]
    prompt: "Summarize {{ steps.fetch.output }}"
`);

    expect(r.ok).toBe(true);
    expect(r.workflow!.ui?.layout.nodes.fetch).toEqual({ x: 120, y: 80 });
    expect(r.workflow!.ui?.layout.viewport).toEqual({ x: -40, y: 12, zoom: 0.85 });

    const reparsed = parseWorkflowYaml(serializeWorkflow(r.workflow!));
    expect(reparsed.ok).toBe(true);
    expect(reparsed.workflow!.ui?.layout.nodes.summarize).toEqual({ x: 420, y: 160 });
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

  it('accepts bridge, condition, and switch steps', () => {
    const r = validateWorkflow({
      name: 'logic-flow',
      description: 'x',
      steps: [
        { id: 'parse', bridge: 'extract vars.x' },
        {
          id: 'gate',
          needs: ['parse'],
          condition: 'if vars.x > 1',
          then: ['heavy'],
          else: ['light'],
        },
        { id: 'heavy', needs: ['gate'], prompt: 'h' },
        { id: 'light', needs: ['gate'], prompt: 'l' },
        {
          id: 'route',
          needs: ['parse'],
          switch: 'pick animal',
          cases: { pies: ['dog'], kot: ['cat'] },
          default: ['other'],
        },
        { id: 'dog', needs: ['route'], prompt: 'd' },
        { id: 'cat', needs: ['route'], prompt: 'c' },
        { id: 'other', needs: ['route'], prompt: 'o' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.workflow!.steps[1]!.then).toEqual(['heavy']);
  });

  it('rejects condition without then/else', () => {
    const r = validateWorkflow({
      name: 'bad-cond',
      description: 'x',
      steps: [{ id: 'g', condition: 'x' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/then|else/);
  });

  it('rejects unknown branch step references', () => {
    const r = validateWorkflow({
      name: 'bad-branch',
      description: 'x',
      steps: [
        { id: 'g', condition: 'x', then: ['ghost'], else: [] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/unknown branch step/);
  });
});
