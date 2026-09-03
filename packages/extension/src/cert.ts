import selfsigned from 'selfsigned';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface GeneratedCert {
  cert: string;
  key: string;
}

/**
 * Generate an ephemeral self-signed TLS cert/key, cached to `cacheDir` so the host can reuse it
 * (the cert only changes per host nickname, not per session, so guests could pin a fingerprint).
 * Used for LAN/dev only; for internet deploys users supply a real cert (reverse proxy).
 */
export async function ensureSelfSignedCert(cacheDir: string, nickname = 'codeshare'): Promise<GeneratedCert> {
  const certPath = path.join(cacheDir, `${nickname}.crt`);
  const keyPath = path.join(cacheDir, `${nickname}.key`);
  try {
    return { cert: await fs.readFile(certPath, 'utf8'), key: await fs.readFile(keyPath, 'utf8') };
  } catch {
    // generate
  }
  await fs.mkdir(cacheDir, { recursive: true });
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: 'codeshare' }],
    { days: 3650, keySize: 2048, algorithm: 'sha256' },
  );
  const generated: GeneratedCert = { cert: pems.cert, key: pems.private };
  await fs.writeFile(certPath, generated.cert, { mode: 0o600 });
  await fs.writeFile(keyPath, generated.key, { mode: 0o600 });
  return generated;
}
