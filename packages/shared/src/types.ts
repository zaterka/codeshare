/** Shared configuration / shape types used by host and extension packages. */

export interface ServerOptions {
  /** Realpath-resolved root folder the MCP server exposes. */
  root: string;
  /** TCP port to listen on. */
  port: number;
  /** Session code; every request must present `Authorization: Bearer <code>`. */
  sessionCode: string;
  /** Optional PEM TLS cert+key. If omitted and `tls` is true, we use a bundled/injected self-signed cert. */
  cert?: { cert: string; key: string };
  /** Max file size in bytes for read/write tools. Default 10 MB. */
  maxFileSizeBytes?: number;
  /** Directories ignored by list/grep. Default ['.git', 'node_modules']. */
  ignoredDirs?: string[];
  /** Hostname to bind; default 0.0.0.0 so remote peers can reach it. */
  host?: string;
}

export interface RunningServer {
  /** e.g. https://0.0.0.0:8443/codeshare */
  url: string;
  /** Cleanly stop the https server + all MCP sessions. */
  close: () => Promise<void>;
  /** Current connected MCP client sessions (session ids). For host "who's connected" view. */
  connectedSessions: ReadonlyArray<string>;
  /** Register a callback fired whenever the set of connected sessions changes. */
  onSessionChange: (cb: (sessionIds: ReadonlyArray<string>) => void) => void;
}
