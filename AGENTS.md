# Reachloop: agent guide

Reachloop is a Bun + TypeScript CLI. Agents call it with `--json`; it talks to X with
the user's own session cookies, from the user's own IP.

## Layout

- `src/cli/` parses flags and prints the JSON envelope. `run.ts` holds the command list;
  one file per noun under `commands/`.
- `src/core/` holds the behavior. `send-gate.ts` is the check every DM passes;
  `errors.ts` maps each error code to its exit code.
- `src/x/` is the X client, based on twikit and Scweet (MIT). `session.ts` is the interface
  the rest of the code uses. Keep request shapes close to theirs so they stay easy to compare.
- `src/signin/chrome.ts` opens Chrome for sign-in. `skills/reachloop/` is the skill that
  `reachloop skill install` copies.

## Rules

- Use Bun for everything: `bun install`, `bun test`, `bun run typecheck`, `bun run lint`.
- Owner-approved sending defaults: outbound DMs are enabled, reply-only is optional
  and off for existing and new accounts, and the daily DM cap is 50 per account with
  a hard maximum of 250. Only an explicit user change raises an individual cap;
  migrations must not raise saved caps automatically.
- Safety rules live in code: every send passes the gate, including confirmation,
  account/session state, daily cap and deduplication. When reply-only is on, require
  a prior inbound DM to the same account (message requests count). Dry runs send
  nothing and consume no quota; they do not need `--yes`, but retain the other
  send checks.
  Changes beyond these owner-approved settings need a new owner decision.
- No proxies, no built-in AI, no telemetry. The calling agent writes every free-form
  message.
- Never print, log, or commit session cookies (`auth_token`, `ct0`, `twid`). Tests use
  fake values.
- Tests never call x.com. CLI tests use the fake X in `test/support/fake-x.ts`; X client
  tests feed response bodies at the HTTP seam.
- stdout carries only the command result. Diagnostics go to stderr.
