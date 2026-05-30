/**
 * MCP servers tab — Model Context Protocol servers the runner knows about.
 * Each Row's Switch reflects the LIVE attach state (`connected`), not the
 * persisted `enabled` flag, so toggling on enables+attaches and off detaches.
 */

import { Icon } from '@/lib/Icon';
import { Section, CardList, Row, Tile, Switch, EmptyState } from './settings-primitives';

export function McpTab({
  servers,
  onToggle,
  search,
}: {
  readonly servers: ReadonlyArray<{ name: string; enabled: boolean; connected: boolean }>;
  readonly onToggle: (name: string, enabled: boolean) => Promise<void>;
  readonly search?: React.ReactNode;
}): JSX.Element {
  return (
    <Section
      title="MCP servers"
      count={servers.length}
      description="Model Context Protocol servers. Toggle one on to attach its tools to the agent."
      search={search}
    >
      {servers.length === 0 ? (
        <EmptyState icon="plug" text="No MCP servers configured." />
      ) : (
        <CardList>
          {servers.map((srv) => (
            <Row
              key={srv.name}
              testId={`mcp-row-${srv.name}`}
              tile={
                <Tile bg="var(--color-primary-soft)" fg="var(--color-primary-strong)">
                  <Icon name="plug" size={18} />
                </Tile>
              }
              title={srv.name}
              subtitle={
                srv.connected
                  ? 'Connected · tools attached'
                  : srv.enabled
                    ? 'Enabled · not attached'
                    : 'Detached'
              }
              trailing={
                // The toggle reflects the LIVE attach state, not the persisted
                // `enabled` flag: detach only clears `connected`, so a switch
                // bound to `enabled` would stay on after disabling. On →
                // enableAndAttach, off → detach.
                <Switch
                  on={srv.connected}
                  label={`${srv.connected ? 'Disable' : 'Enable'} ${srv.name}`}
                  onClick={() => void onToggle(srv.name, !srv.connected)}
                />
              }
            />
          ))}
        </CardList>
      )}
    </Section>
  );
}
