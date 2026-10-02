"""Draws the README's two diagrams, the engine and the bindings, from one source.

The engine diagram shows the cores as the brand mark repeated side by side. The
kernel hands each core's own listener its connections, each core owns its
buffers and caches, and nothing joins one core to another. Below them, the loop
every core runs is the same ring opened into a track: a request enters at read,
passes the stations of the core, leaves at write on the same connection, and
the track returns to the next connection with work ready.

The bindings diagram keeps the same row of cores inside the application's
process. The application declares its routes, rules and static files once at
startup across the C ABI; two cores answer in Rust with no crossing, and two
hand a batch to their paired host thread and write the responses themselves.

Every color is a palette token from docs/brand.md, and every glyph is outlined
from Outfit and JetBrains Mono (SIL Open Font License 1.1) and defined once per
file, so the images render the same on every system and reference no font.

    python scripts/architecture.py [--out assets]

Writes runtime.svg, runtime-dark.svg, bindings.svg and bindings-dark.svg (960
wide, one palette each) and runtime-narrow.svg and bindings-narrow.svg (400
wide). The README selects the narrow file by width alone, because GitHub
rewrites any source that names a color scheme when a viewer picks a single
theme, so each narrow file carries both palettes and switches them with
prefers-color-scheme in its own style element. Every file is transparent. The
fonts are downloaded once into target/fonts from pinned google/fonts commits
and checked by SHA-256. Requires fontTools.
"""

import argparse
import hashlib
import math
import pathlib
import sys
import urllib.request

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = pathlib.Path(__file__).resolve().parent.parent
CACHE = ROOT / "target" / "fonts"

FONTS = {
    "sans": (
        "Outfit[wght].ttf",
        "https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/outfit/Outfit%5Bwght%5D.ttf",
        "fc7287273e66929776e2ba54f144fe699080bec29f61bf649d70d871468aeade",
    ),
    "mono": (
        "JetBrainsMono[wght].ttf",
        "https://raw.githubusercontent.com/google/fonts/6e4b84c976cadb3c49a40fd9a1c203e4f7fcf2da/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf",
        "48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda",
    ),
}

PALETTES = {
    "light": {
        "text": "#16140F",
        "muted": "#57534A",
        "line": "#57534A",
        "station": "#8C6A12",
        "ring": "#8C6A12",
        "lit": "#688D00",
        "accent": "#688D00",
    },
    "dark": {
        "text": "#F4EEE1",
        "muted": "#A39E93",
        "line": "#A39E93",
        "station": "#CFAE45",
        "ring": "#CFAE45",
        "lit": "#D9F542",
        "accent": "#D9F542",
    },
}

PULSE = 52
SLOT = 12

WIDE = [400, 540, 680, 880]
NARROW = [86, 167, 248, 356]
FRAMED = [84, 162, 240, 340]
ANGLES = [-45, 45, 180, -120]
READING = {0, 2}
CROSSING = {0, 2}
NAMES = ["read", "parse", "route", "answer", "write"]

RUNTIME_TITLE = "zero-server engine: one event loop per CPU core"
RUNTIME_DESC = (
    "Four cores drawn side by side as rings, labeled core 0, core 1, core 2 and core n: one "
    "worker per logical CPU, each a single-threaded event loop pinned to its core. At the top, "
    "new connections reach the kernel. On Linux the kernel spreads them over one SO_REUSEPORT "
    "listener per core, drawn as a small square above each ring; on other systems one listener "
    "hands accepted sockets to the cores. A connection never leaves the core that accepted it. "
    "Under each core are its own buffer pool, its own Date header cache and its own small-file "
    "cache. None of these is shared between cores, so the request path takes no locks. A receive "
    "buffer is leased only while bytes are being read: cores 0 and 2 are reading and each holds "
    "one lit buffer, while cores 1 and n hold none, because an idle connection holds no buffer. "
    "The lit segment sits at a different point on each ring because every loop runs on its own; "
    "core 0 rests at the mark's one-thirty position. Below, the loop each core runs is drawn as "
    "the ring opened into a track. The request enters at read, into a leased buffer, with TLS on "
    "the same loop; parse reads the head in place with SIMD scans and no allocation; route looks "
    "it up in the core's own route table; answer runs a rule, a static file or a handler, and a "
    "panicking handler is contained to its request; write sends the responses of a pipelined "
    "burst in order with one vectored write, and the response leaves on the same connection "
    "from the same core. The track then returns, and the loop goes on to the next connection "
    "with work ready instead of waiting on one. Each loop runs on tokio by default, or on compio "
    "over io_uring on Linux, IOCP on Windows or kqueue on macOS."
)

BINDINGS_TITLE = "zero-server bindings: your language on the same engine"
BINDINGS_DESC = (
    "One process holds an application in Node, Python or .NET and the zero-server core, loaded "
    "as a native library. At the top are the application's threads, one per core: a Node worker "
    "isolate, the Python handler thread or a .NET thread. A dashed line marks the C ABI between "
    "the application and the core. At startup the application declares its routes, its rules "
    "such as CORS, security headers and limits, and its static files once, across the C ABI, "
    "and the core keeps them as tables on every core. Below the C ABI is the same row of four "
    "cores as in the engine diagram, one event loop per CPU core. Requests arrive from the "
    "network at the cores, not at the application, and each response leaves on the same "
    "connection from the same core. Cores 1 and n answer their requests entirely in Rust, from "
    "a rule, a static file or a handler written in Rust, with no crossing, and their threads "
    "stay idle. Cores 0 and 2 hold requests whose handler is the application's own function: "
    "each sends its paired thread one batch of whatever is ready, up to 256 requests, as one "
    "call across the C ABI, the thread returns the results, and the core writes the responses. "
    "Every core takes both kinds; the route decides."
)


def font_file(key):
    """Returns the cached font file for a family, downloading and checking it once.

    # Arguments

    * `key` - "sans" or "mono".

    # Returns

    The path of the verified font file.

    # Errors

    Raises `RuntimeError` when the downloaded bytes do not match the pinned hash.
    """
    name, url, digest = FONTS[key]
    path = CACHE / name
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url) as response:
            path.write_bytes(response.read())
    if hashlib.sha256(path.read_bytes()).hexdigest() != digest:
        raise RuntimeError(f"{name} does not match its pinned SHA-256")
    return path


def num(value):
    """Formats a coordinate with at most one decimal."""
    text = f"{value:.1f}".rstrip("0").rstrip(".")
    return "0" if text == "-0" else text


def esc(value):
    """Escapes text for an XML element body."""
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


class Face:
    """One static instance of a variable font, with glyph outlines and advances."""

    def __init__(self, key, weight):
        font = TTFont(font_file(key))
        self.font = instancer.instantiateVariableFont(font, {"wght": weight})
        self.glyphs = self.font.getGlyphSet()
        self.cmap = self.font.getBestCmap()
        self.units = self.font["head"].unitsPerEm

    def width(self, text, size):
        """Returns the advance width of `text` at `size` pixels."""
        scale = size / self.units
        return sum(self.glyphs[self.cmap[ord(c)]].width for c in text) * scale


class Canvas:
    """Collects the elements of one diagram and serializes them.

    With one palette every color is written as an attribute. With two, every
    colored element also carries a role class, and the style element maps the
    classes to the first palette by default and to the second under
    prefers-color-scheme: dark. Each glyph is defined once in font units and
    placed with `use`, which keeps the files small.
    """

    def __init__(self, width, height, palettes, faces, title, desc, floor):
        self.width = width
        self.height = height
        self.palettes = palettes
        self.palette = palettes[0]
        self.faces = faces
        self.title = title
        self.desc = desc
        self.floor = floor
        self.parts = []
        self.glyphs = {}
        self.roles = set()
        self.boxes = []

    def paint(self, prop, role):
        """Returns the attributes that color `prop` (fill or stroke) with a palette role."""
        self.roles.add((prop, role))
        attrs = f'{prop}="{self.palette[role]}"'
        if len(self.palettes) > 1:
            attrs += f' class="{prop[0]}-{role}"'
        return attrs

    def glyph(self, face, name):
        """Returns the id and path data of a glyph, defining it on first use."""
        key = (face, name)
        if key not in self.glyphs:
            font = self.faces[face]
            pen = SVGPathPen(font.glyphs, ntos=lambda v: num(round(v)))
            font.glyphs[name].draw(pen)
            self.glyphs[key] = (f"{face[0]}{len(self.glyphs)}", pen.getCommands())
        return self.glyphs[key]

    def text(self, value, x, y, size, face="sans", role="text", anchor="start"):
        """Adds outlined text with its baseline at `y`; `anchor` is start, middle or end.
        Returns the x coordinate where the text ends."""
        if size < self.floor:
            raise ValueError(f"{value!r} at {size} px is below the {self.floor} px floor")
        font = self.faces[face]
        width = font.width(value, size)
        start = {"start": x, "middle": x - width / 2, "end": x - width}[anchor]
        uses = []
        cursor = 0
        for char in value:
            name = font.cmap[ord(char)]
            ident, data = self.glyph(face, name)
            if data:
                offset = f' x="{cursor}"' if cursor else ""
                uses.append(f'<use xlink:href="#{ident}"{offset}/>')
            cursor += font.glyphs[name].width
        scale = f"{size / font.units:g}"
        self.parts.append(
            f'<g {self.paint("fill", role)} transform="matrix({scale} 0 0 -{scale} {num(start)} {num(y)})">'
            f'{"".join(uses)}</g>'
        )
        self.boxes.append((value, start, y - size * 0.76, start + width, y + size * 0.22))
        return start + width

    def runs(self, segments, x, y, size, anchor="start"):
        """Adds one line made of (text, face, role) segments; returns where it ends."""
        widths = [self.faces[f].width(t, size) for t, f, _ in segments]
        cursor = {"start": x, "middle": x - sum(widths) / 2, "end": x - sum(widths)}[anchor]
        for (value, face, role), w in zip(segments, widths):
            self.text(value, cursor, y, size, face=face, role=role)
            cursor += w
        return cursor

    def line(self, points, role="line", width=3, dash=None):
        """Adds a polyline through `points`."""
        data = "M" + "L".join(f"{num(px)} {num(py)}" for px, py in points)
        extra = f' stroke-dasharray="{dash}"' if dash else ""
        self.parts.append(
            f'<path d="{data}" fill="none" {self.paint("stroke", role)} stroke-width="{num(width)}"'
            f' stroke-linecap="round" stroke-linejoin="round"{extra}/>'
        )

    def arrow(self, x, y, direction, role="line", size=9):
        """Adds a filled arrowhead with its tip at (x, y) pointing up, down, left or right."""
        dx, dy = {"right": (1, 0), "left": (-1, 0), "down": (0, 1), "up": (0, -1)}[direction]
        bx, by = x - dx * size * 1.4, y - dy * size * 1.4
        ax, ay = bx - dy * size * 0.75, by + dx * size * 0.75
        cx, cy = bx + dy * size * 0.75, by - dx * size * 0.75
        self.parts.append(
            f'<path d="M{num(x)} {num(y)}L{num(ax)} {num(ay)}L{num(cx)} {num(cy)}Z" {self.paint("fill", role)}/>'
        )

    def circle(self, x, y, r, role):
        """Adds a filled dot."""
        self.parts.append(f'<circle cx="{num(x)}" cy="{num(y)}" r="{num(r)}" {self.paint("fill", role)}/>')

    def square(self, x, y, size, role, filled=True):
        """Adds a small square, filled or outlined, with its center at (x, y)."""
        h = size / 2
        if filled:
            self.parts.append(
                f'<rect x="{num(x - h)}" y="{num(y - h)}" width="{num(size)}" height="{num(size)}" rx="2"'
                f' {self.paint("fill", role)}/>'
            )
        else:
            self.parts.append(
                f'<rect x="{num(x - h + 1)}" y="{num(y - h + 1)}" width="{num(size - 2)}"'
                f' height="{num(size - 2)}" rx="1.5" fill="none" {self.paint("stroke", role)} stroke-width="2"/>'
            )

    def pill(self, cx, cy, w, h, role, width=2.5):
        """Adds an outlined pill centered at (cx, cy)."""
        self.parts.append(
            f'<rect x="{num(cx - w / 2)}" y="{num(cy - h / 2)}" width="{num(w)}" height="{num(h)}"'
            f' rx="{num(h / 2)}" fill="none" {self.paint("stroke", role)} stroke-width="{num(width)}"/>'
        )

    def frame(self, x0, y0, x1, y1, radius, gap, role="muted", width=1.5):
        """Adds a rounded outline with an opening in its top edge from gap[0] to gap[1]."""
        g0, g1 = gap
        r = radius
        data = (
            f"M{num(g1)} {num(y0)}L{num(x1 - r)} {num(y0)}Q{num(x1)} {num(y0)} {num(x1)} {num(y0 + r)}"
            f"L{num(x1)} {num(y1 - r)}Q{num(x1)} {num(y1)} {num(x1 - r)} {num(y1)}"
            f"L{num(x0 + r)} {num(y1)}Q{num(x0)} {num(y1)} {num(x0)} {num(y1 - r)}"
            f"L{num(x0)} {num(y0 + r)}Q{num(x0)} {num(y0)} {num(x0 + r)} {num(y0)}L{num(g0)} {num(y0)}"
        )
        self.parts.append(
            f'<path d="{data}" fill="none" {self.paint("stroke", role)} stroke-width="{num(width)}"'
            f' stroke-linecap="round" stroke-linejoin="round"/>'
        )

    def table(self, x0, y0, x1, y1, rows, role="muted", width=1.5):
        """Adds an outlined table of `rows` equal rows."""
        step = (y1 - y0) / rows
        data = f"M{num(x0 + 4)} {num(y0)}H{num(x1 - 4)}Q{num(x1)} {num(y0)} {num(x1)} {num(y0 + 4)}"
        data += f"V{num(y1 - 4)}Q{num(x1)} {num(y1)} {num(x1 - 4)} {num(y1)}H{num(x0 + 4)}"
        data += f"Q{num(x0)} {num(y1)} {num(x0)} {num(y1 - 4)}V{num(y0 + 4)}Q{num(x0)} {num(y0)} {num(x0 + 4)} {num(y0)}Z"
        for k in range(1, rows):
            data += f"M{num(x0)} {num(y0 + k * step)}H{num(x1)}"
        self.parts.append(
            f'<path d="{data}" fill="none" {self.paint("stroke", role)} stroke-width="{num(width)}"/>'
        )

    @staticmethod
    def polar(cx, cy, r, deg):
        """Returns the point at `deg` degrees (screen coordinates) on a circle."""
        rad = math.radians(deg)
        return cx + r * math.cos(rad), cy + r * math.sin(rad)

    def arc(self, cx, cy, r, a0, a1):
        """Returns path data for a clockwise arc from `a0` to `a1` degrees."""
        x0, y0 = self.polar(cx, cy, r, a0)
        x1, y1 = self.polar(cx, cy, r, a1)
        large = 1 if (a1 - a0) % 360 > 180 else 0
        return f"M{x0:.2f} {y0:.2f}A{num(r)} {num(r)} 0 {large} 1 {x1:.2f} {y1:.2f}"

    def mark(self, cx, cy, r, width, at=-45):
        """Adds the event loop mark: a ring with a lit segment centered at `at` degrees and
        a slot on each side of it, as scripts/brand.mjs draws it."""
        p0, p1 = at - PULSE / 2, at + PULSE / 2
        ring = self.arc(cx, cy, r, p1 + SLOT, p0 - SLOT + 360)
        pulse = self.arc(cx, cy, r, p0, p1)
        self.parts.append(
            f'<g fill="none" stroke-width="{num(width)}"><path d="{ring}" {self.paint("stroke", "ring")}/>'
            f'<path d="{pulse}" {self.paint("stroke", "lit")}/></g>'
        )

    def check(self, name):
        """Reports text that overlaps other text or leaves the canvas."""
        for i, (value, x0, y0, x1, y1) in enumerate(self.boxes):
            if x0 < 0 or y0 < 0 or x1 > self.width or y1 > self.height:
                print(f"{name}: {value!r} leaves the canvas", file=sys.stderr)
            for other, a0, b0, a1, b1 in self.boxes[i + 1:]:
                if x0 < a1 and a0 < x1 and y0 < b1 and b0 < y1:
                    print(f"{name}: {value!r} overlaps {other!r}", file=sys.stderr)

    def style(self):
        """Returns the style element that switches the palettes, or nothing for one palette."""
        if len(self.palettes) == 1:
            return ""

        def rules(palette):
            return "".join(f".{prop[0]}-{role}{{{prop}:{palette[role]}}}" for prop, role in sorted(self.roles))

        return f"<style>{rules(self.palettes[0])}@media (prefers-color-scheme: dark){{{rules(self.palettes[1])}}}</style>"

    def svg(self):
        """Returns the finished document."""
        defs = "".join(f'<path id="{ident}" d="{data}"/>' for ident, data in self.glyphs.values() if data)
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
            f' viewBox="0 0 {self.width} {self.height}" width="{self.width}" height="{self.height}"'
            f' role="img" aria-labelledby="t d"><title id="t">{esc(self.title)}</title>'
            f'<desc id="d">{esc(self.desc)}</desc>{self.style()}<defs>{defs}</defs>{"".join(self.parts)}</svg>\n'
        )


def rows(c, x, y, lines, gap):
    """Draws a stack of label lines, each (text or segments, size, role); returns the next y."""
    for value, size, role in lines:
        if isinstance(value, str):
            c.text(value, x, y, size, role=role)
        else:
            c.runs(value, x, y, size)
        y += gap
    return y


def ellipsis(c, centers, cy, step):
    """Draws the three dots between the last two cores."""
    gx = (centers[-2] + centers[-1]) / 2
    for k in (-1, 0, 1):
        c.circle(gx + k * step, cy, 2.5, "muted")


def track(c, x0, y0, x1, y1, width, gap):
    """Adds the loop opened into a horizontal track, clockwise, with the lit segment on its
    upper right bend at the one-thirty position and an opening in the bottom straight from
    gap[0] to gap[1] for the label of the return."""
    r = (y1 - y0) / 2
    lx, rx, cy = x0 + r, x1 - r, y0 + r
    p0, p1 = -45 - PULSE / 2, -45 + PULSE / 2
    sx, sy = c.polar(rx, cy, r, p1 + SLOT)
    ex, ey = c.polar(rx, cy, r, p0 - SLOT)
    g0, g1 = gap
    first = f"M{sx:.2f} {sy:.2f}A{num(r)} {num(r)} 0 0 1 {num(rx)} {num(y1)}L{num(g1)} {num(y1)}"
    second = (
        f"M{num(g0)} {num(y1)}L{num(lx)} {num(y1)}A{num(r)} {num(r)} 0 0 1 {num(lx)} {num(y0)}"
        f"L{num(rx)} {num(y0)}A{num(r)} {num(r)} 0 0 1 {ex:.2f} {ey:.2f}"
    )
    c.parts.append(
        f'<g fill="none" stroke-width="{num(width)}"><path d="{first}{second}" {c.paint("stroke", "ring")}/>'
        f'<path d="{c.arc(rx, cy, r, p0, p1)}" {c.paint("stroke", "lit")}/></g>'
    )


def upright_track(c, x0, y0, x1, y1, width):
    """Adds the loop as an upright track: down the right side, back up the left, lit on the
    upper right bend at the one-thirty position."""
    r = (x1 - x0) / 2
    cx, ty, by = x0 + r, y0 + r, y1 - r
    p0, p1 = -45 - PULSE / 2, -45 + PULSE / 2
    sx, sy = c.polar(cx, ty, r, p1 + SLOT)
    ex, ey = c.polar(cx, ty, r, p0 - SLOT)
    data = (
        f"M{sx:.2f} {sy:.2f}A{num(r)} {num(r)} 0 0 1 {num(x1)} {num(ty)}"
        f"L{num(x1)} {num(by)}A{num(r)} {num(r)} 0 0 1 {num(x0)} {num(by)}"
        f"L{num(x0)} {num(ty)}A{num(r)} {num(r)} 0 0 1 {ex:.2f} {ey:.2f}"
    )
    c.parts.append(
        f'<g fill="none" stroke-width="{num(width)}"><path d="{data}" {c.paint("stroke", "ring")}/>'
        f'<path d="{c.arc(cx, ty, r, p0, p1)}" {c.paint("stroke", "lit")}/></g>'
    )


def memory(c, cx, ys, size, step, reading):
    """Draws one core's own memory, centered under its ring: a buffer pool of five, with one
    leased (lit) buffer while the core is reading, one cached Date header, and three cached
    files."""
    for k in range(5):
        x = cx + (k - 2) * step
        if reading and k == 0:
            c.square(x, ys[0], size, "accent")
        else:
            c.square(x, ys[0], size, "station", filled=False)
    c.square(cx, ys[1], size, "station")
    for k in range(3):
        c.square(cx + (k - 1) * step, ys[2], size, "station")


def runtime_wide(palettes, faces):
    """The engine at 960 wide: the cores as columns with labeled rows, the loop below."""
    c = Canvas(960, 688, palettes, faces, RUNTIME_TITLE, RUNTIME_DESC, 16)
    left = 16
    r = 36
    kernel_y = 64
    listen_y = 114
    ring_y = 178

    rows(c, left, 40, [
        ("new connections", 18, "text"),
        ("on Linux the kernel spreads them over", 16, "muted"),
        ([("one ", "sans", "muted"), ("SO_REUSEPORT", "mono", "muted"), (" listener per core;", "sans", "muted")], 16, "muted"),
        ("elsewhere one listener hands them out", 16, "muted"),
    ], 22)

    start = WIDE[0] - 64
    c.text("kernel", start, kernel_y - 12, 16)
    c.line([(start, kernel_y), (944, kernel_y)], width=2.5)
    for cx in WIDE:
        c.circle(cx, kernel_y, 5, "station")
        c.line([(cx, kernel_y + 7), (cx, listen_y - 16)], width=2.5)
        c.arrow(cx, listen_y - 8, "down", size=7)
        c.square(cx, listen_y, 14, "line", filled=False)
        c.line([(cx, listen_y + 7), (cx, ring_y - r - 6)], width=2.5)
    c.text("listener", WIDE[0] - 14, listen_y + 5, 16, role="muted", anchor="end")

    for i, (cx, at) in enumerate(zip(WIDE, ANGLES)):
        c.mark(cx, ring_y, r, 11, at)
        name = "core n" if i == len(WIDE) - 1 else f"core {i}"
        c.text(name, cx, ring_y + r + 30, 17, face="mono", anchor="middle")
    ellipsis(c, WIDE, ring_y, 12)
    rows(c, left, 172, [
        ("one event loop per CPU core", 20, "text"),
        ("a single thread, pinned to its core", 16, "muted"),
        ("a connection never leaves its core", 16, "muted"),
    ], 23)

    c.text("no locks on the request path", left, 288, 16)
    own_y = [314, 344, 374]
    for y, name in zip(own_y, ["own buffer pool", "own Date header cache", "own small-file cache"]):
        c.text(name, left, y + 6, 17)
    for i, cx in enumerate(WIDE):
        memory(c, cx, own_y, 10, 15, i in READING)
    c.square(left + 5, 408, 10, "accent")
    c.text("leased only while bytes are read; an idle connection holds none", left + 19, 414, 16, role="muted")

    head = 472
    top, bottom = head + 56, head + 156
    c.mark(26, head - 6, 9, 3.2)
    c.text("each core runs this loop", 44, head, 18)
    stations = [150, 318, 486, 654, 822]
    notes = [
        ("into a leased buffer", "TLS on the same loop"),
        ("the head, in place", "SIMD, no allocation"),
        ("against the core's", "own route table"),
        ("a rule, file or handler", "a panic is contained"),
        ("pipelined, in order", "one vectored write"),
    ]
    label = "then on to the next connection with work ready"
    half = faces["sans"].width(label, 17) / 2 + 14
    track(c, 16, top, 944, bottom, 5, (480 - half, 480 + half))
    c.text(label, 480, bottom + 6, 17, anchor="middle")
    for ax in ((480 + half + 894) / 2, (66 + 480 - half) / 2):
        c.arrow(ax - 6, bottom, "left", role="ring", size=7)

    c.line([(stations[0], head + 18), (stations[0], top - 22)], width=2.5)
    c.arrow(stations[0], top - 11, "down", size=7)
    c.text("request", stations[0] + 12, head + 40, 16, role="muted")
    c.line([(stations[-1], top - 11), (stations[-1], head + 30)], width=2.5)
    c.arrow(stations[-1], head + 18, "up", size=7)
    c.text("response, same connection, same core", stations[-1] - 12, head + 40, 16, role="muted", anchor="end")

    for i, (sx, name, (n1, n2)) in enumerate(zip(stations, NAMES, notes)):
        c.circle(sx, top, 8, "station")
        if i < len(stations) - 1:
            c.arrow((sx + stations[i + 1]) / 2 + 8, top, "right", role="station", size=7)
        c.text(name, sx, top + 34, 18, anchor="middle")
        c.text(n1, sx, top + 58, 16, role="muted", anchor="middle")
        c.text(n2, sx, top + 80, 16, role="muted", anchor="middle")

    c.runs([
        ("Each loop runs on ", "sans", "muted"),
        ("tokio", "mono", "muted"),
        (" by default, or on ", "sans", "muted"),
        ("compio", "mono", "muted"),
        (" over ", "sans", "muted"),
        ("io_uring", "mono", "muted"),
        (" (Linux), IOCP (Windows) or kqueue (macOS).", "sans", "muted"),
    ], left, bottom + 46, 16)
    c.height = bottom + 60
    c.check("runtime")
    return c.svg()


def runtime_narrow(palettes, faces):
    """The engine at 400 wide: the same rows stacked, the loop as an upright track."""
    c = Canvas(400, 900, palettes, faces, RUNTIME_TITLE, RUNTIME_DESC, 15)
    left = 16
    r = 24

    rows(c, left, 24, [
        ("new connections", 16, "text"),
        ([("one ", "sans", "muted"), ("SO_REUSEPORT", "mono", "muted"), (" listener per core (Linux);", "sans", "muted")], 15, "muted"),
        ("elsewhere one listener hands them out", 15, "muted"),
    ], 21)

    kernel_y = 92
    listen_y = 122
    ring_y = 160
    end = c.text("kernel", left, kernel_y + 5, 15)
    c.line([(end + 8, kernel_y), (384, kernel_y)], width=2)
    for cx in NARROW:
        c.circle(cx, kernel_y, 4, "station")
        c.line([(cx, kernel_y + 6), (cx, listen_y - 13)], width=2)
        c.arrow(cx, listen_y - 6, "down", size=6)
        c.square(cx, listen_y, 11, "line", filled=False)
        c.line([(cx, listen_y + 5.5), (cx, ring_y - r - 4)], width=2)
    c.text("listener", NARROW[0] - 12, listen_y + 5, 15, role="muted", anchor="end")

    for i, (cx, at) in enumerate(zip(NARROW, ANGLES)):
        c.mark(cx, ring_y, r, 8, at)
        name = "core n" if i == len(NARROW) - 1 else f"core {i}"
        c.text(name, cx, ring_y + r + 24, 15, face="mono", anchor="middle")
    ellipsis(c, NARROW, ring_y, 11)

    rows(c, left, 238, [
        ("one event loop per CPU core", 16, "text"),
        ("a pinned thread; a connection never leaves it", 15, "muted"),
    ], 21)

    c.text("no locks on the request path", left, 290, 16)
    own_y = [310, 331, 352]
    for y, name in zip(own_y, ["pool", "Date", "files"]):
        c.text(name, left, y + 5, 15, role="muted")
    for i, cx in enumerate(NARROW):
        memory(c, cx, own_y, 9, 12, i in READING)
    c.square(left + 5, 377, 9, "accent")
    rows(c, left + 16, 382, [
        ("a buffer is leased only while bytes are read;", 15, "muted"),
        ("an idle connection holds none", 15, "muted"),
    ], 21)

    c.mark(25, 433, 8, 3)
    c.text("each core runs this loop", 40, 439, 16)
    top = 456
    x0, x1 = 16, 72
    tx = x1 + 26
    notes = [
        [("in", "the request, into a leased buffer")],
        [(None, "the head in place: SIMD, no allocation")],
        [(None, "against the core's own route table")],
        [(None, "rule, file or handler; a panic is contained")],
        [("out", "the response, same connection;"), (None, "a pipelined burst in one vectored write")],
    ]
    marks = []
    sy = top + 38
    for name, lines in zip(NAMES, notes):
        marks.append(sy)
        c.text(name, tx, sy + 5, 16)
        for k, (flow, line) in enumerate(lines):
            ly = sy + 26 + k * 21
            lx = tx
            if flow == "in":
                c.line([(tx + 18, ly - 5), (tx + 9, ly - 5)], width=2)
                c.arrow(tx + 1, ly - 5, "left", size=5.5)
                lx = tx + 26
            elif flow == "out":
                c.line([(tx, ly - 5), (tx + 10, ly - 5)], width=2)
                c.arrow(tx + 18, ly - 5, "right", size=5.5)
                lx = tx + 26
            c.text(line, lx, ly, 15, role="muted")
        sy += 52 + 21 * (len(lines) - 1)
    bottom = marks[-1] + 52
    upright_track(c, x0, top, x1, bottom, 4)
    for i, my in enumerate(marks):
        c.circle(x1, my, 7, "station")
        if i < len(marks) - 1:
            c.arrow(x1, (my + marks[i + 1]) / 2 + 7, "down", role="station", size=6)
    c.arrow(x0, (top + bottom) / 2 - 7, "up", role="station", size=6)
    c.text("then on to the next connection with work ready", left, bottom + 28, 16)
    y = bottom + 40

    c.runs([
        ("Each loop runs on ", "sans", "muted"),
        ("tokio", "mono", "muted"),
        (" by default, or on", "sans", "muted"),
    ], left, y + 22, 15)
    c.runs([
        ("compio", "mono", "muted"),
        (" over ", "sans", "muted"),
        ("io_uring", "mono", "muted"),
        (" (Linux), IOCP (Windows)", "sans", "muted"),
    ], left, y + 43, 15)
    c.text("or kqueue (macOS).", left, y + 64, 15, role="muted")
    c.height = int(y + 76)
    c.check("runtime-narrow")
    return c.svg()


def thread_pill(c, cx, cy, w, h, size, busy):
    """Draws one host thread as a labeled pill, muted while it has nothing to run."""
    role = "text" if busy else "muted"
    c.pill(cx, cy, w, h, role)
    c.text("thread", cx, cy + size * 0.36, size, face="mono", role=role, anchor="middle")


def batch(c, cx, top, bottom, abi_y, off, square, pitch, arrow):
    """Draws a core's batch to its thread: one call up across the C ABI carrying the ready
    requests, and the results coming back down to the core, which writes the responses."""
    up, down = cx - off, cx + off
    c.line([(up, bottom), (up, top + arrow * 1.4)], width=2)
    c.arrow(up, top, "up", size=arrow)
    c.line([(down, top), (down, bottom - arrow * 1.4)], width=2)
    c.arrow(down, bottom, "down", size=arrow)
    for k in (-1, 0, 1):
        c.square(up, abi_y + k * pitch, square, "station")


def network(c, cx, top, bottom, off, width, size, role):
    """Draws a request arriving at a core from the network and its response leaving."""
    c.line([(cx - off, bottom), (cx - off, top + size * 1.3)], role=role, width=width)
    c.arrow(cx - off, top, "up", role=role, size=size)
    c.line([(cx + off, top), (cx + off, bottom - size * 1.3)], role=role, width=width)
    c.arrow(cx + off, bottom, "down", role=role, size=size)


def bindings_wide(palettes, faces):
    """Your language on the engine at 960 wide: the app's threads above the C ABI, the same
    cores below it, the network meeting only the cores."""
    c = Canvas(960, 536, palettes, faces, BINDINGS_TITLE, BINDINGS_DESC, 16)
    r = 36
    host_y = 108
    abi_y = 204
    ring_y = 306
    box_bottom = 380
    left = 36

    legend = faces["sans"].width("one process", 16)
    c.frame(8, 22, 952, box_bottom, 14, (24, 40 + legend + 8))
    c.text("one process", left, 28, 16, role="muted")

    rows(c, left, 90, [
        ("your app", 20, "text"),
        ("in Node, Python or .NET, with", 16, "muted"),
        ("the core as a native library", 16, "muted"),
    ], 23)
    c.text(
        "one thread per core: a Node worker isolate, the Python handler thread or a .NET thread",
        944, 64, 16, role="muted", anchor="end",
    )

    c.line([(24, abi_y), (944, abi_y)], role="muted", width=1.5, dash="5 6")
    c.text("C ABI", 944, abi_y - 12, 18, anchor="end")

    c.line([(60, 150), (60, 258)], role="station", width=2.5, dash="6 6")
    c.arrow(60, 268, "down", role="station", size=7)
    rows(c, 76, 236, [
        ("declared once, at startup,", 16, "muted"),
        ("kept as tables on every core", 16, "muted"),
    ], 21)
    c.table(44, 270, 292, 354, 3)
    for k, value in enumerate(["routes", "rules: CORS, headers, limits", "static files"]):
        c.text(value, 58, 270 + 28 * k + 19, 16)

    for i, (cx, at) in enumerate(zip(WIDE, ANGLES)):
        crossing = i in CROSSING
        thread_pill(c, cx, host_y, 88, 34, 16, crossing)
        c.mark(cx, ring_y, r, 11, at)
        if crossing:
            batch(c, cx, host_y + 19, ring_y - r - 8, abi_y, 9, 10, 15, 6)
        else:
            c.text("no crossing", cx, 248, 16, role="muted", anchor="middle")
        network(c, cx, ring_y + r + 10, 448, 9, 3, 7, "line" if crossing else "accent")
    ellipsis(c, WIDE, ring_y, 12)
    rows(c, WIDE[2] + 22, 230, [
        ("the core writes", 16, "muted"),
        ("the responses", 16, "muted"),
    ], 21)

    rows(c, left, 424, [
        ("requests", 18, "text"),
        ("every core takes both kinds; the route decides", 16, "muted"),
        ("response on the same connection, same core", 16, "muted"),
    ], 24)

    key_y = 518
    c.line([(left + 4, key_y + 4), (left + 4, key_y - 6)], role="accent", width=3)
    c.arrow(left + 4, key_y - 16, "up", role="accent", size=7)
    c.text("answered in Rust: rules, static files, Rust handlers", left + 22, key_y, 16)
    bx = 528
    c.line([(bx - 18, key_y + 4), (bx - 18, key_y - 6)], role="line", width=3)
    c.arrow(bx - 18, key_y - 16, "up", role="line", size=7)
    for k in range(3):
        c.square(bx + k * 14, key_y - 6, 10, "station")
    c.text("your own handler: one call per batch of up to 256", bx + 42, key_y, 16)
    c.check("bindings")
    return c.svg()


def bindings_narrow(palettes, faces):
    """Your language on the engine at 400 wide, with a key below the picture."""
    c = Canvas(400, 700, palettes, faces, BINDINGS_TITLE, BINDINGS_DESC, 15)
    left = 24
    r = 24
    host_y = 156
    abi_y = 228
    ring_y = 306
    box_bottom = 350

    legend = faces["sans"].width("one process", 15)
    c.frame(8, 16, 392, box_bottom, 12, (22, 36 + legend + 8))
    c.text("one process", 32, 21, 15, role="muted")
    rows(c, left, 52, [
        ("your app in Node, Python or .NET", 16, "text"),
        ("loads the core as a native library, with", 15, "muted"),
        ("one thread per core: a Node worker isolate,", 15, "muted"),
        ("the Python handler thread or a .NET thread", 15, "muted"),
    ], 21)

    c.line([(16, abi_y), (384, abi_y)], role="muted", width=1.5, dash="5 6")
    c.text("C ABI", (FRAMED[2] + FRAMED[3]) / 2, abi_y - 10, 15, anchor="middle")

    c.line([(28, 128), (28, 278)], role="station", width=2.5, dash="6 6")
    c.arrow(28, 288, "down", role="station", size=6)
    c.table(16, 290, 44, 322, 3)

    for i, (cx, at) in enumerate(zip(FRAMED, ANGLES)):
        crossing = i in CROSSING
        thread_pill(c, cx, host_y, 68, 28, 15, crossing)
        c.mark(cx, ring_y, r, 8, at)
        if crossing:
            batch(c, cx, host_y + 16, ring_y - r - 6, abi_y, 7, 9, 13, 5.5)
        network(c, cx, ring_y + r + 8, 420, 7, 2.5, 6, "line" if crossing else "accent")
    ellipsis(c, FRAMED, ring_y, 11)
    c.text("no crossing", FRAMED[1], 268, 15, role="muted", anchor="middle")
    c.text("requests in, responses out on the same connection", 200, 448, 15, role="muted", anchor="middle")
    c.text("every core takes both kinds; the route decides", 200, 469, 15, role="muted", anchor="middle")

    y = 513
    key = [
        ("tables", "routes, rules and static files, declared", "once at startup, kept as tables on every core"),
        ("accent", "answered in Rust: rules, static files and", "Rust handlers, with no crossing"),
        ("batch", "your own handler: one call per batch of", "up to 256; the core writes the responses"),
    ]
    for kind, l1, l2 in key:
        gy = y + 4
        if kind == "tables":
            c.table(16, gy - 18, 40, gy + 6, 3)
        elif kind == "batch":
            c.line([(20, gy + 8), (20, gy - 10)], role="line", width=2.5)
            c.arrow(20, gy - 18, "up", role="line", size=6)
            for k in (-1, 0, 1):
                c.square(36, gy - 6 + k * 13, 9, "station")
        else:
            c.line([(28, gy + 8), (28, gy - 10)], role="accent", width=2.5)
            c.arrow(28, gy - 18, "up", role="accent", size=6)
        c.text(l1, 52, y, 15)
        c.text(l2, 52, y + 21, 15, role="muted")
        y += 62
    c.height = int(y - 22)
    c.check("bindings-narrow")
    return c.svg()


def main():
    """Writes the six diagram files into the output directory."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=str(ROOT / "assets"))
    out = pathlib.Path(parser.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)
    faces = {"sans": Face("sans", 500), "mono": Face("mono", 600)}
    light, dark = PALETTES["light"], PALETTES["dark"]
    files = {
        "runtime.svg": runtime_wide([light], faces),
        "runtime-dark.svg": runtime_wide([dark], faces),
        "runtime-narrow.svg": runtime_narrow([light, dark], faces),
        "bindings.svg": bindings_wide([light], faces),
        "bindings-dark.svg": bindings_wide([dark], faces),
        "bindings-narrow.svg": bindings_narrow([light, dark], faces),
    }
    for name, document in files.items():
        (out / name).write_text(document, encoding="utf-8")
        print(f"wrote {name} ({len(document.encode()) // 1024} KB)")


if __name__ == "__main__":
    main()
