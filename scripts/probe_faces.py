# -*- coding: utf-8 -*-
"""Which FACE of a model does each primitive paint?

For every primitive, group its triangles by face normal and sum the area, so
`wall` resolves to e.g. "+Z face 1.29 m2 -> _defaultMat". This is what tells
you whether the big visible surface is the white one or the dark one.
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
CTYPE = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2),
         5125: ('I', 4), 5126: ('f', 4)}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}

AXES = {(1, 0, 0): '+X', (-1, 0, 0): '-X', (0, 1, 0): '+Y', (0, -1, 0): '-Y',
        (0, 0, 1): '+Z', (0, 0, -1): '-Z'}


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
    return [struct.unpack_from('<' + fmt * n, binbuf, start + i * stride)
            for i in range(acc['count'])]


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def cross(a, b):
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def norm(a):
    m = (a[0] ** 2 + a[1] ** 2 + a[2] ** 2) ** 0.5 or 1.0
    return (a[0] / m, a[1] / m, a[2] / m)


def face_stats(gltf, binbuf, prim):
    pos = accessor(gltf, binbuf, prim['attributes']['POSITION'])
    if 'indices' in prim:
        idx = [v[0] for v in accessor(gltf, binbuf, prim['indices'])]
    else:
        idx = list(range(len(pos)))
    area = defaultdict(float)
    count = defaultdict(int)
    for k in range(0, len(idx) - 2, 3):
        a, b, c = (pos[idx[k + j]] for j in range(3))
        cr = cross(sub(b, a), sub(c, a))
        m = (cr[0] ** 2 + cr[1] ** 2 + cr[2] ** 2) ** 0.5
        if m < 1e-12:
            continue
        n = norm(cr)
        key = tuple(round(x) for x in n)
        area[key] += m / 2.0
        count[key] += 1
    return area, count


def main():
    names = sys.argv[1:] or ['wall', 'wallWindow', 'wallDoorway', 'wallCorner', 'paneling']
    for name in names:
        gltf, binbuf = read_glb(os.path.join(KIT, name + '.glb'))
        mats = [m.get('name', '?') for m in gltf.get('materials', [])]
        print('## %s' % name)
        for mes in gltf.get('meshes', []):
            for pi, pr in enumerate(mes.get('primitives', [])):
                mi = pr.get('material')
                label = mats[mi] if mi is not None else '(none)'
                area, count = face_stats(gltf, binbuf, pr)
                parts = []
                for key, a in sorted(area.items(), key=lambda kv: -kv[1]):
                    ax = AXES.get(key, str(key))
                    parts.append('%s %.3fm2/%dtri' % (ax, a, count[key]))
                print('   prim%d %-14s %s' % (pi, label, '  |  '.join(parts)))


if __name__ == '__main__':
    main()
