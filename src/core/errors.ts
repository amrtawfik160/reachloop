import type { XError } from '../x/session';

export const EXIT = {
  ok: 0,
  failure: 1,
  usage: 2,
  notFound: 3,
  auth: 4,
  rateLimited: 5,
  blocked: 6,
  conflict: 7,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const ERROR_CODES = {
  USAGE: { exit: EXIT.usage, retryable: false },
  NOT_INITIALIZED: { exit: EXIT.failure, retryable: false },
  NOT_FOUND: { exit: EXIT.notFound, retryable: false },
  NO_ACCOUNT: { exit: EXIT.notFound, retryable: false },
  SESSION_EXPIRED: { exit: EXIT.auth, retryable: false },
  ACCOUNT_SUSPENDED: { exit: EXIT.auth, retryable: false },
  RATE_LIMITED: { exit: EXIT.rateLimited, retryable: true },
  CONFIRM_REQUIRED: { exit: EXIT.blocked, retryable: false },
  REPLY_ONLY: { exit: EXIT.blocked, retryable: false },
  DAILY_CAP_REACHED: { exit: EXIT.blocked, retryable: true },
  CAP_ABOVE_MAX: { exit: EXIT.blocked, retryable: false },
  ACCOUNT_PAUSED: { exit: EXIT.blocked, retryable: false },
  CONFLICT: { exit: EXIT.conflict, retryable: false },
  DMS_CLOSED: { exit: EXIT.failure, retryable: false },
  X_ERROR: { exit: EXIT.failure, retryable: true },
  NETWORK_ERROR: { exit: EXIT.failure, retryable: true },
  SIGN_IN_FAILED: { exit: EXIT.failure, retryable: true },
  INTERNAL: { exit: EXIT.failure, retryable: false },
} as const satisfies Record<string, { exit: ExitCode; retryable: boolean }>;

export type ErrorCode = keyof typeof ERROR_CODES;

export class ReachloopError extends Error {
  readonly hint?: string;
  readonly retryAfter?: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    extra: { hint?: string; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = 'ReachloopError';
    this.hint = extra.hint;
    this.retryAfter = extra.retryAfter;
  }
}

export function fromXError(err: XError, account: string): ReachloopError {
  switch (err.code) {
    case 'SESSION_EXPIRED':
      return new ReachloopError('SESSION_EXPIRED', `The X session for ${account} no longer works.`, {
        hint: `reachloop account login --browser   or   reachloop account add --cookies-file <file>`,
      });
    case 'ACCOUNT_SUSPENDED':
      return new ReachloopError('ACCOUNT_SUSPENDED', `X reports ${account} as suspended, locked or restricted.`);
    case 'X_RATE_LIMITED':
      return new ReachloopError('RATE_LIMITED', `X rate-limited ${account}.`, {
        retryAfter: Math.ceil((err.retryAfterMs ?? 15 * 60_000) / 1000),
      });
    case 'DMS_CLOSED':
      return new ReachloopError('DMS_CLOSED', 'This person does not accept DMs from this account.');
    case 'USER_NOT_FOUND':
      return new ReachloopError('NOT_FOUND', err.message);
    case 'NETWORK_ERROR':
      return new ReachloopError('NETWORK_ERROR', err.message);
    case 'API_ERROR':
    case 'QUERY_ID_STALE':
      return new ReachloopError('X_ERROR', err.message);
    default: {
      const exhaustive: never = err.code;
      return new ReachloopError('X_ERROR', String(exhaustive));
    }
  }
}
