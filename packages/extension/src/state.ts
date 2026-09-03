/**
 * Pure, testable helpers for session state and the guest's remote-MCP config (.mcp.json).
 * These intentionally do NOT import `vscode`, so they run under vitest and the node test runner.
 */

export interface SessionState {
  /** Unique session id generated on start. */
  id: string;
  /** Role of this side: 'host' | 'guest'. */
  role: 'host' | 'guest';
  /** Folder being shared (host) or remote URL (guest). */
  root: string;
  /** The session code (bearer secret). Host generates it; guest receives it. */
  sessionCode: string;
  /** Remote endpoint for guest / the local URL for host. */
  url?: string;
  /** When the session was created (epoch ms). */
  startedAt: number;
}

export interface RemoteMcpServerConfig {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

/**
 * Build the `.mcp.json` server entry for a codeshare remote server.
 * Matches the Claude Code project `.mcp.json` schema (and is honored by Cursor and generic clients).
 */
export function buildMcpServerEntry(url: string, sessionCode: string): RemoteMcpServerConfig {
  const normalized = url.startsWith('http') ? url : `https://${url}`;
  return {
    type: 'http',
    url: normalized,
    headers: { Authorization: `Bearer ${sessionCode}` },
  };
}

/**
 * Merge a codeshare entry into an existing parsed `.mcp.json` document (object form), returning a
 * NEW object. Existing `mcpServers` entries that are not named `codeshare` are preserved.
 */
export function mergeMcpConfig(
  existing: { mcpServers?: Record<string, unknown> } | undefined,
  entry: RemoteMcpServerConfig,
): { mcpServers: Record<string, unknown> } {
  const servers = { ...(existing?.mcpServers ?? {}) };
  servers['codeshare'] = entry;
  return { mcpServers: servers };
}

/**
 * Compute the human-facing connection summary shown to the host.
 */
export function hostSummary(state: Pick<SessionState, 'id' | 'root' | 'sessionCode' | 'url'>): string {
  return [
    `Session id: ${state.id}`,
    `Sharing:   ${state.root}`,
    `URL:       ${state.url ?? 'starting…'}`,
    `Code:      ${state.sessionCode}`,
  ].join('\n');
}
