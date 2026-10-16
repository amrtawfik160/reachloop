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
| `reachloop inbox reply <@lead> --text "..." --yes [--account @a] [--idempotency-key k] [--dry-run]` | Reply to someone who wrote first |
| `reachloop limits show <@a>` / `set <@a> --dm N` | Daily DM cap |
| `reachloop run once` | Sync every active account's inbox once |
| `reachloop db path` | Where the database file is |
| `reachloop skill install --agent claude\|codex\|all` | Install this skill |

## Exit codes

| Exit | Meaning |
|---|---|
| 0 | Success, including an empty result |
| 1 | Failure (X error, network, DMs closed) |
| 2 | Bad usage or unknown flag |
| 3 | Not found (account, lead, template, conversation) |
| 4 | Session expired or account suspended: sign in again |
| 5 | Rate-limited by X; wait `error.retryAfter` seconds |
| 6 | Blocked by a safety rule: reply-only, daily cap, `--yes` missing, paused account |
| 7 | Conflict: an earlier send with this idempotency key has no confirmed result |
