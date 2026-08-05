# Flow-Wiser community artwork

![Flow-Wiser](flow-wiser-keep-it-going-900.webp)

Artwork for the unofficial `dblagbro/flow-wiser` continuation fork.

## Assets

| File | Use |
| --- | --- |
| `flow-wiser-keep-it-going.png` | Canonical source master (1254x1254) — print, remixing, high-DPI |
| `flow-wiser-keep-it-going.webp` | Full-resolution web delivery |
| `flow-wiser-keep-it-going-900.webp` | Default README / docs display |
| `flow-wiser-open-source-meme.webp` | Compact inline / social thumbnail |
| `flow-wiser_white.svg` | Header wordmark shipped in the **light** theme |
| `flow-wiser_dark.svg` | Header wordmark shipped in the **dark** theme |
| `flow-wiser-mark.svg` | Bottle-cap "FW" mark — favicons and app icons |
| `fw-16.png` `fw-32.png` `fw-192.png` `fw-512.png` | Rasterised mark |

### ⚠️ Flowise's SVG naming is theme-based, not ink-based

`flowise_white-*.svg` is the file the UI loads in **light** mode, so it must contain
**dark** ink. `flowise_dark-*.svg` is loaded in **dark** mode and needs **white** ink.
Matching ink colour to the filename produces a logo that loads with HTTP 200, reports
correct dimensions, and is completely invisible. Our `flow-wiser_white.svg` therefore
carries dark ink (`#1f2733`), and `flow-wiser_dark.svg` carries white.

The wordmark is a rally poster, not an app icon — it is text-heavy and does not reduce
legibly below roughly 200px. Use `flow-wiser-mark.svg` for favicons.

## Public-use permission

To the extent the repository maintainer owns copyright in this artwork, it is made
available under the [Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/).

Suggested attribution:

> Flow-wiser community artwork - Devin P. Blagbrough / dblagbro/flow-wiser

You may share and adapt the artwork, including publicly and commercially, under the
CC BY 4.0 attribution terms. This artwork licence is separate from the source code
licences described in `LICENSE.md` and `FORK.md`.

## Parody and trademark notice

"Flow-Wiser" is an unofficial humorous parody created as expressive commentary and a
request for volunteer participation in an open-source community project. It is not
product packaging, does not advertise or offer an alcoholic beverage, and is not
presented as a source identifier for beer or any other commercial product.

This artwork and repository are not affiliated with, endorsed by, or sponsored by
FlowiseAI, Workday, Anheuser-Busch, Budweiser, GitHub, or any other third party
referenced or evoked by the parody. All third-party names, logos, mascots, trade dress,
and trademarks remain the property of their respective owners. No trademark rights are
granted by the CC BY 4.0 notice above.

This notice documents the intended expressive and community purpose. It is not a
guarantee regarding every possible jurisdiction or use and is not legal advice.
