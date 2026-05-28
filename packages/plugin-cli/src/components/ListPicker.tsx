import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { Colors } from '../theme.js';
import { Modal, type ModalTab } from './Modal.js';

export interface ListPickerOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly group?: string;
  readonly current?: boolean;
  /**
   * When set, renders as a small colored tag after the label
   * (e.g. "not connected"). Use `badgeColor` to override the default.
   */
  readonly badge?: string;
  readonly badgeColor?: 'red' | 'yellow' | 'green' | 'gray' | 'cyan';
}

export interface ListPickerTab {
  readonly id: string;
  readonly label: string;
  readonly options: ReadonlyArray<ListPickerOption>;
}

export interface ListPickerProps {
  readonly title: string;
  /**
   * Flat option list. Use this for single-list pickers (mode, mcp).
   * Mutually exclusive with `tabs`.
   */
  readonly options?: ReadonlyArray<ListPickerOption>;
  /**
   * Tabbed picker — one tab per group of options (e.g. one tab per
   * provider in /model). ←/→ flips tabs. Each tab keeps its own
   * search query and cursor independently from the others.
   */
  readonly tabs?: ReadonlyArray<ListPickerTab>;
  /** Tab id to focus first. Falls back to the tab containing a
   *  `current` option, otherwise the first tab. */
  readonly initialTabId?: string;
  /**
   * When true, an inline search input filters the visible options by
   * label / description / group, case-insensitive. Search query
   * resets on tab change so each tab feels like a fresh sub-view.
   */
  readonly searchable?: boolean;
  readonly searchPlaceholder?: string;
  readonly onSelect: (id: string) => void;
  readonly onCancel: () => void;
}

/**
 * Generic up/down + enter picker. Used by /model, /mode, /mcp.
 *
 * Two modes:
 *  - Flat: pass `options` directly. Renders one scrollable list.
 *  - Tabbed: pass `tabs` (provider tabs in /model). The Modal header
 *    carries the tab strip; ←/→ cycles tabs; each tab has its own
 *    search query and cursor.
 *
 * Esc / Ctrl+C cancel. Search is owned by this component so adding it
 * doesn't require every consumer to re-implement the keymap.
 */
export const ListPicker: React.FC<ListPickerProps> = ({
  title,
  options,
  tabs,
  initialTabId,
  searchable,
  searchPlaceholder,
  onSelect,
  onCancel,
}) => {
  const hasTabs = !!(tabs && tabs.length > 0);

  // Tabbed mode: track active tab. The initial focus prefers the
  // caller's `initialTabId`, then the tab that owns the `current`
  // option, then the first tab.
  const defaultTabId = useMemo(() => {
    if (!hasTabs) return undefined;
    if (initialTabId && tabs!.some((t) => t.id === initialTabId)) return initialTabId;
    const tabWithCurrent = tabs!.find((t) => t.options.some((o) => o.current));
    return (tabWithCurrent ?? tabs![0]!).id;
  }, [hasTabs, initialTabId, tabs]);

  const [activeTabId, setActiveTabId] = useState<string | undefined>(defaultTabId);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);

  const activeTab = useMemo(
    () => (hasTabs ? tabs!.find((t) => t.id === activeTabId) ?? tabs![0]! : null),
    [hasTabs, tabs, activeTabId],
  );

  const sourceOptions = activeTab ? activeTab.options : options ?? [];

  // Filter the source options by the current query. We match against
  // label, description, and group — broad enough that typing "haiku"
  // surfaces both the model id and provider grouping that mention it.
  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return sourceOptions;
    const q = query.trim().toLowerCase();
    return sourceOptions.filter((o) => {
      if (o.label.toLowerCase().includes(q)) return true;
      if (o.description?.toLowerCase().includes(q)) return true;
      if (o.group?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [searchable, query, sourceOptions]);

  // On tab change, reset query + cursor so the new tab feels like a
  // fresh slate. Also keep cursor in range if `filtered` shrinks.
  useEffect(() => {
    setQuery('');
    setCursor(0);
  }, [activeTabId]);
  useEffect(() => {
    if (cursor >= filtered.length) setCursor(Math.max(0, filtered.length - 1));
  }, [filtered.length, cursor]);

  // Default the cursor to the `current` option on first render so the
  // user lands on their active choice instead of the top of the list.
  // Only fires when the source set first arrives (not on every query
  // update) to avoid stomping the cursor as the user types.
  useEffect(() => {
    if (query) return;
    const idx = filtered.findIndex((o) => o.current);
    if (idx > 0) setCursor(idx);
    // Intentionally narrow deps: react when the tab or source set
    // changes, not on every keystroke (which would stomp the cursor
    // as the user types). `query` and `filtered` are read but
    // omitted on purpose.
  }, [activeTabId, sourceOptions]);

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => Math.min(Math.max(0, filtered.length - 1), c + 1));
      return;
    }
    if (key.return) {
      const picked = filtered[cursor];
      if (picked) onSelect(picked.id);
      return;
    }
    if (hasTabs && (key.leftArrow || key.rightArrow)) {
      // Tab nav is owned by Modal when onTabChange is wired below;
      // returning early here keeps the cursor untouched even though
      // Ink also delivers ←/→ to this hook.
      return;
    }
    if (!searchable) return;
    // Search input — accept printable chars + backspace + Ctrl+U
    // (clear). Modifier-bearing chords are ignored so Ctrl+C above can
    // still cancel without leaving "c" in the query.
    if (key.ctrl && input === 'u') {
      setQuery('');
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      return;
    }
    if (key.ctrl || key.meta || !input) return;
    // Printable characters (Ink hands us the raw codepoint).
    if (input.length === 1 && input.charCodeAt(0) >= 32) {
      setQuery((q) => q + input);
    }
  });

  const { stdout } = useStdout();
  const termRows = stdout?.rows ?? 24;
  // Reserve rows for modal chrome (3-row header band, search box,
  // hints, borders, status line, body margins). Floor at 4 visible
  // rows so very small terminals still show something.
  const chromeRows = searchable ? 18 : 16;
  const maxVisible = Math.max(4, Math.min(filtered.length, termRows - chromeRows));

  let start = 0;
  if (filtered.length > maxVisible) {
    const half = Math.floor(maxVisible / 2);
    start = Math.min(Math.max(0, cursor - half), Math.max(0, filtered.length - maxVisible));
  }
  const end = Math.min(filtered.length, start + maxVisible);
  const moreAbove = start;
  const moreBelow = filtered.length - end;

  const subtitle =
    filtered.length === 0
      ? query
        ? `no matches for "${query}"`
        : 'no options'
      : `${cursor + 1} of ${filtered.length}` +
        (searchable && query ? ` · filtered from ${sourceOptions.length}` : '');

  const hints = buildHints(searchable, hasTabs);

  const modalTabs: ReadonlyArray<ModalTab> | undefined = hasTabs
    ? tabs!.map((t) => ({ id: t.id, label: t.label }))
    : undefined;

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      hints={hints}
      {...(modalTabs ? { tabs: modalTabs, activeTabId, onTabChange: setActiveTabId } : {})}
    >
      {searchable ? (
        <SearchBar query={query} placeholder={searchPlaceholder ?? 'type to filter'} />
      ) : null}
      <Box flexDirection="column">
        {filtered.length === 0 ? (
          <Text dimColor>
            {query ? `(no options match "${query}")` : '(no options)'}
          </Text>
        ) : null}
        {moreAbove > 0 ? <Text dimColor>{`  ↑ ${moreAbove} more`}</Text> : null}
        {filtered.slice(start, end).map((opt, idx) => {
          const i = start + idx;
          // In flat mode, surface group headers between sections. In
          // tabbed mode tabs already partition the view, so group
          // headers would be noise.
          const prevGroup = i > 0 ? filtered[i - 1]!.group : undefined;
          const showHeader = !hasTabs && opt.group != null && opt.group !== prevGroup;
          const focused = i === cursor;
          return (
            <React.Fragment key={opt.id}>
              {showHeader ? (
                <Box marginTop={idx === 0 ? 0 : 1}>
                  <Text dimColor>{opt.group}</Text>
                </Box>
              ) : null}
              <Box>
                <Text {...(focused ? {} : { dimColor: true })}>{focused ? '› ' : '  '}</Text>
                <Text {...(focused ? { bold: true } : {})}>{opt.label}</Text>
                {opt.current ? <Text dimColor>{' (current)'}</Text> : null}
                {opt.badge ? (
                  <Text color={opt.badgeColor === 'red' ? Colors.danger : (opt.badgeColor ?? Colors.danger)}>
                    {`  [${opt.badge}]`}
                  </Text>
                ) : null}
                {opt.description ? (
                  <Text dimColor>{`  — ${opt.description}`}</Text>
                ) : null}
              </Box>
            </React.Fragment>
          );
        })}
        {moreBelow > 0 ? <Text dimColor>{`  ↓ ${moreBelow} more`}</Text> : null}
      </Box>
    </Modal>
  );
};

const SearchBar: React.FC<{ query: string; placeholder: string }> = ({ query, placeholder }) => (
  <Box marginBottom={1}>
    <Text dimColor>{'/ '}</Text>
    {query ? <Text>{query}</Text> : <Text dimColor>{placeholder}</Text>}
    <Text>{'▌'}</Text>
  </Box>
);

function buildHints(searchable: boolean | undefined, hasTabs: boolean): string {
  const parts: string[] = ['↑↓ navigate', 'Enter select'];
  if (searchable) parts.push('type to filter');
  if (searchable) parts.push('Ctrl+U clear');
  if (hasTabs) parts.push('←/→ tabs');
  parts.push('Esc close');
  return parts.join(' · ');
}
