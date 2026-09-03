# codeshare

Peer-to-peer code sharing for local AI assistants.

`codeshare` lets a developer **host** a folder and expose it to a **guest** developer's local
AI assistant (Copilot, Claude Code, Cursor, or any MCP client) as a **remote MCP server** —
over the internet, peer-to-peer, with **zero infrastructure on our side**. The host runs the
server over their own machine/folder; the guest's AI connects to it directly. No file contents
ever pass through a third party.

```
   Host (VSCode + this extension)                     Guest (VSCode + this extension)
   ─────────────────────────────────                  ─────────────────────────────────
   Shared folder ──► authenticated MCP server         local AI assistant ◄── remote MCP
                       (streamable HTTP, TLS)  ─────► (reads & edits shared files like a human)
                          ▲ bearer code added to .mcp.json
```

> Because it is peer-to-peer, data flows only between the two people who connect. Nothing is
> hosted or relayed by us.

## How it works

- **Host** picks a folder and starts an authenticated MCP server (streamable HTTP over TLS). They
  share a short **session code** and the server **URL** with the guest out-of-band.
- **Guest** runs "Connect as Guest", pastes the URL + code. The extension verifies the remote
  server (reachable + authenticated), then writes a merged `.mcp.json` into the workspace so the
  guest's local AI assistant can connect and **read and edit** the shared files using the
  `codeshare_*` tools.
- Every request must present `Authorization: Bearer <session-code>`; the host sees how many
  sessions are connected in its status bar.

Both sides run the extension. The **host** needs its machine reachable by the guest (LAN, VPN,
or a port-forward / reverse proxy with a real TLS certificate for the open internet).

### MCP tools exposed by the host

| Tool | Purpose |
|------|---------|
| `codeshare_read_file` | Read a file's text content |
| `codeshare_write_file` | Create or overwrite a file (atomic) |
| `codeshare_edit_file` | Replace the Nth occurrence of text (atomic; no write on under-match) |
| `codeshare_list_files` | List files (optionally recursive) |
| `codeshare_delete_file` | Delete a file |
| `codeshare_grep` | Regex-search file contents (up to 200 matches) |

All paths are validated to stay inside the shared root (rejects `..`, absolute paths, null bytes,
and symlink escapes) — the same hardening as the official `server-filesystem` reference. `write`
uses an exclusive-create/atomic-temp-rename flow to avoid TOCTOU races.

## Security model (v1)

- **Auth**: a 6-digit session code compared in constant time. It is the shared secret; guard it.
- **Transport**: TLS recommended. For the open internet, terminate TLS at your own reverse proxy
  (or supply `codeshare.cert`/`codeshare.key`) with a real certificate. For LAN/dev against a
  self-signed cert, the guest can allow an insecure connection during verification.
- **No identity/account system** in v1: the host sees session counts, not usernames.
- Reachability is the user's responsibility (the plan for NAT-punching via WebRTC is future work).
- The host MCP server is bound to `0.0.0.0` by default so remote peers can reach it; set
  `codeshare.host` to `127.0.0.1` to restrict to local-only.

## Repository layout

npm workspaces monorepo (TypeScript + esbuild + Node):

| Package | Role |
|---------|------|
| `packages/shared` | Path-safety, session-code helpers, shared types |
| `packages/host` | The MCP server (`startServer`), tools, and the `codeshare-host` CLI |
| `packages/extension` | The VSCode extension (host + guest commands) |

## Build & test

```bash
npm install --cache ./node_modules/.npm-cache   # (global npm cache may be broken on this machine)
npm run build          # shared (tsc) -> host (esbuild) -> extension (esbuild)
npm run typecheck
npm test
```

### Run the host server from the CLI (no VSCode)

```bash
node packages/host/dist/cli.js serve --root ~/projects/api --port 8443
# plain HTTP (LAN/dev). For internet, terminate TLS at your reverse proxy and point clients at
# the proxy URL with the same code.
```

### Package the extension as a VSIX

```bash
npm run package -w codeshare
# produces codeshare-0.1.0.vsix in packages/extension
```

## Using it

### Host

1. Command Palette → **Codeshare: Start Session**.
2. Pick a folder to share. The status bar shows `Codeshare <id> (N connected)`, and a modal shows
   the URL and code (copy to clipboard).
3. Send the URL + code to your guest. Stop anytime with **Codeshare: Stop Session**.

### Guest

1. Open the folder you want to work in.
2. Command Palette → **Codeshare: Connect as Guest**.
3. Paste the host's URL and code. The extension verifies the server, then writes `.mcp.json` with
   the `codeshare` remote MCP server (bearer header) so your AI assistant connects to the shared
   folder. Allow an *insecure* connection only for LAN/dev hosts using a self-signed cert.

## Configuration (`codeshare.*`)

| Setting | Default | Meaning |
|---------|---------|---------|
| `codeshare.port` | `8443` | Host server port |
| `codeshare.host` | `0.0.0.0` | Bind address (`127.0.0.1` = local-only) |
| `codeshare.maxFileSizeMb` | `10` | Cap on files the tools read/write |
| `codeshare.cert` / `codeshare.key` | `""` | Optional real PEM cert/key for the host server |

## License

MIT
