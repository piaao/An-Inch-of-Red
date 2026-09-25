# -*- coding: utf-8 -*-
"""Fetch three.js + addons into vendor/ (mirrors tried in order)."""
import os
import ssl
import sys
import urllib.request

# 相对定位：本脚本住在 scripts/，仓库根目录就是它的上一级。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VENDOR = os.path.join(ROOT, "vendor")
os.makedirs(os.path.join(VENDOR, "addons", "controls"), exist_ok=True)
os.makedirs(os.path.join(VENDOR, "addons", "loaders"), exist_ok=True)
os.makedirs(os.path.join(VENDOR, "addons", "utils"), exist_ok=True)

VER = "0.169.0"

TARGETS = [
    ("build/three.module.js", "three.module.js"),
    ("examples/jsm/controls/OrbitControls.js", "addons/controls/OrbitControls.js"),
    ("examples/jsm/loaders/GLTFLoader.js", "addons/loaders/GLTFLoader.js"),
    ("examples/jsm/utils/BufferGeometryUtils.js", "addons/utils/BufferGeometryUtils.js"),
]

MIRRORS = [
    "https://registry.npmmirror.com/three/{v}/files/",
    "https://cdn.jsdelivr.net/npm/three@{v}/",
    "https://unpkg.com/three@{v}/",
    "https://cdn.staticfile.org/three.js/{v}/",
]

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE

report = []
for rel, dest in TARGETS:
    out = os.path.join(VENDOR, dest)
    if os.path.exists(out) and os.path.getsize(out) > 2000:
        report.append("SKIP  %-44s (already %d bytes)" % (rel, os.path.getsize(out)))
        continue
    got = False
    for m in MIRRORS:
        url = m.format(v=VER) + rel
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=30, context=CTX) as resp:
                data = resp.read()
            if len(data) < 2000:
                report.append("THIN  %-44s %s -> %d bytes" % (rel, url, len(data)))
                continue
            with open(out, "wb") as fh:
                fh.write(data)
            report.append("OK    %-44s %8d bytes  <- %s" % (dest, len(data), url))
            got = True
            break
        except Exception as exc:  # noqa: BLE001
            report.append("FAIL  %-44s %s -> %s" % (rel, url.split('/')[2], type(exc).__name__))
    if not got:
        report.append("MISS  %s could not be fetched from any mirror" % rel)

txt = "\n".join(report)
with open(os.path.join(ROOT, "work", "vendor_fetch.txt"), "w", encoding="utf-8") as fh:
    fh.write(txt)
print(txt)
missing = [r for r in report if r.startswith(("MISS", "THIN"))]
print("\nmissing:", len(missing))
sys.exit(1 if missing else 0)
