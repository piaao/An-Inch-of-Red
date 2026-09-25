# -*- coding: utf-8 -*-
"""check_eol.py — 行尾 / BOM / 非 ASCII 普查。

为什么需要它：有两类故障在编辑器里**看不见** ——
  1. `.bat` 拿到 LF 行尾，双击时 `cmd.exe` 会把最后一行吃掉（甚至一闪而过）；
  2. `.bat` 里有中文，而 cmd 的代码页是 GBK，于是整个文件被误解析；
  3. UTF-8 BOM 让某些解析器把第一行当垃圾（`\ufeff` 直接进标识符）。
这三条都是「打开来看一切正常、跑起来完全不对」，所以要靠数出来的普查，不靠眼睛。

判据（全部可数）：
  * `.bat` / `.ps1`  —— 行尾必须是 **CRLF**（CRLF 数 == LF 总数，且 > 0）
  * `.bat` / `.ps1`  —— 必须**纯 ASCII**
  * 任何受检文本文件 —— 不得带 UTF-8 BOM

    python scripts/check_eol.py                # 普查本仓库
    python scripts/check_eol.py FILE [FILE...] # 只查指定文件（负向对照用）

退出码：0 = 全部通过；1 = 有违规。
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

TEXT_EXT = {".py", ".mjs", ".js", ".html", ".css", ".md", ".json", ".bat", ".pyi", ".yml", ".yaml"}
ASCII_ONLY_EXT = {".bat", ".ps1"}
SKIP_DIRS = {".git", "work", "node_modules", "__pycache__", "renders", "vendor", "assets", "addons"}
MAX_BYTES = 4 * 1024 * 1024
BOM = b"\xef\xbb\xbf"


def inspect(path):
    """Return (violations, facts) for one file."""
    with open(path, "rb") as fh:
        b = fh.read(MAX_BYTES + 1)
    if len(b) > MAX_BYTES:
        return [], {"skipped": "> 4 MB"}
    ext = os.path.splitext(path)[1].lower()
    crlf = b.count(b"\r\n")
    lf = b.count(b"\n")
    bom = b.startswith(BOM)
    try:
        ascii_ok = b.decode("ascii") is not None
    except UnicodeDecodeError:
        ascii_ok = False

    bad = []
    if bom:
        bad.append("BOM")
    if ext in ASCII_ONLY_EXT:
        if not ascii_ok:
            bad.append("非 ASCII")
        if not (crlf > 0 and crlf == lf):
            bad.append("行尾非 CRLF (CRLF %d / LF %d)" % (crlf, lf))
    return bad, {"bytes": len(b), "crlf": crlf, "lf": lf, "bom": bom, "ascii": ascii_ok}


def walk():
    for dp, dn, fn in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for f in sorted(fn):
            ext = os.path.splitext(f)[1].lower()
            if ext in TEXT_EXT or ext in ASCII_ONLY_EXT:
                yield os.path.join(dp, f)


def main(argv):
    if argv:
        targets = [os.path.abspath(a) for a in argv]
        banner = "指定文件 %d 个" % len(targets)
    else:
        targets = sorted(walk())
        banner = "普查 %s" % ROOT

    print(banner)
    print("-" * 78)
    print("  %-46s %8s %9s  %s" % ("文件", "字节", "CRLF/LF", "行尾"))
    bats = []
    bad_total = 0
    checked = 0
    for p in targets:
        if not os.path.isfile(p):
            print("  !! 不存在 %s" % p)
            bad_total += 1
            continue
        bad, facts = inspect(p)
        checked += 1
        rel = os.path.relpath(p, ROOT).replace("\\", "/")
        if "skipped" in facts:
            continue
        ext = os.path.splitext(p)[1].lower()
        if ext in ASCII_ONLY_EXT:
            bats.append(rel)
            print("  %-46s %8d %5d/%-4d  %s %s" % (
                rel, facts["bytes"], facts["crlf"], facts["lf"],
                "CRLF" if facts["crlf"] else "LF", "" if not bad else "  <== " + " + ".join(bad)))
        if bad:
            if ext not in ASCII_ONLY_EXT:
                print("  %-46s %8d %5d/%-4d  %s" % (
                    rel, facts["bytes"], facts["crlf"], facts["lf"], "  <== " + " + ".join(bad)))
            bad_total += 1

    print("-" * 78)
    print("  受检 %d 个文件；其中 .bat/.ps1 共 %d 个（必须 CRLF + 纯 ASCII）" % (checked, len(bats)))
    print("VERDICT %s  %d 个违规" % ("PASS" if bad_total == 0 else "FAIL", bad_total))
    return 0 if bad_total == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
