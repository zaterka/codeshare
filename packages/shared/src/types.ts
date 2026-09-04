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
  /**
   * The URL of this server on the machine it runs on, e.g. `http://127.0.0.1:8443/codeshare`.
   * This is NOT necessarily reachable by a guest — a `0.0.0.0` bind has no single public name.
   * Callers that need a shareable URL must derive one (LAN address, tunnel hostname, reverse proxy).
   */
  localUrl: string;
  /** The port actually bound (resolved, so a `port: 0` request reports the real port). */
  port: number;
  /** Cleanly stop the https server + all MCP sessions. */
  close: () => Promise<void>;
  /** Current connected MCP client sessions (session ids). For host "who's connected" view. */
  connectedSessions: ReadonlyArray<string>;
  /** Register a callback fired whenever the set of connected sessions changes. */
  onSessionChange: (cb: (sessionIds: ReadonlyArray<string>) => void) => void;
}
