import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ClientSession as Session,
  PendingToolCall,
  PermissionContext,
  PermissionDecision,
} from '@moxxy/sdk';
import type { PendingApproval, PendingPermission } from './types.js';

export interface PermissionQueueHandle {
  pendingPermissions: ReadonlyArray<PendingPermission>;
  setPendingPermissions: React.Dispatch<React.SetStateAction<ReadonlyArray<PendingPermission>>>;
  pendingPermission: PendingPermission | null;
  pendingApproval: PendingApproval | null;
  setPendingApproval: React.Dispatch<React.SetStateAction<PendingApproval | null>>;
  /**
   * Mirror of the yolo flag used inside the resolver closure (which is
   * registered once on mount); flip `current` to update without
   * re-registering.
   */
  yoloRef: React.MutableRefObject<boolean>;
}

/**
 * Wires the TUI to the session's permission + approval resolvers and
 * keeps a queue for each. Parallel subagents can request permission
 * simultaneously, so we keep the queue head-of-line; the dialog drains
 * it one at a time. Same shape for approvals.
 */
export function usePermissionQueue(
  session: Session,
  registerInteractiveResolver: (
    prompt: (call: PendingToolCall, ctx: PermissionContext) => Promise<PermissionDecision>,
  ) => void,
): PermissionQueueHandle {
  const [pendingPermissions, setPendingPermissions] = useState<ReadonlyArray<PendingPermission>>([]);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const yoloRef = useRef(false);

  useEffect(() => {
    registerInteractiveResolver(async (call, ctx) => {
      // YOLO mode: auto-allow every tool call without asking. Toggled via
      // `/yolo`. Useful for trusted workflows; the status bar shows it on.
      if (yoloRef.current) {
        return { mode: 'allow', reason: 'yolo mode' };
      }
      return new Promise<PermissionDecision>((resolve) => {
        setPendingPermissions((prev) => [...prev, { call, ctx, resolve }]);
      });
    });

    // Install a generic approval resolver so loop strategies that opt
    // into ctx.approval (plan-execute, future strategies) get a TUI
    // checkpoint dialog. Tears down on unmount so headless tests don't
    // accidentally inherit a dialog-bound resolver.
    session.setApprovalResolver({
      name: 'tui-approval',
      confirm: (request: ApprovalRequest) =>
        new Promise<ApprovalDecision>((resolve) => {
          setPendingApproval({ request, resolve });
        }),
    });

    return () => {
      session.setApprovalResolver(null);
    };
  }, [session, registerInteractiveResolver]);

  return {
    pendingPermissions,
    setPendingPermissions,
    pendingPermission: pendingPermissions[0] ?? null,
    pendingApproval,
    setPendingApproval,
    yoloRef,
  };
}
