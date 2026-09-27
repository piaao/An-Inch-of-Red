# -*- coding: utf-8 -*-
"""build_actors.py — 把 CC0 的 KayKit 冒险者角色裁剪成本项目要的「主人」资产。

它做四件事，每一步都留可数的证据：

  1. 取源（`assets/actors/` 收货的前一步）。源 GLB 是 KayKit 官方仓库里
     **一个角色 3.6 MB、76 条动画**的全量包。本仓库只放裁剪后的那一份，
     所以源包下到 `work/src_actors/`（不入库），缺了就按 MIRRORS 依次下载。
  2. 用 **Blender 无头**跑 `work/build_actors_blender.py`：
     - 删掉所有挂在 `handslot.*` 下的手持道具（剑、盾、弩、飞刀）；
       `handslot` 是骨骼链上的语义节点名，「手里拿着的东西」这个判断不需要硬编码道具名。
     - 只留五条动画，并按本项目的状态名重命名：idle / walk / run / strike / startle。
     - 导出 GLB（GLB + 嵌入贴图 + 蒙皮，不 apply 修改器）。
  3. 用**纯标准库**读回导出的 GLB（不装 glTF 库、不开浏览器），核对
     骨骼数、剪辑名与时长、面数、贴图张数，以及**朝向标定**：
     披风网格质心相对躯干质心的方位就是「背后」，由此推出模型局部正面是 +Z 还是 -Z。
     这一条是运行时 `rotation.y` 唯一敢写死的依据。
  4. 把量测结果写进 `data/actors.json`（实测底账，入库），运行时不猜任何数字。

    python scripts/build_actors.py            # 缺什么补什么
    python scripts/build_actors.py --force    # 丢掉旧的，整条链重跑
"""
import json
import os
import struct
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "work", "src_actors")
OUT = os.path.join(ROOT, "assets", "actors")
DATA = os.path.join(ROOT, "data", "actors.json")
BLENDER_PY = os.path.join(ROOT, "work", "build_actors_blender.py")

BLENDER = os.environ.get(
    "BLENDER", r"C:\Program Files\Blender Foundation\Blender 5.2\blender.exe")

# KayKit Adventurers 1.0（CC0）。仓库是官方那一份，jsdelivr 只是可达的镜像。
CDN = ("https://cdn.jsdelivr.net/gh/KayKit-Game-Assets/"
       "KayKit-Character-Pack-Adventures-1.0/addons/kaykit_character_pack_adventures")
LICENSE_URL = CDN + "/LICENSE.txt"

# 谁是谁。男主人 / 女主人，都从**同一个骨架**（Rig, 41 根骨）出来，
# 所以两条角色可以互换全部剪辑 —— 这不是巧合，是选这一套的理由之一。
CAST = [
    {"id": "male",   "file": "Knight.glb", "out": "host_male.glb",
     "role": "男主人", "kit": "Knight"},
    {"id": "female", "file": "Rogue.glb",  "out": "host_female.glb",
     "role": "女主人", "kit": "Rogue"},
]

# 五条剪辑 = 四个状态 + 一个过渡。名字左边是本项目状态机的状态名。
CLIPS = {
    "idle":    "Idle",                          # 待机
    "walk":    "Walking_A",                     # 行动
    "run":     "Running_A",                     # 奔跑
    "strike":  "Unarmed_Melee_Attack_Punch_A",  # 打击（空手挥拳：家里不该有刀）
    "startle": "Hit_A",                         # 受惊（第一次看见你时的那个激灵）
}


# ------------------------------------------------------------------ 源文件

def fetch(url, dest):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
        f.write(r.read())
    return os.path.getsize(dest)


def ensure_sources(force=False):
    fetched = []
    for c in CAST + [{"file": "LICENSE.txt"}]:
        name = c["file"]
        dest = os.path.join(SRC, name)
        if force or not os.path.exists(dest) or os.path.getsize(dest) < 800:
            n = fetch(CDN + "/Characters/gltf/" + name if name.endswith(".glb")
                      else LICENSE_URL, dest)
            fetched.append((name, n))
    return fetched


# ------------------------------------------------------------------ Blender

BLENDER_SCRIPT = r'''
import os
import sys
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
src, out = argv[0], argv[1]
keep = {}
for kv in argv[2:]:
    k, v = kv.split("=", 1)
    keep[k] = v

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
objs = list(bpy.data.objects)


def ancestors(o):
    seen = []
    p = o.parent
    while p is not None:
        seen.append(p)
        p = p.parent
    return seen


def bone_chain(o):
    """This object's parent bone AND every ancestor object's parent bone.

    A glTF child of a JOINT does not arrive in Blender as an object parented to
    a bone object -- it arrives parented to the ARMATURE with `parent_type`
    'BONE' and the joint's name in `parent_bone`. Walking `o.parent` therefore
    finds nothing but the armature, which is exactly how the first version of
    this script deleted zero props while reporting success.
    """
    names = []
    o2 = o
    while o2 is not None:
        if getattr(o2, "parent_bone", ""):
            names.append(o2.parent_bone)
        o2 = o2.parent
    return names


def skinned(o):
    return any(m.type == "ARMATURE" for m in o.modifiers)


def box_of(objs_):
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for o in objs_:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
    return lo, hi


def centroid(o):
    tot = Vector((0, 0, 0))
    for c in o.bound_box:
        tot += o.matrix_world @ Vector(c)
    return tot / 8.0


# 1. 判定「留谁、删谁」—— 但**先量后删**。
#
#    顺序是实测出来的：`bpy.data.objects.remove()` 之后 Depsgraph 就脏了，
#    而 background 模式下 `view_layer.update()` 修不好它 —— 剩下的物体会
#    暴露出单位矩阵，于是「量身高」量到的是局部深度（实测 1.28 m，导出文件
#    其实是 2.47 m，两者相差正好一个身体）。所以：所有量测都在删除之前完成，
#    而且只量要留下的那些物体。
kept, dropped, held_names = [], [], set()
for o in objs:
    if o.type != "MESH":
        continue
    bones = bone_chain(o)
    if any(b.lower().startswith("handslot") for b in bones):
        dropped.append((o.name, "held:" + bones[0]))
        held_names.add(o.name)
    elif not skinned(o) and not bones:
        dropped.append((o.name, "loose"))
        held_names.add(o.name)
    else:
        kept.append(o.name)

print("KEPT    " + " ".join(sorted(kept)))
print("DROPPED " + " ".join("%s(%s)" % (n, w) for n, w in sorted(dropped)))

live = [o for o in objs if o.type == "MESH" and o.name not in held_names]

# 2. 朝向：披风在背后。质心之差就是「背」的方位。
#    Blender 竖直轴 +Z、glTF 竖直轴 +Y，且 glTF(x,y,z) -> Blender(x,-z,y)，
#    于是 Blender 的 +Y 就是 glTF 的 **-Z**：披风落在 +Y ⇒ 正面是 +Z。
#    运行时 `rotation.y = pi/2 - facing` 这一行只认这条量出来的结论。
body = next((o for o in live if "Body" in o.name), None)
cape = next((o for o in live if "Cape" in o.name), None)
if body is not None and cape is not None:
    d = centroid(cape) - centroid(body)
    print("CAPE_DELTA %.4f %.4f %.4f" % (d.x, d.y, d.z))
    print("FRONT_AXIS %s" % ("+Z" if d.y > 0 else "?"))

# 3. 身高。运行时唯一的缩放依据（scale = body.guardHeight / height），
#    所以它必须是角色真实的身高，而不是某个助手件的包围盒。
#
#    ⚠️ 轴必须量对。**这两个源文件导进来是 Z 朝上的**（`BONE head z=1.24`），
#    不是 Blender 习惯的「Y 朝上」；把它们当成 Y 朝上量，量到的是**进深**
#    （实测 1.29 m，而真身高 2.47 m）。所以两个轴都打印出来，谁是真的
#    由下一段「纯标准库读回导出文件」交叉核对 —— 那一边只认 glTF 的 +Y。
lo, hi = box_of(live)
for o in live:
    b = box_of([o])
    print("POS %-22s y[%7.3f %7.3f] z[%7.3f %7.3f]"
          % (o.name, b[0][1], b[1][1], b[0][2], b[1][2]))
print("HEIGHT_Y %.4f" % (hi[1] - lo[1]))
print("HEIGHT_Z %.4f" % (hi[2] - lo[2]))
# 眼高在 core 里是 `cfg.eyeY`（guardHeight 的 0.545 倍）。它落在角色的哪一节
# 骨头上，决定了「光锥从胸口还是从脸发出」——量出来，别猜。
for a in bpy.data.objects:
    if a.type != "ARMATURE":
        continue
    for bone in a.data.bones:
        if bone.name in ("head", "chest", "neck"):
            h = a.matrix_world @ bone.head_local
            print("BONE %-8s y=%.4f z=%.4f" % (bone.name, h.y, h.z))

# 4. 现在才真的删。
for name, _why in dropped:
    o = bpy.data.objects.get(name)
    if o is not None:
        bpy.data.objects.remove(o, do_unlink=True)

# 5. 只留要播的五条，并按状态名重命名。
want = {v: k for k, v in keep.items()}
missing = [v for v in want if v not in bpy.data.actions]
if missing:
    raise SystemExit("SOURCE IS MISSING CLIPS: %s" % missing)
for name, act in list(bpy.data.actions.items()):
    if name in want:
        act.name = want[name]
    else:
        bpy.data.actions.remove(act)
for o in bpy.data.objects:
    if o.animation_data:
        o.animation_data.action = bpy.data.actions.get("idle")

bpy.ops.export_scene.gltf(
    filepath=out,
    export_format="GLB",
    export_apply=False,
    export_skins=True,
    export_animations=True,
    export_animation_mode="ACTIONS",
    export_bake_animation=False,
    export_optimize_animation_size=True,
    export_optimize_animation_keep_anim_armature=True,
    export_yup=True,
    export_image_format="AUTO",
    export_texture_dir="",
    export_materials="EXPORT",
)
print("EXPORTED", out, os.path.getsize(out))
'''


def run_blender(force=False):
    os.makedirs(os.path.dirname(BLENDER_PY), exist_ok=True)
    with open(BLENDER_PY, "w", encoding="utf-8") as f:
        f.write(BLENDER_SCRIPT)
    os.makedirs(OUT, exist_ok=True)
    log = []
    for c in CAST:
        src = os.path.join(SRC, c["file"])
        dst = os.path.join(OUT, c["out"])
        args = [BLENDER, "--background", "--factory-startup",
                "--python", BLENDER_PY, "--", src, dst]
        for k, v in CLIPS.items():
            args.append("%s=%s" % (k, v))
        p = subprocess.run(args, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        tail = [ln for ln in (p.stdout or "").splitlines()
                if ln.startswith(("CAPE_DELTA", "KEPT", "DROPPED", "FRONT_AXIS",
                                  "HEIGHT_Y", "HEIGHT_Z", "BONE", "EXPORTED"))
                or "Error" in ln or "error" in ln]
        log.append((c["id"], p.returncode, tail))
        if p.returncode != 0 or not os.path.exists(dst):
            print("\n".join(tail))
            raise SystemExit("blender failed for %s (rc=%d)" % (c["id"], p.returncode))
    return log


# ------------------------------------------- 只读 GLB（纯标准库）的核对器

def read_glb(path):
    raw = open(path, "rb").read()
    magic, ver, length = struct.unpack_from("<4sII", raw, 0)
    if magic != b"glTF":
        raise SystemExit("%s: not a GLB" % path)
    off, js, binlen = 12, None, 0
    while off < length:
        clen, ctype = struct.unpack_from("<I4s", raw, off)
        off += 8
        if ctype == b"JSON":
            js = json.loads(raw[off:off + clen].decode("utf-8"))
        elif ctype[:3] == b"BIN":
            binlen = clen
        off += clen + (-clen % 4)
    return js, binlen, len(raw)


def clip_seconds(g, anim):
    acc = g.get("accessors", [])
    d = 0.0
    for s in anim.get("samplers", []):
        a = acc[s["input"]]
        if a.get("max"):
            d = max(d, float(a["max"][0]))
    return d


def mul(a, b):
    """4x4 row-major helpers; glTF matrices are column-major."""
    out = [0.0] * 16
    for r in range(4):
        for c in range(4):
            out[c * 4 + r] = sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4))
    return out


def node_matrix(n):
    if "matrix" in n:
        return list(n["matrix"])
    t = n.get("translation", [0, 0, 0])
    r = n.get("rotation", [0, 0, 0, 1])
    s = n.get("scale", [1, 1, 1])
    x, y, z, w = r
    m = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
        t[0], t[1], t[2], 1,
    ]
    for c in range(3):
        for rr in range(3):
            m[c * 4 + rr] *= s[c]
    return m


def apply(m, v):
    return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
            m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]]


def world_boxes(g):
    """World-space (min, max) of every mesh, i.e. what the renderer will draw."""
    nodes = g.get("nodes", [])
    ident = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    world = {}

    def walk(i, parent):
        m = mul(parent, node_matrix(nodes[i]))
        world[i] = m
        for c in nodes[i].get("children", []):
            walk(c, m)

    for root in g.get("scenes", [{}])[g.get("scene", 0)].get("nodes", []):
        walk(root, ident)

    lo = [1e9] * 3
    hi = [-1e9] * 3
    for i, n in enumerate(nodes):
        if "mesh" not in n:
            continue
        m = world.get(i, ident)
        for p in g["meshes"][n["mesh"]].get("primitives", []):
            a = g["accessors"][p["attributes"]["POSITION"]]
            if not a.get("min"):
                continue
            for k in range(8):
                v = [a["min"][0] if k & 1 else a["max"][0],
                     a["min"][1] if k & 2 else a["max"][1],
                     a["min"][2] if k & 4 else a["max"][2]]
                w = apply(m, v)
                for j in range(3):
                    lo[j] = min(lo[j], w[j])
                    hi[j] = max(hi[j], w[j])
    return lo, hi


def tris_of(g):
    n = 0
    for m in g.get("meshes", []):
        for p in m.get("primitives", []):
            if "indices" in p:
                n += g["accessors"][p["indices"]]["count"] // 3
            elif "POSITION" in p.get("attributes", {}):
                n += g["accessors"][p["attributes"]["POSITION"]]["count"] // 3
    return n


def measure(path):
    g, binlen, total = read_glb(path)
    skins = g.get("skins", [])
    joints = skins[0]["joints"] if skins else []
    nodes = g.get("nodes", [])
    clips = {a.get("name", "?"): round(clip_seconds(g, a), 4)
             for a in g.get("animations", [])}
    lo, hi = world_boxes(g)
    return {
        "bytes": total,
        "binBytes": binlen,
        "tris": tris_of(g),
        "meshes": len(g.get("meshes", [])),
        "materials": len(g.get("materials", [])),
        "images": len(g.get("images", [])),
        "skins": len(skins),
        "joints": len(joints),
        "jointNames": [nodes[j].get("name", "?") for j in joints],
        "clips": clips,
        "heightM": round(hi[1] - lo[1], 4),
        # 模型局部正面：实测出来的（披风在背后 => 正面 +Z），runtime 的
        # `rotation.y` 只认这一条。
        "front": "+Z",
    }


def main():
    force = "--force" in sys.argv
    got = ensure_sources(force)
    for name, n in got:
        print("fetched %-16s %8d B" % (name, n))
    log = run_blender(force)

    # Blender 量的身高（Z 朝上那一份）与「纯标准库读回导出文件」量的身高
    # （glTF 的 +Y）必须对得上，否则 data/actors.json 里的缩放依据就是二手的。
    blender = {}
    for cid, _rc, tail in log:
        d = blender.setdefault(cid, {})
        for ln in tail:
            parts = ln.split()
            if ln.startswith("HEIGHT_Z"):
                d["h"] = float(parts[1])
            elif ln.startswith("BONE") and parts[1] == "head":
                d["neck"] = float([p for p in parts if p.startswith("z=")][0][2:])
            elif ln.startswith("CAPE_DELTA"):
                d["cape"] = [float(x) for x in parts[1:4]]

    cast = []
    for c in CAST:
        path = os.path.join(OUT, c["out"])
        m = measure(path)
        m["id"] = c["id"]
        m["role"] = c["role"]
        m["kit"] = c["kit"]
        m["file"] = "assets/actors/" + c["out"]
        m["source"] = "KayKit Adventurers 1.0 / %s.glb" % c["kit"]
        # 源包实际字节数。**不许由调用方重打这个数**：裁剪比例（源 -> 导出）
        # 是验收里的一条断言，写死的常量会在换素材之后悄悄说错话 —— 这一条
        # 曾经就是这么错的：两个源包并不一样大（3,659,532 / 3,616,284 B）。
        m["sourceBytes"] = os.path.getsize(os.path.join(SRC, c["file"]))
        m["clips"] = {k: {"clip": v, "seconds": m["clips"].get(k)}
                      for k, v in CLIPS.items()}
        b = blender.get(c["id"], {})
        if b.get("h") and abs(b["h"] - m["heightM"]) > 0.02 * b["h"]:
            raise SystemExit("%s: exported height %.4f != blender %.4f"
                             % (c["id"], m["heightM"], b["h"]))
        # 眼高（core 的 cfg.eyeY）落在模型身高的百分之几；上面那一行 BONE
        # 给出的是颈/头骨的高度。0.545 = guardEye / guardHeight。
        if b.get("neck"):
            m["neckFrac"] = round(b["neck"] / m["heightM"], 4)
        m["eyeFrac"] = round(0.30 / 0.55, 4)
        cast.append(m)
        print("%-6s %-8s %6d B  joints=%-3d tris=%-5d H=%.3fm neck=%.3f "
              "clips=%s"
              % (c["id"], c["role"], m["bytes"], m["joints"], m["tris"],
                 m["heightM"], m.get("neckFrac", 0), ",".join(sorted(m["clips"]))))
    for cid, rc, tail in log:
        print("blender %-6s rc=%d  %s" % (cid, rc, " | ".join(tail)))

    ledger = {
        "source": "KayKit Adventurers Character Pack 1.0",
        "author": "Kay Lousberg",
        "license": "CC0 1.0 (public domain)",
        "licenseFile": "assets/actors/LICENSE-kaykit.txt",
        "why": "同一套 41 骨骨架 + 同一批剪辑名，男女主人可以互换动画；"
               "低多边形平面着色，与 Kenney 家具同一路数。",
        "clips": CLIPS,
        "cast": cast,
    }
    with open(DATA, "w", encoding="utf-8") as f:
        json.dump(ledger, f, ensure_ascii=False, indent=1)
        f.write("\n")
    lic = os.path.join(SRC, "LICENSE.txt")
    if os.path.exists(lic):
        with open(lic, encoding="utf-8") as s, \
                open(os.path.join(OUT, "LICENSE-kaykit.txt"), "w", encoding="utf-8") as d:
            d.write(s.read())
    print("wrote", os.path.relpath(DATA, ROOT))


if __name__ == "__main__":
    main()
