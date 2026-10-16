---
name: reachloop
description: Use Reachloop to find or import X leads, read or triage DMs, send outbound DMs or replies, and manage per-account sending limits.
---

# Reachloop

Reachloop runs locally with the user's signed-in X session. Call it from the shell and write every free-form message yourself.

## Every command

- Pass `--json`. Read `ok`, then `data`, `meta`, `warnings` and `hints`; show warnings to the user.
- On failure, follow `error.hint`. Read [commands](reference/commands.md) for flags and exit codes.
- Never ask for, print or store passwords or session cookies. Use user-controlled browser sign-in or import an existing cookie file without displaying its contents.

## First run

1. Run `reachloop init --json`; show `data.notice` once.
2. Run `reachloop account login --browser --json`. Tell the user to sign in in the Chrome window; wait up to 10 minutes for completion. If Chrome is missing, use `reachloop account add --cookies-file <file> --json` with a user-provided export.
3. Show account warnings, including the warning when more than three accounts share this computer.

## Find leads

- Keyword: `reachloop lead search --keyword "saas founder" --open-dm --max 50 --tag founders --json`
- Followers: `reachloop lead import --followers-of @rival --max 200 --json`
- CSV: `reachloop lead import --csv leads.csv --tag event --json`
- Review: `reachloop lead list --dm open --tag founders --limit 20 --json`; follow `meta.next` with `--offset`.

`--open-dm` filters for DMs open to the sending account; it is not platform permission for automated cold outreach.

## Send or reply

1. Select the sender with `--account @a` when needed. Run `reachloop limits show @a --json` to check its cap, usage and `replyOnly`. Outbound is enabled; reply-only is optional and off by default. Read [sending rules](reference/modes-and-limits.md) before sending or changing limits.
2. For replies, run `reachloop inbox sync --json`, `reachloop inbox list --unread --json`, then `reachloop inbox show @jane --json` to read the conversation. For outbound, a handle is enough; saving a lead first is optional.
3. Write a short, specific message. Show the exact text and get permission before adding `--yes`, unless the user already explicitly authorized sending without asking. Preview first with `reachloop inbox send @jane --account @a --text "..." --dry-run --json` if useful; it needs no `--yes` and sends nothing.
4. Run `reachloop inbox send @jane --account @a --text "..." --yes --json`. `inbox reply` is a backward-compatible alias using the same optional mode. Use the preview from step 3 to validate without sending or consuming quota.
5. Check the result: `sent` confirms a send; `already_sent` means duplicate protection prevented another; `dry_run` means no send occurred. On `NETWORK_ERROR`, inspect `inbox show` before retrying because the DM may have been sent.

If `REPLY_ONLY` blocks a send, the account has reply-only enabled. Sync that account if the person already wrote, or report the restriction; change the mode only at the user's request. At `DAILY_CAP_REACHED`, report the cap rather than raising it automatically. Paused accounts and invalid sessions still block sends.

## Change limits

On an explicit user request, use `reachloop limits set @a --dm 75 --reply-only on --json` with either or both flags, choosing the requested cap and `on` or `off`, then check the returned settings. Caps default to 50 per account and accept 0–250; 250 is the hard maximum. Saved caps are never automatically raised.

Other commands: [command reference](reference/commands.md).
