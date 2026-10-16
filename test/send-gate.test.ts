import { describe, expect, it } from 'bun:test';
import { checkReply, DEFAULT_DAILY_DM_CAP, MAX_DAILY_DM_CAP } from '../src/core/send-gate';

const allowed = { confirmed: true, accountStatus: 'active', hasInbound: true, replyOnly: true, sentToday: 0, capDm: 50 } as const;

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

describe('optional outbound policy', () => {
  it('allows cold messages only with reply-only disabled', () => {
    expect(codeOf(checkReply({ ...allowed, replyOnly: false, hasInbound: false }))).toBe('ok');
    expect(codeOf(checkReply({ ...allowed, replyOnly: true, hasInbound: false }))).toBe('REPLY_ONLY');
  });
  it('keeps confirmation, status and zero/250 quota boundaries in outbound mode', () => {
    const cold = { ...allowed, replyOnly: false, hasInbound: false };
    expect(DEFAULT_DAILY_DM_CAP).toBe(50);
    expect(MAX_DAILY_DM_CAP).toBe(250);
    expect(codeOf(checkReply({ ...cold, capDm: 0 }))).toBe('DAILY_CAP_REACHED');
    expect(codeOf(checkReply({ ...cold, capDm: 250, sentToday: 249 }))).toBe('ok');
    expect(codeOf(checkReply({ ...cold, capDm: 250, sentToday: 250 }))).toBe('DAILY_CAP_REACHED');
    expect(codeOf(checkReply({ ...cold, confirmed: false }))).toBe('CONFIRM_REQUIRED');
    expect(codeOf(checkReply({ ...cold, accountStatus: 'suspended' }))).toBe('ACCOUNT_SUSPENDED');
  });
});
