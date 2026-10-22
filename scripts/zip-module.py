#!/usr/bin/env python3
"""Zip a Go module directory for the GitHub release.

    python scripts/zip-module.py sdks/go dist/wardogs-banlist-go-0.1.1.zip

Paths inside the archive are relative to the module root, so unzipping produces
go.mod plus banlist/ directly. Used by scripts/release.mjs; no third-party deps.
"""

import os
import sys
import zipfile


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print("usage: python scripts/zip-module.py <module-dir> <out.zip>", file=sys.stderr)
        return 2

    source, target = argv[1], argv[2]
    if not os.path.isdir(source):
        print(f"not a directory: {source}", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(target)), exist_ok=True)

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for dirpath, dirnames, filenames in os.walk(source):
            dirnames[:] = sorted(d for d in dirnames if d not in {".git", "testdata", "__pycache__"})
            for name in sorted(filenames):
                if name.endswith((".exe", ".test")):
                    continue
                full = os.path.join(dirpath, name)
                archive.write(full, os.path.relpath(full, source).replace(os.sep, "/"))

    print(f"{target} ({os.path.getsize(target)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
