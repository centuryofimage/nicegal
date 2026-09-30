#!/usr/bin/env python3
"""Reject ELF binaries above the Debian 12 GLIBC / libstdc++ baseline."""

import pathlib
import re
import subprocess
import sys


def check(root: pathlib.Path) -> None:
    if not root.is_dir():
        raise SystemExit(f"Missing packaged application: {root}")
    count = 0
    failures = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.is_symlink():
            continue
        with path.open("rb") as file:
            if file.read(4) != b"\x7fELF":
                continue
        count += 1
        info = subprocess.check_output(["readelf", "--version-info", str(path)], text=True)
        # Only imported versions impose host requirements; ignore exported version definitions.
        needs = info.partition("Version needs section")[2]
        summary = []
        for prefix, ceiling in (("GLIBC", (2, 36)), ("GLIBCXX", (3, 4, 30))):
            versions = {
                tuple(map(int, version.split(".")))
                for version in re.findall(rf"Name: {prefix}_([0-9.]+)", needs)
            }
            if versions:
                highest = max(versions)
                requirement = f"{prefix}_{'.'.join(map(str, highest))}"
                summary.append(requirement)
                if highest > ceiling:
                    failures.append(f"{path.relative_to(root)} requires {requirement}")
        print(f"{path.relative_to(root)}: {', '.join(summary) or 'no versioned libc imports'}")
    if not count:
        raise SystemExit("No ELF binaries found in packaged application")
    if failures:
        raise SystemExit("Linux ABI baseline exceeded:\n" + "\n".join(failures))
    print(f"Checked {count} ELF binaries against Debian 12")


if __name__ == "__main__":
    check(pathlib.Path(sys.argv[1]))
