#!/usr/bin/env python3
"""live_payload.py — 量线上首屏到底传了多少字节（压缩后）。

为什么不是把本地数字抄过去：`verify_dist.mjs` 在 127.0.0.1 上量的是**无压缩**
的 dist，报「首屏 3807.3 KB」。线上平台默认开 gzip，同一份文件传输量差两三倍。
引用本地那个数字是错的。

做法：**不重算资源清单，直接复用 verify_dist 的产物**。
`work/dist_eval.json` 里 `phone.res.urls` 是浏览器自己报的 [路径, 解码字节]，
这里拿同一份清单到线上逐条 GET，只统计**实际收到的字节**（不请求解压，
所以 len(body) 就是传输量），于是两边的对比是同一组 URL、同一个口径。

另记一条：这台机器上**无头 Chrome 导航到外网会让 CDP 通道失联**
（`Page.navigate` 拿不到响应，随后 Runtime.evaluate 也超时），
所以线上这一侧不能用浏览器量 —— 这也是这个脚本存在的第二个理由。
（见 scripts/probe/probe_live_payload.mjs 里记的坑。）

用法：
    python scripts/verify_dist.mjs 之后
    python scripts/probe/live_payload.py [https://host/]
"""
import io
import json
import os
import sys
import gzip
from concurrent.futures import ThreadPoolExecutor

HOST = sys.argv[1] if len(sys.argv) > 1 else "https://an-inch-of-red.app.workbuddy.host/"
HOST = HOST.rstrip("/") + "/"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
EVAL = os.path.join(ROOT, "work", "dist_eval.json")

import urllib.request
import urllib.error


def fetch(item):
    """返回 (路径, 状态码, 传输字节, content-type, content-encoding)。不抛异常。"""
    path, decoded = item
    url = HOST + path
    req = urllib.request.Request(url, headers={
        "Accept-Encoding": "gzip, deflate, br",   # 要压缩，但**不**自动解压
        "User-Agent": "live-payload-probe",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()                        # 压缩后的原始字节
            return (path, r.status, len(body),
                    r.headers.get_content_type(), (r.headers.get("Content-Encoding") or "-"),
                    decoded)
    except urllib.error.HTTPError as e:
        return (path, e.code, 0, "-", "-", decoded)
    except Exception as e:                          # 网络层
        return (path, 0, 0, type(e).__name__, "-", decoded)


def main():
    if not os.path.exists(EVAL):
        print("找不到 %s —— 先跑: node scripts/verify_dist.mjs" % EVAL)
        return 1
    d = json.load(io.open(EVAL, encoding="utf-8"))
    urls = d.get("phone", {}).get("res", {}).get("urls")
    if not urls:
        print("dist_eval.json 里没有 phone.res.urls —— 老版本的 verify_dist 产物。")
        print("重跑一次: node scripts/verify_dist.mjs")
        return 1
    local_total = d["phone"]["res"]["total"]

    print("目标 : %s" % HOST)
    print("清单 : 来自 %s（浏览器自己报的 %d 个请求）" % (
        os.path.relpath(EVAL, ROOT).replace(os.sep, "/"), len(urls)))
    print()

    with ThreadPoolExecutor(max_workers=8) as ex:
        rows = list(ex.map(fetch, urls))

    ok = [r for r in rows if r[1] == 200]
    bad = [r for r in rows if r[1] != 200]
    tx = sum(r[2] for r in ok)               # 实际传输（压缩后）
    dec = sum(r[5] for r in ok)              # 同一批文件的解码字节（本地那次的读数）
    enc = {}
    for r in ok:
        enc[r[4]] = enc.get(r[4], 0) + 1

    print("-- 结果 ----")
    print("   200: %d / %d" % (len(ok), len(rows)))
    if bad:
        print("   非 200 的 %d 条:" % len(bad))
        for r in bad[:10]:
            print("     %4s %-46s (%s)" % (r[1], r[0], r[3]))
    print("   Content-Encoding 分布: %s" % json.dumps(enc, ensure_ascii=False))
    print()
    print("   线上传输（压缩后）: %10.1f KB" % (tx / 1024.0))
    print("   其中解码后总量    : %10.1f KB" % (dec / 1024.0))
    print("   压缩到            : %10.1f %%" % (100.0 * tx / max(1, dec)))
    print()
    print("   对照 —— 本机 dist 无压缩首屏: %.1f KB" % (local_total / 1024.0))
    print("   → 线上比本地省掉 %.0f%%（同一组 URL、同一个口径）"
          % (100.0 * (1 - tx / max(1, local_total))))
    print()
    print("-- 最重的 10 个（传输 / 解码）----")
    for r in sorted(ok, key=lambda x: -x[2])[:10]:
        print("   %9d / %9d  %-44s %s" % (r[2], r[5], r[0][:44], r[4]))

    # 逐扩展名的压缩效果，最能说明"该压的压了没有"
    print()
    print("-- 按扩展名 ----")
    byext = {}
    for r in ok:
        ext = os.path.splitext(r[0])[1].lower() or "(无)"
        a = byext.setdefault(ext, [0, 0, 0])
        a[0] += 1
        a[1] += r[2]
        a[2] += r[5]
    for ext, (n, t, dd) in sorted(byext.items(), key=lambda kv: -kv[1][1]):
        print("   %-8s %3d 个  传输 %9.1f KB  解码 %9.1f KB  → %5.1f%%"
              % (ext, n, t / 1024.0, dd / 1024.0, 100.0 * t / max(1, dd)))

    # ---- P2 的账：服务器没压的那部分，压了能省多少 ----
    # 只看**服务器确实没压**的扩展名（Content-Encoding 为 '-'）。这里现在就是
    # .glb —— 首屏最重的一块，而且是唯一没被压过的。用本地文件实测 gzip -6
    # （nginx 默认档）得到真实潜力，而不是"大概能压一半"这种猜法。
    print()
    print("-- 若服务器也压这些（本地实测 gzip -6，nginx 默认档）----")
    uncompressed_ext = {os.path.splitext(r[0])[1].lower() or "(无)"
                        for r in ok if r[4] == "-"}
    saved_total = 0
    for ext in sorted(uncompressed_ext):
        if ext in (".glb", ".png", ".jpg", ".woff2"):     # 已是压缩格式的跳过
            pass
        files = [r[0] for r in ok if (os.path.splitext(r[0])[1].lower() or "(无)") == ext]
        raw = gzsz = 0
        for p in files:
            f = os.path.join(ROOT, "dist", p.replace("/", os.sep))
            if not os.path.exists(f):
                continue
            b = open(f, "rb").read()
            raw += len(b)
            gzsz += len(gzip.compress(b, 6))
        if not raw:
            continue
        saved = raw - gzsz
        saved_total += saved
        print("   %-8s %3d 个  %9.1f KB → %9.1f KB（%4.1f%%）  省 %8.1f KB"
              % (ext, len(files), raw / 1024.0, gzsz / 1024.0,
                 100.0 * gzsz / max(1, raw), saved / 1024.0))
    if saved_total:
        print("   合计可省 %.1f KB → 首屏从 %.1f KB 掉到 %.1f KB（再降 %.0f%%）"
              % (saved_total / 1024.0, tx / 1024.0,
                 (tx - saved_total) / 1024.0, 100.0 * saved_total / max(1, tx)))
        print("   （nginx 一行: gzip_types ... model/gltf-binary;  不动代码）")
    else:
        print("   （服务器已经把该压的都压了）")

    out = os.path.join(ROOT, "work", "live_payload.json")
    json.dump({"host": HOST, "n": len(rows), "ok": len(ok),
               "tx": tx, "dec": dec, "local_dec": local_total,
               "encodings": enc, "rows": [list(r) for r in rows]},
              io.open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print()
    print("已落盘: %s" % os.path.relpath(out, ROOT).replace(os.sep, "/"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
