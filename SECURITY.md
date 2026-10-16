# Security

Reachloop holds X session cookies, which work like passwords. Please report a way to read them, send DMs without the safety checks, or run code through Reachloop by opening a [private security advisory](https://github.com/amrtawfik160/reachloop/security/advisories/new). Do not open a public issue for it.

Include the Reachloop commit, your operating system, and the steps to reproduce.

## Sending safeguards

Outbound DMs are enabled by default. Reply-only is an optional per-account restriction, off by default for existing and new accounts. When enabled, it requires a prior inbound DM to the same sending account; message requests count. Using outbound mode is not itself a security bypass.

Every real send still requires explicit confirmation (`--yes`) and checks account/session state, the daily cap and duplicate protection. Dry runs send nothing and consume no quota; they do not require `--yes`, but retain account/session, cap and optional reply-only checks. The default daily cap is 50 per account, with a hard maximum of 250; users can change individual caps, and saved caps are not automatically raised.

These safeguards do not grant platform permission: recipient privacy settings and X permissions still apply, and X may restrict or suspend automation. See the [X developer guidelines](https://docs.x.com/developer-guidelines) before sending.
