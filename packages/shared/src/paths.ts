import path from 'node:path';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

/**
 * Robust path-safety: enforce that every path an AI tool touches resolves inside a fixed root,
 * even for not-yet-existing files (write/edit), across symlinks and case-insensitive filesystems.
 *
 * Modeled on the official `@modelcontextprotocol/server-filesystem` validatePath:
 *  1. reject bad input up front (absolute, containing `..`, null bytes),
 *  2. resolve + check containment,
 *  3. realpath the target (or its parent when the target doesn't exist yet) and re-check,
 *  4. compare against the realpath'd root so symlink escapes can't slip through.
 */

export interface SafePathResult {
  /** Absolute, realpath-resolved (or parent-resolved for new files) path inside root. */
  absolutePath: string;
  /** Relative path from root, forward-slashed (what MCP clients see / tools use). */
  relativePath: string;
  /** Whether the target file already exists on disk. */
  exists: boolean;
}

function assertSafeInput(p: string): void {
  if (p.includes('\0')) throw new Error('Invalid path: contains null byte');
  if (p.includes('\\')) throw new Error('Invalid path: backslashes are not supported; use forward slashes');
  // Reject absolute paths outright: a remote client should only ever name files within the root.
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) {
    throw new Error('Invalid path: absolute paths are not allowed');
  }
  // Reject any traversal segments.
  const segments = p.split('/');
  if (segments.some((s) => s === '..')) {
    throw new Error('Invalid path: ".." traversal is not allowed');
  }
}

function resolvesInside(abs: string, root: string): boolean {
  const rel = path.relative(root, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Validate that `p` (an AI-provided, root-relative path) stays inside `root`.
 *
 * For existing targets we realpath the full path; for new files we realpath the parent directory
 * (realpath throws ENOENT on non-existent paths) and append the basename. Either way the result is
 * re-checked for containment. Throws an Error on any attempt to escape the root.
 */
export async function validatePath(
  root: string,
  p: string,
  opts: { mustExist?: boolean } = {},
): Promise<SafePathResult> {
  const absRoot = await fs.realpath(root);
  assertSafeInput(p);

  const absCandidate = path.resolve(absRoot, p);
  if (!resolvesInside(absCandidate, absRoot)) {
    throw new Error(`Blocked: path "${p}" escapes the shared root`);
  }

  // Resolve symlinks: realpath the target if it exists, else realpath its parent directory.
  let real: string;
  let exists = false;
  try {
    real = await fs.realpath(absCandidate);
    exists = true;
  } catch {
    const parent = path.dirname(absCandidate);
    const realParent = await fs.realpath(parent);
    real = path.join(realParent, path.basename(absCandidate));
  }

  if (!resolvesInside(real, absRoot)) {
    throw new Error(`Blocked: path "${p}" resolves outside the shared root (symlink escape)`);
  }
  if (opts.mustExist && !exists) {
    throw new Error(`Path does not exist: ${p}`);
  }

  const rel = path.relative(absRoot, real);

  return {
    absolutePath: real,
    relativePath: rel.split(path.sep).join('/'),
    exists,
  };
}

/** Atomic helper: only open a brand-new file (fails if a symlink/file already exists at the path). */
export async function writeFileExclusiveNew(filePath: string, content: string | Buffer): Promise<void> {
  await fs.writeFile(filePath, content, {
    flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
  });
}

/** Atomic overwrite that does not follow symlinks: write a temp file then rename over the target. */
export async function writeFileAtomicReplace(filePath: string, content: string | Buffer): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `.codeshare.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );
  await fs.writeFile(tmp, content, { flag: fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY });
  try {
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}
