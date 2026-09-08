import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, type RunningServer } from '@codeshare/host';
import { generateSessionCode, generateSessionId } from '@codeshare/shared';
import { ensureSelfSignedCert } from './cert.js';
import { startTunnel, type RunningTunnel } from './tunnel.js';
import { hostSummary, type SessionState } from './state.js';

let running: RunningServer | null = null;
let tunnel: RunningTunnel | null = null;
let statusItem: vscode.StatusBarItem | null = null;
let workspaceState: vscode.Memento | null = null;
const sessionListeners = new Set<() => void>();

/** Which transport strategy the host uses to become reachable by a guest. */
type TunnelMode = 'cloudflared' | 'off';

function tunnelMode(): TunnelMode {
  const raw = String(vscode.workspace.getConfiguration('codeshare').get('tunnel') ?? 'cloudflared');
  return raw === 'off' ? 'off' : 'cloudflared';
}

export function onHostState(cb: () => void): void {
  sessionListeners.add(cb);
}

export function isHosting(): boolean {
  return running !== null;
}

/**
 * Resolve the TLS material for the local server.
 *
 * When tunnelling, the only client is `cloudflared` on loopback and TLS is terminated at
 * Cloudflare's edge with a real certificate — so we serve plain HTTP locally. That is strictly
 * better than a self-signed cert here: it removes the trust problem entirely without exposing
 * anything, because the socket never leaves the machine.
 */
async function resolveCert(
  context: vscode.ExtensionContext,
  mode: TunnelMode,
): Promise<{ cert?: { cert: string; key: string }; insecure: boolean }> {
  if (mode === 'cloudflared') return { cert: undefined, insecure: false };
  const cfg = vscode.workspace.getConfiguration('codeshare');
  const certPath = String(cfg.get('cert') ?? '');
  const keyPath = String(cfg.get('key') ?? '');
  if (certPath && keyPath) {
    return {
      cert: { cert: await fs.readFile(certPath, 'utf8'), key: await fs.readFile(keyPath, 'utf8') },
      insecure: false,
    };
  }
  // No user cert: generate a self-signed one for LAN/dev. (Internet deploys should supply a real cert.)
  const cacheDir = path.join(context.globalStorageUri.fsPath, 'certs');
  const cert = await ensureSelfSignedCert(cacheDir);
  return { cert, insecure: true };
}

/**
 * Produce the URL a guest should actually connect to.
 *
 * `cloudflared` mode publishes a real, publicly-trusted hostname. `off` mode falls back to the
 * host's first non-internal IPv4 address, which only works if the guest shares a LAN or VPN with
 * the host — we never advertise `localhost`, since that resolves to the *guest's* own machine.
 */
async function resolveShareUrl(port: number, mode: TunnelMode): Promise<string> {
  if (mode === 'cloudflared') {
    const t = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Opening Cloudflare tunnel (waiting for it to become reachable)…',
      },
      () => startTunnel(port),
    );
    tunnel = t;
    if (!t.verified) {
      // Common on WSL, whose DNS often cannot resolve public names even when cloudflared's own
      // outbound connection succeeded. The guest resolves independently, so this is informational.
      void vscode.window.showWarningMessage(
        `Tunnel published, but this machine could not reach it to confirm (${t.verificationError ?? 'unknown'}). ` +
          'This is often a local DNS limitation — WSL especially — and the URL may still work fine ' +
          'for your guest. Send it and check the status bar: it shows "(1 connected)" once they connect.',
      );
    }
    return `${t.origin}/codeshare`;
  }

  const os = await import('node:os');
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => Boolean(i) && i!.family === 'IPv4' && !i!.internal)
    .map((i) => i.address);
  const advertised = addresses[0];
  if (!advertised) {
    throw new Error(
      'No non-loopback IPv4 address found, so no guest-reachable URL can be advertised. ' +
        'Connect to a network, or set `codeshare.tunnel` to "cloudflared".',
    );
  }
  return `https://${advertised}:${port}/codeshare`;
}

export async function startHost(context: vscode.ExtensionContext): Promise<void> {
  if (running) {
    void vscode.window.showInformationMessage('A codeshare session is already running. Stop it first.');
    return;
  }

  const folders = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Share this folder',
  });
  const picked = folders?.[0];
  if (!picked) return;

  const cfg = vscode.workspace.getConfiguration('codeshare');
  const port = Number(cfg.get('port') ?? 8443);
  const maxFileSizeMb = Number(cfg.get('maxFileSizeMb') ?? 10);
  const mode = tunnelMode();
  // Tunnelling means cloudflared is the only local client, so keep the port off the network
  // entirely rather than binding the configured (default 0.0.0.0) address.
  const host = mode === 'cloudflared' ? '127.0.0.1' : String(cfg.get('host') ?? '0.0.0.0');

  const root = picked.fsPath;
  const sessionCode = generateSessionCode();
  const id = generateSessionId();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem = status;

  try {
    const { cert } = await resolveCert(context, mode);
    running = await startServer({
      root,
      port,
      sessionCode,
      host,
      maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
      cert: cert ? { cert: cert.cert, key: cert.key } : undefined,
    });

    const shareUrl = await resolveShareUrl(running.port, mode);

    const state: SessionState = {
      id,
      role: 'host',
      root,
      sessionCode,
      url: shareUrl,
      startedAt: Date.now(),
    };
    workspaceState = context.workspaceState;
    await context.workspaceState.update('codeshare.active', state);

    status.text = `$(broadcast) Codeshare ${id} (${running.connectedSessions.length} connected)`;
    status.command = 'codeshare.stop';
    status.tooltip = 'Codeshare session — click to stop';
    status.show();

    running.onSessionChange((ids) => {
      if (!statusItem) return;
      statusItem.text = `$(broadcast) Codeshare ${id} (${ids.length} connected)`;
    });

    void vscode.window.showInformationMessage(
      `Codeshare session started.\n\n${hostSummary(state)}`,
      { modal: true },
      'Copy to clipboard',
    ).then((selection) => {
      if (selection === 'Copy to clipboard') {
        void vscode.env.clipboard.writeText(`${shareUrl}\nCode: ${sessionCode}`);
      }
    });
  } catch (err) {
    // Tear down whichever half started, so a failed start never leaves an orphan server/tunnel.
    await running?.close().catch(() => {});
    await tunnel?.close().catch(() => {});
    running = null;
    tunnel = null;
    status.dispose();
    statusItem = null;
    void vscode.window.showErrorMessage(`Failed to start codeshare: ${(err as Error).message}`);
  }
}

export async function stopHost(): Promise<void> {
  if (!running) return;
  const server = running;
  const activeTunnel = tunnel;
  running = null;
  tunnel = null;
  try {
    await server.close();
  } catch {
    // Best-effort teardown; ignore close errors.
  }
  try {
    await activeTunnel?.close();
  } catch {
    // Best-effort teardown; a lingering cloudflared child is not worth failing the stop over.
  }
  statusItem?.dispose();
  statusItem = null;
  // Clear the persisted session so it isn't silently re-served on the next launch.
  const ws = workspaceState;
  workspaceState = null;
  if (ws) {
    try {
      await ws.update('codeshare.active', undefined);
    } catch {
      // Best-effort state clear; ignore persistence errors.
    }
  }
  for (const cb of sessionListeners) cb();
  void vscode.window.showInformationMessage('Codeshare session stopped.');
}

/** Restore a running host session after VSCode restart (hosts re-serve their folder). */
export async function restoreHost(context: vscode.ExtensionContext): Promise<void> {
  const state = context.workspaceState.get<SessionState>('codeshare.active');
  if (!state || state.role !== 'host') return;
  // Re-serve with the persisted code/root/port.
  const cfg = vscode.workspace.getConfiguration('codeshare');
  const port = Number(cfg.get('port') ?? 8443);
  const mode = tunnelMode();
  const host = mode === 'cloudflared' ? '127.0.0.1' : String(cfg.get('host') ?? '0.0.0.0');
  try {
    workspaceState = context.workspaceState;
    const { cert } = await resolveCert(context, mode);
    running = await startServer({
      root: state.root,
      port,
      sessionCode: state.sessionCode,
      host,
      cert: cert ? { cert: cert.cert, key: cert.key } : undefined,
    });
    // A quick tunnel gets a fresh hostname every time it starts, so the persisted URL is stale
    // after a reload. Re-derive it and tell the host, since guests must be re-sent the new URL.
    const shareUrl = await resolveShareUrl(running.port, mode);
    const urlChanged = state.url !== undefined && state.url !== shareUrl;
    await context.workspaceState.update('codeshare.active', { ...state, url: shareUrl });

    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem = status;
    status.text = `$(broadcast) Codeshare ${state.id} (restored)`;
    status.command = 'codeshare.stop';
    status.show();
    running.onSessionChange((ids) => {
      if (statusItem) statusItem.text = `$(broadcast) Codeshare ${state.id} (${ids.length} connected)`;
    });
    for (const cb of sessionListeners) cb();

    if (urlChanged) {
      void vscode.window.showWarningMessage(
        `Codeshare restarted with a NEW URL — re-send it to your guests:\n${shareUrl}\nCode: ${state.sessionCode}`,
        { modal: true },
        'Copy to clipboard',
      ).then((selection) => {
        if (selection === 'Copy to clipboard') {
          void vscode.env.clipboard.writeText(`${shareUrl}\nCode: ${state.sessionCode}`);
        }
      });
    }
  } catch (err) {
    await running?.close().catch(() => {});
    await tunnel?.close().catch(() => {});
    running = null;
    tunnel = null;
    void vscode.window.showErrorMessage(`Could not restore codeshare session: ${(err as Error).message}`);
  }
}

export function currentSessionStatus(): string {
  return running ? `Hosting ${tunnel?.origin ?? running.localUrl}` : 'Not hosting';
}
