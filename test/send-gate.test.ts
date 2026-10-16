import { describe, expect, it } from 'bun:test';
import { checkReply } from '../src/core/send-gate';

const allowed = { confirmed: true, accountStatus: 'active', hasInbound: true, sentToday: 0, capDm: 50 } as const;

function codeOf(result: ReturnType<typeof checkReply>): string {
  return result.ok ? 'ok' : result.error.code;
}

describe('checkReply', () => {
  it('allows a confirmed reply to someone who wrote first, under the daily cap', () => {
    expect(codeOf(checkReply(allowed))).toBe('ok');
  });

  it('refuses a send to someone who never wrote to this account', () => {
    expect(codeOf(checkReply({ ...allowed, hasInbound: false }))).toBe('REPLY_ONLY');
  });

  it('refuses once the daily cap is used up', () => {
    expect(codeOf(checkReply({ ...allowed, sentToday: 49 }))).toBe('ok');
    expect(codeOf(checkReply({ ...allowed, sentToday: 50 }))).toBe('DAILY_CAP_REACHED');
  });

  it('refuses a send without explicit confirmation', () => {
    expect(codeOf(checkReply({ ...allowed, confirmed: false }))).toBe('CONFIRM_REQUIRED');
  });

  it('refuses sends from an account that is not active', () => {
    expect(codeOf(checkReply({ ...allowed, accountStatus: 'paused' }))).toBe('ACCOUNT_PAUSED');
    expect(codeOf(checkReply({ ...allowed, accountStatus: 'session_expired' }))).toBe('SESSION_EXPIRED');
  });
});
