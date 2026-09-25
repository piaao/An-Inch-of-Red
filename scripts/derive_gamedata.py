# -*- coding: utf-8 -*-
"""
derive_gamedata.py -- turn the shipped apartment into the numbers a game design
needs. Nothing here is authored by hand: the ownership matrix comes out of
js/layout.js (which rooms actually place which model) and the colour census
comes out of the GLB files themselves.

Outputs  work/gamedata.json  and prints a human-readable report.
"""
import io, os, re, json, struct, sys, math

sys.stdout.reconfigure(encoding='utf-8', errors='replace')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ------------------------------------------------------------------ ownership
txt = io.open(os.path.join(ROOT, 'js', 'layout.js'), encoding='utf-8').read()
seg = txt.split('export const ROOMS = [', 1)[1].split('/** Every unique kit model', 1)[0]
blocks = re.split(r"\n  \{\n    id: '", seg)[1:]

rooms = []
for b in blocks:
    rid = b.split("'", 1)[0]
    items = re.findall(r"\{ m: '([A-Za-z0-9_]+)'", b)
    rooms.append((rid, items))

home = {}            # model -> set(rooms)
placed = {}          # model -> number of instances
for rid, items in rooms:
    for m in items:
        home.setdefault(m, set()).add(rid)
        placed[m] = placed.get(m, 0) + 1

all_models = sorted(home)
shared = sorted([m for m in all_models if len(home[m]) > 1], key=lambda m: (-len(home[m]), m))
exclusive = sorted([m for m in all_models if len(home[m]) == 1])

# -------------------------------------------------------------------- palette
PALETTE = {
    'wood':        (0.896, 0.602, 0.393),
    'woodDark':    (0.678, 0.456, 0.299),
    'woodMid':     (0.647, 0.459, 0.298),
    'metal':       (0.741, 0.823, 0.840),
    'metalLight':  (0.937, 0.980, 0.957),
    'metalMed':    (0.369, 0.467, 0.467),
    'metalDark':   (0.306, 0.388, 0.388),
    'carpet':      (0.943, 0.367, 0.343),   # <- the kit's one warm red
    'carpetDark':  (0.608, 0.298, 0.285),
    'carpetBlue':  (0.356, 0.517, 0.868),
    'green':       (0.182, 0.821, 0.576),
    'white':       (1.000, 1.000, 1.000),
    'white2':      (0.973, 1.000, 1.000),
    'lamp':        (1.000, 0.914, 0.588),
    'glass':       (0.698, 0.827, 0.769),
}


def near(rgb):
    best, bd = '?', 9e9
    for name, p in PALETTE.items():
        d = sum((a - b) ** 2 for a, b in zip(rgb, p))
        if d < bd:
            bd, best = d, name
    return best if bd < 1e-4 else ('?' + best)


def glb_materials(path):
    b = open(path, 'rb').read()
    off, js = 12, None
    while off < len(b):
        ln, ty = struct.unpack_from('<II', b, off)
        if ty == 0x4E4F534A:
            js = json.loads(b[off + 8:off + 8 + ln].decode('utf-8'))
            break
        off += 8 + ln
    out = []
    for m in js.get('materials', []):
        c = m.get('pbrMetallicRoughness', {}).get('baseColorFactor')
        if c:
            out.append((m.get('name', '?'), tuple(round(v, 3) for v in c[:3])))
    return out


models_dir = os.path.join(ROOT, 'assets', 'models')
colour_of = {}
for f in sorted(os.listdir(models_dir)):
    if not f.endswith('.glb'):
        continue
    name = f[:-4]
    try:
        colour_of[name] = glb_materials(os.path.join(models_dir, f))
    except Exception as e:
        colour_of[name] = []

red_models, glow_models, glass_models = [], [], []
for name, mats in sorted(colour_of.items()):
    slots = [near(c) for _, c in mats]
    if any(s in ('carpet', 'carpetDark') for s in slots):
        red_models.append(name)
    if 'lamp' in slots:
        glow_models.append(name)
    if 'glass' in slots:
        glass_models.append(name)

# ------------------------------------------------------------------- delta E
def s2l(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lab(hexstr):
    h = hexstr.lstrip('#')
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    r, g, b = s2l(r), s2l(g), s2l(b)
    X = r * 0.4124 + g * 0.3576 + b * 0.1805
    Y = r * 0.2126 + g * 0.7152 + b * 0.0722
    Z = r * 0.0193 + g * 0.1192 + b * 0.9505
    Xn, Yn, Zn = 0.95047, 1.0, 1.08883
    def f(t):
        return t ** (1 / 3) if t > 0.008856 else (7.787 * t + 16 / 116)
    fx, fy, fz = f(X / Xn), f(Y / Yn), f(Z / Zn)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def de76(a, b):
    la, lb = lab(a), lab(b)
    return math.sqrt(sum((x - y) ** 2 for x, y in zip(la, lb)))


KIT_RED = '#F05E57'
CAND_MAIN = '#C8102E'
CAND_DARK = '#8E0F22'
CAND_BRIGHT = '#E4002B'
CAND_HEAT = '#D7261E'
# a couple of palette reds as further context
CTX = {'carpet': '#F05E57', 'carpetDark': '#9B4C49', 'lamp': '#FFE996',
       'green': '#2ED193', 'wood': '#E59A64'}

# ---------------------------------------------------------------------- report
out = {
    'plan': {'w': 10, 'd': 8, 'floorTiles': 80, 'wallH': 1.29},
    'rooms': [],
    'shared': [{'model': m, 'rooms': sorted(home[m]), 'instances': placed[m]} for m in shared],
    'exclusive': exclusive,
    'colourOf': {k: [[n, list(c)] for n, c in v] for k, v in colour_of.items()},
    'redModels': red_models,
    'deltaE': {},
}
for rid, items in rooms:
    uniq = sorted(set(items))
    ex = [m for m in uniq if len(home[m]) == 1]
    sh = [m for m in uniq if len(home[m]) > 1]
    out['rooms'].append({'id': rid, 'instances': len(items), 'unique': len(uniq),
                         'exclusive': ex, 'shared': sh})

print('=' * 74)
print('道具归属矩阵  (来源: js/layout.js — 一处手写都没有)')
print('=' * 74)
en = {'bedroom': '卧室', 'bath': '卫生间', 'kitchen': '厨房',
      'living': '客厅', 'dining': '餐厅', 'study': '书房'}
print('%-8s %8s %8s %8s %8s' % ('房间', '实例数', '去重后', '专属件', '通用件'))
for r in out['rooms']:
    print('%-8s %8d %8d %8d %8d' % (en[r['id']], r['instances'], r['unique'],
                                    len(r['exclusive']), len(r['shared'])))
print('合计去重模型 %d 件;  专属 %d 件;  通用(出现在>=2房) %d 件'
      % (len(all_models), len(exclusive), len(shared)))

print()
print('--- 通用道具（选它躲藏 = 零归属风险，但也最容易被误检）---')
for m in shared[:20]:
    print('  %-26s x%-3d  %s' % (m, placed[m], '+'.join(en[q] for q in sorted(home[m]))))

print()
print('--- 完全专属的道具（按房间）---')
for r in out['rooms']:
    print('  %-6s (%2d): %s' % (en[r['id']], len(r['exclusive']), ', '.join(r['exclusive'])))

print()
print('--- 套件全部模型的颜色构成 (前 12 个, 用于确认调色板只有 15 色) ---')
for name in sorted(colour_of)[:12]:
    print('  %-26s %s' % (name, [near(c) for _, c in colour_of[name]]))

print()
print('=' * 74)
print('红色干扰物普查  (红包设计的关键：套件里已经有一堆红)')
print('=' * 74)
print('含 carpet/carpetDark 槽位的模型共 %d 个:' % len(red_models))
print('  ' + ', '.join(red_models))

print()
print('含 lamp 槽位(自发光)的模型 %d 个:' % len(glow_models))
print('  ' + ', '.join(glow_models))
print('含 glass 槽位(半透明)的模型 %d 个:' % len(glass_models))
print('  ' + ', '.join(glass_models))

print()
print('--- 红包候选红 vs 套件那抹红 #F05E57 的 CIE76 色差 ---')
cands = {'#C8102E': '深正红 (中国红)', '#8E0F22': '暗红 (红包阴影面)',
         '#E4002B': '亮正红', '#D7261E': '朱红'}
for hx, label in cands.items():
    out['deltaE'][hx] = label
    print('  %-9s %-22s dE=%5.1f   (对 carpetDark #9B4C49: dE=%4.1f)'
          % (hx, label, de76(hx, KIT_RED), de76(hx, '#9B4C49')))
print()
print('  参考色差: 换色阈值 ~2.3 / 侧眼可辨 ~5 / 一眼可分 ~10 / 远距扫视可辨 ~20')
print('  沙发红 #F05E57 与 亮正红 #E4002B  dE=%.1f' % de76('#F05E57', '#E4002B'))

wd = os.path.join(ROOT, 'work')
if not os.path.isdir(wd):
    os.makedirs(wd)
with io.open(os.path.join(wd, 'gamedata.json'), 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print()
print('wrote work/gamedata.json')
