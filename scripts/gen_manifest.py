# -*- coding: utf-8 -*-
"""Emit assets/manifest.json from the parsed GLB index (facts only)."""
import json
import os

# 相对定位：本脚本住在 scripts/，仓库根目录就是它的上一级。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

kit = json.load(open(os.path.join(DATA, "kit_index.json"), encoding="utf-8"))

models = []
for name in sorted(kit):
    e = kit[name]
    colors = []
    for m in e["materials"]:
        c = m["base"]
        colors.append([round(c[0], 3), round(c[1], 3), round(c[2], 3)])
    models.append({
        "name": name,
        "file": name + ".glb",
        "tris": e["tris"],
        "verts": e["verts"],
        "materials": len(e["materials"]),
        "kb": e["kb"],
        "colors": colors,
    })

out = {
    "kit": "Kenney Furniture Kit",
    "license": "CC0 1.0 (public domain)",
    "source": "kenney.nl",
    "count": len(models),
    "totalTris": sum(m["tris"] for m in models),
    "models": models,
}
dest = os.path.join(ROOT, "assets", "manifest.json")
with open(dest, "w", encoding="utf-8") as fh:
    json.dump(out, fh, ensure_ascii=False, indent=1)
print("wrote %s  (%d models, %d tris)" % (dest, out["count"], out["totalTris"]))
