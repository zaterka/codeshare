# codeshare — VSCode Extension Plan (P2P, host-exposed MCP)

## Goal

Build a VSCode extension named **codeshare** that lets a developer share an in‑progress folder
directly (**peer‑to‑peer**) with another developer over the internet, where the remote participant's
**local AI assistant** gains read+write access to the shared files through a **remote MCP server**.
"Live Share, but the guest is an AI."

**The design is zero-infrastructure on our side:** the HOST runs the MCP server, bound to their own
folder, and the GUEST's AI connects to it as a remote MCP client. No relay of ours, no mirror
folders, no sync engine.

> **Revision (post-v1 testing).** The original plan assumed a *direct* TLS channel and claimed data
> never flows through a third party. That held only when host and guest share a LAN or VPN. For the
> real use case — collaborators in different countries, no shared network, no router access — the
> host cannot accept inbound connections, so the direct path was unreachable in practice, and the
> self-signed-certificate path could not work at all because a guest's AI assistant has no way to
> skip certificate validation.
>
> So reachability is now a **choice** (`codeshare.tunnel`):
> - `cloudflared` (default): host binds loopback; `cloudflared` dials **out** to Cloudflare, which
>   publishes a `*.trycloudflare.com` hostname with a publicly-trusted certificate. Works anywhere,
>   no port-forward or VPN. **TLS terminates at Cloudflare's edge, so this path is not end-to-end
>   private** — the "never through a third party" property is traded away for reachability.
> - `off`: the original direct path, preserved unchanged. End-to-end, but needs LAN/VPN/port-forward.
>
> WebRTC NAT-punching remains the way to get both properties at once; still future work.

Satisfied end‑to‑end scenario (acceptance):

> Host Alice has `/project` open. She runs **Codeshare: Start Session**, picks `/project`, sets a
> session code, and the extension starts an authenticated MCP server (streamable HTTP/TLS)
> exposing `/project`, returning a connection URL. Remote developer Bob runs **Codeshare: Connect
> Guest**, enters Alice's URL + session code; the extension registers that remote MCP server with
> Bob's AI assistant. Bob's assistant calls `codeshare_read_file` / `codeshare_edit_file` /
> `codeshare_write_file`, and Alice sees the changes appear in `/project` (her AI writes through
> the same server). Nothing else is involved.

## Success criteria

1. **Host** command starts a streamable‑HTTP MCP server (TLS/WSS) bound to the chosen folder,
   protected by a session code, and prints a ready-to-connect URL.
2. **Guest** command takes `url + session code`, validates the connection, and wires it into the
   guest's AI as a remote MCP server.
3. MCP tools read/edit/write/list/grep/delete the shared folder with robust path‑traversal
   protection and sensible file-size caps.
4. No relay, persistent store, or cloud service **of ours** runs anywhere in the flow. (In the
   default `cloudflared` mode a Cloudflare quick tunnel carries the traffic — third-party transit,
   not third-party storage; `codeshare.tunnel: "off"` removes it.)
5. Automated tests cover auth rejection, path-safety, tool semantics, and the TLS transport.

## Tech stack

- **TypeScript** (strict) throughout.
- **npm workspaces** monorepo (Node 26 / npm 11 present).
- **esbuild** to bundle the MCP server and extension.
- **vitest** for tests.
- **@modelcontextprotocol/sdk** (v1.30.x) — `StreamableHTTPServerTransport` for the host server.
- Transport: Node `https` (TLS) + `WebSocket` upgrade; `Authorization: Bearer <session-code>` for auth.

## Repository layout (npm workspaces)

```
codeshare/
  package.json                # workspaces root, build order (shared first)
  tsconfig.base.json
  README.md                   # how to run, connect, and reach the host (LAN / VPN / port-forward)
  packages/
    shared/                   # codeshare-shared: path-safety, session-code gen/verify, types
      src/paths.ts
      src/session.ts
      src/types.ts
      package.json
    host/                     # codeshare-host: the MCP server the host runs
      src/server.ts           # TlsMcpServer: starts https server + streamable HTTP MCP transport
      src/tools/              # read/write/edit/delete/list/grep handlers
      src/index.ts            # CLI entry (for dev/testing) + exported factory used by extension
      package.json
    extension/                # codeshare-extension: the VSCode extension
      src/extension.ts        # activate/deactivate
      src/host.ts             # Start Session flow
      src/guest.ts            # Connect Guest flow (register remote MCP with the assistant)
      src/status.ts           # status bar + state persistence
      package.json
```

## Architecture & data flow

- **Host side (server):** the extension starts Node's `https` server with a TLS cert (see "TLS &
  session code") and mounts a **streamable‑HTTP MCP endpoint** (`/codeshare`) that serves `POST` (SSE)
  and `GET` over plain HTTP semantics (no WebSocket — the SDK has no server‑side WS transport).
  Every request is checked for `Authorization: Bearer <session-code>`; mismatches return 401.
- The MCP server binds its `tools` to the selected **root folder**. Tools resolve every path against
  that root with a robust containment check (see Edge cases), so an AI can only touch files under the
  shared folder.
- **Guest side (client extension):** the guest runs the **same codeshare extension** (both sides must
  have it). The guest does **not** maintain a mirror or replicate files. The guest extension provides
  **Connect Guest** which:
  1. `initialize` + `listTools` against the host's URL+code (sending `Authorization: Bearer <code>`)
     to verify reachability and auth, then
  2. **persists the remote MCP server entry (URL, the bearer header, tools)** for the guest's
     assistant (Claude Code / Copilot support remote HTTP MCP servers via a static `Authorization`
     header — e.g. `claude mcp add --transport http <url> --header "Authorization: Bearer <code>"`),
     and
  3. reports its own guest session to the host extension so the host can show connected guests.
  The guest's AI then calls the host's tools directly over the TLS channel using that header.
- **Host visibility of who's connected:** the host's per‑session transport router (see Host section)
  already tracks one session per connected MCP client. The host extension surfaces a **live list of
  connected guest sessions** (status bar badge + a notification on join/leave), so the host knows when
  a guest connects and disconnects. Identity is session‑id based in v1 (no separate username hello).

## Host MCP server (packages/host)

- `TlsMcpServer.start({ root, port, sessionCode, cert, allowMultipleSessions })`:
  - Starts an `https.Server`.
  - Mounts a **per‑session connection router** at `/codeshare`. Because the SDK's single
    `StreamableHTTPServerTransport` is single‑session per instance, the router:
    1. On `POST` containing an `initialize` request and **no** `mcp-session-id`, mints a session id,
       creates a new `StreamableHTTPServerTransport` **and a new tools‑bound `McpServer`**, connects
       them (`onsessioninitialized` to avoid races), and registers them in
       `Map<sessionId, { transport, mcpServer }>`.
    2. Routes subsequent `POST`/`GET`/`DELETE` for that session id to the existing transport.
    3. On `DELETE` (`onsessionclosed`) or close, removes the session from the map so one client's
       teardown never affects another (host AI and guest AI coexist independently).
  - Every request first passes through a **bearer‑auth middleware**: compare `Authorization: Bearer
    <code>` against `sessionCode` with a constant‑time compare; 401 + `WWW-Authenticate: Bearer` on
    mismatch. This is our own middleware — the SDK's `requireBearerAuth` only supports an OAuth
    verifier, not a static secret.
  - **Transport is streamable HTTP only (POST + GET SSE); NO WebSocket.** The SDK ships no server‑side
    WS transport, and Claude Code/Cursor/generic clients all support `type:"http"`
    (streamable HTTP POST+GET) natively.
  - Registers the tools (below) via **`registerTool`** (not deprecated `tool()`), rooted at `root`.
  - Returns `{ url, close() }`; `close()` tears down the session registry + https server.
- CLI `codeshare-host serve --root … --port … [--session-code …] [--cert … --key …]` for manual/dev use.

### Tools (all require auth; all enforce root containment)

- `codeshare_read_file(path)` → content (size + encoding caps).
- `codeshare_write_file(path, content)` → creates/overwrites (returns new mtime; description notes
  overwrite semantics).
- `codeshare_edit_file(path, find, replace, occurrence=1)` → read → replace **the `occurrence`-th
  match** (1‑based, computed on original content, no index shifting) → write back. Atomic fail (no
  write) if fewer matches than `occurrence`.
- `codeshare_list_files(dir?, recursive?)` → path list (prunes ignored dirs: `.git`, `node_modules`).
- `codeshare_delete_file(path)`.
- `codeshare_grep(pattern, dir?)` → file:line matches (regex, bounded result set).

## TLS & session code

- **Session code:** random 6‑digit code generated at session start; stored only in the host's
  `context.globalState` and shared with the guest out‑of‑band. Used as a static `Authorization:
  Bearer <code>` header on both sides.
- **Certificate — primary path is a user‑supplied/reverse‑proxy cert, not ephemeral self‑signed.**
  Remote MCP clients (Claude Code, Cursor) make trusting a self‑signed cert awkward (only a
  per‑process `NODE_EXTRA_CA_CERTS` lever; an *ephemeral* cert also changes every session so it can't
  even be pinned). So: the recommended deployment is placing `codeshare` behind the user's own reverse
  proxy (Caddy/nginx) with a real/trusted TLS cert. We keep `--cert/--key` for that, and document
  ephemeral self‑signed as **LAN/dev‑only** (with `NODE_EXTRA_CA_CERTS` note). Streamable HTTP
  (POST+GET) proxies cleanly behind TLS termination.
- **Reachability is now a code feature (`codeshare.tunnel`), not just a caveat.** In `cloudflared`
  mode the host needs no inbound reachability at all and TLS is handled by Cloudflare's real
  certificate, so neither `--cert/--key` nor the self-signed fallback is used. In `off` mode the
  original caveat stands: the host must be reachable on the chosen port via LAN, VPN
  (Tailscale/Zerotier), or an inbound port-forward.
- **Tunnel lifecycle:** the `cloudflared` child process is owned by the extension — spawned on
  `codeshare.start`, killed (SIGTERM then SIGKILL) on `codeshare.stop`, on deactivate, and on a
  failed start.
- **Readiness, not just publication.** Measured against cloudflared 2026.8.3: the banner containing
  the hostname prints ~2s before DNS resolves, and cloudflared itself warns the URL "may take some
  time to be reachable". Resolving on the banner alone was observed to hand out a URL that failed
  with `ENOTFOUND`. `startTunnel` therefore probes `<origin>/codeshare` until it returns a non-5xx —
  a 401 proves the edge is routing to *our* process, not just that DNS resolved — before reporting
  the URL to the host. Quick-tunnel hostnames are ephemeral, so `restoreHost` re-derives the URL after a
  reload and warns the host that guests need the new one.

## VSCode extension (packages/extension)

- Commands:
  - `codeshare.start` — pick folder, generate session code + chosen port, start `TlsMcpServer`, show
    URL+code, persist state.
  - `codeshare.stop` — stop server, clear status.
  - `codeshare.connectGuest` — input URL + code, verify (initialize + listTools), register remote MCP
    with the assistant, show success/error.
- **Connected‑guest visibility (host):** the host extension subscribes to the `TlsMcpServer` session
  registry and shows a **live count/list of connected guest sessions** — status bar badge updated on
  join/leave plus an info notification when a guest connects (`"Bob's session joined"` → actually a
  session‑id notification in v1). Gives the host "who's connected" without identity.
- Status bar shows session id/port + role (Host/Guest). Restore host on `onStartupFinished` if a
  session was active (persisted `workspaceState`), and clear that state on `codeshare.stop` so a
  stopped session is never silently re-served.
- Configuration: `codeshare.port` (default 8443), `codeshare.host` (default `0.0.0.0`),
  `codeshare.maxFileSizeMb` (default 10), and optional `codeshare.cert`/`codeshare.key` PEM paths.
  Deviation from the original sketch: instead of `certDir` + `trustedProxyBasePath`, the host binds
  `/codeshare` on its own port and accepts a real cert/key pair; when none is supplied it generates
  an ephemeral self-signed cert cached under `globalStorage` (LAN/dev only). Reverse-proxy TLS with a
  real cert remains the primary internet path.
- Requires NO VSCode types in `shared` or `host`; extension wires them.

## Edge cases & failure modes

- **Path safety (robust, modeled on `@modelcontextprotocol/server-filesystem` `validatePath`):**
  reject `..` / absolute / null‑byte inputs on normalize, `resolve` against root, then check
  containment; `realpath` the target — and **`realpath` the parent directory for not‑yet‑existing
  files** (write/edit) since `realpath` throws ENOENT on new files — then re‑check containment.
  Writes use `{flag:'wx'}` (exclusive create, fails on a pre‑existing symlink) and an **atomic
  temp‑file + `fs.rename`** for overwrites (rename doesn't follow symlinks), closing the
  check‑to‑write TOCTOU race. On case‑insensitive filesystems containment is enforced by comparing
  the realpath'‑canonicalized paths (existing targets resolve to their on‑disk case; new files
  resolve their parent), so a wrong‑case input either maps to the real file or fails to create —
  it cannot escape the root. All unit‑tested.
- **Auth:** missing/wrong bearer → 401 + `WWW-Authenticate: Bearer`; no fallback; constant‑time
  compare; code never logged. Guest registers the header so the AI client sends it on every call.
- **Concurrent MCP clients:** the per‑session transport router (see Host section) keeps the host AI
  and guest AI in independent sessions; one client's `DELETE`/teardown never kills the others.
- **Oversized file / binary:** configurable cap (default 10 MB); returns a bounded/declined result,
  never streams unbounded memory.
- **Edit atomicity / occurrence semantics** as specified above; under‑match fails without writing.
- **Concurrent edits from host AI and guest AI** are ordinary MCP writes — last write wins; no
  CRDT/merge (documented, acceptable for v1). `edit_file` is a whole‑file read‑modify‑write; the
  write path is TOCTOU‑safe as above, and we return the new mtime so callers can detect cross‑writes.
- **TLS handshake / self‑signed trust** failures surface with clear guidance (reverse proxy with a
  real cert; ephemeral self‑signed is LAN/dev‑only).
- **Port already in use / bind failure** → clear error; suggest free port.
- **Guest reachability failure / timeout** during verification → clear message (reachability caveat).

## Tests

- `shared`: path‑safety (traversal/absolute/null‑byte/symlink/new‑file-parent, case‑insensitive),
  session‑code gen rules (length/format/random).
- `host`: `registerTool` handlers against a temp root (read/write/edit incl. occurrence + atomic‑fail,
  delete, list prunes ignored dirs, grep bounds); containment rejection for traversal; bearer‑auth
  401 (raw HTTP status + SDK client `UnauthorizedError`); TLS loopback roundtrip via SDK `Client` +
  `StreamableHTTPClientTransport` with `requestInit` bearer (initialize + callTool).
- `host` integration (the critical seam): **two concurrent SDK clients** to one server — both
  initialize, each writes independently; `DELETE` one session and confirm the other keeps working.
- `extension`: unit‑test the state/merge/config logic (VSCode UI verified manually via F5/Dev Host;
  headless command registration out of scope for v1).

## Acceptance / how to verify

1. `npm install && npm run build && npm test` at repo root — all green (root build ensures `shared`
   compiles before `host`/`extension`).
2. `codeshare-host serve --root <tmp> --port <p> --session-code test` — a small SDK MCP client
   connects with the code and calls `codeshare_write_file` + `codeshare_read_file`; confirm the file
   appears on disk. Reject a wrong code (401).
3. MCP tool suite exercised in vitest (HTTPS roundtrip over loopback).
4. Extension: `F5` start a session, connect a guest's assistant, have the assistant edit a file, and
   confirm it lands in the host folder (manual).

## Assumptions (explicit)

- **Both the host and the guest run the codeshare extension** (per user decision), so the host can see
  who is connected. The guest extension wires the remote MCP server into the guest's AI and reports its
  session to the host.
- The guest's AI assistant supports remote/HTTP (streamable) MCP servers — true for current Claude
  Code / Copilot / generic MCP clients.
- No mirror, no relay, no persistence, no auth service: everything is the host's TLS server and the
  guest's MCP client; session code is the shared secret. Production‑grade auth/identity is out of
  scope for v1 (host sees connected sessions by session id, not usernames).
- Reachability (LAN/VPN/port‑forward) is the user's responsibility; documented. WebRTC NAT‑punching
  is a possible future enhancement, not v1.
- Self‑signed TLS with a documented trust/reverse‑proxy path; the user may supply their own cert.
