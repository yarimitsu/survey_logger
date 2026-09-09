#!/usr/bin/env python3
"""Static consistency checks across the app's plain-script files.

There is no build step and no module system here - the scripts share globals via
the page - so nothing catches a renamed function, a selector pointing at an id
that no longer exists, or the two copies of NOAA_LAYERS drifting apart. This
does. Run it before committing:

    python tools/check_static.py
"""

import io
import os
import re
import sys

JS = ["app.js", "ui.js", "main.js", "gps.js", "db.js"]
NAMESPACES = {"UI": "ui.js", "GPS": "gps.js", "App": "app.js", "DB": "db.js"}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(name):
    with io.open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read()


def check_ids(problems):
    """Every $('#id') must name an element that exists in index.html."""
    html = read("index.html")
    ids = set(re.findall(r'id="([^"]+)"', html))
    for f in JS:
        for m in re.finditer(r"""\$\(['"]#([\w-]+)['"]\)""", read(f)):
            if m.group(1) not in ids:
                problems.append(f"{f}: $('#{m.group(1)}') has no matching id in index.html")


def check_namespace_members(problems):
    """Every UI.x / GPS.x / App.x / DB.x must be exported by that file."""
    exports = {}
    for ns, fname in NAMESPACES.items():
        m = re.search(r"const %s = \{(.*?)\n\};" % ns, read(fname), re.S)
        exports[ns] = set(re.findall(r"(\w+)\s*[,:]", m.group(1))) if m else set()
        if not m:
            problems.append(f"{fname}: could not find the `const {ns} = {{...}}` export block")
    for f in JS:
        for ns, name in re.findall(r"\b(UI|GPS|App|DB)\.(\w+)", read(f)):
            if name == "state":
                continue
            if name not in exports.get(ns, set()):
                problems.append(f"{f}: {ns}.{name} is not exported by {NAMESPACES[ns]}")


def check_script_order(problems):
    """gps.js and db.js must load before app.js, which uses them at startup."""
    order = re.findall(r'<script src="([^"]+)"', read("index.html"))
    local = [s for s in order if not s.startswith("http")]
    for earlier, later in (("db.js", "app.js"), ("gps.js", "app.js"), ("app.js", "main.js")):
        if earlier not in local or later not in local:
            problems.append(f"index.html: expected both {earlier} and {later} in the script tags")
        elif local.index(earlier) > local.index(later):
            problems.append(f"index.html: {earlier} must load before {later}")


def check_noaa_layers(problems):
    """The chart layer list is duplicated in ui.js and the fetcher.

    They must match: the fetcher bakes the layer list into the cached tile
    images, so a mismatch means the offline chart silently differs from the
    online one - invisible until someone is at sea with no signal.
    """
    js = re.search(r"const NOAA_LAYERS = '([^']+)'", read("ui.js"))
    py = re.search(r'NOAA_LAYERS = "([^"]+)"', read(os.path.join("tools", "fetch_tiles.py")))
    if not js or not py:
        problems.append("could not find NOAA_LAYERS in both ui.js and tools/fetch_tiles.py")
    elif js.group(1) != py.group(1):
        problems.append(
            f"NOAA_LAYERS differ: ui.js has '{js.group(1)}', "
            f"tools/fetch_tiles.py has '{py.group(1)}'"
        )


def check_shell_files(problems):
    """Every local script and stylesheet must be in the service worker's shell."""
    html = read("index.html")
    sw = read("sw.js")
    assets = [s for s in re.findall(r'<script src="([^"]+)"', html) if not s.startswith("http")]
    assets += [s for s in re.findall(r'<link rel="stylesheet" href="([^"]+)"', html)
               if not s.startswith("http")]
    for a in assets:
        if f"'./{a}'" not in sw:
            problems.append(f"sw.js: {a} is loaded by index.html but not in SHELL_FILES")


def main():
    problems = []
    for check in (check_ids, check_namespace_members, check_script_order,
                  check_noaa_layers, check_shell_files):
        check(problems)
    if problems:
        for p in problems:
            print("FAIL  " + p)
        print(f"\n{len(problems)} problem(s).")
        return 1
    print("PASS  ids, namespace members, script order, NOAA_LAYERS, service worker shell")
    return 0


if __name__ == "__main__":
    sys.exit(main())
