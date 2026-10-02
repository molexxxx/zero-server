# Brand

The zero-server mark, its palette, and which file to use where. Every SVG named
here is plain, readable SVG: a `viewBox`, `role="img"` and an `aria-label`,
colors taken only from the palette below, no script, no external reference and
no editor metadata. The mark files use no font at all; the architecture diagram
draws its labels as outlines of Outfit and JetBrains Mono (SIL Open Font License
1.1), so it renders the same on every system and also references no font.

## The mark

The zero is a ring. One segment of it is lit, with a narrow slot cut on each side
so the lit segment reads as a body traveling inside the ring rather than a stripe
painted on it. In the animated files that segment goes once around the ring in
eight ticks: each tick turns it an eighth of a lap with an ease-out and holds it,
so the motion reads as work being handed on, not as a spinner waiting.

That is the core's runtime drawn literally: one non-blocking event loop per CPU
core, each with one thing in hand and a free slot ahead of it, and nothing else
moving. Every file rests with the segment at the one-thirty position, and the
animated files end where they began.

The wordmark `zero-server` is built from constructed monoline letterforms drawn
as paths (a 100 unit x-height, a stroke of 20, round caps and joins, an s with
elliptical bowls so its width sits near the e and the o, and the space after the
open r closed up before the o and the v), so it renders
the same in a browser, through GitHub's image proxy, and on crates.io, npm, PyPI
and NuGet, none of which can load a font for an image. The hyphen takes the ring's
color and ties the name to the symbol.

The lit segment is always the lighter of the two strokes, on either surface, so
the mark reads by value alone and survives grayscale and small sizes:

| Surface | Ring | Pulse | Lightness (CIE L*) |
| --- | --- | --- | --- |
| light (bone or white) | `hero-mid` #8C6A12 | `accent-deep` #688D00 | 46.9 and 54.0 |
| dark (ink) | `hero` #CFAE45 | `accent` #D9F542 | 72.2 and 91.9 |

## Palette

One hero, one accent, ink, a light surface and two grays. The hero and the accent
each have a deep partner of the same hue for the light surface, because brass and
flare are bright by design and cannot carry text on bone. The hero has a third
step, gilt, used only for the ring and the hyphen on light pages, so the mark
stays gold there instead of turning brown; text keeps bronze. No color in the palette,
or anywhere the brand appears, has an HSL hue between 170 and 300 degrees: no
teal, cyan, blue, indigo, violet or purple. The hero is a muted brass at hue 46,
clear of the rust oranges near hue 18 to 22.

| Token | Name | Hex | Hue | L* | Role | On bone | On ink |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ink` | ink | #16140F | 43 | 6.4 | the dark surface; body text on the light surface | 15.92:1 | |
| `surface` | bone | #F4EEE1 | 41 | 94.2 | the light surface; body text on ink | | 15.92:1 |
| `gray-1` | graphite | #57534A | 42 | 35.4 | muted text and rules on the light surface | 6.63:1 | 2.40:1 |
| `gray-2` | ash | #A39E93 | 41 | 65.2 | muted text and rules on ink | 2.31:1 | 6.90:1 |
| `hero` | brass | #CFAE45 | 46 | 72.2 | the ring; headings and links on ink | 1.85:1 | 8.58:1 |
| `hero-mid` | gilt | #8C6A12 | 43 | 46.9 | the ring and the hyphen on light surfaces; never text (5.02:1 on white) | 4.34:1 | |
| `hero-deep` | bronze | #5F470F | 42 | 31.7 | headings and links on the light surface | 7.58:1 | 2.10:1 |
| `accent` | flare | #D9F542 | 69 | 91.9 | the pulse; focus and status on ink | 1.06:1 | 14.98:1 |
| `accent-deep` | moss | #688D00 | 76 | 54.0 | the pulse; focus and status on the light surface | 3.36:1 | 4.73:1 |

## Contrast

Ratios are WCAG 2.x contrast ratios from relative luminance. Body text needs
4.5:1; large text (24 px, or 18.66 px bold) and interface graphics need 3:1.

| Role | Foreground | Background | Ratio | Minimum |
| --- | --- | --- | --- | --- |
| body text on the light surface | `ink` | `surface` | 15.92:1 | 4.5:1 |
| body text on ink | `surface` | `ink` | 15.92:1 | 4.5:1 |
| muted text on the light surface | `gray-1` | `surface` | 6.63:1 | 4.5:1 |
| muted text on ink | `gray-2` | `ink` | 6.90:1 | 4.5:1 |
| headings and links on the light surface | `hero-deep` | `surface` | 7.58:1 | 4.5:1 |
| headings and links on ink | `hero` | `ink` | 8.58:1 | 4.5:1 |
| large text, focus and status on the light surface | `accent-deep` | `surface` | 3.36:1 | 3:1 |
| large text, focus and status on ink | `accent` | `ink` | 14.98:1 | 3:1 |
| the ring on the light surface | `hero-mid` | `surface` | 4.34:1 | 3:1 |
| the ring on white | `hero-mid` | #FFFFFF | 5.02:1 | 3:1 |
| the ring on ink | `hero` | `ink` | 8.58:1 | 3:1 |
| label text on a `hero-deep` fill | `surface` | `hero-deep` | 7.58:1 | 4.5:1 |
| label text on a `hero` fill | `ink` | `hero` | 8.58:1 | 4.5:1 |
| label text on an `accent-deep` fill | `ink` | `accent-deep` | 4.73:1 | 4.5:1 |
| label text on an `accent` fill | `ink` | `accent` | 14.98:1 | 4.5:1 |

`accent-deep` on bone is for large text, focus outlines and status marks only,
never for body text; use `hero-deep` for links on the light surface.

## Site tokens

`web/theme.css` carries the palette twice. The `--brand-*` properties hold the
eight palette colors as they are. The other properties are the roles the site's
stylesheets read, in the same token shape as the pamoja site, with a light value
and a dark value each; the dark set applies under `prefers-color-scheme: dark`
unless the page sets `data-theme="light"`, and under `data-theme="dark"`. The
stylesheets themselves name no color, only these tokens.

A few roles need a color the palette does not hold (a tint for code blocks, a
rule, the caution and alarm notes, two syntax colors). Each is derived from the
palette's hues or sits in the warm half of the wheel, and each is held to the same
hue rule and contrast minimums:

| Role | Tokens | Light | Dark |
| --- | --- | --- | --- |
| body text | `--ink` on `--paper` | 15.92:1 | 15.92:1 |
| body text on the tint | `--ink` on `--paper-tint` | 14.27:1 | 14.54:1 |
| muted text | `--ink-soft` on `--paper` | 6.63:1 | 6.90:1 |
| muted text on the tint | `--ink-soft` on `--paper-tint` | 5.94:1 | 6.30:1 |
| links and accents | `--accent` on `--paper` | 7.58:1 | 8.58:1 |
| links on the tint | `--accent` on `--paper-tint` | 6.80:1 | 7.84:1 |
| link hover | `--accent-deep` on `--paper` | 10.35:1 | 10.94:1 |
| text on the band | `--on-band` on `--band` | 15.92:1 | 17.02:1 |
| text on an accent fill | `--on-accent` on `--accent` | 7.58:1 | 8.58:1 |
| caution text | `--caution` on `--paper` | 6.47:1 | 8.93:1 |
| caution text on its tint | `--caution` on `--caution-tint` | 5.80:1 | 7.46:1 |
| alarm text | `--alarm` on `--paper` | 6.06:1 | 7.50:1 |
| code strings | `--code-string` on `--paper-tint` | 4.80:1 | 11.31:1 |
| code literals | `--code-literal` on `--paper-tint` | 5.81:1 | 6.98:1 |
| frames and focus outlines | `--frame` on `--paper` | 15.92:1 | 5.15:1 |
| the ring | `--ring` on `--paper` | 7.58:1 | 8.58:1 |
| the pulse | `--pulse` on `--paper` | 3.36:1 | 14.98:1 |

The band (the site header) is ink in both schemes, so the header can carry the
mark exactly as `zero-logo-dark.svg` draws it, and the page's `theme-color` is
`#16140F`. Text on an accent fill uses
`--on-accent`, which is bone on bronze and ink on brass.

## Files

| File | What it is | Use it for |
| --- | --- | --- |
| `assets/zero-logo-animated.svg` | the lockup for light backgrounds, transparent, with the loop | the README header (the light source and the `<img>` fallback that registries show) |
| `assets/zero-logo-animated-dark.svg` | the lockup for dark backgrounds, transparent, with the loop | the README header's dark source |
| `assets/zero-logo.svg` | the static lockup for light backgrounds, transparent | documents, slides, package pages, anywhere motion is out of place |
| `assets/zero-logo-dark.svg` | the static lockup for dark backgrounds, transparent | the same, on ink or any dark page |
| `assets/zero-icon.svg` | the symbol on its own ink plate, 64 by 64 | the favicon, avatars, social and package icons, from 16 px up |
| `assets/zero-icon-animated.svg` | the icon with the loop | profile and project cards at 40 px and up on light pages |
| `assets/zero-symbol.svg`, `assets/zero-symbol-dark.svg` | the bare symbol, no plate, for light and dark pages | anywhere from 24 px up where the ink plate would read as a muddy tile, such as GitHub's dark theme |
| `assets/zero-symbol-animated-dark.svg` | the bare symbol for dark pages with the loop | profile and project cards on dark pages |
| `assets/zero-server-icon.png` | `zero-icon.svg` rasterized at 128 by 128 | the NuGet package icon (`bindings/dotnet/Directory.Build.props` packs it); NuGet takes no SVG |
| `assets/architecture.svg`, `assets/architecture-dark.svg`, `assets/architecture-narrow.svg`, `assets/architecture-narrow-dark.svg` | the architecture diagram, 960 wide and 400 wide, for light and dark pages; generated by `python scripts/architecture.py`, never edited by hand | the README's "How it works", narrow below 600 px |
| `assets/architecture-narrow-card.svg` | the 400 wide diagram, transparent, carrying both palettes and switching by `prefers-color-scheme` inside the file, which browsers evaluate against the embedding page's `color-scheme`; combined from the two narrow files | the README's narrow source, which selects by width only, because GitHub rewrites any source that names a color scheme when a viewer picks a single theme |
| `web/assets/zero-logo.svg`, `web/assets/zero-logo-dark.svg`, `web/assets/zero-icon.svg` | the site's copies, byte for byte the files in `assets/` | the documentation site; `/assets/zero-icon.svg` is its favicon |
| `docs/assets/zero-logo.svg`, `docs/assets/zero-icon.svg` | written by `cargo xtask docs` from `web/assets/` | the reference pages; never edit these by hand |
| `web/theme.css` | the palette and the site roles as custom properties | every stylesheet of the site |

The README picks a file per GitHub theme with `<picture>`:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/zero-logo-animated-dark.svg">
  <img alt="zero-server" src="assets/zero-logo-animated.svg" width="520">
</picture>
```

Every mark file and its copies in `web/assets/` and `docs/assets/` are written by
`node scripts/brand.mjs`, which checks the hue rule, every contrast role in this
page and the ring-to-pulse lightness order before it writes anything. Edit the
script, never the files.

## Usage

- Keep clear space around the lockup of at least the ring's radius, a quarter of
  the lockup's height, on every side.
- The lockup is legible from 120 px wide. Below that, use the icon. The icon
  keeps its ink plate at every size, including the 16 px favicon; the bare symbol
  without a plate is for 24 px and up.
- Put the light lockup on bone, white or another light page and the dark lockup
  on ink or another dark page. Never put a lockup on a photograph or a busy
  pattern; place it on a plate of `ink` or `surface` instead.
- One-color use is allowed: the whole mark in `ink` on a light page or in
  `surface` on a dark one. The two slots keep it readable as the mark rather than
  a plain circle.
- Do not recolor the mark outside the palette, add gradients, shadows or
  outlines, stretch it, rotate it, rebuild the wordmark in a typeface, or change
  the letter spacing. In running text the name is written `zero-server`,
  lowercase, with the hyphen.
- Show at most one animated mark per screen. The animation plays once, after a
  0.6 s pause: one lap in eight ticks over 3.2 s, ending at rest, so it never
  runs longer than five seconds and needs no pause control (WCAG 2.2.2). Under
  `prefers-reduced-motion: reduce` it does not run, and a renderer without CSS
  animation draws the static mark; both rest at one-thirty, like every static
  file.
