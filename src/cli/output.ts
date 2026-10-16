import { ERROR_CODES, EXIT, type ExitCode, ReachloopError } from '../core/errors';

export type Meta = { total: number; returned: number; next?: string };

export type CommandResult = {
  data: unknown;
  meta?: Meta;
  hints?: string[];
  warnings?: string[];
  human?: string;
};

export type Io = { stdout: (text: string) => void; stderr: (text: string) => void };

function scalar(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function humanize(data: unknown): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return 'Nothing to show.';
    return data
      .map((row) =>
        typeof row === 'object' && row !== null
          ? Object.values(row as Record<string, unknown>).slice(0, 4).map(scalar).join('  ')
          : scalar(row),
      )
      .join('\n');
  }
  if (typeof data === 'object' && data !== null) {
    return Object.entries(data as Record<string, unknown>)
      .map(([key, value]) => `${key}: ${scalar(value)}`)
      .join('\n');
  }
  return scalar(data);
}

export function writeSuccess(io: Io, result: CommandResult, json: boolean): ExitCode {
  if (json) {
    const envelope = {
      ok: true,
      data: result.data,
      ...(result.meta ? { meta: result.meta } : {}),
      ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      ...(result.hints?.length ? { hints: result.hints } : {}),
    };
    io.stdout(`${JSON.stringify(envelope)}\n`);
  } else {
    io.stdout(`${result.human ?? humanize(result.data)}\n`);
    if (result.meta && result.meta.total > result.meta.returned) {
      io.stdout(`Showing ${result.meta.returned} of ${result.meta.total}.\n`);
    }
    for (const warning of result.warnings ?? []) io.stderr(`Warning: ${warning}\n`);
    for (const hint of result.hints ?? []) io.stderr(`Next: ${hint}\n`);
  }
  return EXIT.ok;
}

export function writeFailure(io: Io, err: unknown, json: boolean): ExitCode {
  const error =
    err instanceof ReachloopError ? err : new ReachloopError('INTERNAL', err instanceof Error ? err.message : String(err));
  const spec = ERROR_CODES[error.code];
  if (json) {
    const body = {
      code: error.code,
      message: error.message,
      retryable: spec.retryable,
      ...(error.hint ? { hint: error.hint } : {}),
      ...(error.retryAfter !== undefined ? { retryAfter: error.retryAfter } : {}),
    };
    io.stdout(`${JSON.stringify({ ok: false, error: body })}\n`);
  } else {
    io.stderr(`Error (${error.code}): ${error.message}\n`);
    if (error.hint) io.stderr(`Hint: ${error.hint}\n`);
  }
  return spec.exit;
}
