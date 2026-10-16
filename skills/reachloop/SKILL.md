---
name: reachloop
description: Drive Reachloop, the local CLI for X (Twitter) DM outreach. Use when the user asks to find leads on X, import followers or a CSV of X handles, read or triage X DMs, or reply to X DMs.
---

# Reachloop

Reachloop runs on the user's computer and talks to X with the user's own signed-in session. You call it from the shell. You write every free-form message yourself; Reachloop has no AI.

## Rules

- Pass `--json` on every command. Read `ok`, then `data`, `meta`, `warnings` and `hints`. `hints` name the usual next command.
- A failure prints `{"ok":false,"error":{"code","message","retryable","hint"}}` and a non-zero exit code. Follow `error.hint`. Exit codes: [reference/commands.md](reference/commands.md#exit-codes).
- Sending is reply-only. Reachloop refuses a DM to anyone who has not written to that account first (`REPLY_ONLY`, exit 6). Do not look for a way around it; tell the user.
- A send needs `--yes`. Show the user the exact text and get their go-ahead before you add `--yes`, unless they already told you to send without asking.
- Each account has a daily DM cap (default 50, hard maximum 200). At the cap, sends fail with `DAILY_CAP_REACHED`. Details: [reference/modes-and-limits.md](reference/modes-and-limits.md).
- Never print, store or ask for passwords. Sign-in happens in a Chrome window the user controls.

## First run

1. `reachloop init --json`. Show the user `data.notice` once.
2. `reachloop account login --browser --json`. Tell the user a Chrome window opened and they should sign in to X there. Wait for the command to finish (up to 10 minutes).
   - If Chrome is missing, the user can export cookies instead: `reachloop account add --cookies-file <file> --json`.
3. Show `warnings` to the user. A warning appears when more than 3 accounts share this computer.

## Find leads

- Keyword: `reachloop lead search --keyword "saas founder" --open-dm --max 50 --tag founders --json`
- Followers of an account: `reachloop lead import --followers-of @rival --max 200 --json`
- CSV with a `handle` column: `reachloop lead import --csv leads.csv --tag event --json`
- Review: `reachloop lead list --dm open --tag founders --limit 20 --json`. Follow `meta.next` with `--offset`.

`--open-dm` keeps only people whose DMs are open to the account.

## Reply to DMs

1. `reachloop inbox sync --json` reads new DMs and message requests.
2. `reachloop inbox list --unread --json`.
3. `reachloop inbox show @jane --json` returns the conversation (oldest first) and `canReply`.
4. Write the reply. Keep it short and specific to what they said.
5. `reachloop inbox reply @jane --text "..." --yes --json`.
   - `data.status` is `sent`, or `already_sent` when the same text already went out today.
   - `NETWORK_ERROR` on a reply means the DM may have been sent. Run `inbox show` before you try again.

Add `--account @handle` when the user has more than one account.

## Other commands

`reachloop --json` (status), `reachloop doctor --json`, `reachloop account list|show|pause|resume|remove`, `reachloop template add|list|remove`, `reachloop limits show|set`, `reachloop run once`. Full list: [reference/commands.md](reference/commands.md).
