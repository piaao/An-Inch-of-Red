# -*- coding: utf-8 -*-
"""
build_dist.py — 把仓库拼成一份**只含游戏本身**的发布目录。

WHY A WHITELIST AND NOT A BLACKLIST
-----------------------------------
仓库根 ≈ 34 MB，而真正要发到公网的只有 ≈ 6 MB。直接部署根目录会把这些一起
送上互联网：

    work/           探针日志与一次性脚本（本机产物）
    renders/        逐像素取证图
    .workbuddy/     本机工作区记忆 —— 写给下一个会话看的内网笔记
    配置.yaml        百炼 API Key

黑名单是"我想到的那些"，白名单是"我确认为运行所需的那一些"。这个游戏是纯静态、
零后端、three.js 走本地 `vendor/`，所以它的运行所需是**可以穷举的**：
`play.html` + `css/` + `js/` + `vendor/` + `game/` + `assets/models/` +
`assets/actors/` + `data/`。

TWO THINGS IT REFUSES, LOUDLY
-----------------------------
1. 白名单里任何一项不存在 → 直接退出。一个少了一层的 dist 会部署出一个
   白屏的站，而白屏是最难从链接上看出问题的那种失败。
2. 里层出现任何**禁运路径**（上面那四个）→ 直接退出。第二条是给"以后有人
   往 `game/` 或 `assets/` 里放了一个 `配置.yaml`"准备的：白名单挡不住
   白名单**内部**多了什么，只有再查一遍才挡得住。

AND ONE THING IT INSISTS ON
---------------------------
`dist/` 里只允许有**一个** `.html`。发布工具在多页目录里分不清该发哪一页，
这是它在文档里写明的一条；`play.html` 一个页面正好绕开它。

AND IT SYNCS, IT DOES NOT REBUILD
--------------------------------
`dist/` 是**增量同步**的（写变化的那几个、删多出来的那几个），不是 rmtree 重建：

  · 228 个删除目标会撞上本机的批量删除保护（safe-delete），脚本半路死掉之后
    dist 留在"半新半旧"的状态 —— 而"重建"这件事看起来本该是原子的；
  · 每次真要删的通常只有 0–3 个文件。

配合 `scripts/verify_dist.mjs` 的「dist 与当前源码逐字节一致」那一条：
**改了源码忘了同步，验收会先炸**，而不是让一份过期的包悄悄上线。

Usage:
    python scripts/build_dist.py              # 同步 dist/
    python scripts/build_dist.py --out dist2  # 换个目录
"""

import argparse
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 站点能跑的**全部**所需。加一个就要能说出它是被谁请求的。
KEEP = [
    "play.html",
    "css",
    "js",
    "vendor",
    "game",
    "assets/models",
    "assets/actors",
    "data",
    "assets/manifest.json",       # 模型清单（js/kit.js 按它点名加载）
    "assets/LICENSE-kenney.txt",  # 授权原文：发出去就得一起带上
]

# 一个都不许进 dist/。**只检查里层**：`dist/` 本身就叫 dist，不是禁运路径。
BANNED = [
    "配置.yaml",
    ".workbuddy",
    "work",
    "renders",
    "scripts",
    "tools",
    "reports",
    ".git",
]

# 白名单目录里按扩展名再筛一次 —— 白名单管"哪些目录"，这里管"目录里的哪一类"。
#
# `.md` 是**设计书**（`game/DEPLOY.md` / `VERDICT.md` / `ACTORS.md` / `PROPS.md` …），
# 里面写着内部路径、验收脚本名、胜率矩阵。它们**不是运行所需**：运行时代码对
# `.md` 的引用全部在注释里，没有一处 `fetch()`。白名单按目录收 `game/`，就会
# 顺便把这 7 份文档发到公网 —— 所以这一条是必需的，不是洁癖。
SKIP_EXT = (".md",)

# 按扩展名分类，只为了把"钱花在哪儿"印出来。
BIG_EXT = (".js", ".glb", ".json", ".css", ".html")


def human(n):
    for unit, div in (("MB", 1024 * 1024), ("KB", 1024)):
        if n >= div:
            return "%.2f %s" % (n / div, unit)
    return "%d B" % n


def walk_files(base):
    out = []
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if d not in (".git", "__pycache__")]
        for f in fn:
            p = os.path.join(dp, f)
            out.append((os.path.relpath(p, base).replace("\\", "/"), os.path.getsize(p)))
    return out


def collect(src_root, rel):
    """把白名单某一项展开成 (相对路径 -> 源绝对路径)，顺带说出被扩展名筛掉的。"""
    src = os.path.join(src_root, rel.replace("/", os.sep))
    keep, skipped = {}, []
    if os.path.isdir(src):
        for dp, dn, fn in os.walk(src):
            dn[:] = [d for d in dn if d not in (".git", "__pycache__")]
            for f in fn:
                p = os.path.join(dp, f)
                r = os.path.relpath(p, src_root).replace("\\", "/")
                if os.path.splitext(f)[1].lower() in SKIP_EXT:
                    skipped.append(r)
                else:
                    keep[r] = p
    else:
        keep[rel] = src
    return keep, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="dist", help="输出目录（相对仓库根或绝对路径）")
    args = ap.parse_args()
    out = args.out if os.path.isabs(args.out) else os.path.join(ROOT, args.out)

    # ---- 1. 白名单里的东西必须都在，而且非空 ----
    missing, empty = [], []
    for rel in KEEP:
        src = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.exists(src):
            missing.append(rel)
        elif os.path.isdir(src) and not walk_files(src):
            empty.append(rel)
    if missing or empty:
        print("!! 白名单里有东西不在（一个少了一层的 dist 会部署出白屏）：")
        for m in missing:
            print("     缺失: " + m)
        for e in empty:
            print("     空目录: " + e)
        return 1

    # ---- 2. 增量同步，**不整目录删** ----
    #
    # 原来是 `shutil.rmtree(out)` 重建。这有两个毛病，都是实测出来的：
    #   ① 228 个删除目标会撞上本机的批量删除保护（safe-delete），脚本半路死掉、
    #      留下一个半新半旧的 dist —— 而"重建"这件事看起来应该永远是原子的；
    #   ② 全量重拷 6 MB 不值得。
    # 增量同步每次要删的通常只有 0–3 个文件（比如这次筛掉 7 份 .md）。
    wanted = {}
    skipped_md = []
    for rel in KEEP:
        k, s = collect(ROOT, rel)
        wanted.update(k)
        skipped_md.extend(s)

    os.makedirs(out, exist_ok=True)
    written = 0
    for rel, src in sorted(wanted.items()):
        dst = os.path.join(out, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(src) \
                or open(dst, "rb").read() != open(src, "rb").read():
            shutil.copy2(src, dst)
            written += 1

    removed = []
    for dp, dn, fn in os.walk(out):
        for f in fn:
            p = os.path.join(dp, f)
            rel = os.path.relpath(p, out).replace("\\", "/")
            if rel not in wanted:
                os.remove(p)
                removed.append(rel)
    for dp, dn, fn in os.walk(out, topdown=False):
        if dp != out and not os.listdir(dp):
            os.rmdir(dp)

    # ---- 3. 里层禁运复查 ----
    leaked = []
    for dp, dn, fn in os.walk(out):
        for name in list(dn) + fn:
            if name in BANNED or name.lower().endswith((".pem", ".key")):
                leaked.append(os.path.relpath(os.path.join(dp, name), out).replace("\\", "/"))
    if leaked:
        print("!! dist 里出现了禁运路径，已中止（这是最严重的一类事故）：")
        for l in leaked:
            print("     " + l)
        shutil.rmtree(out)
        return 1

    # ---- 4. 只许有一个页面 ----
    pages = [f for f, _ in walk_files(out) if f.endswith((".html", ".htm"))]
    if len(pages) != 1:
        print("!! dist 里有 %d 个 .html（发布工具在多页目录里分不清该发哪一页）：" % len(pages))
        for p in pages:
            print("     " + p)
        return 1

    # ---- 5. 报账 ----
    files = walk_files(out)
    total = sum(s for _, s in files)
    root_bytes = sum(s for _, s in walk_files(ROOT))
    by_ext = {}
    for f, s in files:
        by_ext[os.path.splitext(f)[1].lower()] = by_ext.get(os.path.splitext(f)[1].lower(), 0) + s

    print("dist/ 已同步：%s" % out)
    print("  文件 %d 个 · %s（仓库根是 %s，省掉 %.0f%%）"
          % (len(files), human(total), human(root_bytes),
             100.0 * (1 - total / max(1, root_bytes))))
    print("  本次写入 %d 个，清掉 %d 个" % (written, len(removed)))
    if removed:
        print("  清掉的：%s" % ", ".join(sorted(removed)[:8]))
    if skipped_md:
        print("  按扩展名未发布 %d 个（%s）：%s"
              % (len(skipped_md), "/".join(SKIP_EXT), ", ".join(sorted(skipped_md))))
    print("  入口（唯一页面）: %s" % pages[0])
    print("  按类型：")
    for e, n in sorted(by_ext.items(), key=lambda kv: -kv[1])[:6]:
        print("    %-7s %9s  %4.1f%%" % (e or "(无扩展名)", human(n), 100.0 * n / total))
    print("  最重的 5 个文件：")
    for f, s in sorted(files, key=lambda kv: -kv[1])[:5]:
        print("    %-46s %9s" % (f, human(s)))
    print("  禁运复查：%d 项，一个都没有" % len(BANNED))
    return 0


if __name__ == "__main__":
    sys.exit(main())
