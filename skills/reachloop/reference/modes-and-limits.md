# Sending rules

## Outbound and optional reply-only

Outbound DMs are enabled by default for existing and new accounts. `inbox send @handle` can initiate a conversation without a saved lead. `inbox reply` remains a backward-compatible alias and uses the same mode.

`reachloop limits set @a --reply-only on` restricts both commands to people who have sent a DM to that same sending account. Any prior inbound DM counts, including a message request. `--reply-only off` disables the restriction. `reachloop limits show @a` reports `replyOnly`, the cap, today's usage and `hardMax: 250`.

`inbox sync @a` records inbound DMs and message requests. If `REPLY_ONLY` blocks a send to someone who already wrote, sync that account and retry. Do not change the mode without the user's request.

## Platform restrictions

The [X developer guidelines](https://docs.x.com/developer-guidelines) restrict automated DMs to people who sent you a DM first. Reachloop's outbound setting does not grant permission to send automated cold DMs. Recipient privacy settings and X permissions still apply, and X may restrict or suspend accounts for automation. Open DMs are not blanket permission for automated outreach.

## Daily cap

Each account has a cap per local calendar day, defaulting to 50. `reachloop limits set @a --dm N` accepts a whole number from 0 to 250; 0 prevents sends. The hard maximum is 250. Change an individual cap only at the user's request; saved caps are never automatically raised. At the cap, sends fail with `DAILY_CAP_REACHED`.

You can set either `--dm N` or `--reply-only on|off`, or both in one command.

## Confirmation and account state

Both send commands require `--yes` for a real send. Show the user the exact text and get their permission unless they already explicitly authorized sending without asking. Every send checks account/session state, caps and the optional reply-only restriction. Paused accounts cannot send; expired or suspended sessions remain blocked.

`reachloop inbox send @jane --text "..." --dry-run` previews without sending or consuming quota. It does not require `--yes`, but account/session, cap and optional reply-only checks still apply. Get the user’s go-ahead before the real send.

## Duplicate protection

Each send has an idempotency key. Without `--idempotency-key`, the key is the account, person, text and day, so repeating the same command does not send twice (`status: already_sent`). Send and reply share this protection.

## Accounts

All accounts on one computer send from the same IP address, so X can link them. Reachloop warns when you add a fourth account.
