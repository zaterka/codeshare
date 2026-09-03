import * as vscode from 'vscode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateSessionId } from '@codeshare/shared';
import { verifyRemote } from './guestVerify.js';
import { buildMcpServerEntry, mergeMcpConfig, type SessionState } from './state.js';

const STATE_KEY = 'codeshare.active';
const MCP_CONFIG_NAME = '.mcp.json';

/**
 * Connect as a guest: prompt for the host's URL and session code, verify the remote MCP
 * server is reachable and authenticated, then write a merged `.mcp.json` into the workspace
 * so the local AI assistant can connect to the shared folder as a remote MCP client.
 */
export async function connectGuest(context: vscode.ExtensionContext): Promise<void> {
  const prior = context.workspaceState.get<SessionState>(STATE_KEY);
  const priorUrl = prior?.role === 'guest' ? prior.url ?? '' : '';

  const urlInput = await vscode.window.showInputBox({
    prompt: 'Remote codeshare URL (e.g. https://host:8443/codeshare)',
    value: priorUrl,
    ignoreFocusOut: true,
    placeHolder: 'https://your-host.example.com/codeshare',
    validateInput: (v) => (v.trim() && v.trim().length > 0 ? undefined : 'A URL is required.'),
  });
  if (urlInput === undefined) return; // cancelled
  const rawUrl = urlInput.trim();
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;

  const codeInput = await vscode.window.showInputBox({
    prompt: 'Session code from the host',
    value: prior?.role === 'guest' ? prior.sessionCode : '',
    ignoreFocusOut: true,
    password: true,
    validateInput: (v) => (v.trim().length >= 4 ? undefined : 'Enter the session code (6 digits).'),
  });
  if (codeInput === undefined) return; // cancelled
  const sessionCode = codeInput.trim();

  const insecure = await promptInsecure();
  if (insecure === undefined) return;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Verifying remote codeshare server…',
      cancellable: false,
    },
    async () => {
      const result = await verifyRemote({ url, sessionCode, insecure });
      if (!result.ok) {
        void vscode.window.showErrorMessage(
          result.reason === 'auth'
            ? 'Authentication failed: the session code did not match the host. Double-check the code. (Note: when the host uses a self-signed cert, you may need to allow an insecure connection.)'
            : `Could not reach the host at ${url}. Check the URL, that the host is running, and that it is reachable (LAN/VPN/port-forward).`,
        );
        return;
      }

      const folder = await resolveFolder();
      if (!folder) return;

      // Merge the codeshare entry into the workspace `.mcp.json`.
      const mcpPath = path.join(folder, MCP_CONFIG_NAME);
      const existing = await readMcpJson(mcpPath);
      const merged = mergeMcpConfig(existing, buildMcpServerEntry(url, sessionCode));
      await fs.writeFile(mcpPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');

      // Persist that this side is now a guest of the remote session.
      const state: SessionState = {
        id: prior?.role === 'guest' ? prior.id : generateSessionId(),
        role: 'guest',
        root: folder,
        sessionCode,
        url,
        startedAt: Date.now(),
      };
      await context.workspaceState.update(STATE_KEY, state);

      const toolList = result.tools.length ? `\nDiscovered tools:\n${result.tools.map((t) => `  • ${t}`).join('\n')}` : '';
      void vscode.window.showInformationMessage(
        `Connected to codeshare session (${result.serverName}) as guest.\nWrote ${MCP_CONFIG_NAME} for your AI assistant.${toolList}`,
      );
    },
  );
}

/** Prompt whether to allow an insecure (self-signed) connection, defaulting to the safe choice. */
async function promptInsecure(): Promise<boolean | undefined> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: 'No (secure)', description: 'Require a valid TLS certificate (recommended for internet).', picked: true },
      { label: 'Yes (insecure)', description: 'Allow self-signed certs for LAN/dev hosts.' },
    ],
    { placeHolder: 'Allow an insecure connection to this host?', canPickMany: false },
  );
  if (!choice) return undefined;
  return choice.label.startsWith('Yes');
}

/** Choose the workspace folder that will receive `.mcp.json`. */
async function resolveFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    if (folders.length === 1) return folders[0]!.uri.fsPath;
    const names = folders.map((f) => ({
      label: path.basename(f.uri.fsPath),
      description: f.uri.fsPath,
      fsPath: f.uri.fsPath,
    }));
    const pick = await vscode.window.showQuickPick(names, { placeHolder: 'Choose the folder to write .mcp.json into' });
    return pick?.fsPath;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Save .mcp.json here',
  });
  return picked?.[0]?.fsPath;
}

/** Parse an existing `.mcp.json` if present; otherwise undefined. */
async function readMcpJson(mcpPath: string): Promise<{ mcpServers?: Record<string, unknown> } | undefined> {
  try {
    const raw = await fs.readFile(mcpPath, 'utf8');
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (parsed && typeof parsed === 'object') return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}
