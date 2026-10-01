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
painted on it. In the animated files that segment laps the ring once every three
seconds.

That is the core's runtime drawn literally: one non-blocking event loop per CPU
core, each with one thing in hand and a free slot ahead of it, and nothing else
moving. The static mark shows the segment at rest at the one-thirty position.

The wordmark `zero-server` is built from constructed monoline letterforms drawn
as paths (a 100 unit x-height, a stroke of 20, round caps and joins), so it renders
the same in a browser, through GitHub's image proxy, and on crates.io, npm, PyPI
and NuGet, none of which can load a font for an image. The hyphen takes the ring's
color and ties the name to the symbol.

The lit segment is always the lighter of the two strokes, on either surface, so
the mark reads by value alone and survives grayscale and small sizes:

| Surface | Ring | Pulse | Lightness (CIE L*) |
| --- | --- | --- | --- |
| light (bone) | `hero-deep` #5F470F | `accent-deep` #688D00 | 31.7 and 54.0 |
| dark (ink) | `hero` #CFAE45 | `accent` #D9F542 | 72.2 and 91.9 |

## Palette

One hero, one accent, ink, a light surface and two grays. The hero and the accent
each have a deep partner of the same hue for the light surface, because brass and
flare are bright by design and cannot carry text on bone. No color in the palette,
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
| `hero-deep` | bronze | #5F470F | 42 | 31.7 | the ring; headings and links on the light surface | 7.58:1 | 2.10:1 |
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
| the ring on the light surface | `hero-deep` | `surface` | 7.58:1 | 3:1 |
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
| `assets/zero-icon-animated.svg` | the icon with the loop | profile and project cards at 40 px and up, where one moving icon is welcome |
| `assets/zero-server-icon.png` | `zero-icon.svg` rasterized at 128 by 128 | the NuGet package icon (`bindings/dotnet/Directory.Build.props` packs it); NuGet takes no SVG |
| `assets/architecture.svg`, `assets/architecture-dark.svg`, `assets/architecture-narrow.svg`, `assets/architecture-narrow-dark.svg` | the architecture diagram, 960 wide and 400 wide, for light and dark pages; generated by `python scripts/architecture.py`, never edited by hand | the README's "How it works", narrow below 600 px |
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

When a file in `assets/` changes, the copies in `web/assets/` change with it in the
same commit, and `cargo xtask docs` rewrites the ones in `docs/assets/`.

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
- Show at most one animated mark per screen. The loop is one lap in three
  seconds at constant speed; its fading trail is visible only while it moves.
  Under `prefers-reduced-motion: reduce` the loop stops with the lit segment
  parked at twelve o'clock, and a renderer without CSS animation draws the static
  mark. An SVG shown through `<img>` is a separate document, and headless
  Chromium with the preference emulated kept the loop running there; where motion
  must be guaranteed off, use the static file.
