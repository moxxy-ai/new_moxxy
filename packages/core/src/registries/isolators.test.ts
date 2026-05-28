import type { Isolator } from '@moxxy/sdk';
import { describe, expect, it } from 'vitest';
import { IsolatorRegistry } from './isolators.js';

function fakeIsolator(name: string): Isolator {
  return {
    name,
    strength: 'none',
    run: async (_call, bound, _caps) => bound(undefined),
  } as unknown as Isolator;
}

describe('IsolatorRegistry (core contribution collection)', () => {
  it('registers, looks up, lists, and unregisters by name', () => {
    const reg = new IsolatorRegistry();
    expect(reg.has('docker')).toBe(false);
    reg.register(fakeIsolator('docker'));
    expect(reg.has('docker')).toBe(true);
    expect(reg.get('docker')?.name).toBe('docker');
    expect(reg.list().map((i) => i.name)).toEqual(['docker']);
    reg.unregister('docker');
    expect(reg.has('docker')).toBe(false);
  });

  it('overwrites by name (an isolator may arrive via more than one path)', () => {
    const reg = new IsolatorRegistry();
    const first = fakeIsolator('worker');
    const second = fakeIsolator('worker');
    reg.register(first);
    reg.register(second);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get('worker')).toBe(second);
  });

  it('has no concept of an active isolator (selection stays with the security layer)', () => {
    const reg = new IsolatorRegistry();
    reg.register(fakeIsolator('wasm'));
    // The registry is a plain collection — merely registering never activates
    // anything; the security layer picks one by `security.isolator` config.
    expect('getActive' in reg).toBe(false);
    expect('setActive' in reg).toBe(false);
  });
});
