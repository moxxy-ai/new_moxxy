import React from 'react';
import { Box } from 'ink';
import type { ClientSession as Session } from '@moxxy/sdk';
import { PermissionDialog } from '../components/PermissionDialog.js';
import { ApprovalDialog } from '../components/ApprovalDialog.js';
import { InputBox } from '../components/InputBox.js';
import { ListPicker } from '../components/ListPicker.js';
import { QueueView } from '../components/QueueView.js';
import type { SlashCommand } from '../components/SlashCommands.js';
import type { ExternalInsert } from '../components/prompt/external-insert.js';
import type { QueuedMessage } from './use-turn-runner.js';
import type { PendingApproval, PendingPermission, Picker } from './types.js';
import type { VoicePhase } from './use-voice-input.js';

interface InteractiveZoneProps {
  session: Session;
  pendingPermission: PendingPermission | null;
  pendingPermissionDepth: number;
  pendingApproval: PendingApproval | null;
  picker: Picker;
  busy: boolean;
  voiceReady: boolean;
  voicePhase: VoicePhase;
  yolo: boolean;
  slashCommands: ReadonlyArray<SlashCommand>;
  /** Live queue contents for the always-visible QueueView. */
  queueMessages: ReadonlyArray<QueuedMessage>;
  /** Single-slot priority message set by Ctrl+T. */
  priorityMessage: QueuedMessage | null;
  /** Ctrl+<letter> hotkeys plumbed into the input editor (Ink's useInput
   *  can't see these once PromptInput holds stdin). */
  commandHotkeys: Record<string, () => void>;
  /** Shift+Tab inside the input cycles the active mode. */
  onCycleMode: () => void;
  externalInsert?: ExternalInsert;
  onPermissionDecide: (perm: PendingPermission, decision: import('@moxxy/sdk').PermissionDecision) => void;
  onApprovalDecide: (decision: import('@moxxy/sdk').ApprovalDecision) => void;
  onPickerSelect: (picker: NonNullable<Picker>, id: string) => void;
  onPickerCancel: () => void;
  onSubmit: (text: string) => void | Promise<void>;
  onPasteText: (text: string) => string;
}

/**
 * The bottom-of-screen interactive slot. Mutually exclusive: at most
 * one of permission dialog, approval dialog, picker, or input box is
 * rendered at a time. PromptInput's raw-mode stdin handler doesn't
 * react well to being mounted alongside dialogs that also useInput,
 * which is why the gating happens here at the boundary.
 */
export const InteractiveZone: React.FC<InteractiveZoneProps> = ({
  session,
  pendingPermission,
  pendingPermissionDepth,
  pendingApproval,
  picker,
  busy,
  voiceReady,
  voicePhase,
  yolo,
  slashCommands,
  queueMessages,
  priorityMessage,
  commandHotkeys,
  onCycleMode,
  externalInsert,
  onPermissionDecide,
  onApprovalDecide,
  onPickerSelect,
  onPickerCancel,
  onSubmit,
  onPasteText,
}) => {
  if (pendingPermission) {
    return (
      <PermissionDialog
        call={pendingPermission.call}
        toolDescription={session.tools.get(pendingPermission.call.name)?.description}
        queueDepth={pendingPermissionDepth}
        onDecide={(decision) => onPermissionDecide(pendingPermission, decision)}
      />
    );
  }
  if (pendingApproval) {
    return (
      <ApprovalDialog
        request={pendingApproval.request}
        onDecide={(decision) => onApprovalDecide(decision)}
      />
    );
  }
  if (picker) {
    return (
      <ListPicker
        title={picker.title}
        options={picker.options}
        onSelect={(id) => onPickerSelect(picker, id)}
        onCancel={onPickerCancel}
      />
    );
  }
  // The queue strip touches the input directly (no border-bottom on
  // the queue, no margin-top on the input). The wrapper carries a
  // single line of margin so the strip — or, when empty, the input —
  // has breathing room from the chat above.
  return (
    <Box flexDirection="column" marginTop={1}>
      <QueueView messages={queueMessages} priority={priorityMessage} />
      <InputBox
        onSubmit={onSubmit}
        disabled={false}
        yolo={yolo}
        voicePhase={voicePhase}
        slashCommands={slashCommands}
        placeholder={buildPromptPlaceholder(busy, voiceReady)}
        onPasteText={onPasteText}
        commandHotkeys={commandHotkeys}
        onShiftTab={onCycleMode}
        externalInsert={externalInsert}
      />
    </Box>
  );
};

export function buildPromptPlaceholder(busy: boolean, voiceReady = true): string {
  if (busy) return 'type to queue a message — sent after the current turn (ctrl+t to force-send first)';
  return voiceReady ? 'type a prompt, / for commands, Ctrl+R voice' : 'type a prompt, / for commands';
}
