/**
 * Cloudflare quick-tunnel management.
 *
 * The host binds its MCP server to loopback and `cloudflared` makes an *outbound* connection to
 * Cloudflare's edge, which publishes a `https://<random>.trycloudflare.com` hostname. That inverts
 * the reachability problem: no port-forward, no VPN, no inbound firewall rule on the host, and the
 * guest gets a publicly-trusted TLS certificate for free (no self-signed trust dance).
 *
 * Trade-off, deliberately accepted and documented: TLS terminates at Cloudflare's edge, so this
 * path is NOT end-to-end private — Cloudflare can see the plaintext the guest's AI reads and
 * writes. The session code still gates all access. Use `codeshare.tunnel: "off"` for the direct
 * LAN/VPN path when that matters.
 */

import { spawn, type ChildProcess } from 'node:child_process';

/** How long to wait for cloudflared to report its hostname before giving up. */
const HOSTNAME_TIMEOUT_MS = 30_000;

/**
 * Match the published quick-tunnel origin. The trailing lookahead anchors the end of the hostname
 * so a longer name that merely *contains* `.trycloudflare.com` as a prefix — e.g.
 * `https://x.trycloudflare.com.example.test/` — is not mistaken for the real thing.
 */
const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com(?![a-z0-9.-])/i;

/**
 * Platform-appropriate install instructions. Hosting works from macOS, Linux, WSL and native
 * Windows, and each has a different package manager — a hardcoded `brew` hint is useless (and
 * misleading) on the other three.
 *
 * Note for WSL: `cloudflared` must be installed *inside* the WSL distribution, because the MCP
 * server binds WSL's loopback. A copy on the Windows host cannot reach it without extra port
 * forwarding.
 */
function installHint(platform: NodeJS.Platform = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'Install it with `brew install cloudflared`.';
    case 'win32':
      return 'Install it with `winget install --id Cloudflare.cloudflared`.';
    default:
      // Linux, including WSL distributions.
      return (
        'Install it inside this Linux/WSL environment — e.g. ' +
        '`curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 ' +
        '-o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared`. ' +
        'A cloudflared on the Windows host will not work: the server listens on WSL loopback.'
      );
  }
}

export class CloudflaredMissingError extends Error {
  constructor(platform: NodeJS.Platform = process.platform) {
    super(
      `cloudflared is not installed or not on PATH. ${installHint(platform)} ` +
        'Alternatively set `codeshare.tunnel` to "off" to share over LAN/VPN instead.',
    );
    this.name = 'CloudflaredMissingError';
  }
}

/** How long to keep probing the published hostname before declaring the tunnel unusable. */
const READY_TIMEOUT_MS = 60_000;

/**
 * Poll `<origin>/codeshare` until the Cloudflare edge routes to our MCP server.
 *
 * An unauthenticated request to a working codeshare server returns **401** — which makes it an
 * ideal readiness signal: it proves not just that DNS resolved and the edge is up, but that the
 * tunnel is connected to *our* process. Cloudflare's own "tunnel not connected" responses are 5xx
 * (502/530/1033), and DNS failures throw, so both are correctly treated as not-ready.
 */
async function waitUntilRoutable(origin: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastDetail = 'no response';
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${origin}/codeshare`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      // 401 = our server answered. Any 2xx/4xx other than a Cloudflare error page also means the
      // request reached us, so accept anything that isn't a 5xx.
      if (resp.status < 500) return;
      lastDetail = `HTTP ${resp.status} from the Cloudflare edge`;
    } catch (err) {
      lastDetail = (err as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `The tunnel was published but never became reachable within ${Math.round(timeoutMs / 1000)}s ` +
      `(${lastDetail}). Check your network, then try starting the session again.`,
  );
}

export interface RunningTunnel {
  /** Public base origin, e.g. `https://foo-bar-baz.trycloudflare.com` (no trailing slash). */
  origin: string;
  /**
   * Whether we confirmed the published URL is reachable *from this machine*.
   *
   * `false` is not a failure. The probe is a courtesy check, and a host can fail it while the
   * tunnel works perfectly for the guest — notably under WSL, whose DNS frequently cannot resolve
   * public names even though cloudflared's outbound connection to Cloudflare succeeded. Since the
   * guest resolves via entirely different DNS, we surface this as a warning, never a hard stop.
   */
  verified: boolean;
  /** Why verification failed, when `verified` is false. */
  verificationError?: string;
  /** Terminate the tunnel process. Safe to call more than once. */
  close: () => Promise<void>;
}

/**
 * Start a Cloudflare quick tunnel pointing at `http://127.0.0.1:<port>` and resolve once the
 * public hostname has been assigned.
 *
 * @param port Local port the codeshare MCP server is listening on.
 * @param opts.binary Path/name of the cloudflared executable. Defaults to `cloudflared` on PATH.
 * @param opts.argv Override the arguments passed to `binary`. Exists so tests can substitute a
 *                  stub process for the real binary; production callers should omit it.
 * @param opts.waitForReady Poll the published hostname until it actually routes to our server
 *                  before resolving (default true). Tests using a stub process set this false.
 */
export interface StartTunnelOptions {
  binary?: string;
  argv?: string[];
  waitForReady?: boolean;
  /** Override the readiness-probe budget. Tests use a short one; production uses the default. */
  readyTimeoutMs?: number;
}

export async function startTunnel(
  port: number,
  opts: StartTunnelOptions = {},
): Promise<RunningTunnel> {
  const { binary = 'cloudflared', argv, waitForReady = true, readyTimeoutMs } = opts;
  const child = spawn(
    binary,
    argv ?? ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      // On Windows, package managers commonly install `cloudflared` as a `.cmd`/`.bat` shim, which
      // CreateProcess cannot execute directly — only `.exe` resolves without a shell. Our argv is
      // fully controlled (a literal flag list plus a numeric port), so there is nothing here for a
      // shell to interpolate.
      shell: process.platform === 'win32',
    },
  );

  let settled = false;
  let timer: NodeJS.Timeout | undefined;

  /** Kill the process; used both on failure and on explicit close. */
  const kill = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    // Give it a moment to exit cleanly, then insist.
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        resolve();
      }, 2000);
      t.unref?.();
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  };

  return new Promise<RunningTunnel>((resolve, reject) => {
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void kill().then(() => reject(err));
    };

    const succeed = (origin: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!waitForReady) {
        resolve({ origin, verified: false, close: kill });
        return;
      }
      // The banner prints before the hostname is routable — cloudflared says as much ("it may take
      // some time to be reachable"). Probing avoids handing the host a URL that is not live yet.
      // But a failed probe does NOT mean a broken tunnel: it only proves *this* machine cannot
      // reach the URL, and the guest uses different DNS and a different network path. So report the
      // outcome and let the session start either way.
      waitUntilRoutable(origin, readyTimeoutMs).then(
        () => resolve({ origin, verified: true, close: kill }),
        (err: Error) =>
          resolve({ origin, verified: false, verificationError: err.message, close: kill }),
      );
    };

    // cloudflared prints the banner containing the hostname to stderr, but scan both streams so a
    // change in its logging destination doesn't break us.
    let diagnostics = '';
    const scan = (chunk: Buffer | string) => {
      const text = String(chunk);
      // Keep a bounded tail of the output to classify a premature exit.
      diagnostics = (diagnostics + text).slice(-4096);
      const match = QUICK_TUNNEL_URL.exec(text);
      if (match) succeed(match[0].replace(/\/+$/, ''));
    };
    child.stdout?.on('data', scan);
    child.stderr?.on('data', scan);

    child.once('error', (err) => {
      // ENOENT => the binary isn't installed; surface actionable guidance instead of a raw errno.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') fail(new CloudflaredMissingError());
      else fail(err);
    });

    child.once('exit', (code, signal) => {
      // When spawned through a shell (Windows), a missing binary surfaces as a normal non-zero
      // exit with a shell diagnostic rather than an ENOENT `error` event — classify it here so the
      // host still gets install instructions instead of a bare exit code.
      if (/not recognized|not found|No such file/i.test(diagnostics)) {
        fail(new CloudflaredMissingError());
        return;
      }
      const detail = diagnostics.trim().split('\n').slice(-3).join(' ').slice(0, 300);
      fail(
        new Error(
          `cloudflared exited before publishing a tunnel (code ${code ?? signal}).` +
            (detail ? ` Last output: ${detail}` : ''),
        ),
      );
    });

    timer = setTimeout(
      () => fail(new Error('Timed out waiting for cloudflared to publish a tunnel hostname.')),
      HOSTNAME_TIMEOUT_MS,
    );
    timer.unref?.();
  });
}

/** Keep a handle on the process so `codeshare.stop`/deactivate can tear it down. */
export type { ChildProcess };
