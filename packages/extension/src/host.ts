import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startServer, type RunningServer } from '@codeshare/host';
import { generateSessionCode, generateSessionId } from '@codeshare/shared';
import { ensureSelfSignedCert } from './cert.js';
import { hostSummary, type SessionState } from './state.js';

let running: RunningServer | null = null;
let statusItem: vscode.StatusBarItem | null = null;
let workspaceState: vscode.Memento | null = null;
const sessionListeners = new Set<() => void>();

export function onHostState(cb: () => void): void {
  sessionListeners.add(cb);
}

export function isHosting(): boolean {
  return running !== null;
}

async function resolveCert(
  context: vscode.ExtensionContext,
): Promise<{ cert?: { cert: string; key: string }; insecure: boolean }> {
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
  const host = String(cfg.get('host') ?? '0.0.0.0');
  const maxFileSizeMb = Number(cfg.get('maxFileSizeMb') ?? 10);

  const root = picked.fsPath;
  const sessionCode = generateSessionCode();
  const id = generateSessionId();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusItem = status;

  try {
    const { cert } = await resolveCert(context);
    running = await startServer({
      root,
      port,
      sessionCode,
      host,
      maxFileSizeBytes: maxFileSizeMb * 1024 * 1024,
      cert: cert ? { cert: cert.cert, key: cert.key } : undefined,
    });

    const state: SessionState = {
      id,
      role: 'host',
      root,
      sessionCode,
      url: running.url,
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
        void vscode.env.clipboard.writeText(`${running?.url}\nCode: ${sessionCode}`);
      }
    });
  } catch (err) {
    running = null;
    status.dispose();
    statusItem = null;
    void vscode.window.showErrorMessage(`Failed to start codeshare: ${(err as Error).message}`);
  }
}

export async function stopHost(): Promise<void> {
  if (!running) return;
  const server = running;
  running = null;
  try {
    await server.close();
  } catch {
    // Best-effort teardown; ignore close errors.
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
  const host = String(cfg.get('host') ?? '0.0.0.0');
  try {
    workspaceState = context.workspaceState;
    const { cert } = await resolveCert(context);
    running = await startServer({
      root: state.root,
      port,
      sessionCode: state.sessionCode,
      host,
      cert: cert ? { cert: cert.cert, key: cert.key } : undefined,
    });
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusItem = status;
    status.text = `$(broadcast) Codeshare ${state.id} (restored)`;
    status.command = 'codeshare.stop';
    status.show();
    running.onSessionChange((ids) => {
      if (statusItem) statusItem.text = `$(broadcast) Codeshare ${state.id} (${ids.length} connected)`;
    });
    for (const cb of sessionListeners) cb();
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not restore codeshare session: ${(err as Error).message}`);
  }
}

export function currentSessionStatus(): string {
  return running ? `Hosting ${running.url}` : 'Not hosting';
}
