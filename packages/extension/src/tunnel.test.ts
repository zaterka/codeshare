import { describe, expect, it } from 'vitest';
import { CloudflaredMissingError, startTunnel } from './tunnel.js';

/**
 * These tests drive `startTunnel` against a *fake* cloudflared: a short node script that mimics the
 * real binary's output. That exercises the part we actually own — spawning, scraping the hostname
 * out of the banner, and the failure paths — without needing cloudflared installed or network access.
 */

describe('startTunnel', () => {
  it('scrapes the quick-tunnel hostname from the banner on stderr', async () => {
    // The real binary prints a boxed banner to stderr; reproduce the shape, including noise lines.
    const script = [
      "process.stderr.write('INF Requesting new quick Tunnel on trycloudflare.com...\\n');",
      "process.stderr.write('INF +----------------------------------------+\\n');",
      "process.stderr.write('INF |  Your quick Tunnel has been created!   |\\n');",
      "process.stderr.write('INF |  https://witty-brave-otter-42.trycloudflare.com  |\\n');",
      "process.stderr.write('INF +----------------------------------------+\\n');",
      'setTimeout(() => {}, 60000);',
    ].join('');

    const tunnel = await startTunnel(8443, { binary: process.execPath, argv: ['-e', script], waitForReady: false });
    expect(tunnel.origin).toBe('https://witty-brave-otter-42.trycloudflare.com');
    await tunnel.close();
  });

  it('also accepts the hostname on stdout', async () => {
    const script =
      "process.stdout.write('https://a-b-c.trycloudflare.com\\n'); setTimeout(() => {}, 60000);";
    const tunnel = await startTunnel(8443, { binary: process.execPath, argv: ['-e', script], waitForReady: false });
    expect(tunnel.origin).toBe('https://a-b-c.trycloudflare.com');
    await tunnel.close();
  });

  it('reports a missing binary as CloudflaredMissingError with install guidance', async () => {
    await expect(startTunnel(8443, { binary: '/nonexistent/cloudflared-xyz' })).rejects.toBeInstanceOf(
      CloudflaredMissingError,
    );
    await expect(startTunnel(8443, { binary: '/nonexistent/cloudflared-xyz' })).rejects.toThrow(
      /brew install cloudflared/,
    );
  });

  it('fails when the process exits before publishing a hostname, quoting its last output', async () => {
    const script = "process.stderr.write('ERR failed to connect to edge\\n'); process.exit(1);";
    await expect(startTunnel(8443, { binary: process.execPath, argv: ['-e', script], waitForReady: false })).rejects.toThrow(
      /exited before publishing.*failed to connect to edge/s,
    );
  });

  it('classifies a shell "not recognized" exit as a missing binary (the Windows shell path)', async () => {
    // With `shell: true` a missing binary exits non-zero instead of raising ENOENT, so the message
    // has to be recovered from the shell's diagnostic.
    const script =
      "process.stderr.write(\"'cloudflared' is not recognized as an internal or external command\\n\"); process.exit(1);";
    await expect(startTunnel(8443, { binary: process.execPath, argv: ['-e', script], waitForReady: false })).rejects.toBeInstanceOf(
      CloudflaredMissingError,
    );
  });

  it('gives platform-appropriate install instructions', () => {
    expect(new CloudflaredMissingError('darwin').message).toMatch(/brew install cloudflared/);
    expect(new CloudflaredMissingError('win32').message).toMatch(/winget install/);
    // Linux/WSL must be warned that a Windows-side cloudflared cannot reach WSL loopback.
    const linux = new CloudflaredMissingError('linux').message;
    expect(linux).toMatch(/cloudflared-linux-amd64/);
    expect(linux).toMatch(/WSL loopback/);
  });

  it('fails when the published hostname never becomes routable', async () => {
    // Observed in practice: cloudflared prints the banner a couple of seconds before DNS resolves,
    // so resolving on the banner alone can hand the host a URL that the guest cannot yet reach.
    // This hostname will never resolve, so the readiness probe must reject rather than succeed.
    const script =
      "process.stderr.write('https://definitely-not-a-real-tunnel-zzq.trycloudflare.com\\n'); setTimeout(() => {}, 60000);";
    await expect(
      startTunnel(8443, {
        binary: process.execPath,
        argv: ['-e', script],
        readyTimeoutMs: 4000,
      }),
    ).rejects.toThrow(/never became reachable/);
  }, 30_000);

  it('ignores lookalike hostnames that are not trycloudflare.com', async () => {
    // Must not latch onto an attacker-ish or unrelated URL in the log stream.
    const script = [
      "process.stderr.write('INF see https://evil.trycloudflare.com.attacker.test/x\\n');",
      "process.stderr.write('INF https://real-one.trycloudflare.com\\n');",
      'setTimeout(() => {}, 60000);',
    ].join('');
    const tunnel = await startTunnel(8443, { binary: process.execPath, argv: ['-e', script], waitForReady: false });
    expect(tunnel.origin).toBe('https://real-one.trycloudflare.com');
    await tunnel.close();
  });
});
