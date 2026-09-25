# -*- coding: utf-8 -*-
"""Walk GLB node hierarchy with full transforms -> true world-space bbox.

Local accessor min/max ignores node scale/translation, which Kenney kits use.
Writes data/kit_world.json and appends a table to data/kit_index.txt.
"""
import json
import os
import struct

# 相对定位：本脚本住在 scripts/，仓库根目录就是它的上一级。
# 素材读的是游戏自己收编的那 140 个 .glb —— 与原 Kenney 套件逐字节相同
# （140/140 已实测），所以本仓库不依赖任何外部素材包，也不写死本机绝对路径。
GAME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.path.join(GAME, "assets", "models")
OUT = os.path.join(GAME, "data")
os.makedirs(OUT, exist_ok=True)


# ---------------------------------------------------------------- mat4 helpers
def ident():
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def mul(a, b):
    """Column-major 4x4 multiply, matching glTF: result = a * b."""
    out = [0.0] * 16
    for c in range(4):
        for r in range(4):
            s = 0.0
            for k in range(4):
                s += a[k * 4 + r] * b[c * 4 + k]
            out[c * 4 + r] = s
    return out


def from_trs(t, r, s):
    x, y, z, w = r
    m = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
        0, 0, 0, 1,
    ]
    for c in range(3):
        for r2 in range(3):
            m[c * 4 + r2] *= s[c]
    m[12], m[13], m[14] = t
    return m


def xform(m, p):
    x, y, z = p
    return [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    ]


def read_glb(path):
    with open(path, "rb") as fh:
        data = fh.read()
    _magic, _v, length = struct.unpack_from("<4sII", data, 0)
    off, gltf = 12, None
    while off < length:
        clen, ctype = struct.unpack_from("<I4s", data, off)
        if ctype == b"JSON":
            gltf = json.loads(data[off + 8: off + 8 + clen].decode("utf-8"))
        off += 8 + clen
    return gltf


def world_bbox(gltf):
    accessors = gltf.get("accessors", [])
    nodes = gltf.get("nodes", [])
    meshes = gltf.get("meshes", [])
    scene = gltf.get("scenes", [{}])[gltf.get("scene", 0)]
    bmin, bmax = [1e9] * 3, [-1e9] * 3
    node_scale = []

    def visit(idx, parent):
        node = nodes[idx]
        if "matrix" in node:
            local = list(node["matrix"])
        else:
            local = from_trs(
                node.get("translation", [0, 0, 0]),
                node.get("rotation", [0, 0, 0, 1]),
                node.get("scale", [1, 1, 1]),
            )
        world = mul(parent, local)
        # record uniform-ish scale for reporting
        sx = (world[0] ** 2 + world[1] ** 2 + world[2] ** 2) ** 0.5
        if sx and abs(sx - 1.0) > 1e-4:
            node_scale.append(round(sx, 5))
        if "mesh" in node:
            for prim in meshes[node["mesh"]].get("primitives", []):
                pos = prim.get("attributes", {}).get("POSITION")
                if pos is None:
                    continue
                acc = accessors[pos]
                lo, hi = acc.get("min"), acc.get("max")
                if not lo:
                    continue
                for cx in (lo[0], hi[0]):
                    for cy in (lo[1], hi[1]):
                        for cz in (lo[2], hi[2]):
                            p = xform(world, (cx, cy, cz))
                            for i in range(3):
                                bmin[i] = min(bmin[i], p[i])
                                bmax[i] = max(bmax[i], p[i])
        for ch in node.get("children", []):
            visit(ch, world)

    for root in scene.get("nodes", []):
        visit(root, ident())
    return bmin, bmax, sorted(set(node_scale))


def main():
    names = sorted(f for f in os.listdir(KIT) if f.endswith(".glb"))
    out = {}
    for n in names:
        tag = os.path.splitext(n)[0]
        gltf = read_glb(os.path.join(KIT, n))
        bmin, bmax, scales = world_bbox(gltf)
        if bmin[0] > 1e8:
            continue
        out[tag] = {
            "world_min": [round(v, 4) for v in bmin],
            "world_max": [round(v, 4) for v in bmax],
            "size": [round(bmax[i] - bmin[i], 4) for i in range(3)],
            "footprint_min": [round(bmin[0], 3), round(bmin[2], 3)],
            "ground_z": round(bmin[1], 4),
            "node_scales": scales,
        }
    with open(os.path.join(OUT, "kit_world.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)

    lines = ["", "== WORLD-SPACE sizes (node transforms applied) ==",
             "  %-30s %-26s %-10s %s" % ("model", "size X x Y x Z (m)", "z(min)", "node scales")]
    for tag in sorted(out):
        v = out[tag]
        lines.append("  %-30s %-26s %-10s %s" % (
            tag, " x ".join("%6.3f" % s for s in v["size"]),
            "%6.3f" % v["ground_z"], v["node_scales"] or "-"))
    txt = "\n".join(lines)
    with open(os.path.join(OUT, "kit_world.txt"), "w", encoding="utf-8") as fh:
        fh.write(txt)
    print(txt)
    print("\n[probe] wrote data/kit_world.json")


if __name__ == "__main__":
    main()
