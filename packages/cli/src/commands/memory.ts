import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { MemoryStore, defaultMemoryDir, type MemoryEntry, type MemoryType } from '@moxxy/plugin-memory';
import type { ParsedArgv } from '../argv.js';
import { confirmedYes } from '../argv-helpers.js';
import { printError } from '../errors.js';
import { colors } from '../colors.js';

const HELP = `moxxy memory — view and curate long-term memory

  moxxy memory list                     short listing (name · type · description)
  moxxy memory audit [--type <t>]       full audit: size, dates, tags, grouped by type
  moxxy memory show <name>              print the body of a single entry
  moxxy memory revert <name>            delete a single entry
  moxxy memory prune-stale --days <n>   delete entries not updated in <n> days
  moxxy memory path                     print the memory directory
`;

export async function runMemoryCommand(argv: ParsedArgv): Promise<number> {
  const sub = argv.positional[0] ?? 'list';
  const store = new MemoryStore({ embedder: null });

  switch (sub) {
    case 'list': {
      const entries = await store.list();
      if (entries.length === 0) {
        process.stdout.write('(no memories)\n');
        return 0;
      }
      for (const e of entries) {
        process.stdout.write(`${e.frontmatter.name}\t${e.frontmatter.type}\t${e.frontmatter.description}\n`);
      }
      return 0;
    }
    case 'audit': {
      const filterType = (argv.flags.type ? String(argv.flags.type) : undefined) as MemoryType | undefined;
      const entries = await store.list(filterType);
      if (entries.length === 0) {
        process.stdout.write('(no memories)\n');
        return 0;
      }
      const stats = await Promise.all(entries.map(statOf));
      const byType = groupByType(stats);
      const totalSize = stats.reduce((sum, s) => sum + s.size, 0);
      process.stdout.write(
        `${colors.bold(String(entries.length))} memories · ${colors.cyan(formatSize(totalSize))} total\n`,
      );
      for (const [type, items] of byType) {
        process.stdout.write(`\n${colors.bold(colors.magenta('## ' + type))} ${colors.dim(`(${items.length})`)}\n`);
        for (const item of items) {
          const tags = item.entry.frontmatter.tags?.length
            ? colors.dim(`  [${item.entry.frontmatter.tags.join(', ')}]`)
            : '';
          process.stdout.write(
            `  ${item.entry.frontmatter.name.padEnd(36)} ${colors.cyan(formatSize(item.size).padStart(8))}  ${colors.dim('updated ' + formatRelative(item.updatedAt))}${tags}\n`,
          );
        }
      }
      return 0;
    }
    case 'show': {
      const name = argv.positional[1];
      if (!name) {
        printError('usage: moxxy memory show <name>');
        return 2;
      }
      const entry = await store.get(name);
      if (!entry) {
        printError(`not found: ${name}`);
        return 1;
      }
      process.stdout.write(`# ${entry.frontmatter.name}\n`);
      process.stdout.write(`type: ${entry.frontmatter.type}\n`);
      process.stdout.write(`description: ${entry.frontmatter.description}\n`);
      if (entry.frontmatter.tags?.length) {
        process.stdout.write(`tags: ${entry.frontmatter.tags.join(', ')}\n`);
      }
      process.stdout.write(`\n${entry.body}\n`);
      return 0;
    }
    case 'revert': {
      const name = argv.positional[1];
      if (!name) {
        printError('usage: moxxy memory revert <name>');
        return 2;
      }
      const removed = await store.forget(name);
      process.stdout.write(removed ? `removed ${name}\n` : `not found: ${name}\n`);
      return removed ? 0 : 1;
    }
    case 'prune-stale': {
      const days = Number(argv.flags.days ?? 90);
      if (!Number.isFinite(days) || days <= 0) {
        printError('--days <n> must be a positive number');
        return 2;
      }
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const entries = await store.list();
      const stats = await Promise.all(entries.map(statOf));
      const stale = stats.filter((s) => s.updatedAt.getTime() < cutoff);
      if (stale.length === 0) {
        process.stdout.write(`(no entries older than ${days}d)\n`);
        return 0;
      }
      if (!confirmedYes(argv)) {
        process.stdout.write(
          `would delete ${stale.length} stale entries (use --yes to confirm):\n`,
        );
        for (const s of stale) {
          process.stdout.write(`  ${s.entry.frontmatter.name}  updated ${formatRelative(s.updatedAt)}\n`);
        }
        return 0;
      }
      for (const s of stale) await store.forget(s.entry.frontmatter.name);
      process.stdout.write(`deleted ${stale.length} stale entries\n`);
      return 0;
    }
    case 'path': {
      process.stdout.write(defaultMemoryDir() + '\n');
      return 0;
    }
    default:
      printError(`unknown 'memory' subcommand: ${sub}\n${HELP}`);
      return 2;
  }
}

interface MemoryStat {
  readonly entry: MemoryEntry;
  readonly size: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

async function statOf(entry: MemoryEntry): Promise<MemoryStat> {
  const stat = await fs.stat(entry.path).catch(() => null);
  return {
    entry,
    size: stat?.size ?? entry.body.length,
    createdAt: new Date(entry.frontmatter.createdAt ?? stat?.birthtime ?? Date.now()),
    updatedAt: new Date(entry.frontmatter.updatedAt ?? stat?.mtime ?? Date.now()),
  };
}

function groupByType(stats: ReadonlyArray<MemoryStat>): ReadonlyArray<[MemoryType, MemoryStat[]]> {
  const order: MemoryType[] = ['fact', 'preference', 'project', 'reference'];
  const groups = new Map<MemoryType, MemoryStat[]>();
  for (const t of order) groups.set(t, []);
  for (const s of stats) {
    const list = groups.get(s.entry.frontmatter.type) ?? [];
    list.push(s);
    groups.set(s.entry.frontmatter.type, list);
  }
  return [...groups.entries()].filter(([, items]) => items.length > 0);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

void path;
