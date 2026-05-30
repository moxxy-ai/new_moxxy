/**
 * Providers tab — the model providers the connected runner can route to. Each
 * provider is a Row with a deterministic colour-tinted initial Tile and a
 * ready/inactive StatusDot; add a provider's key in the vault to activate it.
 */

import type { useSettings } from '@/lib/useSettings';
import { Section, CardList, Row, Tile, StatusDot, EmptyState } from './settings-primitives';

export function ProvidersTab({
  providers,
  search,
}: {
  readonly providers: ReturnType<typeof useSettings>['providers'];
  readonly search?: React.ReactNode;
}): JSX.Element {
  return (
    <Section
      title="Providers"
      count={providers.length}
      description="Model providers the runner can route to. Add a provider's key in the vault to activate it."
      search={search}
    >
      {providers.length === 0 ? (
        <EmptyState icon="spark" text="No providers known to the connected runner." />
      ) : (
        <CardList>
          {providers.map((p) => {
            const { bg, fg } = tintFor(p.name);
            return (
              <Row
                key={p.name}
                tile={
                  <Tile bg={bg} fg={fg}>
                    {p.name.slice(0, 1).toUpperCase()}
                  </Tile>
                }
                title={p.name}
                subtitle={p.ready ? 'Active · credentials resolved' : 'Inactive · add a key to use'}
                trailing={<StatusDot ok={p.ready} okLabel="Ready" offLabel="Inactive" />}
              />
            );
          })}
        </CardList>
      )}
    </Section>
  );
}

/** Deterministic soft tint per provider name, so each tile is distinct
 *  but on-brand (pastel bg, saturated fg from the same hue). */
function tintFor(name: string): { bg: string; fg: string } {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return { bg: `hsl(${h} 72% 95%)`, fg: `hsl(${h} 55% 42%)` };
}
