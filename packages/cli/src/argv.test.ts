import { describe, expect, it } from 'vitest';
import { parseArgv } from './argv.js';

describe('parseArgv', () => {
  it('empty argv → tui command', () => {
    expect(parseArgv([])).toMatchObject({ command: 'tui' });
  });

  it('--office does not map to a built-in office command', () => {
    expect(parseArgv(['--office'])).toMatchObject({
      command: 'tui',
      flags: { office: true },
    });
  });

  it('-p alone maps to prompt command', () => {
    expect(parseArgv(['-p', 'hello'])).toMatchObject({
      command: 'prompt',
      flags: { p: 'hello' },
    });
  });

  it('--prompt maps to prompt command', () => {
    expect(parseArgv(['--prompt', 'hello'])).toMatchObject({
      command: 'prompt',
      flags: { prompt: 'hello' },
    });
  });

  it('explicit tui command', () => {
    expect(parseArgv(['tui'])).toMatchObject({ command: 'tui' });
  });

  it('skills new <name>', () => {
    expect(parseArgv(['skills', 'new', 'foo'])).toMatchObject({
      command: 'skills',
      positional: ['new', 'foo'],
    });
  });

  it('--key=value form', () => {
    expect(parseArgv(['-p', 'x', '--output-format=json'])).toMatchObject({
      flags: { 'output-format': 'json' },
    });
  });

  it('--flag without value is true', () => {
    expect(parseArgv(['-p', 'x', '--allow-all'])).toMatchObject({
      flags: { 'allow-all': true },
    });
  });

  it('--version maps to version command', () => {
    expect(parseArgv(['--version'])).toMatchObject({ command: 'version' });
  });

  it('captures argv after `--` as passthrough', () => {
    expect(
      parseArgv(['ui', 'open', 'virtual-office', '--port', '18000', '--', '--theme', 'dark', '-v']),
    ).toMatchObject({
      command: 'ui',
      positional: ['open', 'virtual-office'],
      flags: { port: '18000' },
      passthrough: ['--theme', 'dark', '-v'],
    });
  });

  it('passthrough is empty when no `--` separator is present', () => {
    expect(parseArgv(['ui', 'list']).passthrough).toEqual([]);
  });
});
