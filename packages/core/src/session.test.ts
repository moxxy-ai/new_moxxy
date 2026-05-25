import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@moxxy/sdk';
import { Session } from './session.js';

describe('Session', () => {
  it('boots with sensible defaults', () => {
    const s = new Session({ cwd: '/tmp', silent: true });
    expect(s.id).toMatch(/^[0-9A-Z]+$/);
    expect(s.cwd).toBe('/tmp');
    expect(s.log.length).toBe(0);
    expect(s.signal.aborted).toBe(false);
  });

  it('abort flips signal', () => {
    const s = new Session({ cwd: '/tmp', silent: true });
    s.abort('test');
    expect(s.signal.aborted).toBe(true);
  });

  it('startTurn returns a fresh turn id', () => {
    const s = new Session({ cwd: '/tmp', silent: true });
    const t1 = s.startTurn().turnId;
    const t2 = s.startTurn().turnId;
    expect(t1).not.toBe(t2);
  });

  it('exposes an immutable appContext snapshot', () => {
    const s = new Session({ cwd: '/tmp', silent: true });
    const ctx = s.appContext();
    expect(ctx.sessionId).toBe(s.id);
    expect(ctx.cwd).toBe('/tmp');
    expect(ctx.log.length).toBe(0);
  });

  it('fans appended events out to plugin onEvent hooks', async () => {
    const s = new Session({ cwd: '/tmp', silent: true });
    const onEvent = vi.fn();
    s.pluginHost.registerStatic(
      definePlugin({
        name: 'observer',
        version: '0.0.0',
        hooks: { onEvent },
      }),
    );
    await s.log.append({
      type: 'user_prompt',
      sessionId: s.id,
      turnId: s.startTurn().turnId,
      source: 'user',
      text: 'hi',
    });
    expect(onEvent).toHaveBeenCalledTimes(1);
    const arg = onEvent.mock.calls[0]![0] as { type: string; text?: string };
    expect(arg.type).toBe('user_prompt');
    expect(arg.text).toBe('hi');
  });

  it('close() fires plugin onShutdown hooks and aborts the session', async () => {
    const s = new Session({ cwd: '/tmp', silent: true });
    const onShutdown = vi.fn();
    s.pluginHost.registerStatic(
      definePlugin({ name: 'p', version: '0.0.0', hooks: { onShutdown } }),
    );
    await s.close();
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(s.signal.aborted).toBe(true);
  });

  it('close() is idempotent', async () => {
    const s = new Session({ cwd: '/tmp', silent: true });
    const onShutdown = vi.fn();
    s.pluginHost.registerStatic(
      definePlugin({ name: 'p', version: '0.0.0', hooks: { onShutdown } }),
    );
    await s.close();
    await s.close();
    expect(onShutdown).toHaveBeenCalledTimes(1);
  });

  it('getInfo returns a serializable snapshot of the registries', () => {
    const s = new Session({ cwd: '/tmp', silent: true });
    const info = s.getInfo();
    expect(info.sessionId).toBe(s.id);
    expect(info.cwd).toBe('/tmp');
    // Bare session: nothing active yet, all lists empty, no transcriber.
    expect(info.activeProvider).toBeNull();
    expect(info.activeMode).toBeNull();
    expect(info.providers).toEqual([]);
    expect(info.modes).toEqual([]);
    expect(info.tools).toEqual([]);
    expect(info.commands).toEqual([]);
    expect(info.readyProviders).toEqual([]);
    expect(info.hasTranscriber).toBe(false);
    // The snapshot must survive a JSON round-trip (it crosses the wire).
    expect(JSON.parse(JSON.stringify(info))).toEqual(info);
  });

  it('exposes runTurn as a method (SessionLike conformance)', () => {
    const s = new Session({ cwd: '/tmp', silent: true });
    expect(typeof s.runTurn).toBe('function');
    expect(typeof s.getInfo).toBe('function');
  });
});
