import type {
  ApprovalDecision,
  ApprovalRequest,
  PendingToolCall,
  PermissionContext,
  PermissionDecision,
} from '@moxxy/sdk';
import type { ListPickerOption } from '../components/ListPicker.js';

export type Overlay =
  | { kind: 'skills' }
  | { kind: 'tools' }
  | { kind: 'agents' }
  | { kind: 'usage' }
  | null;

export type Picker =
  | null
  | { kind: 'model' | 'mode'; title: string; options: ReadonlyArray<ListPickerOption> }
  | { kind: 'mcp-server'; title: string; options: ReadonlyArray<ListPickerOption> }
  | {
      kind: 'mcp-action';
      title: string;
      serverName: string;
      options: ReadonlyArray<ListPickerOption>;
    };

export interface PendingPermission {
  call: PendingToolCall;
  ctx: PermissionContext;
  resolve: (d: PermissionDecision) => void;
}

export interface PendingApproval {
  request: ApprovalRequest;
  resolve: (d: ApprovalDecision) => void;
}
