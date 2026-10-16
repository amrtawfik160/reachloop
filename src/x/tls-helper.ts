import { chmod, mkdir, rename, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HELPER_FILES: Record<string, Partial<Record<string, string>>> = {
  linux: { x64: 'index', arm64: 'index-arm64' },
  darwin: { x64: 'index-mac', arm64: 'index-mac-arm64' },
};

export type HelperTarget = { platform: string; arch: string };

export function helperFileName(target: HelperTarget): string | undefined {
  return HELPER_FILES[target.platform]?.[target.arch];
}

export function isCompiledBinary(modulePath: string = import.meta.path): boolean {
  return modulePath.startsWith('/$bunfs/');
}

function cacheRoot(): string {
  if (process.env.REACHLOOP_CACHE_DIR) return process.env.REACHLOOP_CACHE_DIR;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'reachloop');
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'reachloop');
}

// A compiled binary cannot spawn a file inside its own virtual file system, so
// the cycletls Go helper ships as an embedded asset and is unpacked once into
// the cache folder. Outside a compiled binary cycletls finds it in node_modules.
export async function resolveTlsHelperPath(): Promise<string | undefined> {
  if (!isCompiledBinary()) return undefined;
  const fileName = helperFileName({ platform: process.platform, arch: process.arch });
  const embedded = fileName ? Bun.embeddedFiles.find((file) => (file as File).name === fileName) : undefined;
  if (!fileName || !embedded) {
    throw new Error(
      `This reachloop build has no TLS helper for ${process.platform}-${process.arch}. Install a build for this platform.`,
    );
  }
  const bytes = new Uint8Array(await embedded.arrayBuffer());
  const target = path.join(cacheRoot(), `tls-helper-${Bun.hash(bytes).toString(16)}`);
  const existing = await stat(target).catch(() => null);
  if (existing?.size === bytes.byteLength) return target;
  await mkdir(path.dirname(target), { recursive: true });
  const partial = `${target}.${process.pid}.partial`;
  await Bun.write(partial, bytes);
  await chmod(partial, 0o755);
  await rename(partial, target);
  return target;
}
