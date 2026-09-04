# codeshare

Peer-to-peer code sharing for local AI assistants.

`codeshare` lets a developer **host** a folder and expose it to a **guest** developer's local
AI assistant (Copilot, Claude Code, Cursor, or any MCP client) as a **remote MCP server**. The
host serves their own folder; the guest's AI reads and edits it over an authenticated connection.
There is no account, no relay of ours, and no sync engine.

There are two ways the guest reaches the host, and they make **different privacy trade-offs**:

| `codeshare.tunnel` | Reachability | Privacy |
|---|---|---|
| `cloudflared` (default) | Works across networks and countries. No port-forward, no VPN. | **Not end-to-end.** TLS terminates at Cloudflare's edge, so Cloudflare can see file contents in plaintext. |
| `off` | Guest must share a LAN or VPN with the host, or the host must port-forward. | End-to-end between the two machines. Nothing in between. |

Pick `off` when the code must not transit a third party. Pick the default when you need it to
just work between two people in different places.

```
   Host (VSCode + this extension)                     Guest (VSCode + this extension)
   ─────────────────────────────────                  ─────────────────────────────────
   Shared folder ──► authenticated MCP server         local AI assistant ◄── remote MCP
                       (streamable HTTP)   ─────────► (reads & edits shared files like a human)
                          ▲ bearer code added to .mcp.json
```

## How it works

- **Host** picks a folder and starts an authenticated MCP server. With the default tunnel mode the
  server binds loopback only and `cloudflared` publishes a `https://<random>.trycloudflare.com`
  hostname; the host shares that **URL** plus a short **session code** with the guest out-of-band.
- **Guest** runs "Connect as Guest", pastes the URL + code. The extension verifies the remote
  server (reachable + authenticated), then writes a merged `.mcp.json` into the workspace so the
  guest's local AI assistant can connect and **read and edit** the shared files using the
  `codeshare_*` tools.
- Every request must present `Authorization: Bearer <session-code>`; the host sees how many
  sessions are connected in its status bar.

Both sides run the extension. In tunnel mode the host needs **no** inbound reachability —
`cloudflared` dials out. With `codeshare.tunnel: "off"` the host must be reachable by the guest
(LAN, VPN, or a port-forward / reverse proxy with a real TLS certificate).

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

- **Auth**: a 6-digit session code compared in constant time. It is the shared secret, it is the
  *only* thing standing between a tunnel URL and your files, and a 6-digit space is small — treat a
  live session as short-lived and stop it when you are done.
- **Anyone with the URL + code has read/write access** to the shared folder for as long as the
  session runs. There is no per-guest revocation; `Codeshare: Stop Session` revokes everyone.
- **Tunnel mode is not end-to-end private.** Cloudflare terminates TLS and can see file contents.
  Use `codeshare.tunnel: "off"` for sensitive code.
- **Direct mode transport**: supply `codeshare.cert`/`codeshare.key` with a real certificate, or
  terminate TLS at your own reverse proxy. A generated self-signed cert is LAN/dev only — and note
  the guest's AI assistant, unlike the extension's own verification step, has no way to skip
  certificate validation, so self-signed hosts generally will not work for real tool calls.
- **No identity/account system** in v1: the host sees session counts, not usernames.
- In tunnel mode the server binds `127.0.0.1`, so the port is never exposed to the network. In
  direct mode it binds `codeshare.host` (default `0.0.0.0`).

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

# Opt-in end-to-end test: spawns the real cloudflared, publishes a temp folder, drives MCP tool
# calls through the public URL, and asserts a wrong code gets 401. Needs cloudflared + network.
npm run test:e2e -w codeshare
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

## Installing

Not on the Marketplace — install the VSIX directly. Build it (`npm run package -w codeshare`) or
take the prebuilt `packages/extension/codeshare-0.1.0.vsix`, then:

```bash
code --install-extension codeshare-0.1.0.vsix
```

Or in VSCode: Extensions view → `...` menu → **Install from VSIX...**. Reload the window after.

**Hosts also need `cloudflared`** (guests do not):

```bash
brew install cloudflared                             # macOS
winget install --id Cloudflare.cloudflared           # Windows
# Linux / WSL: download the binary from
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

### Hosting from Windows or WSL

Both work. Tunnel mode is strongly preferred on WSL: WSL2 has its own NAT, so `tunnel: "off"`
would additionally need a `netsh interface portproxy` rule on the Windows side. In tunnel mode
everything stays inside WSL and dials outward.

The requirement is that **`cloudflared` is installed in the same environment as the extension**:

- Extension running inside WSL → install `cloudflared` inside the WSL distro. A copy on the Windows
  host cannot reach the server, which listens on WSL's loopback.
- Extension on native Windows → `winget install --id Cloudflare.cloudflared`.

`.cmd`/`.bat` shims from Scoop/Chocolatey are handled (the tunnel is spawned through a shell on
Windows so non-`.exe` shims resolve).

### WSL, SSH remotes, and dev containers

The extension writes `.mcp.json` into the workspace, so it must run in the **same filesystem
context as your AI assistant**. If you use a WSL/SSH/container window, install the VSIX *in that
remote* (open the remote window first, then install — or use the "Install in WSL: …" button),
otherwise `.mcp.json` lands on the wrong side and your assistant silently starts with no codeshare
tools. The guest flow warns when it detects a remote window.

### Developing on it

Press **F5** to launch an Extension Development Host with codeshare loaded (`.vscode/launch.json`
builds first). Faster than install/uninstall cycles.

## Using it

### Host

**Prerequisite:** `cloudflared` on your PATH, in the same environment as the extension — see
[Installing](#installing). Without it, Start Session fails with install instructions for your
platform. (Not needed with `codeshare.tunnel: "off"`.)

1. Command Palette → **Codeshare: Start Session**.
2. Pick a folder to share. The status bar shows `Codeshare <id> (N connected)`, and a modal shows
   the URL and code (copy to clipboard).
3. Send the URL + code to your guest. Stop anytime with **Codeshare: Stop Session**.

Quick-tunnel hostnames are **ephemeral**: restart the session (or reload the window) and the URL
changes, so guests must be re-sent the new one. The extension shows a modal when this happens.

### Guest

1. Open the folder you want to work in.
2. Command Palette → **Codeshare: Connect as Guest**.
3. Paste the host's URL and code. The extension verifies the server, then writes `.mcp.json` with
   the `codeshare` remote MCP server (bearer header) so your AI assistant connects to the shared
   folder. Allow an *insecure* connection only for LAN/dev hosts using a self-signed cert.

## Configuration (`codeshare.*`)

| Setting | Default | Meaning |
|---------|---------|---------|
| `codeshare.tunnel` | `cloudflared` | `cloudflared` = publish via Cloudflare quick tunnel; `off` = serve directly |
| `codeshare.port` | `8443` | Host server port |
| `codeshare.host` | `0.0.0.0` | Bind address in direct mode (ignored in tunnel mode, which forces `127.0.0.1`) |
| `codeshare.maxFileSizeMb` | `10` | Cap on files the tools read/write |
| `codeshare.cert` / `codeshare.key` | `""` | Optional real PEM cert/key for the host server |

## License

MIT
