import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { moxxyHome } from '@moxxy/sdk';
import { mergeConfigs } from './merge.js';
import { moxxyConfigSchema, type MoxxyConfig } from './schema.js';

export interface LoadConfigOptions {
  readonly cwd: string;
  readonly explicitPath?: string;
  readonly skipUser?: boolean;
}

export interface LoadedConfig {
  readonly config: MoxxyConfig;
  readonly sources: ReadonlyArray<{ scope: 'project' | 'user' | 'explicit'; path: string }>;
}

const CONFIG_NAMES = [
  'moxxy.config.yaml',
  'moxxy.config.yml',
  'moxxy.config.ts',
  'moxxy.config.js',
  'moxxy.config.mjs',
  'moxxy.config.cjs',
];
const USER_CONFIG_NAMES = [
  'config.yaml',
  'config.yml',
  'config.ts',
  'config.js',
  'config.mjs',
  'config.cjs',
];
// Cap upward filesystem traversal when searching for a project config.
const MAX_CONFIG_SEARCH_DEPTH = 12;

export async function loadConfig(opts: LoadConfigOptions): Promise<LoadedConfig> {
  const sources: Array<{ scope: 'project' | 'user' | 'explicit'; path: string }> = [];
  const configs: MoxxyConfig[] = [];

  if (!opts.skipUser) {
    const userPath = await findFile(moxxyHome(), USER_CONFIG_NAMES);
    if (userPath) {
      const cfg = await loadOne(userPath);
      configs.push(cfg);
      sources.push({ scope: 'user', path: userPath });
    }
  }

  if (opts.explicitPath) {
    const cfg = await loadOne(opts.explicitPath);
    configs.push(cfg);
    sources.push({ scope: 'explicit', path: opts.explicitPath });
  } else {
    const projectPath = await findUpward(opts.cwd, CONFIG_NAMES);
    if (projectPath) {
      const cfg = await loadOne(projectPath);
      configs.push(cfg);
      sources.push({ scope: 'project', path: projectPath });
    }
  }

  return { config: mergeConfigs(...configs), sources };
}

async function loadOne(filePath: string): Promise<MoxxyConfig> {
  const ext = path.extname(filePath);
  let raw: unknown;

  if (ext === '.yaml' || ext === '.yml') {
    const yamlText = await fs.readFile(filePath, 'utf8');
    const yamlMod = (await import('yaml')) as { parse: (text: string) => unknown };
    raw = yamlMod.parse(yamlText);
    if (raw === null || raw === undefined) raw = {};
  } else {
    let mod: unknown;
    if (ext === '.ts' || ext === '.tsx') {
      const jiti = await getJiti(path.dirname(filePath));
      if (!jiti) throw new Error(`Cannot load ${filePath}: jiti is required for .ts configs.`);
      mod = jiti(filePath);
    } else {
      const url = `${pathToFileURL(filePath).href}?v=${Date.now()}`;
      mod = await import(url);
    }
    raw = extractDefault(mod);
    if (!raw) {
      throw new Error(`Config file ${filePath} must default-export the result of defineConfig().`);
    }
  }

  const parsed = moxxyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid moxxy config at ${filePath}:\n` + JSON.stringify(parsed.error.issues, null, 2),
    );
  }
  return parsed.data;
}

let cachedJiti: ((id: string) => unknown) | null = null;

type JitiFactory = (cwd: string, opts?: unknown) => (id: string) => unknown;

async function getJiti(cwd: string): Promise<((id: string) => unknown) | null> {
  if (cachedJiti) return cachedJiti;
  try {
    const mod = await import('jiti');
    const factory =
      (mod as { createJiti?: JitiFactory; default?: JitiFactory }).createJiti ??
      (mod as { default?: JitiFactory }).default;
    if (!factory) return null;
    cachedJiti = factory(cwd, { interopDefault: true });
    return cachedJiti;
  } catch {
    return null;
  }
}

function extractDefault(mod: unknown): unknown {
  if (!mod) return undefined;
  if (typeof mod !== 'object') return undefined;
  const m = mod as Record<string, unknown>;
  if (m.default && typeof m.default === 'object') return m.default;
  return undefined;
}

async function findUpward(startDir: string, names: ReadonlyArray<string>): Promise<string | null> {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < MAX_CONFIG_SEARCH_DEPTH; i++) {
    const found = await findFile(cursor, names);
    if (found) return found;
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

async function findFile(dir: string, names: ReadonlyArray<string>): Promise<string | null> {
  for (const name of names) {
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
}
