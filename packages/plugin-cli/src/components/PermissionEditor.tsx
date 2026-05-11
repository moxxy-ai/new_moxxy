import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { PermissionEngine } from '@moxxy/core';

export interface PermissionEditorProps {
  readonly policyPath: string;
}

interface Row {
  readonly kind: 'deny' | 'allow';
  readonly name: string;
  readonly reason?: string;
}

type Mode =
  | { kind: 'list' }
  | { kind: 'add'; buffer: string; bucket: 'allow' | 'deny' }
  | { kind: 'confirm-delete'; row: Row }
  | { kind: 'message'; text: string };

export const PermissionEditor: React.FC<PermissionEditorProps> = ({ policyPath }) => {
  const { exit } = useApp();
  const [engine, setEngine] = useState<PermissionEngine | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [status, setStatus] = useState<string>('');

  // Initial load
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const e = await PermissionEngine.load(policyPath);
      if (cancelled) return;
      setEngine(e);
      setRows(toRows(e));
    })();
    return () => {
      cancelled = true;
    };
  }, [policyPath]);

  const refresh = (e: PermissionEngine): void => {
    const next = toRows(e);
    setRows(next);
    if (cursor >= next.length) setCursor(Math.max(0, next.length - 1));
  };

  useInput((input, key) => {
    if (mode.kind === 'message') {
      setMode({ kind: 'list' });
      return;
    }

    if (mode.kind === 'add') {
      if (key.escape) {
        setMode({ kind: 'list' });
        return;
      }
      if (key.return) {
        const name = mode.buffer.trim();
        if (!name || !engine) {
          setMode({ kind: 'list' });
          return;
        }
        const promise =
          mode.bucket === 'allow'
            ? engine.addAllow({ name, action: 'allow' })
            : engine.addDeny({ name, action: 'deny' });
        void promise.then(() => {
          refresh(engine);
          setDirty(true);
          setMode({ kind: 'message', text: `added ${mode.bucket}: ${name}` });
          setStatus('saved');
        });
        return;
      }
      if (key.backspace || key.delete) {
        setMode({ ...mode, buffer: mode.buffer.slice(0, -1) });
        return;
      }
      if (!key.ctrl && !key.meta && input && input.length === 1) {
        setMode({ ...mode, buffer: mode.buffer + input });
      }
      return;
    }

    if (mode.kind === 'confirm-delete') {
      if (input === 'y' || key.return) {
        if (!engine) {
          setMode({ kind: 'list' });
          return;
        }
        void engine.removeByName(mode.row.name).then(() => {
          refresh(engine);
          setDirty(true);
          setMode({ kind: 'message', text: `removed: ${mode.row.name}` });
          setStatus('saved');
        });
        return;
      }
      setMode({ kind: 'list' });
      return;
    }

    // list mode
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(rows.length - 1, c + 1));
      return;
    }
    if (input === 'd' || key.delete) {
      const row = rows[cursor];
      if (row) setMode({ kind: 'confirm-delete', row });
      return;
    }
    if (input === 'a') {
      setMode({ kind: 'add', buffer: '', bucket: 'allow' });
      return;
    }
    if (input === 'D') {
      setMode({ kind: 'add', buffer: '', bucket: 'deny' });
      return;
    }
    if (input === ' ' || key.return) {
      // Toggle: remove + re-add with the opposite kind.
      const row = rows[cursor];
      if (!row || !engine) return;
      const targetKind: 'allow' | 'deny' = row.kind === 'allow' ? 'deny' : 'allow';
      void (async () => {
        await engine.removeByName(row.name);
        if (targetKind === 'allow') {
          await engine.addAllow({
            name: row.name,
            action: 'allow',
            ...(row.reason ? { reason: row.reason } : {}),
          });
        } else {
          await engine.addDeny({
            name: row.name,
            action: 'deny',
            ...(row.reason ? { reason: row.reason } : {}),
          });
        }
        refresh(engine);
        setDirty(true);
        setStatus(`flipped ${row.name} → ${targetKind}`);
      })();
      return;
    }
    if (input === 'q' || (key.ctrl && input === 'c')) {
      exit();
    }
  });

  const visible = useMemo(() => rows, [rows]);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="magenta">moxxy perms editor</Text>
        <Text dimColor>  ({policyPath})</Text>
      </Box>

      {visible.length === 0 ? (
        <Text dimColor>(no rules — press `a` to add an allow rule, `D` for deny)</Text>
      ) : (
        visible.map((row, i) => {
          const focused = i === cursor;
          return (
            <Box key={`${row.kind}:${row.name}:${i}`}>
              <Text color={focused ? 'cyan' : undefined}>{focused ? '› ' : '  '}</Text>
              <Text color={row.kind === 'allow' ? 'green' : 'red'}>{row.kind.padEnd(5)}</Text>
              <Text>  {row.name}</Text>
              {row.reason ? <Text dimColor>  — {row.reason}</Text> : null}
            </Box>
          );
        })
      )}

      <Box marginTop={1}>
        {mode.kind === 'add' ? (
          <Text>
            new {mode.bucket} rule: <Text color="cyan">{mode.buffer}</Text>
            <Text dimColor> (enter to confirm, esc to cancel)</Text>
          </Text>
        ) : mode.kind === 'confirm-delete' ? (
          <Text color="yellow">delete `{mode.row.name}` ({mode.row.kind})? [y/N]</Text>
        ) : mode.kind === 'message' ? (
          <Text color="green">{mode.text}  (press any key)</Text>
        ) : (
          <Text dimColor>
            ↑/↓ move · space/enter flip · a add allow · D add deny · d delete · q quit
            {dirty ? <Text color="green">  · {status}</Text> : null}
          </Text>
        )}
      </Box>
    </Box>
  );
};

function toRows(engine: PermissionEngine): Row[] {
  const snap = engine.policySnapshot;
  const out: Row[] = [];
  for (const r of snap.deny) out.push({ kind: 'deny', name: r.name, reason: r.reason });
  for (const r of snap.allow) out.push({ kind: 'allow', name: r.name, reason: r.reason });
  return out;
}
