import os from 'node:os';
import path from 'node:path';

export type Paths = { home: string; db: string; secretsFile: string };

export function resolvePaths(env: Record<string, string | undefined>): Paths {
  const home = env.REACHLOOP_HOME || defaultHome(env);
  return { home, db: path.join(home, 'reachloop.db'), secretsFile: path.join(home, 'secrets.json') };
}

function defaultHome(env: Record<string, string | undefined>): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'reachloop');
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'reachloop');
}
