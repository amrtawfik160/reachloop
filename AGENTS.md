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
- Safety rules live in code, never only in the skill or docs: reply-only sending is the
  default, the daily DM cap is 50 by default with a hard maximum of 200, and every send
  passes the send gate first. A change that weakens one of these needs an owner decision.
- No proxies, no built-in AI, no telemetry. The calling agent writes every free-form
  message.
- Never print, log, or commit session cookies (`auth_token`, `ct0`, `twid`). Tests use
  fake values.
- Tests never call x.com. CLI tests use the fake X in `test/support/fake-x.ts`; X client
  tests feed response bodies at the HTTP seam.
- stdout carries only the command result. Diagnostics go to stderr.
