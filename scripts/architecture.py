"""Draws the architecture diagram the README shows, in four files from one source.

The picture follows one request: it arrives from the network at a core, runs
along the five handler tiers cheapest first, and stops at the first tier that
answers; only tier 3 crosses the C ABI, as one batch, to the host runtime, and
the response leaves on the same connection. Every color is a palette token from
docs/brand.md, and every glyph is outlined from Outfit and JetBrains Mono (SIL
Open Font License 1.1), so the image renders the same on every system.

    python scripts/architecture.py [--out assets]

Writes architecture.svg and architecture-dark.svg (960 wide) and
architecture-narrow.svg and architecture-narrow-dark.svg (400 wide). The fonts
are downloaded once into target/fonts from pinned google/fonts commits and
checked by SHA-256. Requires fontTools.
"""

import argparse
import hashlib
import pathlib
import urllib.request

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
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
        "idle": "#57534A",
    },
    "dark": {
        "text": "#F4EEE1",
        "muted": "#A39E93",
        "line": "#A39E93",
        "station": "#CFAE45",
        "ring": "#CFAE45",
        "lit": "#D9F542",
        "accent": "#D9F542",
        "idle": "#A39E93",
    },
}

TITLE = "zero-server architecture"
DESC = (
    "A request arrives from the network at one core; there is one core, with its own "
    "event loop, per CPU core. On the core the request runs along five handler tiers, "
    "cheapest first, and stops at the first tier that answers: 0 declarative rules, "
    "1 the core's cache, 2 a data plan the core runs itself, 3 a host-language handler, "
    "4 a Rust handler. Only tier 3 leaves Rust: it crosses the C ABI with one call per "
    "batch to the Node, Python or .NET runtime paired with the core. The response "
    "leaves on the same connection."
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

    def path(self, text, x, y, size):
        """Returns SVG path data for `text` with its baseline origin at (x, y)."""
        scale = size / self.units
        pen = SVGPathPen(self.glyphs, ntos=lambda v: f"{v:.1f}".rstrip("0").rstrip("."))
        cursor = x
        for char in text:
            glyph = self.glyphs[self.cmap[ord(char)]]
            glyph.draw(TransformPen(pen, (scale, 0, 0, -scale, cursor, y)))
            cursor += glyph.width * scale
        return pen.getCommands()


class Canvas:
    """Collects the elements of one diagram and serializes them."""

    def __init__(self, width, height, palette, faces, top=0):
        self.width = width
        self.height = height
        self.top = top
        self.palette = palette
        self.faces = faces
        self.parts = []

    def text(self, value, x, y, size, face="sans", role="text", anchor="start"):
        """Adds outlined text; `anchor` is start, middle or end."""
        font = self.faces[face]
        width = font.width(value, size)
        start = {"start": x, "middle": x - width / 2, "end": x - width}[anchor]
        fill = self.palette[role]
        self.parts.append(f'<path fill="{fill}" d="{font.path(value, start, y, size)}"/>')
        return start + width

    def line(self, points, role="line", width=3, dash=None):
        """Adds a polyline through `points`."""
        data = "M" + " L".join(f"{px:g} {py:g}" for px, py in points)
        extra = f' stroke-dasharray="{dash}"' if dash else ""
        stroke = self.palette[role]
        self.parts.append(
            f'<path d="{data}" fill="none" stroke="{stroke}" stroke-width="{width}"'
            f' stroke-linecap="round" stroke-linejoin="round"{extra}/>'
        )

    def arrow(self, x, y, direction, role="line", size=9):
        """Adds a filled arrowhead with its tip at (x, y) pointing up, down, left or right."""
        dx, dy = {"right": (1, 0), "left": (-1, 0), "down": (0, 1), "up": (0, -1)}[direction]
        bx, by = x - dx * size * 1.4, y - dy * size * 1.4
        ax, ay = bx - dy * size * 0.75, by + dx * size * 0.75
        cx, cy = bx + dy * size * 0.75, by - dx * size * 0.75
        fill = self.palette[role]
        self.parts.append(f'<path d="M{x:g} {y:g}L{ax:g} {ay:g}L{cx:g} {cy:g}Z" fill="{fill}"/>')

    def circle(self, x, y, r, fill=None, stroke=None, width=3):
        """Adds a circle filled or stroked with palette roles."""
        attrs = f'fill="{self.palette[fill]}"' if fill else 'fill="none"'
        if stroke:
            attrs += f' stroke="{self.palette[stroke]}" stroke-width="{width}"'
        self.parts.append(f'<circle cx="{x:g}" cy="{y:g}" r="{r:g}" {attrs}/>')

    def rect(self, x, y, w, h, role):
        """Adds a small filled square, used for the request slots of a batch."""
        self.parts.append(
            f'<rect x="{x:g}" y="{y:g}" width="{w:g}" height="{h:g}" rx="2" fill="{self.palette[role]}"/>'
        )

    def ring(self, x, y, r, width):
        """Adds the brand mark: a ring with one lit segment, the core's event loop."""
        self.circle(x, y, r, stroke="ring", width=width)
        self.parts.append(
            f'<path d="M{x + r * 0.643:.1f} {y - r * 0.766:.1f}A{r} {r} 0 0 1 {x + r * 0.985:.1f} {y - r * 0.174:.1f}"'
            f' fill="none" stroke="{self.palette["lit"]}" stroke-width="{width}"/>'
        )

    def svg(self):
        """Returns the finished document."""
        body = "".join(self.parts)
        visible = self.height - self.top
        return (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {self.top} {self.width} {visible}"'
            f' width="{self.width}" height="{visible}" role="img" aria-labelledby="t d">'
            f'<title id="t">{TITLE}</title><desc id="d">{DESC}</desc>{body}</svg>\n'
        )


def tier_label(c, number, name, x, y, size, anchor):
    """Draws a tier as its number in the mono voice followed by its name."""
    mono = c.faces["mono"]
    sans = c.faces["sans"]
    gap = size * 0.4
    total = mono.width(number, size) + gap + sans.width(name, size)
    start = {"start": x, "middle": x - total / 2}[anchor]
    after = c.text(number, start, y, size, face="mono", role="muted")
    c.text(name, after + gap, y, size)


def wide(palette, faces):
    """The 960-wide variant: the request path read left to right."""
    c = Canvas(960, 312, palette, faces, top=44)
    track_y = 110
    ring_x = 140
    stations = [260, 400, 540, 690, 840]
    names = ["rules", "cache", "data plan", "host handler", "Rust handler"]

    c.text("response", 16, 74, 18, role="muted")
    c.line([(98, 88), (28, 88)])
    c.arrow(18, 88, "left")
    c.text("request", 16, 156, 18, role="muted")
    c.line([(16, 132), (86, 132)])
    c.arrow(96, 132, "right")

    c.ring(ring_x, track_y, 40, 12)
    c.text("event loop", ring_x, 184, 20, anchor="middle")
    c.text("one per CPU core", ring_x, 210, 18, role="muted", anchor="middle")

    c.line([(ring_x + 46, track_y), (stations[3], track_y)])
    c.line([(stations[3], track_y), (stations[4], track_y)], role="idle", width=2, dash="2 8")
    for x in stations[:4]:
        c.arrow(x - 16, track_y, "right")
    for i, x in enumerate(stations):
        if i == 3:
            c.circle(x, track_y, 12, fill="accent")
        elif i == 4:
            c.circle(x, track_y, 8, stroke="idle", width=2.5)
        else:
            c.circle(x, track_y, 9, fill="station")
        tier_label(c, str(i), names[i], x, 80, 20, "middle")

    c.text("stops at the first tier that answers", 244, 156, 18, role="muted")

    c.line([(612, 236), (948, 236)], role="muted", width=1.5, dash="5 6")
    c.text("C ABI, one call per batch", 948, 222, 18, role="muted", anchor="end")
    c.line([(682, track_y + 20), (682, 264)], role="accent")
    c.arrow(682, 274, "down", role="accent")
    c.line([(698, 266), (698, track_y + 28)], role="accent")
    c.arrow(698, track_y + 18, "up", role="accent")
    for i in range(3):
        c.rect(644 + i * 12, 230, 9, 9, "accent")
    c.text("Node   Python   .NET", 690, 302, 20, anchor="middle")
    return c.svg()


def narrow(palette, faces):
    """The 400-wide variant: the request path read top to bottom."""
    c = Canvas(400, 640, palette, faces)
    track_x = 120
    stations = [210, 290, 370, 450, 530]
    names = ["rules", "cache", "data plan", "host handler", "Rust handler"]

    c.text("response", 96, 30, 16, role="muted", anchor="end")
    c.line([(108, 60), (108, 20)])
    c.arrow(108, 10, "up")
    c.text("request", 146, 30, 16, role="muted")
    c.line([(132, 8), (132, 48)])
    c.arrow(132, 58, "down")

    c.ring(track_x, 100, 34, 10)
    c.text("event loop", 172, 98, 18)
    c.text("one per CPU core", 172, 122, 16, role="muted")

    c.line([(track_x, 139), (track_x, stations[3])])
    c.line([(track_x, stations[3]), (track_x, stations[4])], role="idle", width=2, dash="2 8")
    for y in stations[:4]:
        c.arrow(track_x, y - 15, "down")
    for i, y in enumerate(stations):
        if i == 3:
            c.circle(track_x, y, 11, fill="accent")
        elif i == 4:
            c.circle(track_x, y, 7, stroke="idle", width=2.5)
        else:
            c.circle(track_x, y, 8, fill="station")
        tier_label(c, str(i), names[i], track_x + 26, y + 6, 18, "start")

    c.line([(300, 400), (300, 500)], role="muted", width=1.5, dash="5 6")
    c.text("C ABI", 300, 392, 16, role="muted", anchor="middle")
    c.line([(track_x + 16, stations[3] + 22), (322, stations[3] + 22)], role="accent")
    c.arrow(332, stations[3] + 22, "right", role="accent")
    for i in range(3):
        c.rect(252 + i * 12, stations[3] + 30, 9, 9, "accent")
    c.text("Node", 344, stations[3] - 18, 16, anchor="start")
    c.text("Python", 344, stations[3] + 6, 16, anchor="start")
    c.text(".NET", 344, stations[3] + 30, 16, anchor="start")

    c.text("stops at the first tier", 24, 588, 16, role="muted")
    c.text("that answers", 24, 610, 16, role="muted")
    return c.svg()


def main():
    """Writes the four diagram files into the output directory."""
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=str(ROOT / "assets"))
    out = pathlib.Path(parser.parse_args().out)
    out.mkdir(parents=True, exist_ok=True)
    faces = {"sans": Face("sans", 500), "mono": Face("mono", 600)}
    for scheme, palette in PALETTES.items():
        suffix = "" if scheme == "light" else "-dark"
        (out / f"architecture{suffix}.svg").write_text(wide(palette, faces), encoding="utf-8")
        (out / f"architecture-narrow{suffix}.svg").write_text(narrow(palette, faces), encoding="utf-8")
        print(f"wrote architecture{suffix}.svg and architecture-narrow{suffix}.svg")


if __name__ == "__main__":
    main()
