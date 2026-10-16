# Sending rules

## Reply-only

X allows automated DMs only after the person has sent you a DM. Reachloop enforces this in code before every send. A person counts as having written first when any DM from them reached that same account, ever. A message request counts.

`inbox sync` records who wrote first. Run it before `inbox reply` if a reply is refused with `REPLY_ONLY` and you believe the person did write.

## Daily cap

Each account may send at most its cap per local calendar day. The default is 50. `reachloop limits set @a --dm N` changes it, up to a hard maximum of 200. No flag raises the maximum.

## Duplicate protection

Each send has an idempotency key. Without `--idempotency-key`, the key is the account, the person, the text and the day, so repeating the same command does not send twice (`status: already_sent`).

## Accounts

All accounts on one computer send from the same IP address, so X can link them. Reachloop warns when you add a fourth account.
