import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp } from 'ink';
import type { MoxxyEvent, PendingToolCall, PermissionContext, PermissionDecision } from '@moxxy/sdk';
import { runTurn, type Session } from '@moxxy/core';
import { ChatView } from './components/ChatView.js';
import { PromptInput } from './components/PromptInput.js';
import { PermissionDialog } from './components/PermissionDialog.js';
import { StatusBar } from './components/StatusBar.js';
import { Spinner } from './components/Spinner.js';
import { Logo } from './components/Logo.js';
import { SessionInfo } from './components/SessionInfo.js';
import { BUILTIN_SLASH_COMMANDS } from './components/SlashCommands.js';
import { estimateContextTokens } from './context-estimate.js';

export interface InteractiveSessionProps {
  readonly session: Session;
  readonly registerInteractiveResolver: (
    prompt: (call: PendingToolCall, ctx: PermissionContext) => Promise<PermissionDecision>,
  ) => void;
  readonly model?: string;
}

export const InteractiveSession: React.FC<InteractiveSessionProps> = ({
  session,
  registerInteractiveResolver,
  model,
}) => {
  const { exit } = useApp();
  const [events, setEvents] = useState<ReadonlyArray<MoxxyEvent>>([]);
  const [streamingDelta, setStreamingDelta] = useState('');
  const [busy, setBusy] = useState(false);
  const [systemNotice, setSystemNotice] = useState<string | null>(null);
  const [pendingPermission, setPendingPermission] = useState<{
    call: PendingToolCall;
    ctx: PermissionContext;
    resolve: (d: PermissionDecision) => void;
  } | null>(null);
  const streamingBufferRef = useRef('');

  useEffect(() => {
    const unsub = session.log.subscribe((event) => {
      setEvents((prev) => [...prev, event]);
      if (event.type === 'assistant_chunk') {
        streamingBufferRef.current += event.delta;
        setStreamingDelta(streamingBufferRef.current);
      }
      if (event.type === 'assistant_message') {
        streamingBufferRef.current = '';
        setStreamingDelta('');
      }
    });

    registerInteractiveResolver(async (call, ctx) => {
      return new Promise<PermissionDecision>((resolve) => {
        setPendingPermission({ call, ctx, resolve });
      });
    });

    return () => unsub();
  }, [session, registerInteractiveResolver]);

  // Snapshot the session's stable session metadata for the header table.
  const providerName = session.providers.getActiveName() ?? '(none)';
  const activeModel =
    model ?? (() => {
      try {
        return session.providers.getActive().models[0]?.id ?? 'default';
      } catch {
        return 'default';
      }
    })();
  // Look up the active model's context window from its ModelDescriptor —
  // need this for the percentage meter on the status bar. The active
  // ModelDescriptor isn't tracked centrally, so we match by id on the
  // active provider's `models` list.
  const contextWindow = (() => {
    try {
      const provider = session.providers.getActive();
      const match = provider.models.find((m) => m.id === activeModel);
      return match?.contextWindow ?? provider.models[0]?.contextWindow ?? null;
    } catch {
      return null;
    }
  })();
  // Re-estimate every render. estimateContextTokens is char-cheap so
  // this stays well under a millisecond even on busy logs.
  const contextUsed = estimateContextTokens(session.log);

  const loopName = (() => {
    try {
      return session.loops.getActive().name;
    } catch {
      return '(none)';
    }
  })();
  const toolCount = session.tools.list().length;
  const skillCount = session.skills.list().length;
  const pluginCount = session.pluginHost.list().length;

  const runSlash = (cmd: string): void => {
    const [head] = cmd.split(/\s+/);
    switch (head) {
      case '/exit':
      case '/quit':
      case '/q':
        exit();
        return;
      case '/clear':
        setEvents([]);
        setStreamingDelta('');
        streamingBufferRef.current = '';
        setSystemNotice('chat scrollback cleared (events still in the log)');
        return;
      case '/tools':
        setSystemNotice(
          session.tools
            .list()
            .map((t) => `${t.name}  — ${t.description}`)
            .join('\n') || '(no tools registered)',
        );
        return;
      case '/skills':
        setSystemNotice(
          session.skills
            .list()
            .map((s) => `${s.frontmatter.name}  — ${s.frontmatter.description}`)
            .join('\n') || '(no skills discovered)',
        );
        return;
      case '/model':
        setSystemNotice(`provider: ${providerName}   model: ${activeModel}`);
        return;
      case '/help':
        setSystemNotice(
          BUILTIN_SLASH_COMMANDS.map((c) => `/${c.name}  — ${c.description}`).join('\n'),
        );
        return;
      default:
        setSystemNotice(`unknown command: ${cmd}   (try /help)`);
        return;
    }
  };

  const handleSubmit = async (text: string): Promise<void> => {
    setSystemNotice(null);
    if (text.startsWith('/')) {
      runSlash(text);
      return;
    }
    setBusy(true);
    streamingBufferRef.current = '';
    setStreamingDelta('');
    try {
      for await (const _event of runTurn(session, text, model ? { model } : {})) {
        void _event;
      }
    } catch (err) {
      // surfaced via error events; nothing extra to do
      void err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column">
      <Logo />
      <SessionInfo
        loop={loopName}
        toolCount={toolCount}
        skillCount={skillCount}
        pluginCount={pluginCount}
      />
      <Box marginBottom={1}>
        <Text dimColor>type / for commands · /exit to quit</Text>
      </Box>
      <ChatView events={events} streamingDelta={streamingDelta} />
      {systemNotice ? (
        <Box marginTop={1} marginBottom={1} flexDirection="column">
          {systemNotice.split('\n').map((line, i) => (
            <Text key={i} color="yellow">{line}</Text>
          ))}
        </Box>
      ) : null}
      {busy ? (
        <Box marginTop={1}>
          <Spinner label="thinking…" color="yellow" />
        </Box>
      ) : null}
      {pendingPermission ? (
        <PermissionDialog
          call={pendingPermission.call}
          toolDescription={session.tools.get(pendingPermission.call.name)?.description}
          onDecide={(decision) => {
            const { resolve } = pendingPermission;
            setPendingPermission(null);
            resolve(decision);
          }}
        />
      ) : (
        <PromptInput
          onSubmit={handleSubmit}
          disabled={busy}
          placeholder={busy ? '' : 'type a prompt or / for commands'}
        />
      )}
      <StatusBar
        provider={providerName}
        model={activeModel}
        contextUsed={contextUsed}
        contextWindow={contextWindow ?? undefined}
      />
    </Box>
  );
};
