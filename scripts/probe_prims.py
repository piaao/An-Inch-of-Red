# -*- coding: utf-8 -*-
"""Do multi-material primitives of one GLB share triangles, or are they disjoint?

Reads the BIN chunk, resolves each primitive's POSITION + indices, builds the
triangle set as a frozenset of rounded vertex triples, and reports pairwise
overlap. Coincident duplicates = z-fighting when all materials are drawn;
disjoint = complementary faces (wall body / trim / baseboard).
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

CTYPE = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2),
         5125: ('I', 4), 5126: ('f', 4)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    _m, _v, length = struct.unpack_from('<4sII', data, 0)
    off, gltf, binbuf = 12, None, None
    while off < length:
        clen, ctype = struct.unpack_from('<I4s', data, off)
        chunk = data[off + 8: off + 8 + clen]
        if ctype == b'JSON':
            gltf = json.loads(chunk.decode('utf-8'))
        elif ctype[:3] == b'BIN':
            binbuf = chunk
        off += 8 + clen
    return gltf, binbuf


def accessor(gltf, binbuf, idx):
    acc = gltf['accessors'][idx]
    bv = gltf['bufferViews'][acc['bufferView']]
    fmt, size = CTYPE[acc['componentType']]
    n = NCOMP[acc['type']]
    start = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    stride = bv.get('byteStride') or (size * n)
    out = []
    for i in range(acc['count']):
        out.append(struct.unpack_from('<' + fmt * n, binbuf, start + i * stride))
    return out


def tri_set(gltf, binbuf, prim):
    pos = accessor(gltf, binbuf, prim['attributes']['POSITION'])
    if 'indices' in prim:
        idx = [v[0] for v in accessor(gltf, binbuf, prim['indices'])]
    else:
        idx = list(range(len(pos)))
    tris = set()
    for k in range(0, len(idx) - 2, 3):
        t = tuple(sorted(tuple(round(c, 5) for c in pos[idx[k + j]]) for j in range(3)))
        tris.add(t)
    return tris


def main():
    names = sys.argv[1:] or ['wall', 'wallWindow', 'wallDoorway', 'wallCorner',
                             'floorFull', 'doorway', 'doorwayFront', 'kitchenStove',
                             'loungeSofa', 'desk']
    for name in names:
        gltf, binbuf = read_glb(os.path.join(KIT, name + '.glb'))
        mats = [m.get('name', '?') for m in gltf.get('materials', [])]
        prims = []
        for mes in gltf.get('meshes', []):
            for pr in mes.get('primitives', []):
                prims.append(pr)
        sets = [tri_set(gltf, binbuf, pr) for pr in prims]
        sizes = [len(s) for s in sets]
        print('## %-16s prims=%d  tris=%s  mats=%s' % (name, len(prims), sizes, mats))

        if len(sets) > 1:
            for i in range(len(sets)):
                for j in range(i + 1, len(sets)):
                    inter = len(sets[i] & sets[j])
                    if inter:
                        pct = inter / max(1, min(sizes[i], sizes[j])) * 100
                        verdict = 'IDENTICAL' if inter == sizes[i] == sizes[j] else 'PARTIAL'
                        print('     prim%d(%s) ^ prim%d(%s) = %d tris  (%.0f%% of smaller) -> %s'
                              % (i, mats[prims[i].get('material', -1)] if prims[i].get('material') is not None else '?',
                                 j, mats[prims[j].get('material', -1)] if prims[j].get('material') is not None else '?',
                                 inter, pct, verdict))
            union = set().union(*sets)
            total = sum(sizes)
            print('     union=%d  sum=%d  duplicated=%d' % (len(union), total, total - len(union)))


if __name__ == '__main__':
    main()
