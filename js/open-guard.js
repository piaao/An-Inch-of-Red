/**
 * open-guard.js -- "why is this page blank?" answered by the page itself.
 *
 * WHY A CLASSIC SCRIPT, AND WHY ONE SHARED FILE.
 *
 * Classic, because the failure it exists to explain is "the module graph never
 * ran": a module cannot report its own failure to load. It has to be something
 * the browser runs unconditionally.
 *
 * One shared file, because this is the third page in this repo to need it.
 * index.html and play.html each carry the lesson; procgen.html was written
 * afterwards and shipped without it -- so the ONE page a person most wanted to
 * open, the workbench, was the only one that stayed silent. A rule kept in a
 * copy is a rule the next page forgets.
 *
 * THE MEASUREMENT THIS EXISTS FOR. Opened as file://, procgen.html built 0 of
 * its 14 controls, drew 0 <svg> plans, and its status pill still read 准备中… --
 * the literal text in the HTML, never overwritten, because no line of the page
 * had executed. The browser's own words, from the console:
 *
 *   Access to script at 'file:///.../game/procgen/playground.js' from origin
 *   'null' has been blocked by CORS policy
 *
 * A pristine-looking shell that will never do anything is the worst possible
 * failure mode, so the two cases it names are:
 *
 * THREE READERS, NOT TWO. The first two below are the local ones. The third
 * arrived when the game got a public URL: a VISITOR on the deployed page has no
 * repository, no terminal and no `start.bat`, so telling them to double-click it
 * is not an explanation, it is a dead end printed in a large font. Serving is
 * therefore split by host -- loopback gets the developer message, anything else
 * gets "reload, then try another network or browser" and names no script that
 * the reader could not possibly run. `scripts/verify_open.mjs` reads all three
 * message bodies back and fails if a local-only instruction leaks into the
 * remote one.
 *
 *   1. opened as file://  -- browsers refuse ES modules and fetch for file://
 *      documents, so nothing on the page will ever run;
 *   2. served over http but the module never ran -- a 404, a syntax error, a
 *      path that stopped existing.
 *
 * IT REFUSES TO GUESS. It does not fire on a timer and hope: it watches for the
 * global the page's own module sets (data-needle) and reports only after that
 * global has been absent for a while. And if the page boots late, it takes the
 * warning back -- a false alarm would be worse than silence here, because it
 * would teach the reader to ignore this box.
 *
 * WHY A NAMED FUNCTION RATHER THAN AN IIFE. The static gate in shoot.js reads
 * every module under js/ and refuses one whose comment-stripped source has no
 * top-level declaration. An IIFE trips it -- correctly: "no declarations" is
 * what a gutted file looks like. So the body is a named function, called
 * immediately, which is also the only moment document.currentScript is valid.
 *
 * Configured with data-* on the tag that loads it:
 *   data-needle   global the page's module sets once the module graph has run
 *   data-overlay  id of the box to show -- the page's own overlay where it has
 *                 one, so the explanation lands where the reader is looking
 *   data-title    id of the heading inside it
 *   data-msg      id of the paragraph inside it
 *   data-cmd-id   optional: id of a line that should carry the command alone
 *   data-alt-id   optional: id of a line that should carry the double-click hint
 *                 (give both or neither; without them everything is folded into
 *                 the message paragraph, which is what play.html and index.html
 *                 want -- their overlay is one message box)
 *   data-reveal   classes to REMOVE from the box (default "hidden")
 *   data-fail     class to ADD to it, for pages whose overlay has a failed look
 *   data-page     this page's file name, for the URL printed in the message
 *   data-open     the .bat a double-click can actually reach
 *   data-cmd      the command-line equivalent
 */
function installOpenGuard() {
  'use strict';

  var me = document.currentScript;
  if (!me) return;

  var cfg = {
    needle: me.getAttribute('data-needle'),
    overlay: me.getAttribute('data-overlay'),
    title: me.getAttribute('data-title'),
    msg: me.getAttribute('data-msg'),
    cmdId: me.getAttribute('data-cmd-id'),
    altId: me.getAttribute('data-alt-id'),
    reveal: me.getAttribute('data-reveal') || 'hidden',
    fail: me.getAttribute('data-fail') || '',
    page: me.getAttribute('data-page') || '',
    open: me.getAttribute('data-open') || 'start.bat',
    cmd: me.getAttribute('data-cmd') || 'python serve.py'
  };
  if (!cfg.needle || !cfg.overlay) return;

  var isFile = location.protocol === 'file:';
  // file:// is a verdict, not a suspicion, so it may be reported quickly. Over
  // http a slow disk is not a bug, so the window is generous.
  var deadline = isFile ? 1200 : 2600;
  var firstError = '';
  var shown = false;
  var wasHidden = false;
  var cfgCase = '';

  // 环回地址 = "这台机器自己在开发"。除此之外全是线上访客。
  var LOOPBACK = { '127.0.0.1': 1, 'localhost': 1, '::1': 1, '[::1]': 1, '0.0.0.0': 1 };

  // Captured with capture=true, because a failed <script src> never reaches
  // window.onerror as a normal error -- it only surfaces as an error event on
  // the element itself.
  window.addEventListener('error', function (e) {
    if (firstError) return;
    var t = e && e.target;
    if (t && t.tagName === 'SCRIPT' && t.src) firstError = '脚本没加载成功：' + t.src;
    else if (e && e.message) firstError = e.message + (e.filename ? '（' + e.filename + '）' : '');
  }, true);

  var esc = function (s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  };
  var byId = function (id) { return id ? document.getElementById(id) : null; };
  var each = function (cls, fn) {
    if (!cls) return;
    cls.split(/\s+/).forEach(function (c) { if (c) fn(c); });
  };

  /** 这一页是在哪儿被打开的？三种情况，三种读者。 */
  function whereAmI() {
    if (isFile) return 'file';
    return LOOPBACK[String(location.hostname || '').toLowerCase()] ? 'served-local' : 'served-remote';
  }

  /**
   * 三种情况该显示什么。**纯数据**（`tail` 是延迟求值的"怎么打开它"那一段），
   * 所以验收可以逐字把它读回来，而不必去伪造一个主机名。
   *
   * 线上那一段不许出现 `start.bat` / `serve.py` / `127.0.0.1` / `diag_open.mjs`：
   * 访客手里一样都没有。这不是措辞问题 —— 一段要人执行本机命令的说明，在
   * 线上就是"这个游戏坏了"的另一种写法。
   */
  function bodies(kind) {
    if (kind === 'file') {
      return {
        heading: '需要通过本地服务器打开',
        lead: '你是<strong>双击</strong>打开的这个文件。浏览器禁止 <code>file://</code> 下的 '
          + 'ES 模块与 <code>fetch</code>，所以这一页的代码<strong>一行都没执行</strong> —— '
          + '界面看着是好的，其实是个空壳。',
        tail: function () {
          var url = 'http://127.0.0.1:8777/' + cfg.page;
          return '在资源管理器里双击本文件旁边的 <code>' + esc(cfg.open) + '</code>，'
            + '或执行：<br><code>' + esc(cfg.cmd) + '</code><br>然后访问 <code>' + esc(url) + '</code>';
        },
        alt: function () {
          var url = 'http://127.0.0.1:8777/' + cfg.page;
          return '或者更省事：在资源管理器里双击 <code>' + esc(cfg.open) + '</code>。'
            + '然后访问 <code>' + esc(url) + '</code>';
        },
      };
    }
    if (kind === 'served-remote') {
      return {
        heading: '页面没能加载',
        lead: '页面脚本没有加载成功。'
          + (firstError ? '<br>浏览器给的原因：<code>' + esc(firstError) + '</code>' : '')
          + '<br>先刷新一次（<b>Ctrl / ⌘ + R</b>）。还是这样的话，'
          + '多半是网络中断、或者浏览器扩展拦了脚本 —— 换个网络或换一个浏览器再试。',
      };
    }
    return {
      heading: '页面脚本没有执行',
      lead: '服务是通的，但这一页的脚本没有加载成功。'
        + (firstError ? '<br>浏览器给的原因：<code>' + esc(firstError) + '</code>' : '')
        + '<br>按 <b>F12</b> 看 Console 与 Network；命令行诊断：'
        + '<code>node scripts/diag_open.mjs</code>',
    };
  }

  function explain(kindOverride) {
    var box = byId(cfg.overlay);
    if (!box) return;
    var kind = kindOverride || whereAmI();
    shown = true;
    cfgCase = kind;
    globalThis.__openGuardCase = kind;
    wasHidden = box.classList.contains('hidden');
    each(cfg.reveal, function (c) { box.classList.remove(c); });
    each(cfg.fail, function (c) { box.classList.add(c); });

    var head = byId(cfg.title);
    var body = byId(cfg.msg);
    var t = bodies(kind);
    if (head) head.textContent = t.heading;
    if (body) body.innerHTML = t.lead;
    if (!t.tail) return;

    // A page that gave the command its own line gets it there, so the card
    // reads like a recipe instead of a paragraph. A page whose overlay is a
    // single message box (play.html, index.html) gets it appended to that box.
    // Either way all three facts reach the screen: what happened, what to
    // double-click, and the URL to end up at. Markup that exists and is never
    // written to renders as an empty bar, which is its own small lie.
    var cmdEl = byId(cfg.cmdId);
    var altEl = byId(cfg.altId);
    if (cmdEl && altEl) {
      cmdEl.textContent = cfg.cmd;
      altEl.innerHTML = t.alt();
    } else if (body) {
      body.innerHTML = t.lead + '<br>' + t.tail();
    }
  }

  /**
   * 三种情况会印出来的字，**原样**。给验收用的：主机名没法在无头浏览器里
   * 伪造，而"线上那一段不许出现 start.bat"是一条关于**字符串**的断言，
   * 所以直接把字符串读出来比伪造一个环境更诚实。
   */
  globalThis.__openGuardPreview = function (kind) {
    var t = bodies(kind);
    return {
      heading: t.heading,
      lead: t.lead,
      tail: t.tail ? t.tail() : '',
      alt: t.alt ? t.alt() : '',
      case: kind,
    };
  };

  /** A late boot must erase the alarm, or the box teaches people to ignore it. */
  function withdraw() {
    if (!shown) return;
    shown = false;
    var box = byId(cfg.overlay);
    if (!box) return;
    each(cfg.fail, function (c) { box.classList.remove(c); });
    if (wasHidden) box.classList.add('hidden');
  }

  var t0 = Date.now();
  var timer = setInterval(function () {
    if (globalThis[cfg.needle]) { clearInterval(timer); withdraw(); return; }
    if (shown) return;                        // shown: only waiting to withdraw
    if (Date.now() - t0 < deadline) return;
    explain();
    // Keep a slow watch so a boot at 5 s still clears the box.
    clearInterval(timer);
    timer = setInterval(function () {
      if (globalThis[cfg.needle]) { clearInterval(timer); withdraw(); }
    }, 1000);
  }, 150);
}

// Called immediately, because a classic script runs at parse time and
// document.currentScript is only valid during that turn. Named and top-level on
// purpose: the static gate in shoot.js refuses any module under js/ whose
// comment-stripped source has no top-level declaration -- which is the shape of
// a file that has been gutted, and an IIFE looks exactly like that.
installOpenGuard();
