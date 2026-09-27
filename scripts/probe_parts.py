# -*- coding: utf-8 -*-
"""Probe the SUB-MESH structure of hero prop GLBs.

Why this exists
---------------
`props.js` animates a prop by transforming its hero group. That group's origin
is the model's bbox centre (see `kit.js` load(): root.position.set(-c.x,
-box.min.y, -c.z)), NOT a hinge or a drawer pivot. So rotating the whole group
swings the object about its own middle -- which reads as "the door vanished".

The fix is to animate the RIGHT sub-mesh (the door leaf / the drawer) about its
own pivot. That needs facts, not guesses: which mesh names exist in each file,
and where each one's axis-aligned bbox sits. This script prints exactly that,
from the GLB bytes, with no three.js and no browser.

Usage:  python scripts/probe_parts.py [model ...]
Output: data/prop_parts.json + a readable report on stdout.
"""
import json
import os
import struct
import sys

GAME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.path.join(GAME, "assets", "models")
OUT = os.path.join(GAME, "data")

# Models a player actually walks up to in the shipped flat, plus the special
# cases (a single-mesh hood, a doorway whose leaf is a distinct mesh).
DEFAULT = [
    "doorway", "doorwayFront", "doorwayOpen",
    "kitchenCabinet", "kitchenCabinetDrawer", "kitchenCabinetUpper",
    "kitchenCabinetUpperDouble", "kitchenCabinetUpperCorner",
    "cabinetBed", "cabinetBedDrawer", "cabinetBedDrawerTable",
    "cabinetTelevision", "cabinetTelevisionDoors",
    "bathroomCabinet", "bathroomCabinetDrawer",
    "bookcaseClosed", "bookcaseClosedDoors", "bookcaseClosedWide",
    "bookcaseOpen", "bookcaseOpenLow",
    "cardboardBoxClosed", "cardboardBoxOpen",
    "fridge", "fridgeBuiltin", "hoodLarge", "hoodModern",
    "washer", "dryer", "sideTableDrawers", "sideTable",
    "trashcan", "coatRackStanding",
]


def read_glb(path):
    with open(path, "rb") as fh:
        data = fh.read()
    magic, _version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError("not a glb: %s" % path)
    off = 12
    gltf = None
    while off < length:
        clen, ctype = struct.unpack_from("<I4s", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == b"JSON":
            gltf = json.loads(chunk.decode("utf-8"))
        off += 8 + clen
    return gltf


def node_world(gltf):
    """Every node's name + world translation, so a mesh's pivot is known."""
    nodes = gltf.get("nodes", [])
    out = []
    for i, n in enumerate(nodes):
        t = n.get("translation", [0, 0, 0])
        out.append({
            "i": i,
            "name": n.get("name", ""),
            "mesh": n.get("mesh"),
            "t": [round(v, 4) for v in t],
            "children": n.get("children", []),
        })
    return out


def main():
    names = sys.argv[1:] or DEFAULT
    accessors_cache = {}
    report = {}

    for name in names:
        path = os.path.join(KIT, name + ".glb")
        if not os.path.exists(path):
            report[name] = {"error": "missing file"}
            continue
        gltf = read_glb(path)
        accs = gltf.get("accessors", [])
        meshes = gltf.get("meshes", [])
        accessors_cache.clear()

        parts = []
        for mi, mes in enumerate(meshes):
            for pi, prim in enumerate(mes.get("primitives", [])):
                pos = prim.get("attributes", {}).get("POSITION")
                if pos is None:
                    continue
                acc = accs[pos]
                parts.append({
                    "mesh": mes.get("name", "mesh%d" % mi),
                    "prim": pi,
                    "tris": accs[prim["indices"]]["count"] // 3 if "indices" in prim else 0,
                    "min": [round(v, 4) for v in acc.get("min", [0, 0, 0])],
                    "max": [round(v, 4) for v in acc.get("max", [0, 0, 0])],
                })

        report[name] = {
            "nodes": node_world(gltf),
            "parts": parts,
            "meshes": len(meshes),
            "node_count": len(gltf.get("nodes", [])),
        }

    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, "prop_parts.json"), "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=1)

    lines = []
    for name in names:
        r = report.get(name, {})
        if "error" in r:
            lines.append("%-28s  ERROR %s" % (name, r["error"]))
            continue
        lines.append("%-28s  meshes=%d nodes=%d" % (name, r["meshes"], r["node_count"]))
        for p in r["parts"]:
            size = [round(p["max"][i] - p["min"][i], 4) for i in range(3)]
            lines.append("    %-26s tris=%-5d size=%s  min=%s max=%s" % (
                p["mesh"], p["tris"], size, p["min"], p["max"]))
        # Node pivots matter when a sub-mesh is a separate node (e.g. doorFridge).
        for nd in r["nodes"]:
            if nd["name"]:
                lines.append("    node %-24s mesh=%s t=%s" % (nd["name"], nd["mesh"], nd["t"]))
        lines.append("")

    txt = "\n".join(lines)
    with open(os.path.join(GAME, "reports", "prop_parts.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt)
    print(txt)
    print("[probe_parts] wrote data/prop_parts.json")


if __name__ == "__main__":
    main()
