import { describe, expect, it } from 'vitest';
import { renderYaml } from './setup-yaml.js';

const base = {
  apiKeys: {},
  primary: 'anthropic',
  model: 'claude-sonnet-4-6',
  mode: 'tool-use',
  embedder: 'tfidf',
};

describe('renderYaml', () => {
  it('renders a minimal single-provider config (anthropic + tfidf)', () => {
    const yaml = renderYaml({ ...base, providers: ['anthropic'] });
    expect(yaml).toContain('provider:');
    expect(yaml).toContain('name: anthropic');
    expect(yaml).toContain('model: claude-sonnet-4-6');
    expect(yaml).toContain('apiKey: ${vault:ANTHROPIC_API_KEY}');
    expect(yaml).toContain('mode: tool-use');
    // TF-IDF is the default — no embeddings block emitted.
    expect(yaml).not.toContain('embeddings:');
    // No fallbacks for single-provider setup.
    expect(yaml).not.toContain('fallbacks:');
  });

  it('emits fallbacks when multiple providers are selected, excluding the primary', () => {
    const yaml = renderYaml({
      ...base,
      providers: ['anthropic', 'openai'],
      primary: 'anthropic',
    });
    expect(yaml).toContain('fallbacks:');
    expect(yaml).toMatch(/- openai/);
    // Primary should NOT appear in the fallbacks list
    expect(yaml.split('fallbacks:')[1] ?? '').not.toContain('anthropic');
  });

  it('different primary inverts the fallback ordering', () => {
    const yaml = renderYaml({
      ...base,
      providers: ['anthropic', 'openai'],
      primary: 'openai',
    });
    expect(yaml).toContain('name: openai');
    expect(yaml).toContain('apiKey: ${vault:OPENAI_API_KEY}');
    expect(yaml).toMatch(/- anthropic/);
  });

  it('emits an embeddings block when embedder is not tfidf', () => {
    const yaml = renderYaml({ ...base, providers: ['anthropic'], embedder: 'openai' });
    expect(yaml).toContain('embeddings:');
    expect(yaml).toContain('provider: openai');
  });

  it('skips the model line when no model is selected', () => {
    const yaml = renderYaml({ ...base, providers: ['anthropic'], model: null });
    expect(yaml).not.toMatch(/^\s*model:/m);
    // Provider block still emitted
    expect(yaml).toContain('name: anthropic');
  });

  it('honors the chosen mode strategy', () => {
    const yaml = renderYaml({ ...base, providers: ['anthropic'], mode: 'plan-execute' });
    expect(yaml).toContain('mode: plan-execute');
  });

  it('output starts with a generator comment', () => {
    const yaml = renderYaml({ ...base, providers: ['anthropic'] });
    expect(yaml.startsWith('# moxxy.config.yaml')).toBe(true);
  });

  it('vault placeholder uses the canonical uppercase provider name', () => {
    const yaml = renderYaml({ ...base, providers: ['openai'], primary: 'openai' });
    expect(yaml).toContain('${vault:OPENAI_API_KEY}');
  });

  it('produces a config that parses as valid YAML', async () => {
    const yaml = renderYaml({
      ...base,
      providers: ['anthropic', 'openai'],
      embedder: 'transformers',
    });
    const yamlMod = (await import('yaml')) as typeof import('yaml');
    const parsed = yamlMod.parse(yaml);
    expect(parsed.provider.name).toBe('anthropic');
    expect(parsed.provider.fallbacks).toEqual(['openai']);
    expect(parsed.embeddings.provider).toBe('transformers');
    expect(parsed.mode).toBe('tool-use');
  });

  it('omits the apiKey vault line when the primary provider authenticates via OAuth', () => {
    const yaml = renderYaml({
      ...base,
      providers: ['openai-codex'],
      primary: 'openai-codex',
      model: null,
      authKinds: { 'openai-codex': 'oauth' },
    });
    expect(yaml).toContain('name: openai-codex');
    // OAuth providers persist tokens under a provider-specific vault key,
    // not a generic *_API_KEY entry — the config must not reference one.
    expect(yaml).not.toContain('apiKey:');
    expect(yaml).not.toContain('config:');
  });

  it('still emits apiKey for an API-key primary even when a fallback is OAuth', () => {
    const yaml = renderYaml({
      ...base,
      providers: ['anthropic', 'openai-codex'],
      primary: 'anthropic',
      authKinds: { 'openai-codex': 'oauth' },
    });
    expect(yaml).toContain('apiKey: ${vault:ANTHROPIC_API_KEY}');
    expect(yaml).toMatch(/- openai-codex/);
  });
});
