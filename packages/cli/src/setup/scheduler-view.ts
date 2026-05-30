import type {
  ScheduleCreateInput,
  ScheduleEntryView,
  ScheduleListOptions,
  SchedulerView,
  ScheduleUpdateInput,
} from '@moxxy/sdk';
import {
  nextFireTime,
  runSchedule,
  type ScheduleEntry,
  type SchedulePromptRunner,
  type ScheduleStore,
} from '@moxxy/plugin-scheduler';

export function buildSchedulerView({
  store,
  runner,
}: {
  readonly store: ScheduleStore;
  readonly runner: SchedulePromptRunner;
}): SchedulerView {
  const describe = (entry: ScheduleEntry): ScheduleEntryView => describeScheduleEntry(entry);
  const requireManual = async (id: string): Promise<ScheduleEntry | null> => {
    const entry = await store.get(id);
    if (!entry) return null;
    if (entry.source !== 'manual') {
      throw new Error('read_only_schedule');
    }
    return entry;
  };

  return {
    async list(options: ScheduleListOptions = {}) {
      const source = options.source ?? 'all';
      const includeDisabled = options.includeDisabled ?? true;
      const schedules = await store.list();
      return schedules
        .filter((entry) => source === 'all' || entry.source === source)
        .filter((entry) => includeDisabled || entry.enabled)
        .map(describe);
    },
    async create(input: ScheduleCreateInput) {
      const entry = await store.create(normalizeCreateInput(input));
      return describe(entry);
    },
    async update(id: string, input: ScheduleUpdateInput) {
      const entry = await requireManual(id);
      if (!entry) return null;
      const updated = await store.update(id, normalizeUpdateInput(input));
      return updated ? describe(updated) : null;
    },
    async setEnabled(id: string, enabled: boolean) {
      const entry = await requireManual(id);
      if (!entry) return null;
      const updated = await store.update(id, { enabled });
      return updated ? describe(updated) : null;
    },
    async delete(id: string) {
      const entry = await requireManual(id);
      if (!entry) return { ok: false };
      return { ok: await store.delete(id) };
    },
    async runNow(id: string) {
      const entry = await store.get(id);
      if (!entry) throw new Error('schedule_not_found');
      const outcome = await runSchedule(entry, runner, store);
      return {
        ok: outcome.ok,
        text: outcome.text,
        ...(outcome.inboxPath ? { inboxPath: outcome.inboxPath } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    },
  };
}

export function describeScheduleEntry(entry: ScheduleEntry): ScheduleEntryView {
  const next = nextFireMs(entry);
  return {
    id: entry.id,
    name: entry.name,
    prompt: entry.prompt,
    enabled: entry.enabled,
    source: entry.source,
    skillName: entry.skillName ?? null,
    workflowName: entry.workflowName ?? null,
    cron: entry.cron ?? null,
    runAt: entry.runAt ?? null,
    timeZone: entry.timeZone ?? null,
    channel: entry.channel ?? null,
    model: entry.model ?? null,
    createdAt: new Date(entry.createdAt).toISOString(),
    lastRunAt: entry.lastRunAt ? new Date(entry.lastRunAt).toISOString() : null,
    lastResult: entry.lastResult ?? null,
    lastError: entry.lastError ?? null,
    nextFireAt: next,
    nextFireIso: next ? new Date(next).toISOString() : null,
    editable: entry.source === 'manual',
    runnable: true,
  };
}

function normalizeCreateInput(input: ScheduleCreateInput): Parameters<ScheduleStore['create']>[0] {
  const normalized: Record<string, unknown> = {
    name: input.name,
    prompt: input.prompt,
    source: 'manual',
    enabled: input.enabled ?? true,
  };
  if (input.cron !== undefined && input.cron.trim()) normalized.cron = input.cron.trim();
  if (input.runAt !== undefined) normalized.runAt = normalizeRunAt(input.runAt);
  if (input.timeZone !== undefined && input.timeZone.trim()) normalized.timeZone = input.timeZone.trim();
  if (input.channel !== undefined && input.channel.trim()) normalized.channel = input.channel.trim();
  if (input.model !== undefined && input.model.trim()) normalized.model = input.model.trim();
  return normalized as Parameters<ScheduleStore['create']>[0];
}

function normalizeUpdateInput(input: ScheduleUpdateInput): Partial<ScheduleEntry> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.prompt !== undefined) patch.prompt = input.prompt;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if ('cron' in input) patch.cron = input.cron?.trim() || undefined;
  if ('runAt' in input) patch.runAt = input.runAt == null ? undefined : normalizeRunAt(input.runAt);
  if ('timeZone' in input) patch.timeZone = input.timeZone?.trim() || undefined;
  if ('channel' in input) patch.channel = input.channel?.trim() || undefined;
  if ('model' in input) patch.model = input.model?.trim() || undefined;
  return patch as Partial<ScheduleEntry>;
}

function normalizeRunAt(value: string | number): number {
  if (typeof value === 'number') return value;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`invalid runAt: ${value}`);
  return ms;
}

function nextFireMs(entry: ScheduleEntry): number | null {
  if (!entry.enabled) return null;
  if (entry.runAt && entry.runAt > Date.now()) return entry.runAt;
  if (!entry.cron) return null;
  return nextFireTime(entry.cron, new Date(), entry.timeZone)?.getTime() ?? null;
}
