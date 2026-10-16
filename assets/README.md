# Reachloop artwork

| File | Use |
| --- | --- |
| `logo-light.svg`, `logo-dark.svg` | Horizontal mark and wordmark. The README selects the variant for the reader's color scheme. |
| `mark-light.svg`, `mark-dark.svg` | Mark alone, including at 32 pixels high. |
| `logo-light.png`, `logo-dark.png` | Square raster logos, 1254 by 1254 pixels. |
| `hero.png` | README banner and social preview, 1774 by 887 pixels. |
| `how-it-works.png` | The current CLI path, 1774 by 887 pixels. |
| `cli-json.png` | A real command and its JSON output, 1774 by 887 pixels. |
| `review/` | Separate, unscaled browser screenshots of the rendered README and small logos. |

The PNG artwork was generated with the built-in image tool. The SVG files are editable companions drawn from the generated loop design. SVG wordmarks use the reader's rounded or system sans-serif font.

The banner has a solid background and a 2:1 aspect ratio. GitHub recommends an image under 1 MB and at least 640 by 320 pixels for a [repository social preview](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview). The PNG is 980,704 bytes after lossless compression. Repository settings are unchanged.

The diagram matches Phase 1. The CLI calls X directly, with no daemon. SQLite and session storage remain local. Session storage prefers the OS keychain and falls back to an owner-only file.

The terminal illustration uses `reachloop lead list --limit 20 --json` after initialization of a fresh local database. Its JSON matches the executed command. It contains no real accounts, handles, or private data.

The screenshots use GitHub's Markdown API rendering with GitHub-style CSS on a local preview. Desktop captures are 1280 by 960 pixels. The phone capture is 390 by 844 pixels. Each capture is its original PNG.

## Generation prompts

The logo prompt requested an original thick blue return loop with an apricot origin dot and a lowercase humanist `reachloop` wordmark. The dark edit changed the blue mark and wordmark to off-white on blue and kept the dot and geometry.

The hero prompt used the logo as a style reference. It requested a 2:1 banner, a local laptop and message loop, and the exact text "reachloop", "Your agents.", "Your computer.", and "Local CLI for X leads and DM replies".

The workflow prompt requested an agent and CLI inside a "Your computer" boundary, X outside it, "commands + JSON" and "your own IP" arrows, and local SQLite and session storage. It excluded a daemon, cloud, campaigns, trademarked marks, people, and handles.

The terminal prompt requested the exact lead-list command and its empty JSON envelope, with the caption "Actual output from a fresh local database." All prompts excluded existing logos and private data.
