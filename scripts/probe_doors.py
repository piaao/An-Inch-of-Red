# -*- coding: utf-8 -*-
"""
probe_doors.py — is `doorway` a closed door, or just a frame?

`doorwayOpen` measures 0.486 x 1.010 x 0.089 and 0.089 is exactly the depth of a
bare wall opening (`wallDoorway`), so it is a frame with nothing in it. The other
two are 0.113 deep. A 0.024 m difference is *consistent* with a 2.4 cm door leaf
seated inside the frame -- but "consistent with" is not evidence. A leaf that
size would show up as a large flat panel whose normal is perpendicular to the
opening, so census the faces by normal and measure the area. That is decidable.
"""
import json, struct, os, sys, math

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2), 5125: ('I', 4), 5126: ('f', 4)}
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def load(p):
    b = open(p, 'rb').read()
    off, js, bin_ = 12, None, None
    while off < len(b):
        ln, ty = struct.unpack_from('<II', b, off)
        ch = b[off + 8:off + 8 + ln]
        if ty == 0x4E4F534A:
            js = json.loads(ch.decode('utf-8'))
        elif ty == 0x004E4942:
            bin_ = ch
        off += 8 + ln
    return js, bin_


def acc(g, bin_, i):
    a = g['accessors'][i]
    bv = g['bufferViews'][a['bufferView']]
    fmt, sz = CT[a['componentType']]
    n = NC[a['type']]
    off = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride') or sz * n
    return [struct.unpack_from('<' + fmt * n, bin_, off + k * stride) for k in range(a['count'])]


def census(name):
    p = os.path.join(ROOT, 'assets', 'models', name + '.glb')
    g, bin_ = load(p)
    total, by_n = 0.0, {}
    big = []
    for mesh in g.get('meshes', []):
        for pr in mesh.get('primitives', []):
            pos = acc(g, bin_, pr['attributes']['POSITION'])
            if 'indices' in pr:
                idx = [v[0] for v in acc(g, bin_, pr['indices'])]
            else:
                idx = list(range(len(pos)))
            for t in range(0, len(idx) - 2, 3):
                a_, b_, c_ = pos[idx[t]], pos[idx[t + 1]], pos[idx[t + 2]]
                u = (b_[0] - a_[0], b_[1] - a_[1], b_[2] - a_[2])
                v = (c_[0] - a_[0], c_[1] - a_[1], c_[2] - a_[2])
                n = (u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
                L = math.sqrt(sum(x * x for x in n))
                area = L / 2.0
                total += area
                if L > 0:
                    n = tuple(x / L for x in n)
                    k = ('+Z' if n[2] > 0.9 else '-Z' if n[2] < -0.9
                         else '+X' if n[0] > 0.9 else '-X' if n[0] < -0.9
                         else '+Y' if n[1] > 0.9 else '-Y' if n[1] < -0.9 else 'oblique')
                    by_n[k] = by_n.get(k, 0.0) + area
                    if k in ('+Z', '-Z') and area > 0.02:
                        big.append((area, k, a_, b_, c_))
            break    # first primitive only is enough for this question
    return total, by_n, big


print('=' * 72)
print('门模型面片普查：有门扇就会有一块垂直于门洞的大平板')
print('=' * 72)
for name in ['doorway', 'doorwayOpen', 'doorwayFront', 'wallDoorway', 'wall']:
    total, by_n, big = census(name)
    print()
    print('%s   total surface area = %.4f m2' % (name, total))
    for k in ['+Z', '-Z', '+X', '-X', '+Y', '-Y', 'oblique']:
        if k in by_n:
            print('    %-8s area = %6.4f  (%4.1f%% of total)' % (k, by_n[k], 100 * by_n[k] / total))
    if big:
        print('    big panels perpendicular to the opening:')
        for area, k, a_, b_, c_ in sorted(big, key=lambda r: -r[0])[:4]:
            print('      %s  area=%.4f  at x=%.3f y=%.3f z=%.3f' % (k, area, a_[0], a_[1], a_[2]+0.0))
    else:
        print('    -> no panel large enough to be a door leaf (largest is under 0.02 m2)')
