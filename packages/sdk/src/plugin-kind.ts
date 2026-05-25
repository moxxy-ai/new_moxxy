export const PLUGIN_KINDS = [
  'tools',
  'provider',
  'mode',
  'compactor',
  'cache-strategy',
  'view-renderer',
  'tunnel-provider',
  'mcp',
  'cli',
  'channel',
  'hooks',
  'agent',
  'command',
  'transcriber',
  'embedder',
  'isolator',
  'workflow-executor',
  'ui',
] as const;

export type PluginKind = (typeof PLUGIN_KINDS)[number];

export interface PluginKindCarrier {
  readonly kind?: PluginKind | ReadonlyArray<PluginKind>;
}

export function pluginKindList(kind: PluginKindCarrier['kind']): ReadonlyArray<PluginKind> {
  if (!kind) return [];
  return typeof kind === 'string' ? [kind] : kind;
}

export function isPureUiPluginManifest(manifest: PluginKindCarrier): boolean {
  const kinds = pluginKindList(manifest.kind);
  return kinds.length === 1 && kinds[0] === 'ui';
}
