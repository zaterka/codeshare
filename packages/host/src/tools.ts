import path from 'node:path';
import fs from 'node:fs/promises';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  validatePath,
  writeFileExclusiveNew,
  writeFileAtomicReplace,
  type SafePathResult,
} from '@codeshare/shared';

export interface ToolContext {
  root: string;
  maxFileSizeBytes: number;
  ignoredDirs: string[];
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

async function readFileAsText(safe: SafePathResult, maxBytes: number): Promise<string> {
  const st = await fs.stat(safe.absolutePath);
  if (st.size > maxBytes) {
    throw new Error(`File too large (${st.size} bytes > ${maxBytes} byte cap). Refusing to read.`);
  }
  const buf = await fs.readFile(safe.absolutePath);
  // Guard against binary content: null bytes are a strong signal.
  if (buf.includes(0)) {
    throw new Error('Refusing to return binary content as text.');
  }
  return buf.toString('utf8');
}

async function walkFiles(
  dirAbs: string,
  relPrefix: string,
  ignoredDirs: string[],
  out: string[],
  depth = 0,
): Promise<void> {
  if (depth > 32) return; // depth guard against nastiness
  const entries = await fs.readdir(dirAbs, { withFileTypes: true });
  for (const e of entries) {
    const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (ignoredDirs.includes(e.name)) continue;
      await walkFiles(path.join(dirAbs, e.name), rel, ignoredDirs, out, depth + 1);
    } else if (e.isFile() || e.isSymbolicLink()) {
      out.push(rel);
    }
  }
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  const { root, maxFileSizeBytes, ignoredDirs } = ctx;

  server.registerTool(
    'codeshare_read_file',
    {
      title: 'Read file',
      description:
        'Read the full text content of a file inside the shared folder. Returns an error if the file is too large or binary.',
      inputSchema: { path: z.string().describe('Path relative to the shared folder root') },
    },
    async ({ path: p }) => {
      try {
        const safe = await validatePath(root, p, { mustExist: true });
        const content = await readFileAsText(safe, maxFileSizeBytes);
        return textResult(content);
      } catch (err) {
        return textResult(`codeshare_read_file error: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    'codeshare_write_file',
    {
      title: 'Write file',
      description:
        'Create a new file (fails if it already exists) or overwrite an existing file inside the shared folder. '
        + 'Overwriting replaces the whole file. Note: parent directories are NOT created automatically; '
        + 'use a path whose parent already exists.',
      inputSchema: { path: z.string(), content: z.string() },
    },
    async ({ path: p, content }) => {
      try {
        const safe = await validatePath(root, p);
        if (Buffer.byteLength(content, 'utf8') > maxFileSizeBytes) {
          throw new Error(`Content exceeds ${maxFileSizeBytes} byte cap.`);
        }
        if (safe.exists) {
          await writeFileAtomicReplace(safe.absolutePath, content);
        } else {
          await writeFileExclusiveNew(safe.absolutePath, content);
        }
        const st = await fs.stat(safe.absolutePath);
        return textResult(`Wrote ${safe.relativePath} (${st.size} bytes).`);
      } catch (err) {
        return textResult(`codeshare_write_file error: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    'codeshare_edit_file',
    {
      title: 'Edit file',
      description:
        'Replace the Nth (1-based) occurrence of `find` with `replace` in a file, then write the whole file back. '
        + 'Fails atomically (no write) if fewer than `occurrence` matches exist. Occurrence indices are computed '
        + 'against the original content. This is a whole-file read-modify-write; concurrent edits are last-write-wins.',
      inputSchema: {
        path: z.string(),
        find: z.string(),
        replace: z.string(),
        occurrence: z.number().int().min(1).default(1),
      },
    },
    async ({ path: p, find, replace, occurrence }) => {
      try {
        const safe = await validatePath(root, p, { mustExist: true });
        const content = await readFileAsText(safe, maxFileSizeBytes);
        // Find all match indices based on the original content.
        const indices: number[] = [];
        let from = 0;
        let idx: number;
        while ((idx = content.indexOf(find, from)) !== -1) {
          indices.push(idx);
          from = idx + find.length;
          if (find.length === 0) break; // guard against empty match infinite loop
        }
        if (indices.length < occurrence) {
          throw new Error(
            `Found ${indices.length} match(es) for find; requested occurrence ${occurrence}. No change written.`,
          );
        }
        const target = indices[occurrence - 1] as number;
        const edited = content.slice(0, target) + replace + content.slice(target + find.length);
        await writeFileAtomicReplace(safe.absolutePath, edited);
        return textResult(`Replaced occurrence ${occurrence} in ${safe.relativePath}.`);
      } catch (err) {
        return textResult(`codeshare_edit_file error: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    'codeshare_list_files',
    {
      title: 'List files',
      description:
        'List files under a directory (default root). Recursively lists all files when `recursive` is true. '
        + 'Skips ignored directories such as .git and node_modules.',
      inputSchema: {
        dir: z.string().optional().describe('Directory relative to root; default "."'),
        recursive: z.boolean().optional().default(false),
      },
    },
    async ({ dir, recursive }) => {
      try {
        const target = dir && dir !== '.' ? dir : '.';
        const safe = await validatePath(root, target, { mustExist: true });
        if (recursive) {
          const files: string[] = [];
          await walkFiles(safe.absolutePath, safe.relativePath === '.' ? '' : safe.relativePath, ignoredDirs, files);
          return textResult(files.length ? files.join('\n') : '(no files)');
        }
        const entries = await fs.readdir(safe.absolutePath, { withFileTypes: true });
        const names = entries
          .filter((e) => !(e.isDirectory() && ignoredDirs.includes(e.name)))
          .map((e) => e.name);
        return textResult(names.length ? names.join('\n') : '(empty directory)');
      } catch (err) {
        return textResult(`codeshare_list_files error: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    'codeshare_delete_file',
    {
      title: 'Delete file',
      description: 'Delete a file inside the shared folder. Fails if the path is a directory or does not exist.',
      inputSchema: { path: z.string() },
    },
    async ({ path: p }) => {
      try {
        const safe = await validatePath(root, p, { mustExist: true });
        const st = await fs.lstat(safe.absolutePath);
        if (st.isDirectory()) {
          throw new Error('Refusing to delete a directory.');
        }
        await fs.rm(safe.absolutePath, { force: true });
        return textResult(`Deleted ${safe.relativePath}.`);
      } catch (err) {
        return textResult(`codeshare_delete_file error: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    'codeshare_grep',
    {
      title: 'Grep',
      description:
        'Search file contents in the shared folder for a regular expression. Returns up to 200 file:line matches.',
      inputSchema: {
        pattern: z.string().describe('Regular expression to search for'),
        dir: z.string().optional().describe('Directory relative to root; default "."'),
      },
    },
    async ({ pattern, dir }) => {
      try {
        const target = dir && dir !== '.' ? dir : '.';
        const safe = await validatePath(root, target, { mustExist: true });
        let re: RegExp;
        try {
          re = new RegExp(pattern);
        } catch {
          throw new Error(`Invalid regular expression: ${pattern}`);
        }
        const files: string[] = [];
        await walkFiles(
          safe.absolutePath,
          safe.relativePath === '.' ? '' : safe.relativePath,
          ignoredDirs,
          files,
        );
        const results: string[] = [];
        let total = 0;
        for (const rel of files) {
          const abs = safe.absolutePath === root ? path.join(root, rel) : path.join(safe.absolutePath, rel);
          const st = await fs.stat(abs).catch(() => null);
          if (!st || st.size > maxFileSizeBytes) continue;
          const text = await fs.readFile(abs, 'utf8').catch(() => null);
          if (text == null) continue;
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i]!)) {
              results.push(`${rel}:${i + 1}:${lines[i]}`);
              total++;
              if (total >= 200) break;
            }
          }
          if (total >= 200) break;
        }
        return textResult(results.length ? results.join('\n') : `(no matches for ${pattern})`);
      } catch (err) {
        return textResult(`codeshare_grep error: ${(err as Error).message}`, true);
      }
    },
  );
}
