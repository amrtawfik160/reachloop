import { ReachloopError } from './errors';

export const DEFAULT_DAILY_DM_CAP = 50;
export const MAX_DAILY_DM_CAP = 200;

export type AccountStatus = 'active' | 'paused' | 'session_expired' | 'suspended';

export type ReplyCheck = {
  confirmed: boolean;
  accountStatus: AccountStatus;
  hasInbound: boolean;
  sentToday: number;
  capDm: number;
};

export type GateResult = { ok: true } | { ok: false; error: ReachloopError };

const refuse = (error: ReachloopError): GateResult => ({ ok: false, error });

// Every DM goes through this check before it reaches X. Reply-only: a person
// must have sent this account a DM (a message request counts) before we write.
export function checkReply(check: ReplyCheck): GateResult {
  if (!check.confirmed) {
    return refuse(
      new ReachloopError('CONFIRM_REQUIRED', 'Sending a DM needs --yes.', { hint: 'Add --yes to send.' }),
    );
  }
  switch (check.accountStatus) {
    case 'active':
      break;
    case 'paused':
      return refuse(new ReachloopError('ACCOUNT_PAUSED', 'This account is paused.', { hint: 'reachloop account resume <@handle>' }));
    case 'session_expired':
      return refuse(
        new ReachloopError('SESSION_EXPIRED', 'This account must sign in again.', { hint: 'reachloop account login --browser' }),
      );
    case 'suspended':
      return refuse(new ReachloopError('ACCOUNT_SUSPENDED', 'X reports this account as suspended or locked.'));
    default: {
      const exhaustive: never = check.accountStatus;
      return refuse(new ReachloopError('INTERNAL', `unknown account status ${String(exhaustive)}`));
    }
  }
  if (!check.hasInbound) {
    return refuse(
      new ReachloopError('REPLY_ONLY', 'This person has not written to this account, so Reachloop will not DM them.', {
        hint: 'reachloop inbox sync',
      }),
    );
  }
  if (check.sentToday >= check.capDm) {
    return refuse(
      new ReachloopError('DAILY_CAP_REACHED', `This account already sent ${check.sentToday} DMs today (cap ${check.capDm}).`, {
        hint: 'Try again tomorrow, or raise the cap with reachloop limits set.',
      }),
    );
  }
  return { ok: true };
}
