import * as vscode from 'vscode';
import { startHost, stopHost, restoreHost } from './host.js';
import { connectGuest } from './guest.js';

/**
 * codeshare extension entry point.
 * - Host side: starts an authenticated MCP server over a chosen folder (P2P, host-exposed).
 * - Guest side: verifies a remote host then registers the remote MCP server with the local AI.
 */
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('codeshare.start', () => startHost(context)),
    vscode.commands.registerCommand('codeshare.stop', async () => {
      await stopHost();
    }),
    vscode.commands.registerCommand('codeshare.connectGuest', () => connectGuest(context)),
  );

  // Re-serve a persisted host session after a window reload (e.g. extension reload / restart).
  void restoreHost(context);
}

export function deactivate(): void {
  void stopHost();
}
