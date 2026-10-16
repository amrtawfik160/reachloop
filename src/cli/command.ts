import type { App, AppDeps } from '../core/app';
import { ReachloopError } from '../core/errors';
import type { CommandResult, Io } from './output';

export type OptionSpec = Record<string, { type: 'string' | 'boolean' }>;

export type Values = Record<string, string | boolean | undefined>;

export type BareContext = { deps: AppDeps; io: Io; values: Values; positionals: string[] };
export type Context = BareContext & { app: App };

type CommandInfo = {
  path: string;
  usage: string;
  summary: string;
  options: OptionSpec;
  positionals?: { min: number; max: number };
};

export type Command =
  | (CommandInfo & { db: 'required' | 'create'; run: (ctx: Context) => Promise<CommandResult> })
  | (CommandInfo & { db: 'none'; run: (ctx: BareContext) => Promise<CommandResult> });

export function str(values: Values, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

export function requiredStr(values: Values, name: string): string {
  const value = str(values, name);
  if (!value) throw new ReachloopError('USAGE', `--${name} is required.`);
  return value;
}

export function bool(values: Values, name: string): boolean {
  return values[name] === true;
}

export function int(values: Values, name: string, fallback: number, range: { min: number; max: number }): number {
  const raw = str(values, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
    throw new ReachloopError('USAGE', `--${name} must be a whole number from ${range.min} to ${range.max}.`);
  }
  return parsed;
}

export function oneOf<T extends string>(values: Values, name: string, allowed: readonly T[]): T | undefined {
  const raw = str(values, name);
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new ReachloopError('USAGE', `--${name} must be one of: ${allowed.join(', ')}.`);
  }
  return raw as T;
}

export function tags(values: Values): string[] {
  const raw = str(values, 'tag');
  return raw ? raw.split(',').map((t) => t.trim()).filter(Boolean) : [];
}
