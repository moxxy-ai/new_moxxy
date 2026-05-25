import React, { useEffect, useState } from 'react';
import type { ClientSession as Session } from '@moxxy/sdk';

export interface McpStatus {
  connected: number;
  enabled: number;
}

/**
 * MCP attach summary — refreshed on mount, after every /mcp action, and
 * every 5s while the session is open so lazy stubs that connect mid-turn
 * surface in the status bar without needing a user-driven refresh.
 */
export function useMcpStatus(session: Session): {
  mcpStatus: McpStatus;
  refreshMcpStatus: () => Promise<void>;
} {
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({ connected: 0, enabled: 0 });
  const refreshMcpStatus = React.useCallback(async () => {
    const api = (
      session as unknown as {
        mcpAdmin?: {
          listServers: () => Promise<ReadonlyArray<{ enabled: boolean; connected: boolean }>>;
        };
      }
    ).mcpAdmin;
    if (!api?.listServers) return;
    try {
      const list = await api.listServers();
      const enabled = list.filter((s) => s.enabled);
      setMcpStatus({
        enabled: enabled.length,
        connected: enabled.filter((s) => s.connected).length,
      });
    } catch {
      // best-effort — leave the previous count visible
    }
  }, [session]);
  useEffect(() => {
    void refreshMcpStatus();
    const t = setInterval(() => void refreshMcpStatus(), 5000);
    return () => clearInterval(t);
  }, [refreshMcpStatus]);
  return { mcpStatus, refreshMcpStatus };
}
