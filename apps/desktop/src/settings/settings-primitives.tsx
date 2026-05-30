/**
 * Shared list primitives for the settings tabs. Providers / MCP / Vault speak
 * one list language — a leading icon Tile, a name + status subtitle in a
 * flexible middle column, and a right-aligned StatusDot / Switch / Badge — so
 * every row lines up on the same grid. Section wraps a tab in its TabHeader +
 * optional search; CardList / Row render the rows; SearchBox / EmptyState are
 * the surrounding chrome.
 */

import { Icon } from '@/lib/Icon';
import { TabHeader } from './TabHeader';

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly placeholder: string;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 9,
        padding: '9px 12px',
        background: '#fff',
        border: '1px solid var(--color-card-border)',
        borderRadius: 10,
      }}
    >
      <Icon name="search" size={15} style={{ color: 'var(--color-text-dim)', flexShrink: 0 }} />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          border: 'none',
          outline: 'none',
          background: 'transparent',
          fontSize: 13,
          color: 'var(--color-text)',
        }}
      />
    </div>
  );
}

export function Section({
  title,
  count,
  description,
  actions,
  search,
  children,
}: {
  readonly title: string;
  readonly count?: number;
  readonly description?: string;
  readonly actions?: React.ReactNode;
  readonly search?: React.ReactNode;
  readonly children: React.ReactNode;
}): JSX.Element {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <TabHeader
        title={title}
        {...(count !== undefined ? { count } : {})}
        {...(description ? { description } : {})}
        {...(actions ? { actions } : {})}
      />
      {search}
      {children}
    </section>
  );
}

export function CardList({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return (
    <ul
      role="list"
      style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {children}
    </ul>
  );
}

export function Row({
  tile,
  title,
  subtitle,
  trailing,
  mono,
  testId,
}: {
  readonly tile: React.ReactNode;
  readonly title: string;
  readonly subtitle?: string;
  readonly trailing?: React.ReactNode;
  readonly mono?: boolean;
  readonly testId?: string;
}): JSX.Element {
  return (
    <li
      {...(testId ? { 'data-testid': testId } : {})}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '13px 16px',
        background: 'var(--color-card-bg)',
        border: '1px solid var(--color-card-border)',
        borderRadius: 14,
      }}
    >
      {tile}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          className={mono ? 'mono' : undefined}
          style={{
            fontSize: 14,
            fontWeight: 600,
            color: 'var(--color-text)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {title}
        </div>
        {subtitle && (
          <div style={{ marginTop: 2, fontSize: 12, color: 'var(--color-text-dim)' }}>{subtitle}</div>
        )}
      </div>
      {trailing}
    </li>
  );
}

export function Tile({
  children,
  bg,
  fg,
}: {
  readonly children: React.ReactNode;
  readonly bg: string;
  readonly fg: string;
}): JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        width: 38,
        height: 38,
        flexShrink: 0,
        borderRadius: 11,
        background: bg,
        color: fg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 15,
        fontWeight: 700,
      }}
    >
      {children}
    </span>
  );
}

export function StatusDot({
  ok,
  okLabel,
  offLabel,
}: {
  readonly ok: boolean;
  readonly okLabel: string;
  readonly offLabel: string;
}): JSX.Element {
  return (
    <span
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        fontSize: 12.5,
        fontWeight: 600,
        color: ok ? 'var(--color-text-muted)' : 'var(--color-text-dim)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: ok ? 'var(--color-green)' : 'var(--color-card-border-strong)',
          boxShadow: ok ? '0 0 0 3px rgba(16, 185, 129, 0.16)' : 'none',
        }}
      />
      {ok ? okLabel : offLabel}
    </span>
  );
}

/** iOS-style toggle — the MCP attach/detach control. */
export function Switch({
  on,
  onClick,
  label,
}: {
  readonly on: boolean;
  readonly onClick: () => void;
  readonly label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onClick}
      style={{
        flexShrink: 0,
        width: 42,
        height: 24,
        padding: 2,
        borderRadius: 999,
        background: on ? 'var(--color-primary)' : 'var(--color-card-border-strong)',
        display: 'inline-flex',
        alignItems: 'center',
        transition: 'background 160ms ease',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 2px rgba(15, 23, 42, 0.35)',
          transform: on ? 'translateX(18px)' : 'translateX(0)',
          transition: 'transform 160ms ease',
        }}
      />
    </button>
  );
}

export function Badge({ children }: { readonly children: React.ReactNode }): JSX.Element {
  return (
    <span
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        padding: '3px 9px',
        borderRadius: 999,
        background: 'rgba(148, 163, 184, 0.16)',
        color: 'var(--color-text-muted)',
      }}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  icon,
  text,
}: {
  readonly icon: Parameters<typeof Icon>[0]['name'];
  readonly text: string;
}): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
        padding: '44px 20px',
        border: '1px dashed var(--color-card-border)',
        borderRadius: 14,
        color: 'var(--color-text-dim)',
      }}
    >
      <Icon name={icon} size={22} />
      <p style={{ margin: 0, fontSize: 13 }}>{text}</p>
    </div>
  );
}
