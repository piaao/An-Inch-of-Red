# -*- coding: utf-8 -*-
"""Extract, per kit model, the bbox of its RED slots and of its GLASS slots.

Why this exists: the whole point of 方案二「寻红」is the near-colour gamble --
a 红包 at #C8102E sitting among furniture whose red is #F05E57. To measure how
often a player would walk over to a red thing and find it is not a 红包, the
visibility model has to know WHERE the red on a sofa actually is. A sofa's
bounding box is mostly beige; only the cushion is red. Using the model AABB
would overstate how easy the target is and understate the false-positive rate.

Frame: the SAME normalised frame `js/kit.js` produces at load time --
footprint centre at XZ origin, lowest point at y = 0, so a model placed at
(x, z) with rotation r spans [-size/2, +size/2] around it. That makes the
numbers here directly comparable with `data/kit_three.json`.

Writes data/model_surfaces.json.
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

# Which authored slots mean "red"?
#
# The first attempt used `r - max(g,b) > 0.15`, which flagged 97 of 140 models
# and called the whole kit red. It is wrong: the kit's wood is (0.896, 0.602,
# 0.393), which clears that bar easily, and wood is a warm ORANGE, not a red.
# Redness is a HUE question, not a "red channel is biggest" question.
#
# Hue separation in this palette is enormous, so a tight gate is safe:
#   carpet       (0.943, 0.367, 0.343) -> hue  2.3 deg, sat 0.64   RED
#   carpetDarker (0.608, 0.298, 0.285) -> hue  2.4 deg, sat 0.53   RED
#   wood         (0.896, 0.602, 0.393) -> hue 24.9 deg, sat 0.56   orange
#   fur          (0.647, 0.459, 0.298) -> hue 27.7 deg, sat 0.54   orange
#   lamp         (1.000, 0.914, 0.588) -> hue 47.5 deg, sat 0.41   yellow
# A 15 deg ceiling sits in a 22 deg gap, so nothing straddles the boundary.
RED_HUE_MAX = 15.0
RED_SAT_MIN = 0.35


def hue_sat(rgb):
    r, g, b = rgb[0], rgb[1], rgb[2]
    mx, mn = max(r, g, b), min(r, g, b)
    d = mx - mn
    if d < 1e-9:
        return 0.0, 0.0
    if mx == r:
        h = 60.0 * (((g - b) / d) % 6.0)
    elif mx == g:
        h = 60.0 * (((b - r) / d) + 2.0)
    else:
        h = 60.0 * (((r - g) / d) + 4.0)
    return h, (d / mx if mx > 1e-9 else 0.0)


def is_red(rgb):
    h, s = hue_sat(rgb)
    return h <= RED_HUE_MAX and s >= RED_SAT_MIN


def srgb_hex(rgb):
    """The kit writes sRGB numbers into a linear field; kit.js re-encodes on
    the way in, so the colour you actually see is the authored triple read as
    sRGB. Reproduce that here so the report quotes visible colours."""
    def f(v):
        v = max(0.0, min(1.0, v))
        return int(round(v * 255))
    return "#%02X%02X%02X" % (f(rgb[0]), f(rgb[1]), f(rgb[2]))


# ---------------------------------------------------------------- mat4 helpers
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
    length = struct.unpack_from("<I", data, 8)[0]
    off, gltf = 12, None
    while off < length:
        clen, ctype = struct.unpack_from("<I4s", data, off)
        if ctype == b"JSON":
            gltf = json.loads(data[off + 8: off + 8 + clen].decode("utf-8"))
        off += 8 + clen
    return gltf


class Box:
    __slots__ = ("lo", "hi", "empty")

    def __init__(self):
        self.lo = [1e9] * 3
        self.hi = [-1e9] * 3
        self.empty = True

    def add(self, p):
        for i in range(3):
            if p[i] < self.lo[i]:
                self.lo[i] = p[i]
            if p[i] > self.hi[i]:
                self.hi[i] = p[i]
        self.empty = False

    def add_box(self, o):
        if o.empty:
            return
        self.add(o.lo)
        self.add(o.hi)


def scan(gltf):
    """One traversal. Returns (whole, red, glass) boxes in glTF world space."""
    accessors = gltf.get("accessors", [])
    nodes = gltf.get("nodes", [])
    meshes = gltf.get("meshes", [])
    materials = gltf.get("materials", [])
    scene = gltf.get("scenes", [{}])[gltf.get("scene", 0)]

    whole, red, glass = Box(), Box(), Box()
    red_slots, glass_slots = set(), set()
    slot_rgb = {}

    def visit(idx, parent):
        node = nodes[idx]
        if "matrix" in node:
            local = list(node["matrix"])
        else:
            local = from_trs(node.get("translation", [0, 0, 0]),
                             node.get("rotation", [0, 0, 0, 1]),
                             node.get("scale", [1, 1, 1]))
        world = mul(parent, local)
        if "mesh" in node:
            for prim in meshes[node["mesh"]].get("primitives", []):
                pos = prim.get("attributes", {}).get("POSITION")
                if pos is None:
                    continue
                acc = accessors[pos]
                lo, hi = acc.get("min"), acc.get("max")
                if not lo:
                    continue
                # The primitive's own box, in its node's local space.
                pb = Box()
                for cx in (lo[0], hi[0]):
                    for cy in (lo[1], hi[1]):
                        for cz in (lo[2], hi[2]):
                            pb.add(xform(world, (cx, cy, cz)))
                whole.add_box(pb)

                mi = prim.get("material")
                mat = materials[mi] if mi is not None and mi < len(materials) else {}
                base = mat.get("pbrMetallicRoughness", {}).get("baseColorFactor", [1, 1, 1, 1])
                name = mat.get("name", "")
                alpha = base[3] if len(base) > 3 else 1.0
                if is_red(base):
                    red.add_box(pb)
                    red_slots.add(name)
                    slot_rgb[name] = [round(v, 3) for v in base[:3]]
                if name == "glass" or alpha < 0.999:
                    glass.add_box(pb)
                    glass_slots.add(name or "alpha<1")
        for ch in node.get("children", []):
            visit(ch, world)

    for root in scene.get("nodes", []):
        visit(root, ident())
    return whole, red, glass, sorted(red_slots), sorted(glass_slots), slot_rgb


def main():
    names = sorted(f for f in os.listdir(KIT) if f.endswith(".glb"))
    out = {}
    red_models, glass_models = [], []
    all_red_slots = {}
    for n in names:
        tag = os.path.splitext(n)[0]
        gltf = read_glb(os.path.join(KIT, n))
        whole, red, glass, rslots, gslots, slot_rgb = scan(gltf)
        for s, rgb in slot_rgb.items():
            all_red_slots[s] = rgb
        if whole.empty:
            continue
        # Normalise exactly like kit.js: subtract footprint centre (XZ) and floor (Y).
        cx = (whole.lo[0] + whole.hi[0]) / 2.0
        cz = (whole.lo[2] + whole.hi[2]) / 2.0
        cy = whole.lo[1]

        def norm(b):
            if b.empty:
                return None
            lo = [b.lo[0] - cx, b.lo[1] - cy, b.lo[2] - cz]
            hi = [b.hi[0] - cx, b.hi[1] - cy, b.hi[2] - cz]
            return {
                "min": [round(v, 4) for v in lo],
                "max": [round(v, 4) for v in hi],
                "size": [round(hi[i] - lo[i], 4) for i in range(3)],
                "centre": [round((lo[i] + hi[i]) / 2.0, 4) for i in range(3)],
            }

        rec = {"red": norm(red), "glass": norm(glass),
               "size": [round(whole.hi[i] - whole.lo[i], 4) for i in range(3)]}
        if rec["red"]:
            rec["red"]["slots"] = rslots
            red_models.append(tag)
        if rec["glass"]:
            rec["glass"]["slots"] = gslots
            glass_models.append(tag)
        out[tag] = rec

    if not os.path.isdir(OUT):
        os.makedirs(OUT)
    with open(os.path.join(OUT, "model_surfaces.json"), "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1, sort_keys=True)

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print("models parsed          : %d" % len(out))
    print("with a red slot        : %d" % len(red_models))
    print("with a glass/alpha slot: %d" % len(glass_models))
    print()
    # The tight hue gate should admit exactly the kit's two carpet reds. If a
    # third slot ever shows up here, the threshold has drifted and every
    # colour number downstream is suspect -- so state it loudly.
    print("red slots in use (authored triple -> the colour a viewer sees):")
    for s in sorted(all_red_slots):
        rgb = all_red_slots[s]
        h, sat = hue_sat(rgb)
        print("   %-16s %-22s -> %s   hue %5.1f deg  sat %.2f"
              % (s, "(" + ", ".join("%.3f" % v for v in rgb) + ")", srgb_hex(rgb), h, sat))
    if len(all_red_slots) != 2:
        print("   !! EXPECTED exactly 2 red slots (carpet, carpetDarker); got %d"
              % len(all_red_slots))
    print()
    print("largest red patches (a patch you could actually spot across a room):")
    rows = sorted((out[t]["red"]["size"][0] * out[t]["red"]["size"][2], t) for t in red_models)
    for area, t in rows[-10:]:
        r = out[t]["red"]
        print("   %-26s footprint %.3f x %.3f  y %.3f..%.3f  slots=%s"
              % (t, r["size"][0], r["size"][2], r["min"][1], r["max"][1], ",".join(r["slots"])))
    print()
    print("[derive_redbox] wrote data/model_surfaces.json")


if __name__ == "__main__":
    main()
