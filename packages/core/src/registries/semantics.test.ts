import { describe, expect, it } from 'vitest';
import type { CompactorDef, ModeDef, ProviderDef } from '@moxxy/sdk';
import { ProviderRegistry } from './providers.js';
import { ModeRegistry } from './modes.js';
import { CompactorRegistry } from './compactors.js';
import { SkillRegistryImpl } from './skills.js';

/**
 * PR3-1 regression suite: every registry behaves the same way on
 * duplicate register (throws), exposes an explicit `replace()`, and
 * has predictable active-slot behavior on unregister.
 */

const fakeProvider = (name: string): ProviderDef => ({
  name,
  models: [],
  createClient: () => ({ name, models: [], stream: async function* () {}, countTokens: async () => 0 }),
});
const fakeLoop = (name: string): ModeDef => ({ name, run: async function* () {} });
const fakeCompactor = (name: string): CompactorDef => ({
  name,
  shouldCompact: () => false,
  compact: async () => ({}) as never,
});

describe('Registry consistency (PR3-1)', () => {
  it('ProviderRegistry: throws on duplicate, replace() overrides + drops cached instance', () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider('a'));
    expect(() => r.register(fakeProvider('a'))).toThrow(/already registered/);

    r.setActive('a'); // caches an instance
    r.replace(fakeProvider('a'));
    // Replacing should drop the old instance so the new createClient runs on next setActive
    let constructed = 0;
    r.replace({
      name: 'a',
      models: [],
      createClient: () => {
        constructed++;
        return { name: 'a', models: [], stream: async function* () {}, countTokens: async () => 0 };
      },
    });
    r.setActive('a');
    expect(constructed).toBe(1);
  });

  it('ProviderRegistry: unregister clears active', () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider('a'));
    r.setActive('a');
    r.unregister('a');
    expect(r.getActiveName()).toBeNull();
  });

  it('ModeRegistry: throws on duplicate, auto-activates first, unregister clears active', () => {
    const r = new ModeRegistry();
    r.register(fakeLoop('first'));
    r.register(fakeLoop('second'));
    expect(() => r.register(fakeLoop('first'))).toThrow(/already registered/);
    expect(r.getActive().name).toBe('first');

    r.unregister('first');
    // Don't silently pick "second" — caller must setActive explicitly.
    expect(() => r.getActive()).toThrow(/no active/i);

    r.setActive('second');
    expect(r.getActive().name).toBe('second');
  });

  it('CompactorRegistry: throws on duplicate, auto-activates first, unregister clears active', () => {
    const r = new CompactorRegistry();
    r.register(fakeCompactor('first'));
    r.register(fakeCompactor('second'));
    expect(() => r.register(fakeCompactor('first'))).toThrow(/already registered/);
    expect(r.getActive()?.name).toBe('first');

    r.unregister('first');
    // getActive returns null after the active is gone (no arbitrary fallback).
    expect(r.getActive()).toBeNull();
  });

  it('SkillRegistryImpl: throws on duplicate id, replace() overrides', () => {
    const r = new SkillRegistryImpl();
    const skill = {
      id: 'project/foo' as never,
      path: '/a.md',
      scope: 'project' as const,
      frontmatter: { name: 'foo', description: 'd' },
      body: 'one',
    };
    r.register(skill);
    expect(() => r.register(skill)).toThrow(/already registered/);
    r.replace({ ...skill, body: 'two' });
    expect(r.get('project/foo' as never)?.body).toBe('two');
  });
});
