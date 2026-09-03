import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { validatePath, writeFileExclusiveNew, writeFileAtomicReplace } from './paths.js';
import { generateSessionCode, generateSessionId, safeEqual, SESSION_CODE_LENGTH } from './session.js';

async function makeRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codeshare-paths-'));
  await fs.mkdir(path.join(dir, 'sub'));
  await fs.writeFile(path.join(dir, 'sub', 'file.txt'), 'hello');
  await fs.writeFile(path.join(dir, 'target.txt'), 'original');
  return dir;
}

describe('validatePath', () => {
  it('accepts an existing file inside root', async () => {
    const root = await makeRoot();
    const realRoot = await fs.realpath(root);
    const r = await validatePath(root, 'sub/file.txt', { mustExist: true });
    expect(r.exists).toBe(true);
    expect(r.relativePath).toBe('sub/file.txt');
    expect(r.absolutePath).toBe(path.join(realRoot, 'sub', 'file.txt'));
  });

  it('rejects absolute paths', async () => {
    const root = await makeRoot();
    await expect(validatePath(root, '/etc/passwd')).rejects.toThrow('absolute');
    await expect(validatePath(root, 'C:\\Windows\\x')).rejects.toThrow(); // backslash check fires
  });

  it('rejects .. traversal', async () => {
    const root = await makeRoot();
    await expect(validatePath(root, '../other')).rejects.toThrow('".."');
    await expect(validatePath(root, 'sub/../../x')).rejects.toThrow('".."');
  });

  it('rejects backslashes and null bytes', async () => {
    const root = await makeRoot();
    await expect(validatePath(root, 'sub\\file.txt')).rejects.toThrow('backslash');
    await expect(validatePath(root, 'a\0b')).rejects.toThrow('null byte');
  });

  it('returns not-existing for a new file under root', async () => {
    const root = await makeRoot();
    const realRoot = await fs.realpath(root);
    const r = await validatePath(root, 'sub/new.txt');
    expect(r.exists).toBe(false);
    expect(r.absolutePath).toBe(path.join(realRoot, 'sub', 'new.txt'));
  });

  it('mustExist throws for a missing file', async () => {
    const root = await makeRoot();
    await expect(validatePath(root, 'missing.txt', { mustExist: true })).rejects.toThrow('does not exist');
  });

  it('blocks a symlink escape', async () => {
    const root = await makeRoot();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'codeshare-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret');
    await fs.symlink(outside, path.join(root, 'link'));
    await expect(validatePath(root, 'link/secret.txt')).rejects.toThrow(/outside|escape/);
  });
});

describe('write helpers', () => {
  it('writeFileExclusiveNew refuses to overwrite an existing file', async () => {
    const root = await makeRoot();
    await expect(writeFileExclusiveNew(path.join(root, 'target.txt'), 'x')).rejects.toThrow();
    const after = await fs.readFile(path.join(root, 'target.txt'), 'utf8');
    expect(after).toBe('original');
  });

  it('writeFileExclusiveNew creates a brand-new file', async () => {
    const root = await makeRoot();
    await writeFileExclusiveNew(path.join(root, 'fresh.txt'), 'fresh');
    expect(await fs.readFile(path.join(root, 'fresh.txt'), 'utf8')).toBe('fresh');
  });

  it('writeFileAtomicReplace overwrites existing content', async () => {
    const root = await makeRoot();
    await writeFileAtomicReplace(path.join(root, 'target.txt'), 'replaced');
    expect(await fs.readFile(path.join(root, 'target.txt'), 'utf8')).toBe('replaced');
    const leftovers = (await fs.readdir(root)).filter((n) => n.startsWith('.codeshare.tmp'));
    expect(leftovers).toHaveLength(0);
  });
});

describe('session', () => {
  it('generates a 6-digit numeric code by default', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateSessionCode();
      expect(code).toMatch(/^\d{6}$/);
    }
    expect(generateSessionCode().length).toBe(SESSION_CODE_LENGTH);
  });

  it('generates a session id of the expected shape', () => {
    expect(generateSessionId()).toMatch(/^[0-9a-f]{8}$/);
  });

  it('safeEqual is true for equal strings and false otherwise', () => {
    expect(safeEqual('123456', '123456')).toBe(true);
    expect(safeEqual('123456', '123457')).toBe(false);
    expect(safeEqual('123456', '12345')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('safeEqual does not throw on arbitrary unicode input', () => {
    expect(safeEqual('héllo😀', 'héllo😀')).toBe(true);
    expect(safeEqual('héllo😀', 'héllo😃')).toBe(false);
  });
});
