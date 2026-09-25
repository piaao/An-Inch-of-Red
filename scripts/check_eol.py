# -*- coding: utf-8 -*-
"""Report line endings + sizes of the files patch_p18/p19 will touch."""
import io
import os

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')

for rel in ('game/core/nav.js', 'game/core/guard.js'):
    p = os.path.join(ROOT, rel)
    with open(p, 'rb') as fh:
        b = fh.read()
    crlf = b.count(b'\r\n')
    lf = b.count(b'\n')
    print('%-20s %7d bytes  CRLF %5d  LF-total %5d  %s'
          % (rel, len(b), crlf, lf, 'CRLF' if crlf else 'LF'))
