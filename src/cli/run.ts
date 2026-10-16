import { parseArgs } from 'node:util';
import { type AppDeps, openApp } from '../core/app';
import { type ExitCode, ReachloopError } from '../core/errors';
import type { Command } from './command';
import { accountCommands } from './commands/account';
import { inboxCommands } from './commands/inbox';
import { leadCommands } from './commands/lead';
import { limitsCommands } from './commands/limits';
import { setupCommands } from './commands/setup';
import { templateCommands } from './commands/template';
import { type Io, writeFailure, writeSuccess } from './output';

export const COMMANDS: Command[] = [
  ...setupCommands,
  ...accountCommands,
  ...leadCommands,
  ...templateCommands,
  ...inboxCommands,
  ...limitsCommands,
];

function findCommand(argv: string[]): { command: Command; rest: string[] } | null {
  const words = argv.slice(0, 2);
  if (words.length === 0 || words[0]?.startsWith('-')) {
    const status = COMMANDS.find((c) => c.path === 'status');
    return status ? { command: status, rest: argv } : null;
  }
  for (const length of [2, 1]) {
    const path = words.slice(0, length).join(' ');
    const command = COMMANDS.find((c) => c.path === path);
    if (command) return { command, rest: argv.slice(length) };
  }
  return null;
}

function overview(): string {
  const rows = COMMANDS.filter((c) => c.path !== 'status').map((c) => `  ${c.path.padEnd(16)} ${c.summary}`);
  return ['Usage: reachloop <command> [flags] [--json]', '', 'Commands:', ...rows, '', 'Run reachloop <command> --help for its flags.'].join('\n');
}

function commandHelp(command: Command): string {
  const flags = Object.entries(command.options).map(([name, spec]) => `  --${name}${spec.type === 'string' ? ' <value>' : ''}`);
  return [command.summary, '', `Usage: ${command.usage}`, ...(flags.length ? ['', 'Flags:', ...flags, '  --json'] : ['', 'Flags:', '  --json'])].join('\n');
}

export async function runCli(argv: string[], deps: AppDeps, io: Io): Promise<ExitCode> {
  const json = argv.includes('--json');
  if (argv[0] === 'help' || (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h'))) {
    io.stdout(`${overview()}\n`);
    return 0;
  }
  const found = findCommand(argv);
  if (!found) {
    return writeFailure(io, new ReachloopError('USAGE', `Unknown command: ${argv.slice(0, 2).join(' ')}.`, { hint: 'reachloop --help' }), json);
  }
  const { command, rest } = found;
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: rest,
      options: { ...command.options, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    return writeFailure(io, new ReachloopError('USAGE', (err as Error).message, { hint: `reachloop ${command.path} --help` }), json);
  }
  if (values.help) {
    io.stdout(`${commandHelp(command)}\n`);
    return 0;
  }
  const allowed = command.positionals ?? { min: 0, max: 0 };
  if (positionals.length < allowed.min || positionals.length > allowed.max) {
    return writeFailure(io, new ReachloopError('USAGE', `Usage: ${command.usage}`), json);
  }
  const base = { deps, io, values, positionals };
  let app: Awaited<ReturnType<typeof openApp>> | null = null;
  try {
    if (command.db === 'none') return writeSuccess(io, await command.run(base), json);
    app = await openApp(deps, { create: command.db === 'create' });
    return writeSuccess(io, await command.run({ ...base, app }), json);
  } catch (err) {
    return writeFailure(io, err, json);
  } finally {
    app?.db.close();
  }
}
