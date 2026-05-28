import type {
  ApprovalDecision,
  ApprovalRequest,
  PendingToolCall,
  PermissionContext,
  PermissionDecision,
} from '@moxxy/sdk';
import type { ListPickerOption, ListPickerTab } from '../components/ListPicker.js';

export type Overlay =
  | { kind: 'skills' }
  | { kind: 'tools' }
  | { kind: 'agents' }
  | { kind: 'usage' }
  | { kind: 'workflows' }
  | null;

export type Picker =
  | null
  | {
      kind: 'model';
      title: string;
      tabs: ReadonlyArray<ListPickerTab>;
      initialTabId?: string;
      searchable?: boolean;
      searchPlaceholder?: string;
    }
  | { kind: 'mode'; title: string; options: ReadonlyArray<ListPickerOption> }
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
