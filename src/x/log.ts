type Fields = Record<string, unknown>;

// Diagnostics go to stderr, and only when REACHLOOP_DEBUG is set, so stdout
// stays a clean JSON channel for the calling agent.
function write(level: 'info' | 'warn', args: unknown[]): void {
  if (!process.env.REACHLOOP_DEBUG) return;
  const [first, ...rest] = args;
  const fields: Fields | undefined =
    typeof first === 'object' && first !== null && !(first instanceof Error) ? (first as Fields) : undefined;
  const parts = fields ? rest : args;
  const message = parts.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join(' ');
  process.stderr.write(`${JSON.stringify({ level, message, ...fields })}\n`);
}

export const log = {
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
};
