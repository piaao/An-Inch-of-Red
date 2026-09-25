# -*- coding: utf-8 -*-
"""
serve.py - 本地静态服务器，打开《一寸红》或场景查看器。

为什么需要它：浏览器禁止 file:// 协议下的 ES 模块与 .glb 模型加载
（CORS 限制），所以直接双击 play.html / index.html 会是一片空白。

用法：
    python serve.py                     # 起服务并打开游戏 play.html
    python serve.py --viewer            # 打开场景查看器 index.html
    python serve.py --workbench         # 打开参数化户型工作台 procgen.html
    python serve.py 9000                # 指定端口
    python serve.py 9000 --no-open      # 不自动打开浏览器
    python serve.py --open index.html   # 直接指定要打开的页面

位置参数既可以是端口、也可以是页面关键字，可以任意顺序混写：
    python serve.py 9000 workbench      # 端口 9000，开工作台
关键字：game / viewer / workbench（play / scene / procgen 是它们的同义词）。

浏览器不是「起服务后固定等 0.8 秒就打开」，而是**等端口真的应答之后**才打开。
这台机器上 Python 冷启动加上杀毒软件扫描有时要好几秒，早开就是一句「无法连接」；
轮询超时了也会照常把地址打印出来，让人自己点。

按 Ctrl+C 停止。
"""
import argparse
import functools
import http.server
import os
import socket
import socketserver
import sys
import threading
import time
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.abspath(__file__))

# 关键：.glb 必须给出正确的 MIME，否则部分浏览器会拒绝解析
EXTRA_TYPES = {
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".bin": "application/octet-stream",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".wasm": "application/wasm",
    ".ico": "image/x-icon",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # 只报告错误，正常请求不刷屏
        code = str(args[1]) if len(args) > 1 else ""
        if code.startswith(("4", "5")):
            sys.stderr.write("  [%s] %s\n" % (code, args[0]))

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in EXTRA_TYPES:
            return EXTRA_TYPES[ext]
        return super().guess_type(path)


def _in_use(p):
    """
    端口是否已经被别人占用。

    不要用 bind() 判断：Windows 上 `SO_REUSEADDR` 允许绑定一个**已被别人监听**的
    端口（与 Linux 语义相反），所以 bind 成功不等于端口是空的。直接连它 ——
    连得上（connect_ex == 0）就是有人在听。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", p)) == 0


def free_port(preferred):
    """优先用 preferred，被占用则向后找一个可用的。"""
    for p in range(preferred, preferred + 40):
        if not _in_use(p):
            return p
    raise SystemExit("找不到可用端口（从 %d 起 40 个都被占用）" % preferred)


def _answers(port, timeout=1.0):
    """端口上有没有一个**真的在应答 HTTP** 的服务。"""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/" % port,
                                    timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def wait_until_ready(port, deadline=40.0):
    """
    等服务真的应答。

    判据必须是「拿到一次 200」，不能是「端口被占用」：serve_forever() 还没开始
    监听时端口也可能是通的（连接会被内核排进 backlog），那时候打开浏览器只会
    看到连接被拒。这个函数同时给 open_when_ready() 和自检脚本用。
    """
    end = time.time() + deadline
    while time.time() < end:
        if _answers(port):
            return True
        time.sleep(0.15)
    return False


def open_when_ready(port, page, deadline=40.0):
    """等服务真的应答了，再打开浏览器。"""
    if wait_until_ready(port, deadline):
        webbrowser.open("http://127.0.0.1:%d/%s" % (port, page))
        return True
    sys.stderr.write("  [!] 服务在 %.0f 秒内没有应答，请自己打开上面的地址。\n" % deadline)
    return False


# 位置参数既能是端口，也能是页面关键字。文档里一直是这么写的，但旧实现只接受
# int，于是 `start.bat viewer` 会以 argparse 的 "invalid int value: 'viewer'"
# 结束 —— 服务根本没绑上端口，而报错看起来像参数写错了，不像启动器坏了。
PAGE_ALIASES = {
    "game": "play.html",
    "play": "play.html",
    "viewer": "index.html",
    "scene": "index.html",
    "workbench": "procgen.html",
    "procgen": "procgen.html",
}


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("targets", nargs="*", metavar="TARGET",
                    help="端口号（默认 8777）和/或页面关键字，可混写："
                         "game / viewer / workbench")
    ap.add_argument("--no-open", action="store_true", help="不要自动打开浏览器")
    ap.add_argument("--open", dest="page", default=None, metavar="PAGE",
                    help="要打开的页面（默认 play.html，也就是游戏）")
    ap.add_argument("--viewer", action="store_true",
                    help="打开场景查看器（等价于 --open index.html）")
    ap.add_argument("--workbench", action="store_true",
                    help="打开参数化户型工作台（等价于 --open procgen.html）")
    ap.add_argument("--print-target", action="store_true",
                    help="只打印解析出的端口与页面就退出（给自检用，不起服务）")
    args = ap.parse_args()

    port = 8777
    page = None
    for tok in args.targets:
        if tok.isdigit():
            port = int(tok)
        elif tok.lower() in PAGE_ALIASES:
            page = PAGE_ALIASES[tok.lower()]
        else:
            raise SystemExit(
                "不认识的目标 %r\n"
                "  端口请写成数字（例：9000）；页面关键字：%s"
                % (tok, " / ".join(sorted(PAGE_ALIASES))))

    # 显式开关优先于关键字，--open 最明确、放最后。
    if args.viewer:
        page = "index.html"
    if args.workbench:
        page = "procgen.html"
    if args.page is not None:
        page = args.page
    if page is None:
        page = "play.html"

    # 只回答「会开哪个页面」就退出：让冒烟测试能断言解析结果，
    # 而不是去猜一个已经打开的浏览器窗口开了哪一页。
    if args.print_target:
        print("%d %s" % (port, page))
        return

    # 游戏本体缺一不可；查看器是附带的，缺了只提示、不拦
    missing = [f for f in ("play.html", "game/play/play.js", "vendor/three.module.js")
               if not os.path.exists(os.path.join(ROOT, f))]
    if missing:
        raise SystemExit("缺少文件：%s\n请在仓库根目录（含 play.html 的那一层）下运行本脚本。" % ", ".join(missing))

    viewer_ok = all(os.path.exists(os.path.join(ROOT, f))
                    for f in ("index.html", "js/app.js"))

    # 工作台的三个模块缺一不可：抽出去的那份管线（pipeline）与绘图（draw）
    # 就是页面本身，少一个页面会在控制台静默半死。
    workbench_ok = all(os.path.exists(os.path.join(ROOT, f))
                       for f in ("procgen.html", "game/procgen/playground.js",
                                 "game/procgen/pipeline.js", "game/procgen/draw.js"))

    if page != "play.html" and not os.path.exists(os.path.join(ROOT, page)):
        sys.stderr.write("  [!] %s 不存在，改开 play.html\n" % page)
        page = "play.html"

    port = free_port(port)
    base = "http://127.0.0.1:%d/" % port

    handler = functools.partial(Handler, directory=ROOT)
    socketserver.TCPServer.allow_reuse_address = True

    with socketserver.ThreadingTCPServer(("127.0.0.1", port), handler) as httpd:
        httpd.daemon_threads = True
        n_models = len([f for f in os.listdir(os.path.join(ROOT, "assets", "models"))
                        if f.endswith(".glb")]) if os.path.isdir(
                            os.path.join(ROOT, "assets", "models")) else 0

        print("=" * 62)
        print("  一寸红 · An Inch of Red")
        print("=" * 62)
        print("  目录   %s" % ROOT)
        print("  模型   %d 个 .glb" % n_models)
        print("  游戏   %splay.html" % base)
        if viewer_ok:
            print("  查看器 %s" % base)
        if workbench_ok:
            print("  工作台 %sprocgen.html" % base)
        print("  停止   Ctrl + C")
        print("=" * 62)

        if not args.no_open:
            threading.Thread(target=open_when_ready, args=(port, page),
                             daemon=True).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n已停止。")


if __name__ == "__main__":
    main()
