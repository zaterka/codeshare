import { describe, it, expect } from 'vitest';
import { buildMcpServerEntry, mergeMcpConfig, hostSummary } from './state.js';

describe('buildMcpServerEntry', () => {
  it('builds a Claude-Code / MCP-compatible http entry with bearer auth', () => {
    const entry = buildMcpServerEntry('https://host:8443/codeshare', '123456');
    expect(entry).toEqual({
      type: 'http',
      url: 'https://host:8443/codeshare',
      headers: { Authorization: 'Bearer 123456' },
    });
  });

  it('normalizes a URL lacking a scheme to https', () => {
    const entry = buildMcpServerEntry('myhost:8443/codeshare', '000000');
    expect(entry.url).toBe('https://myhost:8443/codeshare');
  });

  it('leaves an http:// URL scheme intact', () => {
    const entry = buildMcpServerEntry('http://localhost:8443/codeshare', '111111');
    expect(entry.url).toBe('http://localhost:8443/codeshare');
  });
});

describe('mergeMcpConfig', () => {
  it('creates mcpServers when none exists', () => {
    const merged = mergeMcpConfig(undefined, buildMcpServerEntry('http://x/codeshare', '1'));
    expect(merged.mcpServers['codeshare']).toBeTruthy();
    expect(Object.keys(merged.mcpServers)).toEqual(['codeshare']);
  });

  it('preserves unrelated servers and merges the codeshare entry', () => {
    const existing = { mcpServers: { other: { type: 'stdio', command: 'x' } } };
    const merged = mergeMcpConfig(existing, buildMcpServerEntry('http://x/codeshare', '1'));
    expect(merged.mcpServers['other']).toEqual({ type: 'stdio', command: 'x' });
    expect((merged.mcpServers['codeshare'] as { headers: Record<string, string> }).headers['Authorization']).toBe(
      'Bearer 1',
    );
  });

  it('replaces an existing codeshare entry without mutating the input', () => {
    const existing = {
      mcpServers: { codeshare: { type: 'http', url: 'old' }, keep: { type: 'http', url: 'y' } },
    };
    const merged = mergeMcpConfig(existing, buildMcpServerEntry('http://new/codeshare', '2'));
    expect(existing.mcpServers['codeshare']).toEqual({ type: 'http', url: 'old' }); // unchanged
    expect(merged.mcpServers['codeshare']).toEqual(buildMcpServerEntry('http://new/codeshare', '2'));
    expect(merged.mcpServers['keep']).toBeTruthy();
  });
});

describe('hostSummary', () => {
  it('renders the connection details', () => {
    const summary = hostSummary({
      id: 'abc12345',
      root: '/path/to/folder',
      sessionCode: '123456',
      url: 'https://localhost:8443/codeshare',
    });
    expect(summary).toContain('abc12345');
    expect(summary).toContain('/path/to/folder');
    expect(summary).toContain('123456');
    expect(summary).toContain('https://localhost:8443/codeshare');
  });
});
