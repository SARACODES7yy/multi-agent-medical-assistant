"""i18n drift check: every translation key referenced in the UI must exist in
every language dictionary, and all dictionaries must expose the same key set.

    python scripts/check_i18n.py

Exits non-zero on any drift (missing key, extra key, or dangling reference).
"""

import glob
import os
import re
import sys

JS_PATH = "static/js/i18n.js"
TEMPLATE_GLOB = "templates/*.html"
CLIENT_JS_GLOBS = ["static/js/*.js"]

_KEY_RE = re.compile(r"""(?:\x27([^\x27\\]+)\x27|"([^"\\]+)")\s*:""")
_LANG_BLOCK_RE = re.compile(r"I18N_DICT\.(\w+)\s*=\s*\{(.*?)\n\};", re.S)
_USAGE_RE = re.compile(r"""data-i18n(?:-html)?=["']([^"']+)["']""")
_TS_RE = re.compile(r"""\bt\(\x27([^\x27\\]+)\x27\)""")


def parse_langs():
    src = open(JS_PATH, encoding="utf-8").read()
    langs = {}
    for m in _LANG_BLOCK_RE.finditer(src):
        lang, body = m.group(1), m.group(2)
        keys = set()
        for k1, k2 in _KEY_RE.findall(body):
            keys.add(k1 or k2)
        langs[lang] = keys
    return langs


def collect_usages():
    used = {}
    for tpl in glob.glob(TEMPLATE_GLOB):
        html = open(tpl, encoding="utf-8").read()
        for k in _USAGE_RE.findall(html):
            used.setdefault(k, []).append(tpl)
    for js in glob.glob("static/js/*.js"):
        if js.endswith("i18n.js"):
            continue
        text = open(js, encoding="utf-8").read()
        for k in _TS_RE.findall(text):
            used.setdefault(k, []).append(js)
    return used


def main():
    langs = parse_langs()
    if len(langs) < 2:
        print("FAIL could not parse language dictionaries from", JS_PATH)
        return 1
    base = langs["en"]
    print(f"i18n: {len(langs)} languages, en has {len(base)} keys")
    problems = []
    for lang, keys in langs.items():
        for k in base - keys:
            problems.append(f"{lang}: MISSING key {k!r}")
        for k in keys - base:
            problems.append(f"{lang}: EXTRA key {k!r} (not in en)")
    used = collect_usages()
    for u, srcs in sorted(used.items()):
        if u not in base:
            problems.append(f"REFERENCED key {u!r} missing from dictionaries (via {', '.join(srcs)})")
    # tab.appointments is the newest key; make sure it landed everywhere
    for lang in langs:
        if "tab.appointments" not in langs[lang]:
            problems.append(f"{lang}: tab.appointments missing")
    if problems:
        print("\n".join(sorted(set(problems))))
        print(f"i18n DRIFT: {len(set(problems))} problem(s)")
        return 1
    print("i18n: no drift, all languages consistent")
    return 0


if __name__ == "__main__":
    sys.exit(main())