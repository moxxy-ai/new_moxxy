/**
 * Workspace file browser in the right context rail.
 *
 * Lazy-loads one directory at a time via the workspace.listDir IPC.
 * Clicking a folder expands it inline; clicking a file inserts its
 * path as an `@<relative-path>` reference at the composer's cursor
 * (broadcast via a custom DOM event the Composer listens to).
 *
 * Defaults to the active workspace's cwd. Hidden + heavy directories
 * (node_modules, .git, dist, …) are filtered server-side.
 */

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Icon } from '@/lib/Icon';

interface Entry {
  readonly name: string;
  readonly kind: 'file' | 'dir';
}

interface DirNode {
  readonly path: string;
  readonly entries: ReadonlyArray<Entry>;
  readonly loading: boolean;
  readonly error: string | null;
}

export const FILE_INSERT_EVENT = 'moxxy:insert-path';

/** Broadcast a path so the Composer can append it to the current
 *  draft. Plain DOM event keeps the wiring decoupled from React refs
 *  / context. The composer attaches a single window listener. */
export function emitInsertPath(relPath: string): void {
  const ev = new CustomEvent(FILE_INSERT_EVENT, { detail: { path: relPath } });
  window.dispatchEvent(ev);
}

export function WorkspaceFiles({
  workspaceId,
}: {
  readonly workspaceId: string;
}): JSX.Element {
  const [nodes, setNodes] = useState<Record<string, DirNode>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(['.']));

  const load = useCallback(
    async (relPath: string): Promise<void> => {
      setNodes((cur) => ({
        ...cur,
        [relPath]: {
          path: relPath,
          entries: cur[relPath]?.entries ?? [],
          loading: true,
          error: null,
        },
      }));
      try {
        const result = await api().invoke('workspace.listDir', {
          workspaceId,
          path: relPath === '.' ? undefined : relPath,
        });
        setNodes((cur) => ({
          ...cur,
          [relPath]: {
            path: relPath,
            entries: result.entries,
            loading: false,
            error: null,
          },
        }));
      } catch (e) {
        setNodes((cur) => ({
          ...cur,
          [relPath]: {
            path: relPath,
            entries: cur[relPath]?.entries ?? [],
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          },
        }));
      }
    },
    [workspaceId],
  );

  // Always load the root on mount + when workspace changes.
  useEffect(() => {
    setNodes({});
    setExpanded(new Set(['.']));
    void load('.');
  }, [workspaceId, load]);

  const toggle = (relPath: string): void => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(relPath)) {
        next.delete(relPath);
      } else {
        next.add(relPath);
        if (!nodes[relPath]) void load(relPath);
      }
      return next;
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <DirRow path="." level={0} expanded={expanded} nodes={nodes} onToggle={toggle} />
    </div>
  );
}

function DirRow({
  path,
  level,
  expanded,
  nodes,
  onToggle,
}: {
  readonly path: string;
  readonly level: number;
  readonly expanded: ReadonlySet<string>;
  readonly nodes: Record<string, DirNode>;
  readonly onToggle: (path: string) => void;
}): JSX.Element {
  const node = nodes[path];
  const open = expanded.has(path);
  return (
    <>
      {path !== '.' && (
        <Row
          icon={
            <Icon
              name="chevron-right"
              size={11}
              style={{
                transform: open ? 'rotate(90deg)' : 'none',
                transition: 'transform 120ms ease',
              }}
            />
          }
          name={path.split('/').pop() ?? path}
          level={level}
          onClick={() => onToggle(path)}
          kind="dir"
        />
      )}
      {open && (
        <>
          {node?.loading && node.entries.length === 0 && (
            <LoadingRow level={level + 1} />
          )}
          {node?.error && (
            <ErrorRow message={node.error} level={level + 1} />
          )}
          {node?.entries.map((entry) => {
            const child = path === '.' ? entry.name : `${path}/${entry.name}`;
            if (entry.kind === 'dir') {
              return (
                <DirRow
                  key={child}
                  path={child}
                  level={path === '.' ? 0 : level + 1}
                  expanded={expanded}
                  nodes={nodes}
                  onToggle={onToggle}
                />
              );
            }
            return (
              <FileRow
                key={child}
                name={entry.name}
                path={child}
                level={path === '.' ? 0 : level + 1}
              />
            );
          })}
        </>
      )}
    </>
  );
}

function FileRow({
  name,
  path,
  level,
}: {
  readonly name: string;
  readonly path: string;
  readonly level: number;
}): JSX.Element {
  return (
    <Row
      icon={<Icon name="copy" size={11} />}
      name={name}
      level={level}
      kind="file"
      title={path}
      onClick={() => emitInsertPath(path)}
    />
  );
}

function Row({
  icon,
  name,
  level,
  onClick,
  kind,
  title,
}: {
  readonly icon: React.ReactNode;
  readonly name: string;
  readonly level: number;
  readonly onClick: () => void;
  readonly kind: 'file' | 'dir';
  readonly title?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="row-button"
      title={title ?? name}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        width: '100%',
        padding: '4px 6px',
        paddingLeft: 6 + level * 12,
        borderRadius: 6,
        fontSize: 12,
        color: kind === 'dir' ? 'var(--color-text)' : 'var(--color-text-muted)',
        fontWeight: kind === 'dir' ? 600 : 500,
        textAlign: 'left',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 14,
          color: kind === 'dir' ? 'var(--color-primary-strong)' : 'var(--color-text-dim)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {icon}
      </span>
      <span
        className={kind === 'file' ? 'mono' : undefined}
        style={{
          flex: 1,
          minWidth: 0,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {name}
      </span>
    </button>
  );
}

function LoadingRow({ level }: { readonly level: number }): JSX.Element {
  return (
    <div
      style={{
        padding: '4px 6px',
        paddingLeft: 6 + level * 12,
        fontSize: 11,
        color: 'var(--color-text-dim)',
        fontStyle: 'italic',
      }}
    >
      Loading…
    </div>
  );
}

function ErrorRow({
  message,
  level,
}: {
  readonly message: string;
  readonly level: number;
}): JSX.Element {
  return (
    <div
      role="alert"
      title={message}
      style={{
        padding: '4px 6px',
        paddingLeft: 6 + level * 12,
        fontSize: 11,
        color: 'var(--color-red)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {message}
    </div>
  );
}
