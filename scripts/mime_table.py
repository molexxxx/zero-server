#!/usr/bin/env python3
"""Write crates/zero-mime/src/table.rs from a copy of mime-db's db.json.

Usage: python3 scripts/mime_table.py <db.json> <package.json> <nginx mime.types>

The extension table maps every file extension mime-db knows to one media type.
Where mime-db lists an extension under several types, the one registered with
IANA wins, then the one Apache's table names, then nginx's, then the rest; a tie
goes to the type nginx's own table names for the extension, then to a type whose
top-level type is not `application`, then to the alphabetically first, so the
table is a function of the inputs alone.
"""

import json
import re
import sys

SOURCE_RANK = {"iana": 0, "apache": 1, "nginx": 2}


def nginx_table(path):
    """The extension to media type map of nginx's conf/mime.types."""
    table = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            line = line.strip().rstrip(";")
            if not line or line.startswith(("#", "types", "}")):
                continue
            parts = line.split()
            for extension in parts[1:]:
                table.setdefault(extension.lower(), parts[0].lower())
    return table


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        return 2
    with open(sys.argv[1], encoding="utf-8") as handle:
        db = json.load(handle)
    with open(sys.argv[2], encoding="utf-8") as handle:
        version = json.load(handle)["version"]
    nginx = nginx_table(sys.argv[3])
    by_extension = {}
    for media_type, info in db.items():
        for extension in info.get("extensions", []):
            rank = SOURCE_RANK.get(info.get("source"), 3)
            by_extension.setdefault(extension.lower(), []).append((rank, media_type.lower()))
    rows = []
    for extension in sorted(by_extension):
        def key(candidate, extension=extension):
            rank, media_type = candidate
            return (
                rank,
                0 if nginx.get(extension) == media_type else 1,
                1 if media_type.startswith("application/") else 0,
                media_type,
            )
        _, media_type = sorted(by_extension[extension], key=key)[0]
        rows.append((extension, media_type))
    for extension, media_type in rows:
        assert extension.isascii() and media_type.isascii()
        assert '"' not in extension and '"' not in media_type
    lines = [
        "//! The extension table, written by `scripts/mime_table.py` from mime-db",
        f"//! {version} (jshttp, MIT), itself compiled from the IANA media type registry,",
        "//! Apache's and nginx's tables. Do not edit by hand.",
        "",
        "/// The mime-db version the table was written from.",
        f'pub const SOURCE_VERSION: &str = "{version}";',
        "",
        "/// Lowercase extension to lowercase media type, sorted by extension.",
        f"pub static EXTENSIONS: [(&str, &str); {len(rows)}] = [",
    ]
    lines.extend(f'    ("{ext}", "{mt}"),' for ext, mt in rows)
    lines.append("];")
    lines.append("")
    with open("crates/zero-mime/src/table.rs", "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines))
    print(f"wrote {len(rows)} extensions from mime-db {version}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
