import React, { useEffect } from 'react';
import { Text, useInput } from 'ink';
import type { PendingToolCall, PermissionDecision } from '@moxxy/sdk';
import { Colors } from '../theme.js';
import { Modal } from './Modal.js';

export interface PermissionDialogProps {
  readonly call: PendingToolCall;
  readonly toolDescription?: string;
  /**
   * How many additional requests are queued behind this one. Parallel
   * subagents can each request permission concurrently — surfacing the
   * depth tells the user they're about to make N decisions back-to-back.
   */
  readonly queueDepth?: number;
  readonly onDecide: (decision: PermissionDecision) => void;
}

export const PermissionDialog: React.FC<PermissionDialogProps> = ({
  call,
  toolDescription,
  queueDepth = 0,
  onDecide,
}) => {
  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === 'y' || key.return) onDecide({ mode: 'allow' });
    else if (ch === 'a') onDecide({ mode: 'allow_session' });
    else if (ch === 'p') onDecide({ mode: 'allow_always' });
    else if (ch === 'n' || key.escape) onDecide({ mode: 'deny', reason: 'user declined' });
  });

  useEffect(() => {
    // Auto-focus the dialog by capturing input on mount; useInput handles it.
  }, []);

  const title =
    queueDepth > 0
      ? `Tool permission requested (${queueDepth} more queued)`
      : 'Tool permission requested';
  return (
    <Modal title={title} hints="y allow · a session · p always · n deny">
      <Text>
        Tool: <Text bold>{call.name}</Text>
        {toolDescription ? <Text dimColor> — {toolDescription}</Text> : null}
      </Text>
      <Text dimColor>Input: {JSON.stringify(call.input).slice(0, 200)}</Text>
      <Text>
        <Text>[y]</Text>
        <Text dimColor> allow once · </Text>
        <Text>[a]</Text>
        <Text dimColor> allow session · </Text>
        <Text>[p]</Text>
        <Text dimColor> always · </Text>
        <Text color={Colors.danger}>[n]</Text>
        <Text dimColor> deny</Text>
      </Text>
    </Modal>
  );
};
