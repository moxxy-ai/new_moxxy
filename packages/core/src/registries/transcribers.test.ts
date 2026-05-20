import { describe, expect, it } from 'vitest';
import { defineTranscriber } from '@moxxy/sdk';
import { TranscriberRegistry } from './transcribers.js';

const fake = (name: string, echo = '') =>
  defineTranscriber({
    name,
    createClient: (cfg) => ({
      name,
      transcribe: async () => ({ text: String(cfg.echo ?? echo) }),
    }),
  });

describe('TranscriberRegistry', () => {
  it('registers, lists, and looks up', () => {
    const reg = new TranscriberRegistry();
    reg.register(fake('whisper'));
    expect(reg.has('whisper')).toBe(true);
    expect(reg.list()).toHaveLength(1);
  });

  it('rejects duplicate registration', () => {
    const reg = new TranscriberRegistry();
    const t = fake('whisper');
    reg.register(t);
    expect(() => reg.register(t)).toThrow(/already registered/);
  });

  it('setActive instantiates lazily and getActive returns the instance', async () => {
    const reg = new TranscriberRegistry();
    reg.register(fake('whisper'));
    expect(reg.getActiveName()).toBeNull();
    const inst = reg.setActive('whisper', { echo: 'hello' });
    expect(reg.getActiveName()).toBe('whisper');
    expect(reg.getActive()).toBe(inst);
    const out = await inst.transcribe(new Uint8Array());
    expect(out.text).toBe('hello');
  });

  it('tryGetActive returns null without an active one', () => {
    const reg = new TranscriberRegistry();
    expect(reg.tryGetActive()).toBeNull();
    expect(() => reg.getActive()).toThrow(/No active transcriber/);
  });

  it('unregister clears active when it matches', () => {
    const reg = new TranscriberRegistry();
    reg.register(fake('whisper'));
    reg.setActive('whisper');
    reg.unregister('whisper');
    expect(reg.getActiveName()).toBeNull();
    expect(reg.tryGetActive()).toBeNull();
  });

  it('setActive throws for unknown name', () => {
    const reg = new TranscriberRegistry();
    expect(() => reg.setActive('nope')).toThrow(/not registered/);
  });

  it('replace overwrites def and drops cached instance', () => {
    const reg = new TranscriberRegistry();
    reg.register(fake('whisper', 'old'));
    reg.setActive('whisper');
    reg.replace(fake('whisper', 'new'));
    const inst = reg.setActive('whisper');
    return inst.transcribe(new Uint8Array()).then((r) => {
      expect(r.text).toBe('new');
    });
  });
});
