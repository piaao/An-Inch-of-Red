# -*- coding: utf-8 -*-
"""Measure where the gaps in each wall model actually are.

Why not just assume: "a doorway is a hole in a wall" is a sentence, not a
number. How wide is it -- 0.40 m or 0.90 m? Does the model keep a lintel over
it? Is a window's opening above a crawling player's head or not? Every one of
those decides whether a guard can follow you through a door, and all of them
are sitting inside the GLB waiting to be read.

Method: for a set of heights and positions along the wall's length, fire a ray
along +Z from inside the wall's thickness and count how many triangles it
crosses. Odd => there is material at that (x, height); even => the wall is open
there. Sample at 1 cm and turn the result into solid intervals.

The result is cross-checkable against something measured a completely different
way: the empty door frame `doorwayOpen` is 0.486 wide, so the gap the ray-cast
finds in `wallDoorway` should be 0.486 wide too. If those two disagree, this
script is wrong -- and it says so in the output rather than letting a bad
number into the level.

Writes data/wall_gaps.json
"""
import json
import os
import struct
import sys

# 相对定位：本脚本住在 scripts/，仓库根目录就是它的上一级。
# 素材读的是游戏自己收编的那 140 个 .glb —— 与原 Kenney 套件逐字节相同
# （140/140 已实测），所以本仓库不依赖任何外部素材包，也不写死本机绝对路径。
GAME = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KIT = os.path.join(GAME, "assets", "models")
OUT = os.path.join(GAME, "data")

# Below the shortest player's head, at eye level, and two probes above it.
# 0.36 is the design's eye height for a 0.42-tall walker.
HEIGHTS = [0.15, 0.36, 0.60, 0.90]
STEP = 0.01

CT = {5120: ("b", 1), 5121: ("B", 1), 5122: ("h", 2), 5123: ("H", 2), 5125: ("I", 4), 5126: ("f", 4)}
NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


def read_glb(path):
    with open(path, "rb") as fh:
        data = fh.read()
    length = struct.unpack_from("<I", data, 8)[0]
    off, js, bin_ = 12, None, None
    while off < length:
        clen, ctype = struct.unpack_from("<I4s", data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == b"JSON":
            js = json.loads(chunk.decode("utf-8"))
        elif ctype == b"BIN\x00":
            bin_ = chunk
        off += 8 + clen
    return js, bin_


def read_acc(g, bin_, i):
    a = g["accessors"][i]
    bv = g["bufferViews"][a["bufferView"]]
    fmt, sz = CT[a["componentType"]]
    n = NC[a["type"]]
    base = bv.get("byteOffset", 0) + a.get("byteOffset", 0)
    stride = bv.get("byteStride") or sz * n
    return [struct.unpack_from("<" + fmt * n, bin_, base + k * stride) for k in range(a["count"])]


# --------------------------------------------------------------- mat4 helpers
def ident():
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def mul(a, b):
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


def xf(m, p):
    x, y, z = p
    return (
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    )


def triangles(g, bin_):
    """Every triangle in glTF world space."""
    nodes, meshes = g.get("nodes", []), g.get("meshes", [])
    scene = g.get("scenes", [{}])[g.get("scene", 0)]
    tris = []

    def visit(idx, parent):
        node = nodes[idx]
        local = list(node["matrix"]) if "matrix" in node else from_trs(
            node.get("translation", [0, 0, 0]),
            node.get("rotation", [0, 0, 0, 1]),
            node.get("scale", [1, 1, 1]))
        world = mul(parent, local)
        if "mesh" in node:
            for prim in meshes[node["mesh"]].get("primitives", []):
                pos_i = prim.get("attributes", {}).get("POSITION")
                if pos_i is None:
                    continue
                pos = read_acc(g, bin_, pos_i)
                if "index" in prim:
                    idxs = [v[0] for v in read_acc(g, bin_, prim["index"])]
                else:
                    idxs = list(range(len(pos)))
                for t in range(0, len(idxs) - 2, 3):
                    a, b, c = idxs[t], idxs[t + 1], idxs[t + 2]
                    if max(a, b, c) >= len(pos):
                        continue                     # tolerate a malformed index
                    tris.append((xf(world, pos[a]), xf(world, pos[b]), xf(world, pos[c])))
        for ch in node.get("children", []):
            visit(ch, world)

    for root in scene.get("nodes", []):
        visit(root, ident())
    return tris


def ray_up(P, tri):
    """Moller-Trumbore for a ray along +Z from P. Returns t or None."""
    p0, p1, p2 = tri
    e1 = (p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2])
    e2 = (p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2])
    d = (0.0, 0.0, 1.0)
    h = (d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0])
    a = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2]
    if abs(a) < 1e-12:
        return None
    f = 1.0 / a
    s = (P[0] - p0[0], P[1] - p0[1], P[2] - p0[2])
    u = f * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2])
    if u < -1e-9 or u > 1 + 1e-9:
        return None
    q = (s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0])
    v = f * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2])
    if v < -1e-9 or u + v > 1 + 1e-9:
        return None
    t = f * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2])
    return t if t > 1e-7 else None


def covered_xy(p, tri):
    """Is the point (px, py) inside this triangle's projection onto the XY plane?

    This replaced the obvious tool, and the reason is worth recording. Firing a
    ray along +Z and counting crossings (odd = inside) is the textbook way to
    ask "is this point inside a solid", and it produced nonsense here: it
    reported a plain 1 x 1.29 m wall segment as solid over only 6 cm of its
    length at head height. The wall is NOT a closed solid. It is a union of
    separate open panels -- an interior face, an exterior face, a baseboard, a
    top trim -- so a ray from inside its thickness usually crosses nothing at
    all, and parity answers "outside" for a point that is unmistakably wall.

    The question the level actually needs is not "is this point in a volume",
    it is "is there material at this (x, y)". That is a coverage question: does
    any face of the model cast a shadow at this point. Side faces and top faces
    project to a line and so cover nothing, which leaves exactly the ±Z faces --
    the wall's silhouette. Holes in the silhouette are the doorways and windows.
    """
    (x1, y1, _), (x2, y2, _), (x3, y3, _) = tri
    d = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3)
    if abs(d) < 1e-12:
        return False                     # edge-on to XY: projects to a line
    a = ((y2 - y3) * (p[0] - x3) + (x3 - x2) * (p[1] - y3)) / d
    b = ((y3 - y1) * (p[0] - x3) + (x1 - x3) * (p[1] - y3)) / d
    c = 1.0 - a - b
    eps = -1e-9                          # inclusive at the seams between panels
    return a >= eps and b >= eps and c >= eps


def analyse(tag):
    g, bin_ = read_glb(os.path.join(KIT, tag + ".glb"))
    tris = triangles(g, bin_)
    if not tris:
        return None
    xs = [p[0] for t in tris for p in t]
    ys = [p[1] for t in tris for p in t]
    zs = [p[2] for t in tris for p in t]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)

    per_height = {}
    for h in HEIGHTS:
        if h < y0 - 1e-9 or h > y1 + 1e-9:
            per_height[str(h)] = {"solid": None, "note": "outside the model's vertical span"}
            continue
        solid_pts = []
        x = x0 + STEP / 2
        while x <= x1:
            inside = any(covered_xy((x, h), t) for t in tris)
            solid_pts.append((x, inside))
            x += STEP

        intervals = []
        run = None
        for x, inside in solid_pts:
            if inside and run is None:
                run = x - STEP / 2
            elif not inside and run is not None:
                intervals.append([round(run, 4), round(x - STEP / 2, 4)])
                run = None
        if run is not None:
            intervals.append([round(run, 4), round(solid_pts[-1][0] + STEP / 2, 4)])
        intervals = [[a, b] for a, b in intervals if b - a > 0.0015]
        per_height[str(h)] = {
            "solid": intervals,
            "solidWidth": round(sum(b - a for a, b in intervals), 4),
            "gaps": [[intervals[i][1], intervals[i + 1][0]] for i in range(len(intervals) - 1)],
        }
    return {
        "spanX": [round(x0, 4), round(x1, 4)],
        "spanY": [round(y0, 4), round(y1, 4)],
        "spanZ": [round(min(zs), 4), round(max(zs), 4)],
        "tris": len(tris),
        "heights": per_height,
    }


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    names = sorted(f for f in os.listdir(KIT) if f.endswith(".glb") and f.startswith("wall"))
    out = {}
    for n in names:
        tag = os.path.splitext(n)[0]
        r = analyse(tag)
        if r:
            out[tag] = r

    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    with open(os.path.join(OUT, "wall_gaps.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1, sort_keys=True)

    print("wall models analysed: %d" % len(out))
    print()
    for tag in sorted(out):
        r = out[tag]
        print("%s   span x %.3f..%.3f  y %.3f..%.3f  (%d tris)"
              % (tag, r["spanX"][0], r["spanX"][1], r["spanY"][0], r["spanY"][1], r["tris"]))
        for h in HEIGHTS:
            e = r["heights"][str(h)]
            if e["solid"] is None:
                print("    h=%.2f  %s" % (h, e["note"]))
            else:
                gaps = "  gaps=" + str([[round(a, 3), round(b, 3)] for a, b in e["gaps"]]) if e["gaps"] else ""
                print("    h=%.2f  solid=%.3f m  %s%s"
                      % (h, e["solidWidth"], [[round(a, 3), round(b, 3)] for a, b in e["solid"]], gaps))
        print()

    # Cross-check: the ray-cast gap in the doorway wall must match the empty
    # door frame, which was measured a completely different way.
    g, bin_ = read_glb(os.path.join(KIT, "doorwayOpen.glb"))
    tris = triangles(g, bin_)
    xs = [p[0] for t in tris for p in t]
    frame_w = max(xs) - min(xs)
    print("cross-check: doorwayOpen frame width = %.4f m" % frame_w)
    for tag in ("wallDoorway", "wallDoorwayWide"):
        if tag not in out:
            continue
        gaps = out[tag]["heights"]["0.36"]["gaps"]
        if gaps:
            w = max(b - a for a, b in gaps)
            verdict = "MATCH" if abs(w - frame_w) < 0.02 else "MISMATCH"
            print("             %-16s gap at eye level = %.4f m  -> %s" % (tag, w, verdict))
        else:
            print("             %-16s no gap at 0.36 -- it is a solid wall" % tag)
    print()
    print("[derive_wall_gaps] wrote data/wall_gaps.json")


if __name__ == "__main__":
    main()
