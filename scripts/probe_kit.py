# -*- coding: utf-8 -*-
"""Parse Kenney GLB files with pure stdlib: bbox, materials, tri counts.

Writes data/kit_index.json + a human-readable report.
"""
import json
import os
import struct
import sys
from collections import defaultdict

# 相对定位：本脚本住在 scripts/，仓库根目录就是它的上一级。
# 素材读的是游戏自己收编的那 140 个 .glb —— 与原 Kenney 套件逐字节相同
# （140/140 已实测），所以本仓库不依赖任何外部素材包，也不写死本机绝对路径。
GAME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.path.join(GAME, "assets", "models")
OUT = os.path.join(GAME, "data")
os.makedirs(OUT, exist_ok=True)


def read_glb(path):
    with open(path, "rb") as fh:
        data = fh.read()
    magic, version, length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise ValueError("not a glb: %s" % path)
    off = 12
    gltf = None
    binbuf = None
    while off < length:
        clen, ctype = struct.unpack_from("<I4s", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == b"JSON":
            gltf = json.loads(chunk.decode("utf-8"))
        elif ctype[:3] == b"BIN":
            binbuf = chunk
        off += 8 + clen
    return gltf, binbuf, len(data)


def probe(path):
    gltf, _bin, nbytes = read_glb(path)
    accessors = gltf.get("accessors", [])
    meshes = gltf.get("meshes", [])
    nodes = gltf.get("nodes", [])
    materials = gltf.get("materials", [])
    images = gltf.get("images", [])
    textures = gltf.get("textures", [])

    tris = 0
    verts = 0
    bmin = [1e9] * 3
    bmax = [-1e9] * 3
    for mes in meshes:
        for prim in mes.get("primitives", []):
            if "indices" in prim:
                tris += accessors[prim["indices"]]["count"] // 3
            pos = prim.get("attributes", {}).get("POSITION")
            if pos is not None:
                acc = accessors[pos]
                verts += acc["count"]
                if "min" in acc:
                    for i in range(3):
                        bmin[i] = min(bmin[i], acc["min"][i])
                        bmax[i] = max(bmax[i], acc["max"][i])

    mats = []
    for m in materials:
        pbr = m.get("pbrMetallicRoughness", {})
        base = pbr.get("baseColorFactor", [1, 1, 1, 1])
        mats.append({
            "name": m.get("name", ""),
            "base": [round(c, 4) for c in base],
            "metallic": pbr.get("metallicFactor", 1.0),
            "roughness": pbr.get("roughnessFactor", 1.0),
            "has_tex": "baseColorTexture" in pbr,
        })

    return {
        "file": os.path.basename(path),
        "kb": round(nbytes / 1024.0, 1),
        "nodes": len(nodes),
        "meshes": len(meshes),
        "materials": mats,
        "images": len(images),
        "textures": len(textures),
        "tris": tris,
        "verts": verts,
        "bbox_min": [round(v, 4) for v in bmin],
        "bbox_max": [round(v, 4) for v in bmax],
        "size": [round(bmax[i] - bmin[i], 4) for i in range(3)],
        "node_names": [n.get("name", "") for n in nodes][:8],
    }


def main():
    names = sorted(f for f in os.listdir(KIT) if f.endswith(".glb"))
    index = {}
    fails = []
    for n in names:
        tag = os.path.splitext(n)[0]
        try:
            index[tag] = probe(os.path.join(KIT, n))
        except Exception as exc:  # noqa
            fails.append((tag, repr(exc)))

    with open(os.path.join(OUT, "kit_index.json"), "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, indent=1)

    tot_tris = sum(v["tris"] for v in index.values())
    mat_all = defaultdict(int)
    for v in index.values():
        for m in v["materials"]:
            mat_all[tuple(m["base"])] += 1

    lines = []
    lines.append("models parsed : %d   (failures: %d)" % (len(index), len(fails)))
    lines.append("total tris    : %d" % tot_tris)
    lines.append("total verts   : %d" % sum(v["verts"] for v in index.values()))
    lines.append("any embedded image: %s" % any(v["images"] for v in index.values()))
    lines.append("distinct baseColors used: %d" % len(mat_all))
    lines.append("")
    lines.append("== distinct material colors (rgb -> usage) ==")
    for c, n in sorted(mat_all.items(), key=lambda kv: -kv[1]):
        lines.append("   %-34s %d" % (str([round(x, 3) for x in c[:3]]), n))
    lines.append("")
    lines.append("== per-model (name | kb | tris | verts | mats | size XYZ in glb units) ==")
    for tag in sorted(index):
        v = index[tag]
        lines.append("  %-30s %6.1f KB  t%-5d v%-5d m%-2d  %s" % (
            tag, v["kb"], v["tris"], v["verts"], len(v["materials"]),
            " x ".join("%7.3f" % s for s in v["size"])))
    if fails:
        lines.append("")
        lines.append("== FAILURES ==")
        for t, e in fails:
            lines.append("   %s -> %s" % (t, e))

    txt = "\n".join(lines)
    with open(os.path.join(OUT, "kit_index.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt)
    print(txt[:6000])
    print("\n[probe_kit] wrote %s" % os.path.join(OUT, "kit_index.json"))


if __name__ == "__main__":
    main()
