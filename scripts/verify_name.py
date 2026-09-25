# -*- coding: utf-8 -*-
"""
verify_name.py — 《一寸红》 naming census.

The patch script says what it *intended* to write. This one says what is on
disk now, read back independently, and it is the file that decides.

Run it after any rename: it checks the five wiring points listed in
game/NAME.md §5, plus the one thing a rename must not do --
lose the codename 寻红 from the places where it is a measurement record.

    python scripts/verify_name.py
"""
import json
import os

# 相对定位：本脚本住在 scripts/，向上两级就是仓库根。
# 不写死本机绝对路径 —— 这个仓库要能被别人 clone 下来直接跑。
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPORT = os.path.join(ROOT, "work", "verify_name.txt")

ZH = "一寸红"
EN = "An Inch of Red"
CODE = "寻红"

results = []


def check(name, ok, detail=""):
    results.append((bool(ok), name, detail))


def read(rel):
    p = os.path.join(ROOT, rel)
    with open(p, "rb") as fh:
        raw = fh.read()
    crlf = raw.count(b"\r\n")
    lf = raw.count(b"\n") - crlf
    return raw.decode("utf-8"), len(raw), crlf, lf, os.path.exists(p)


# ------------------------------------------------------- A/B/C  the screen
html, nb, crlf, lf, _ = read("play.html")
title = html.split("<title>")[1].split("</title>")[0]
h1 = html.split("<h1>")[1].split("</h1>")[0]
check("A title  = 一寸红 · An Inch of Red · 剖面公寓",
      title == "一寸红 · An Inch of Red · 剖面公寓", repr(title))
check("B h1     = 一 寸 红", h1 == "一 寸 红", repr(h1))
check("C .sub.en 恰好一处", html.count('class="sub en"') == 1,
      f"{html.count('class=\"sub en\"')} 处")
# The English name belongs in TWO places on purpose -- <title> and the start
# card -- so "appears exactly once" would be a question that cannot be
# answered yes. Ask where it is instead: once in each, and the card's text is
# the name itself, not the name plus something.
en_sub = html.split('class="sub en">')[1].split("</p>")[0]
check("C sub.en 文本就是英文名", en_sub == EN, repr(en_sub))
check("C 英文名恰好 2 处（<title> + 开始页）", html.count(EN) == 2, f"{html.count(EN)} 处")
check("C <title> 里含英文名", EN in title, "")
check("D 显示面不含代号 寻红", CODE not in h1 and CODE not in title, "h1/title 干净")
check("E html EOL 单一", crlf == 0 or lf == 0, f"crlf={crlf} lf={lf}")

# -------------------------------------------------------------- the style
css, ncss, crlf, lf, _ = read("css/play.css")
block = css.split(".panel .sub.en {")[1].split("}")[0] if ".panel .sub.en {" in css else ""
check("F .panel .sub.en 规则恰好一条", css.count(".panel .sub.en {") == 1,
      f"{css.count('.panel .sub.en {')} 条")
check("F 该规则大写英文名", "text-transform: uppercase" in block,
      "uppercase" if "text-transform: uppercase" in block else "缺")
ls = [l.strip() for l in block.splitlines() if "letter-spacing" in l]
check("F 该规则字距存在", bool(ls), ls[0] if ls else "缺")
check("F 大括号配平", css.count("{") == css.count("}"), f"{css.count('{')}/{css.count('}')}")
check("F css EOL 单一", crlf == 0 or lf == 0, f"crlf={crlf} lf={lf}")

# ----------------------------------------------------------------- the doc
rd, nrd, crlf, lf, _ = read("SCENE.md")
check("G SCENE 新章节标题", "## 可玩版本 ·《一寸红》/ An Inch of Red" in rd, "")
check("G SCENE 旧章节标题 = 0", rd.count("## 可玩版本 · 寻红") == 0, "")
check("G SCENE 指向 NAME.md", rd.count("NAME.md") >= 1, f"{rd.count('NAME.md')} 处")
check("G SCENE 目录树含 play.html 新名", "可玩版本《一寸红》入口" in rd, "")
# The front door is part of the wiring too: a repository whose README does not
# carry the name cannot be found by the name. Ask for both halves and the link.
fd, _, _, _, _ = read("README.md")
check("G README 门面含中英文名并指向 SCENE.md",
      ZH in fd and EN in fd and "SCENE.md" in fd,
      f"{ZH} x{fd.count(ZH)} · {EN} x{fd.count(EN)} · SCENE.md x{fd.count('SCENE.md')}")

# ---------------------------------------------------------------- the pkg
pj = json.loads(read("game/package.json")[0])
check("H package.json name", pj["name"] == "an-inch-of-red", repr(pj["name"]))
check("H package.json 仍有代号", CODE in pj["description"], "")
check("H package.json 零依赖", "dependencies" not in pj, "无 dependencies 键")

# ----------------------------------------------------- the naming source
nm, _, _, _, _ = read("game/NAME.md")
check("I NAME.md 声明中文名", "**《一寸红》**" in nm, "")
check("I NAME.md 声明英文名", "**An Inch of Red**" in nm, "")
check("I NAME.md 含改名清单", "改名清单" in nm, "")

# ------------------------------------------- the census: codename survives
# A ruler must not measure itself. These reports quote the codename by
# definition, so counting them would make the number grow by one every run.
# `work/` holds regenerated logs/reports (this one included), and `.workbuddy/`
# is agent scaffolding -- neither is shipped content, so both are skipped.
census = []
for dp, dn, fn in os.walk(ROOT):
    parts = dp.replace("\\", "/").split("/")
    if ".git" in parts or "work" in parts or ".workbuddy" in parts:
        dn[:] = []
        continue
    for f in fn:
        p = os.path.join(dp, f)
        try:
            if os.path.getsize(p) > 4 * 1024 * 1024:
                continue
            with open(p, "rb") as fh:
                if CODE.encode("utf-8") in fh.read():
                    census.append(os.path.relpath(p, ROOT).replace("\\", "/"))
        except OSError:
            pass

# 数量阈值是拟合，点名才是断言：代号必须留在这些「它是测量记录」的地方。
MUST_KEEP = [
    "game/play/play.js",      # 渲染层
    "scripts/verify_play.mjs",  # 70 条验收
    "scripts/verify_game.mjs",  # 玩法矩阵
    "game/NAME.md",           # 命名决定书
    "game/VERDICT.md",        # 验证结论
    "GAME_DESIGN.md",         # 设计文档
]
missing = [m for m in MUST_KEEP if m not in census]
check("J 代号 寻红 留在该留的地方", not missing,
      f"{len(MUST_KEEP) - len(missing)}/{len(MUST_KEEP)} 处命中，全库 {len(census)} 个文件"
      + ("" if not missing else " 缺: " + ", ".join(missing)))

lines = []
bad = 0
for ok, name, detail in results:
    if not ok:
        bad += 1
    lines.append(f"[{'PASS' if ok else 'FAIL'}] {name:<40} {detail}")
lines.append("")
lines.append(f"代号 寻红 普查：{len(census)} 个文件")
for c in sorted(census)[:24]:
    lines.append("    " + c)
if len(census) > 24:
    lines.append(f"    … 另有 {len(census) - 24} 个")
lines.append("")
lines.append(f"VERDICT {'PASS' if bad == 0 else 'FAIL'}  {len(results) - bad}/{len(results)}")

with open(REPORT, "w", encoding="utf-8") as fh:
    fh.write("\n".join(lines))
print("written")
