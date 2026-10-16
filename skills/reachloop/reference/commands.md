# Reachloop commands

Every command accepts `--json` and `--help`. Unknown flags exit with code 2.

| Command | What it does |
|---|---|
| `reachloop` | Status: accounts, DMs today, leads by status, unread conversations |
| `reachloop init` | Create the database; show the X rules notice |
| `reachloop doctor [--offline]` | Check database, secret store, Chrome, x.com and each session |
| `reachloop account login --browser [--timeout <min>]` | Sign in through a Chrome window |
| `reachloop account add --cookies-file <file>` | Import `auth_token`, `ct0`, `twid` (JSON object, browser export, or Cookie header) |
| `reachloop account list` / `show <@a>` | List or show accounts |
| `reachloop account pause <@a>` / `resume <@a>` | Stop or allow sends |
| `reachloop account remove <@a> --yes` | Remove the account and its saved session |
| `reachloop lead search --keyword <w> [--open-dm] [--max N] [--tag t] [--account @a]` | Save matching X profiles as leads |
| `reachloop lead import --followers-of <@x> [--max N] [--open-dm] [--tag t]` | Save followers of an account |
| `reachloop lead import --csv <file> [--tag t]` | Save handles from a CSV (`handle`, `username` or `screen_name` column) |
| `reachloop lead list [--status s] [--dm open\|closed\|unknown] [--tag t] [--limit N] [--offset N]` | List leads |
| `reachloop template add --name n --text "..."` / `list` / `remove <n> --yes` | Manage templates (`{{firstName}}`, `{{name}}`, `{{handle}}`) |
| `reachloop inbox sync [@a]` | Read DMs and message requests from X |
| `reachloop inbox list [--unread] [--account @a] [--limit N]` | List conversations |
| `reachloop inbox show <@lead> [--account @a] [--limit N] [--cached]` | Show a conversation |
| `reachloop inbox send <@handle> --text "..." [--yes] [--account @a] [--idempotency-key k] [--dry-run]` | Send an outbound DM or reply; saved lead optional |
| `reachloop inbox reply <@handle> --text "..." [--yes] [--account @a] [--idempotency-key k] [--dry-run]` | Backward-compatible alias for send, using the same optional reply-only mode |
| `reachloop limits show <@a>` | Show cap, today’s usage, `replyOnly` and `hardMax: 250` |
| `reachloop limits set <@a> [--dm <0-250>] [--reply-only on\|off]` | Change either or both per-account settings; at least one flag required |
| `reachloop run once` | Sync every active account's inbox once |
| `reachloop db path` | Where the database file is |
| `reachloop skill install --agent claude\|codex\|all` | Install this skill |

## Sending and limits

Reply-only is optional and off by default for existing and new accounts. When on, both send commands require a prior inbound DM to the same sending account; message requests count. `REPLY_ONLY` (exit 6) applies only when that restriction is enabled. Sync the account if an inbound message is missing; change its mode only at the user’s request.

Each account defaults to 50 DMs per local calendar day. Users can explicitly set an individual cap to 0–250; saved caps are never automatically raised, and no flag exceeds the hard maximum of 250.

`--yes` is required for real sends. Use `inbox send @handle --text "..." --dry-run` to preview without `--yes`: it sends nothing and consumes no quota, while retaining account/session, daily cap and optional reply-only checks. Both send commands share confirmation for real sends and duplicate protection. See [sending rules](modes-and-limits.md) for platform restrictions and permission requirements.

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Success, including an empty result |
| 1 | Failure (X error, network, DMs closed) |
| 2 | Bad usage or unknown flag |
| 3 | Not found (account, lead, template, conversation) |
| 4 | Session expired or account suspended: sign in again |
| 5 | Rate-limited by X; wait `error.retryAfter` seconds |
| 6 | Blocked by a safety rule: optional reply-only (`REPLY_ONLY`), daily cap, `--yes` missing, paused account |
| 7 | Conflict: an earlier send with this idempotency key has no confirmed result |
