// Writes the zero-server mark: the lockups, the icon, the bare symbol and their animated
// variants, from the palette in this file. Run from the repository root:
//
//   node scripts/brand.mjs
//
// The palette is checked before anything is written: no hue between 170 and 300 degrees,
// every text and mark role at its WCAG contrast minimum, and the lit segment lighter than
// the ring on every surface. docs/brand.md documents the result.

import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");

export const palette = [
  { token: "ink", name: "ink", hex: "#16140F", role: "dark surface; body text on the light surface" },
  { token: "surface", name: "bone", hex: "#F4EEE1", role: "light surface; body text on ink" },
  { token: "gray-1", name: "graphite", hex: "#57534A", role: "muted text and rules on the light surface" },
  { token: "gray-2", name: "ash", hex: "#A39E93", role: "muted text and rules on ink" },
  { token: "hero", name: "brass", hex: "#CFAE45", role: "the ring; headings and links on ink" },
  { token: "hero-mid", name: "gilt", hex: "#8C6A12", role: "the ring and the hyphen on light surfaces; never text" },
  { token: "hero-deep", name: "bronze", hex: "#5F470F", role: "headings and links on the light surface" },
  { token: "accent", name: "flare", hex: "#D9F542", role: "the pulse; focus and status on ink" },
  { token: "accent-deep", name: "moss", hex: "#688D00", role: "the pulse; focus and status on the light surface" },
];

const T = Object.fromEntries(palette.map((p) => [p.token, p.hex]));
const WHITE = "#FFFFFF";

const rgb = (hex) =>
{
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/** HSL hue in degrees and saturation of a hex color. */
export function hsl(hex)
{
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { h: 0, s: 0 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: ((h * 60) + 360) % 360, s };
}

/** WCAG relative luminance of a hex color. */
export function luminance(hex)
{
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const [r, g, b] = rgb(hex).map((v) => lin(v / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** CIE L* of a hex color. */
export function lightness(hex)
{
  const y = luminance(hex);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (y * 24389) / 27;
}

/** WCAG contrast ratio between two hex colors. */
export function contrast(a, b)
{
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const roles = [
  ["body text on the light surface", T.ink, T.surface, 4.5],
  ["body text on ink", T.surface, T.ink, 4.5],
  ["muted text on the light surface", T["gray-1"], T.surface, 4.5],
  ["muted text on ink", T["gray-2"], T.ink, 4.5],
  ["headings and links on the light surface", T["hero-deep"], T.surface, 4.5],
  ["headings and links on ink", T.hero, T.ink, 4.5],
  ["the ring on bone", T["hero-mid"], T.surface, 3],
  ["the ring on white", T["hero-mid"], WHITE, 3],
  ["the ring on ink", T.hero, T.ink, 3],
  ["the pulse on bone", T["accent-deep"], T.surface, 3],
  ["the pulse on ink", T.accent, T.ink, 3],
];
for (const p of palette)
{
  const { h, s } = hsl(p.hex);
  if (s > 0.05 && h >= 170 && h <= 300) throw new Error(`${p.token} hue ${h.toFixed(1)} is in the refused band`);
}
for (const [role, fg, bg, min] of roles)
{
  const ratio = contrast(fg, bg);
  if (ratio < min) throw new Error(`${role}: ${ratio.toFixed(2)}:1 is below ${min}:1`);
}
if (lightness(T["accent-deep"]) <= lightness(T["hero-mid"])) throw new Error("the pulse must be lighter than the ring on light surfaces");
if (lightness(T.accent) <= lightness(T.hero)) throw new Error("the pulse must be lighter than the ring on ink");

// The symbol: a ring with one lit segment of 52 degrees and a 12 degree slot on each side,
// at rest with the segment centered at minus 45 degrees, the one-thirty position.
const PULSE = 52, SLOT = 12, REST = -45;
const f = (n) => Math.round(n * 100) / 100;

function symbol(cx, cy, r)
{
  const pt = (deg) => [f(cx + r * Math.cos((deg * Math.PI) / 180)), f(cy + r * Math.sin((deg * Math.PI) / 180))];
  const arc = (a0, a1) =>
  {
    const [x0, y0] = pt(a0), [x1, y1] = pt(a1);
    return `M${x0} ${y0}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const p0 = REST - PULSE / 2, p1 = REST + PULSE / 2;
  return { ring: arc(p1 + SLOT, p0 - SLOT + 360), pulse: arc(p0, p1) };
}

// The animation: one lap in eight ticks. Each tick turns the segment 45 degrees in 0.15 s
// with an ease-out and holds it for 0.25 s, so the motion reads as work being handed on, not
// as waiting. It plays once, 3.2 s after a 0.6 s pause, and ends where it began; under
// reduced motion it does not run at all.
const TICKS = 8, LAP = 3.2, MOVE = 0.15;
const keyframes = (() =>
{
  const step = 100 / TICKS, move = (MOVE / LAP) * 100;
  const frames = [];
  for (let i = 0; i < TICKS; i += 1)
  {
    frames.push(`${f(i * step)}%{transform:rotate(${i * 45}deg)}`);
    frames.push(`${f(i * step + move)}%{transform:rotate(${(i + 1) * 45}deg)}`);
  }
  frames.push("100%{transform:rotate(360deg)}");
  return frames.join("");
})();
const STYLE = `<style>.loop{transform-box:fill-box;transform-origin:center;animation:tick ${LAP}s cubic-bezier(.2,.8,.2,1) .6s 1 both}@keyframes tick{${keyframes}}@media (prefers-reduced-motion:reduce){.loop{animation:none}}</style>`;

function mark(cx, cy, r, width, ring, pulse, animated)
{
  const s = symbol(cx, cy, r);
  return `<g${animated ? ' class="loop"' : ""} fill="none" stroke-width="${width}"><path d="${s.ring}" stroke="${ring}"/><path d="${s.pulse}" stroke="${pulse}"/></g>`;
}

// The wordmark: monoline letterforms on a 100 unit x-height, stroke 20, round caps and
// joins. The s takes elliptical bowls so its width sits closer to the e and the o, and the
// open right side of the r is closed up optically before the o and the v.
const letters = {
  z: { d: "M10 10H74L10 90H74", w: 84 },
  e: { d: "M10 50H82A36 40 0 1 0 73.58 75.71", w: 92 },
  r: { d: "M10 90V10M10 50A36 40 0 0 1 46 10", w: 56 },
  o: { d: "M82 50A36 40 0 1 1 10 50A36 40 0 1 1 82 50", w: 92 },
  "-": { d: "M10 50H40", w: 50 },
  s: { d: "M59.56 21.55A26 20 0 1 0 36 50A26 20 0 1 1 12.44 78.45", w: 72 },
  v: { d: "M10 10L40 90L70 10", w: 80 },
};
const GAP = 16;
const KERN = { ro: -14, rv: -10 };
const NAME = "zero-server";

function wordmark(x, top, k, color, hyphen)
{
  let cursor = 0;
  const parts = [];
  for (let i = 0; i < NAME.length; i += 1)
  {
    const ch = NAME[i];
    const tint = ch === "-" ? ` stroke="${hyphen}"` : "";
    parts.push(`<path transform="translate(${cursor})" d="${letters[ch].d}"${tint}/>`);
    cursor += letters[ch].w + GAP + (KERN[ch + (NAME[i + 1] ?? "")] ?? 0);
  }
  const width = (cursor - GAP) * k;
  return { svg: `<g transform="translate(${x} ${top}) scale(${k})" fill="none" stroke="${color}" stroke-width="20" stroke-linecap="round" stroke-linejoin="round">${parts.join("")}</g>`, width };
}

const XMLNS = 'xmlns="http://www.w3.org/2000/svg"';

function logo({ dark, animated })
{
  const H = 160;
  const text = dark ? T.surface : T.ink;
  const ring = dark ? T.hero : T["hero-mid"];
  const pulse = dark ? T.accent : T["accent-deep"];
  const word = wordmark(170, 47.5, 0.65, text, ring);
  const W = Math.ceil(170 + word.width + 34);
  return `<svg ${XMLNS} viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="zero-server">${animated ? STYLE : ""}${mark(80, 80, 40, 14.5, ring, pulse, animated)}${word.svg}</svg>\n`;
}

function icon({ animated })
{
  return `<svg ${XMLNS} viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="zero-server">${animated ? STYLE : ""}<rect width="64" height="64" rx="14" fill="${T.ink}"/>${mark(32, 32, 21.5, 9, T.hero, T.accent, animated)}</svg>\n`;
}

function bare({ dark, animated })
{
  const ring = dark ? T.hero : T["hero-mid"];
  const pulse = dark ? T.accent : T["accent-deep"];
  return `<svg ${XMLNS} viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="zero-server">${animated ? STYLE : ""}${mark(32, 32, 24, 10, ring, pulse, animated)}</svg>\n`;
}

const files = {
  "assets/zero-logo.svg": logo({ dark: false, animated: false }),
  "assets/zero-logo-dark.svg": logo({ dark: true, animated: false }),
  "assets/zero-logo-animated.svg": logo({ dark: false, animated: true }),
  "assets/zero-logo-animated-dark.svg": logo({ dark: true, animated: true }),
  "assets/zero-icon.svg": icon({ animated: false }),
  "assets/zero-icon-animated.svg": icon({ animated: true }),
  "assets/zero-symbol.svg": bare({ dark: false, animated: false }),
  "assets/zero-symbol-dark.svg": bare({ dark: true, animated: false }),
  "assets/zero-symbol-animated-dark.svg": bare({ dark: true, animated: true }),
};
for (const name of ["zero-logo.svg", "zero-logo-dark.svg", "zero-icon.svg"]) files[`web/assets/${name}`] = files[`assets/${name}`];
for (const name of ["zero-logo.svg", "zero-icon.svg"]) files[`docs/assets/${name}`] = files[`assets/${name}`];

for (const [path, body] of Object.entries(files))
{
  const target = join(repo, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, body);
  console.log(`${path} ${Buffer.byteLength(body)} B`);
}
for (const [role, fg, bg] of roles) console.log(`${role}: ${contrast(fg, bg).toFixed(2)}:1`);
console.log(`L* gilt ${lightness(T["hero-mid"]).toFixed(1)}, moss ${lightness(T["accent-deep"]).toFixed(1)}, brass ${lightness(T.hero).toFixed(1)}, flare ${lightness(T.accent).toFixed(1)}`);
