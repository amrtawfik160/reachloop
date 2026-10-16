import path from 'node:path';
import { helperFileName } from '../src/x/tls-helper';

const TARGETS = {
  'linux-x64': { platform: 'linux', arch: 'x64' },
  'linux-arm64': { platform: 'linux', arch: 'arm64' },
  'darwin-x64': { platform: 'darwin', arch: 'x64' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64' },
} as const;

type TargetName = keyof typeof TARGETS;

function isTargetName(value: string): value is TargetName {
  return value in TARGETS;
}

const [entry, name, requested = `${process.platform}-${process.arch}`, outDir = 'dist'] = process.argv.slice(2);
if (!entry || !name || !isTargetName(requested)) {
  process.stderr.write(`usage: bun scripts/build.ts <entry> <name> [${Object.keys(TARGETS).join('|')}] [outDir]\n`);
  process.exit(2);
}

const helper = helperFileName(TARGETS[requested]);
if (!helper) throw new Error(`no cycletls helper for ${requested}`);
const helperPath = path.join('node_modules', 'cycletls', 'dist', helper);
const outfile = path.join(outDir, `${name}-${requested}`);

const proc = Bun.spawnSync(
  [
    'bun', 'build', '--compile', `--target=bun-${requested}`,
    '--asset-naming=[name]', entry, helperPath, '--outfile', outfile,
  ],
  { stdout: 'inherit', stderr: 'inherit' },
);
process.exit(proc.exitCode ?? 1);
