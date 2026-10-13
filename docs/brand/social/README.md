# Social images

Cards to attach to the X threads about Jev in eziee. Each is 2400 × 1350.

| File | Account | Post |
| --- | --- | --- |
| `eziee-post-1-share-card.png` | eziee | 1, and the single post |
| `eziee-post-2-decisions.png` | eziee | 2 |
| `eziee-post-3-reads-ranks.png` | eziee | 3 |
| `eziee-post-8-three-jobs.png` | eziee, personal | eziee 8, personal 7 |
| `personal-post-1-measured.png` | personal | 1, and the single post |
| `personal-post-4-wallet.png` | personal | 4 |

`eziee-post-1-share-card.png` is a copy of `docs/research/2026-09-20-jev-spike/share-card.png`. The rest are rendered from `source/`.

Every number comes from the spike in `docs/research/2026-09-20-jev-spike/`: 12 prompts, fixture data, and a comparison that is not like for like. The cards say so in their footers. Keep it that way.

## Re-render

Playwright resolves from `apps/web`, so run the script from there:

```bash
cd apps/web
cp ../../docs/brand/social/source/render.mjs ./_render.mjs
node ./_render.mjs "$(cd ../../docs/brand/social/source && pwd)"
rm ./_render.mjs
```

The cards load Satoshi from `packages/ui/fonts/` and DM Mono from Google Fonts, so rendering needs a network connection.
