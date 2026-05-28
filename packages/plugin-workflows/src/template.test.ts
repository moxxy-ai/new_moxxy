import { describe, expect, it } from 'vitest';
import { evalCondition, renderArgs, renderTemplate, validateCondition, type TemplateScope } from './template.js';

const scope: TemplateScope = {
  steps: { fetch: { output: 'AAPL up 3%' }, empty: { output: '   ' } },
  inputs: { watchlist: ['AAPL', 'MSFT'], region: 'US' },
  trigger: 'schedule',
  now: '2026-05-28T08:00:00Z',
  vars: { mood: 'bullish' },
};

describe('renderTemplate', () => {
  it('substitutes step / input / trigger / now / vars refs', () => {
    expect(renderTemplate('news: {{ steps.fetch.output }}', scope)).toBe('news: AAPL up 3%');
    expect(renderTemplate('{{ inputs.region }}', scope)).toBe('US');
    expect(renderTemplate('{{ trigger }} @ {{ now }}', scope)).toBe('schedule @ 2026-05-28T08:00:00Z');
    expect(renderTemplate('{{ vars.mood }}', scope)).toBe('bullish');
  });

  it('JSON-stringifies non-string values', () => {
    expect(renderTemplate('{{ inputs.watchlist }}', scope)).toBe('["AAPL","MSFT"]');
  });

  it('renders unknown refs as empty string', () => {
    expect(renderTemplate('x{{ steps.missing.output }}y', scope)).toBe('xy');
    expect(renderTemplate('x{{ inputs.nope }}y', scope)).toBe('xy');
  });
});

describe('renderArgs', () => {
  it('deep-renders string leaves', () => {
    const out = renderArgs({ to: 'me', body: '{{ steps.fetch.output }}', nested: { x: ['{{ inputs.region }}'] } }, scope);
    expect(out).toEqual({ to: 'me', body: 'AAPL up 3%', nested: { x: ['US'] } });
  });
});

describe('evalCondition', () => {
  it('handles contains / == / !=', () => {
    expect(evalCondition('{{ steps.fetch.output }} contains "AAPL"', scope)).toBe(true);
    expect(evalCondition('{{ steps.fetch.output }} contains "TSLA"', scope)).toBe(false);
    expect(evalCondition('{{ inputs.region }} == "US"', scope)).toBe(true);
    expect(evalCondition('{{ inputs.region }} != "EU"', scope)).toBe(true);
  });

  it('handles is empty / is not empty (whitespace-aware)', () => {
    expect(evalCondition('{{ steps.fetch.output }} is not empty', scope)).toBe(true);
    expect(evalCondition('{{ steps.empty.output }} is empty', scope)).toBe(true);
    expect(evalCondition('{{ steps.missing.output }} is empty', scope)).toBe(true);
  });

  it('handles and / or with correct precedence', () => {
    expect(evalCondition('{{ inputs.region }} == "US" and {{ steps.fetch.output }} contains "AAPL"', scope)).toBe(true);
    expect(evalCondition('{{ inputs.region }} == "EU" and {{ steps.fetch.output }} contains "AAPL"', scope)).toBe(false);
    expect(evalCondition('{{ inputs.region }} == "EU" or {{ steps.fetch.output }} contains "AAPL"', scope)).toBe(true);
  });

  it('accepts a bare (non-{{}}) ref on the LHS', () => {
    expect(evalCondition('steps.fetch.output contains "AAPL"', scope)).toBe(true);
  });

  it('throws on malformed syntax', () => {
    expect(() => evalCondition('nonsense here', scope)).toThrow();
  });
});

describe('validateCondition', () => {
  it('returns null for valid, a message for invalid', () => {
    expect(validateCondition('{{ steps.x.output }} is empty')).toBeNull();
    expect(validateCondition('blah blah')).toMatch(/unrecognized/);
    expect(validateCondition('')).toMatch(/empty condition/);
  });
});
