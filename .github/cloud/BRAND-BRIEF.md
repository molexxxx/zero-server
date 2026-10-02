# Brand brief

The owner's words: "a new logo and color palette design, unique, I'm tired of
blue and purple; an animated logo and icon; the README technical, easy to
understand, and showing the vision." The header of the README is the animated
SVG logo (as the pamoja README opens with its animated logo), never a GIF, and
never the raster social preview.

If `assets/zero-logo-animated.svg` and `docs/brand.md` exist in the tree, the
brand work landed and this brief is only the record of its constraints. If they
do not, produce them to this brief before any other README work.

## Palette

- No hue between 170 and 300 degrees in HSL: no teal, cyan, blue, indigo,
  violet or purple. Allowed families: reds, oranges, ambers, yellows,
  yellow-greens and greens (hue 60 to 160), and warm or cool neutrals (ink,
  graphite, bone, sand). A neutral may carry a slight tint only if its hue is
  outside 170 to 300.
- The hero color is not Rust's rust-orange family (#B7410E, #DEA584,
  #F74C00) and the result looks unlike the logos of tokio, hyper, axum, actix,
  deno, bun, zig and pamoja. No "terminal green on black" cliche, no gradient
  blob, no lightning bolt, no rocket, no crab.
- Shape: one hero, one accent, ink, surface, two grays, with token names and
  WCAG contrast ratios computed and stated for every text role (at least
  4.5:1 for body text on surface and on ink, 3:1 for large text and UI). A
  light and a dark surface.

## Mark

- A symbol plus the wordmark "zero-server". Concept hooks that fit the
  product: the zero as a ring with a pulse circulating around it (the per-core
  event loop); the zero whose counter is a hexagon; a ring of slots (the
  request arena); the zero as a racetrack.
- Reads in one color, at 16 px as the icon, on dark and on light, and does not
  depend on a font: letterforms are paths.
- Animated variant: the same symbol with a subtle loop of 2 to 4 seconds using
  SMIL or CSS inside the SVG only, no script, honoring prefers-reduced-motion
  through a CSS media query inside the file, rendering as the static mark
  where animation is unsupported.
- Craft: clean hand-written SVG, viewBox based, no editor metadata, static
  files under 20 KB, animated under 40 KB, every color a palette token,
  `role="img"` and `aria-label` on each file.

## Files

- `assets/zero-logo.svg`, `assets/zero-logo-dark.svg`, `assets/zero-icon.svg`,
  `assets/zero-logo-animated.svg`, `assets/zero-logo-animated-dark.svg`,
  `assets/zero-icon-animated.svg`, `assets/architecture.svg`; the site
  generator also reads `docs/assets/zero-logo.svg` and
  `docs/assets/zero-icon.svg` (see `crates/xtask/src/docs.rs` and
  `crates/xtask/src/site/mod.rs` for the exact expectations).
- `docs/brand.md`: the palette table with tokens, hex, roles and contrast
  ratios; what the mark means; usage rules; which file to use where.
- `web/theme.css`: the palette as CSS custom properties, light and dark.
- The README opens with the animated logo in a `<picture>` element (dark
  source, light fallback, width about 520).

## The molexxxx profile

The GitHub profile at molexxxx/molexxxx shows project cards under
`.github/badges/card-<project>-{dark,light}.svg`, embedded in its README with
`<picture>` elements and `?v=<hash>` cache keys. The zero-server card must show
the Rust core (molexxxx/zero-server) with the new icon and palette; the Node
line (molexxxx/zero-server-node) is a smaller or renamed entry. That work
happens in the profile repository, not here.
