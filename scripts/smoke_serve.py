# -*- coding: utf-8 -*-
"""
smoke_serve.py — prove the delivered launcher actually serves the scene.

serve.py is what the user is told to run, so "it looks right" is not good
enough. This starts it exactly the way the user would, over HTTP, and checks
four things the browser depends on:

  * index.html answers 200 with text/html
  * js/app.js answers with a JavaScript MIME (a wrong one kills ES modules)
  * vendor/three.module.js answers with the full byte count on disk
  * assets/models/*.glb answers with model/gltf-binary AND the exact file size
    (a truncated .glb is the classic silent failure -- GLTFLoader just throws)

Exits non-zero if anything disagrees.
"""
import io
import os
import socket
import subprocess
import sys
import time
import urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = sys.executable
PREFERRED_PORT = 8791


def _port_in_use(p):
    """
    True if something is already listening on p.

    Not `bind()`: on Windows `SO_REUSEADDR` allows binding a port another socket
    is LISTENING on (the opposite of the Linux meaning), so a successful bind
    says nothing. A successful connect is the direct answer.
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(('127.0.0.1', p)) == 0


def pick_port(preferred=PREFERRED_PORT):
    """
    Return a port nothing is listening on.

    A fixed port is not a port you own. Stale `python -m http.server` processes
    from earlier sessions survive and answer on it; the smoke test would then
    grade a server it did not launch, and the reading that comes back describes
    the stale process -- not `serve.py`. `serve.py`'s own free_port() would have
    moved the child to the next port while this test kept talking to the
    squatter, so the port has to be reserved here, before the launch.
    """
    for p in range(preferred, preferred + 40):
        if not _port_in_use(p):
            return p
    raise SystemExit('no free port in [%d, %d)' % (preferred, preferred + 40))

CHECKS = [
    # path, expected MIME substring, must contain the scene markup
    ('/index.html', 'text/html', True),
    ('/procgen.html', 'text/html', False),
    ('/css/procgen.css', 'text/css', False),
    ('/game/procgen/playground.js', 'javascript', False),
    ('/game/procgen/pipeline.js', 'javascript', False),
    ('/game/procgen/draw.js', 'javascript', False),
    ('/js/app.js', 'javascript', False),
    ('/js/kit.js', 'javascript', False),
    ('/js/layout.js', 'javascript', False),
    ('/js/build.js', 'javascript', False),
    ('/js/env.js', 'javascript', False),
    ('/js/ui.js', 'javascript', False),
    ('/css/style.css', 'text/css', False),
    ('/vendor/three.module.js', 'javascript', False),
    ('/vendor/addons/controls/OrbitControls.js', 'javascript', False),
    ('/vendor/addons/loaders/GLTFLoader.js', 'javascript', False),
    ('/vendor/addons/utils/BufferGeometryUtils.js', 'javascript', False),
    ('/assets/models/tableCoffee.glb', 'model/gltf-binary', False),
    ('/assets/models/wallWindow.glb', 'model/gltf-binary', False),
    ('/assets/models/bedDouble.glb', 'model/gltf-binary', False),
    ('/assets/models/floorFull.glb', 'model/gltf-binary', False),
]

fail = []


def main():
    port = pick_port()
    base = 'http://127.0.0.1:%d' % port
    print('smoke port %d -- verified free before launch' % port)
    proc = subprocess.Popen(
        [PY, 'serve.py', str(port), '--no-open'],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

    try:
        # wait for the port to answer
        up = False
        for _ in range(50):
            try:
                urllib.request.urlopen(base + '/index.html', timeout=1).read()
                up = True
                break
            except Exception:
                time.sleep(0.2)
        if not up:
            print('FAIL  serve.py never came up on port %d' % port)
            out = proc.stdout.read().decode('utf-8', 'replace')
            print(out[-2000:])
            sys.exit(1)

        print('serve.py is up on %s' % base)

        # Prove the responder is the child we just launched. A stale
        # `python -m http.server` from an earlier session answers on the same
        # port and serves the same bytes with a different Content-Type, so
        # without this check every MIME reading below is a statement about the
        # wrong program. serve.py sends Cache-Control itself; the stdlib does not.
        _cc = urllib.request.urlopen(base + '/index.html', timeout=5) \
            .headers.get('Cache-Control', '')
        if 'no-store' not in _cc:
            print('FAIL  the process on port %d is NOT serve.py '
                  '(Cache-Control=%r). A stale static server is squatting the '
                  'port; the MIME findings below would be about it, not about '
                  'the launcher under test.' % (port, _cc))
            fail.append('not-our-server')
        else:
            print('the responder is our own serve.py  ok')
        print('%-46s %-6s %-22s %s' % ('path', 'status', 'content-type', 'bytes'))
        print('-' * 92)

        for path, want_type, must_be_html in CHECKS:
            try:
                r = urllib.request.urlopen(base + path, timeout=5)
                body = r.read()
                status = r.status
                ctype = r.headers.get('Content-Type', '')
            except Exception as e:
                print('%-46s %s' % (path, 'ERROR ' + str(e)))
                fail.append(path)
                continue

            disk = os.path.join(ROOT, path.lstrip('/'))
            on_disk = os.path.getsize(disk) if os.path.exists(disk) else -1
            ok_type = want_type in ctype
            ok_len = (len(body) == on_disk)
            flag = 'ok' if (status == 200 and ok_type and ok_len) else 'MISMATCH'
            if flag != 'ok':
                fail.append(path)
            print('%-46s %-6d %-22s %8d %s%s' % (
                path, status, ctype, len(body),
                flag, '' if on_disk < 0 else '  (disk %d)' % on_disk))
            if must_be_html and b'<canvas id="stage"' not in body:
                print('    FAIL: served index.html is not the scene page')
                fail.append(path)

        # a wrong MIME on the .glb is the one that actually breaks the scene
        r = urllib.request.urlopen(base + '/assets/models/tableCoffee.glb', timeout=5)
        if r.headers.get('Content-Type') != 'model/gltf-binary':
            print('FAIL: .glb MIME is %r, GLTFLoader expects model/gltf-binary'
                  % r.headers.get('Content-Type'))
            fail.append('glb-mime')
        else:
            print('glb MIME is model/gltf-binary  ok')

        # the workbench page must really be the workbench: id="params" is where
        # the 13 controls are built, id="plan" is where the SVG lands.
        wb = urllib.request.urlopen(base + '/procgen.html', timeout=5).read()
        if b'id="params"' not in wb or b'id="plan"' not in wb:
            print('FAIL: served procgen.html is not the workbench page')
            fail.append('procgen-marker')
        else:
            print('procgen.html carries the workbench markup  ok')

        # --- the launch words the docs advertise ------------------------------
        # These are the very first thing a reader types, and they used to die
        # inside argparse (invalid int value: 'viewer') before the server ever
        # bound: a documented one-word launch that could not work. Assert the
        # resolution rather than trusting the prose. --print-target makes "which
        # page will open" an observable string instead of a guessed-at window.
        print('')
        print('%-30s %-6s %-14s %s' % ('launch words', 'port', 'page', 'result'))
        print('-' * 92)
        for words, want_port, want_page in (
                ([], 8777, 'play.html'),
                (['game'], 8777, 'play.html'),
                (['viewer'], 8777, 'index.html'),
                (['workbench'], 8777, 'procgen.html'),
                (['9000'], 9000, 'play.html'),
                (['9100', 'workbench'], 9100, 'procgen.html'),
                (['workbench', '9200'], 9200, 'procgen.html')):
            r = subprocess.run([PY, 'serve.py'] + words + ['--print-target'],
                               cwd=ROOT, capture_output=True, text=True)
            got = (r.stdout or '').strip()
            want = '%d %s' % (want_port, want_page)
            good = r.returncode == 0 and got == want
            if not good:
                fail.append('launch:' + (' '.join(words) or '<default>'))
            label = ' '.join(words) if words else '(no arguments)'
            print('%-30s %-6d %-14s %s' % (
                label, want_port, want_page,
                'ok' if good else 'MISMATCH got %r rc=%d %s'
                % (got, r.returncode, (r.stderr or '').strip().splitlines()[-1:][:1])))

        # and a 404 must really be a 404
        try:
            urllib.request.urlopen(base + '/nope.glb', timeout=5)
            print('FAIL: missing file did not 404')
            fail.append('404')
        except urllib.error.HTTPError as e:
            print('missing file -> %d  ok' % e.code)
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()

    print('-' * 92)
    print('SMOKE %s%s' % ('PASS' if not fail else 'FAIL ', '' if not fail else str(fail)))
    sys.exit(0 if not fail else 1)


if __name__ == '__main__':
    main()
