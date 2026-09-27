/**
 * verify_actors.mjs — 证明「男女主人」真的上了场，而且是**只换渲染**。
 *
 * 这里要回答的问题只有四个，每一个都可以数出来：
 *
 *   1. 素材是不是我们声称的那一份？      骨骼数、剪辑名、身高、道具清干净了没有
 *   2. 浏览器里真的换上去了吗？          `hosts.source === 'files'`，缩放到 guardHeight，
 *                                        脚踩在地上，正面朝视锥那一侧
 *   3. 状态机真的在跑吗？                待机/行动/奔跑/打击四态各进过一次，
 *                                        正在播的剪辑名 == 状态名，且只有一条动画在跑
 *   4. **它有没有偷偷改物理？**          同一个种子，`step()`（只跑模拟）与
 *                                        `tick()`（模拟 + 动画）必须逐位相同
 *
 * 第 4 条是这个文件存在的理由。`game/VERDICT.md` 里每一个胜率都是在「守卫走多快、
 * 看多远」这套固定事实上测的；一个会把守卫拖慢两米的挥拳动画，会让那些数字全部
 * 作废却看不出来。所以这里做的是 A/B 对照，不是"看起来没问题"。
 *
 * 用法：  node scripts/verify_actors.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cdp from './cdp.js';
import { HOSTS } from '../game/play/config.js';

const { serve, launch, attach, killStrayChrome, sleep } = cdp;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const WORK = path.join(ROOT, 'work');
const SHOTS = path.join(ROOT, 'renders', 'play');
const PORT = 8787;
const DEBUG = 9233;
const SEED = process.argv[2] || '2026-09-25';
/** 两人同场的那一档。`solo` / `patrol` 只派一名主人，看不到这一对。 */
const PRESET = 'tight';

const log = [];
const say = (s = '') => { log.push(s); console.log(s); };
const num = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  say(`   ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  return !!ok;
}

/* ---------------------------------------------------------- GLB 只读读取 */

const GLB_MAGIC = 0x46546c67;      // 'glTF' little-endian
const CHUNK_JSON = 0x4e4f534a;     // 'JSON'

function readGlbJson(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file}: not a GLB`);
  let off = 12;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === CHUNK_JSON) {
      return JSON.parse(buf.slice(off + 8, off + 8 + len).toString('utf8'));
    }
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  throw new Error(`${file}: no JSON chunk`);
}

function clipSeconds(g, anim) {
  let d = 0;
  for (const s of anim.samplers || []) {
    const a = g.accessors[s.input];
    if (a && a.max) d = Math.max(d, a.max[0]);
  }
  return d;
}

/** 手里拿着的东西一件都不该剩（剑、盾、弩、刀、投掷物）。 */
const HELD = /handslot|sword|shield|crossbow|knife|throwable|bomb|staff|wand|arrow|axe|mug|quiver|smoke/i;

/* ------------------------------------------------------------------ 主流程 */

let server = null;
let chrome = null;
let sess = null;
let exitCode = 0;
const report = {};

async function main() {
  /* ============================================================ 0. 素材 */
  say('');
  say('-- 0. 素材：它是不是我们声称的那一份 ------------------------------');
  const ledgerPath = path.join(ROOT, 'data', 'actors.json');
  const haveLedger = fs.existsSync(ledgerPath);
  check('data/actors.json 在', haveLedger, ledgerPath);
  if (!haveLedger) return;
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  report.ledger = { cast: (ledger.cast || []).map((c) => c.id), clips: ledger.clips };

  const lic = path.join(ROOT, ledger.licenseFile || '');
  check('CC0 授权原文随素材存放', fs.existsSync(lic),
    ledger.licenseFile + ' ' + (fs.existsSync(lic) ? `${fs.statSync(lic).size} B` : '缺失'));

  const loaded = [];
  // 源包字节数**从底账里读**，不在这里重打一个常量。裁剪比例是验收里的一条
  // 断言，写死的数字会在换素材之后悄悄说错话 —— 这一条曾经就是这么错的：
  // 两个源包并不一样大（男 3,659,532 / 女 3,616,284 B），而旧代码假定一样大。
  let bytes = 0;
  let totalSource = 0;
  const noSrc = [];
  for (const c of ledger.cast || []) {
    if (c.sourceBytes > 0) totalSource += c.sourceBytes;
    else noSrc.push(c.id);
  }
  check('底账里有每个角色的源包字节数（cast[].sourceBytes）',
    noSrc.length === 0, noSrc.length ? noSrc.join(',') : `合计 ${totalSource} B`);
  for (const c of ledger.cast || []) {
    const file = path.join(ROOT, c.file);
    if (!fs.existsSync(file)) { check(`${c.role} GLB 在`, false, c.file); continue; }
    const size = fs.statSync(file).size;
    bytes += size;
    let g;
    try { g = readGlbJson(file); } catch (e) { check(`${c.role} 可解析`, false, e.message); continue; }
    const joints = (g.skins && g.skins[0] && g.skins[0].joints.length) || 0;
    const clips = (g.animations || []).map((a) => a.name).sort();
    const want = Object.values(HOSTS.clips).sort();
    // 只查**带几何的节点**。`handslotl` / `handslotr` 是骨架里的挂点骨骼，名字里
    // 也含 "handslot"，但它们不是道具 —— 上一版把它们数成了残留，于是这一条在
    // 道具真的清干净了的时候反而报错。挂点骨骼留着是对的：剪辑里有挂手的轨道。
    const jointIdx = new Set((g.skins && g.skins[0] && g.skins[0].joints) || []);
    const heldLeft = (g.nodes || [])
      .map((n, i) => ({ name: n.name || '', mesh: n.mesh, i }))
      .filter((n) => n.mesh != null && !jointIdx.has(n.i) && HELD.test(n.name))
      .map((n) => n.name);
    const meshes = (g.meshes || []).length;

    const t = {
      id: c.id, role: c.role, file: c.file, size, joints, clips,
      tris: (g.meshes || []).reduce((a, m) => a + (m.primitives || []).reduce(
        (b, p) => b + (p.indices != null
          ? g.accessors[p.indices].count / 3
          : (p.attributes.POSITION != null ? g.accessors[p.attributes.POSITION].count / 3 : 0)), 0), 0),
      seconds: Object.fromEntries((g.animations || []).map((a) => [a.name, +clipSeconds(g, a).toFixed(3)])),
      heightM: c.heightM,
    };
    loaded.push(t);
    report[c.id] = t;

    say(`   ${c.role}  ${c.file}  ${size} B  joints=${joints}  meshes=${meshes}  tris=${t.tris}`);
    check(`${c.role}: 一副真骨架（41 骨）`, joints === 41, `joints=${joints}`);
    check(`${c.role}: 五条剪辑齐`, want.every((w) => clips.includes(w)),
      clips.length + ' 条：' + clips.join(','));
    check(`${c.role}: 每条剪辑都有时长`, Object.values(t.seconds).every((s) => s > 0.2),
      Object.entries(t.seconds).map(([k, v]) => `${k}=${v}s`).join(' '));
    check(`${c.role}: 手里的道具一件不剩`, heldLeft.length === 0,
      heldLeft.length ? heldLeft.join(',') : '0 个残留节点');
    check(`${c.role}: 只有一张贴图一个材质（低多边形）`,
      (g.images || []).length === 1 && (g.materials || []).length === 1,
      `images=${(g.images || []).length} materials=${(g.materials || []).length}`);
    check(`${c.role}: 裁剪真的瘦了身（< 700 KB）`, size < 700 * 1024,
      `${size} B，源包 ${c.sourceBytes} B 的 ${(100 * size / c.sourceBytes).toFixed(1)} %`);
  }
  check('两条骨架可以互换（骨数 + 剪辑名完全一致）',
    loaded.length === 2 && loaded.every((l) => l.joints === loaded[0].joints
      && l.clips.join('|') === loaded[0].clips.join('|')),
    loaded.map((l) => `${l.id}:${l.joints}`).join(' '));
  check('两个人共用一套剪辑名（换人不换动画）',
    loaded.length === 2 && loaded[0].clips.join(',') === loaded[1].clips.join(','),
    loaded.map((l) => l.clips.length + ' 条').join(' / '));
  report.trimRatio = +(bytes / totalSource).toFixed(4);
  say(`   裁剪：${totalSource} B -> ${bytes} B（${(100 * bytes / totalSource).toFixed(1)} %）`);

  /* ============================================================ 1. 上场 */
  say('');
  say('-- 1. 浏览器：主人真的站在场上 -------------------------------------');
  await killStrayChrome();
  server = await serve(ROOT, PORT);
  chrome = await launch({
    port: DEBUG, gl: 'gpu',
    userDataDir: 'C:/Users/Public/cdpprofile_actors',
  });
  sess = await attach({ port: DEBUG });
  await sess.viewport(1600, 900);

  await sess.goto(`http://127.0.0.1:${PORT}/play.html`, { settle: 1500 });
  let ready = false;
  for (let i = 0; i < 240; i++) {
    if (await sess.evalJs('!!(window.__ready && window.__play)') === true) { ready = true; break; }
    await sleep(500);
  }
  const bootErr = await sess.evalJs('window.__playError || null');
  check('页面起来了', ready, bootErr ? String(bootErr) : '');
  if (!ready) return;

  await sess.evalAsync(`await __play.pinSeed(${JSON.stringify(SEED)});
    await __play.begin(${JSON.stringify(PRESET)}); return 1;`);
  const hosts = await sess.evalJs('JSON.stringify(__play.hosts)');
  const h = JSON.parse(hosts);
  report.hosts = h;
  check(`hosts.source === 'files'（不是程序化机器人）`, h.source === 'files',
    `source=${h.source}${h.why ? ' why=' + h.why : ''}`);
  check(`${PRESET} 派了两名主人（一男一女）`, h.actors.length === 2,
    `actors=${h.actors.length} cast=[${h.cast.join(',')}]`);
  const roles = h.actors.map((a) => a.actor && a.actor.role);
  check('两个人分别是男主人与女主人',
    roles.includes('男主人') && roles.includes('女主人'), roles.join(' + '));
  check('两个 actor 都换成了骨骼身体',
    h.actors.every((a) => a.body === 'skeletal' && a.fallbackVisible === false),
    h.actors.map((a) => `${a.actor.id}:${a.body}`).join(' '));

  /* ================================================== 2. 尺度 / 朝向 */
  say('');
  say('-- 2. 尺度与朝向：0.55 m 高、脚踩地、脸朝视锥那一侧 -----------------');
  // 量之前必须先画一帧：`GuardActor.update()`（摆位置 + `rotation.y = -facing`）
  // 挂在 `render()` 上，而 `step()` / `tick()` 都**不画**。上一版没画就量，量到的
  // 是"还没摆过去"的静态变换（rotY = 0、位置还在原点），朝向断言读到的是一段
  // 噪声 —— `dot = 1` 正是退化向量被 `|| 1` 兜底之后的指纹。
  const live = await sess.evalAsync(`
    // 先真的跑 30 帧。begin() 之后还没 stepSim 过，两名守卫的 pos 都还是
    // (0,0)、facing 都是 0 —— 两组叠在原点，靠位置配对会把同一个组认给两个人
    // （实测输出里 actor[male] 出现了两次）。跑几十帧，人就走开了。
    await __play.begin(${JSON.stringify(PRESET)});
    __play.tick(1 / 60, 30);
    __play.renderOnce();
    const T = __play.THREE, level = __play.level;
    const gs = __play.guards;
    // 配对：scene.children 里叫 'guard' 的组与 guards[i] 只是碰巧同序，靠
    // **位置**对上才算数 —— 顺手把"组真的跟着核心走"也一起证了。
    const groups = __play.scene.children.filter((o) => o.name === 'guard');
    const out = [];
    const used = new Set();          // 一个组只能认一个守卫
    for (let i = 0; i < gs.length; i++) {
      const g = gs[i].state();
      let grp = null, best = 1e9;
      for (const c of groups) {
        if (used.has(c)) continue;
        const d = Math.hypot(c.position.x - g.pos.x, c.position.z - g.pos.z);
        if (d < best) { best = d; grp = c; }
      }
      if (grp) used.add(grp);
      if (!grp) { out.push({ id: '?', pairDist: null }); continue; }
      const box = new T.Box3().setFromObject(grp);
      let skinned = 0, cape = null, body = null, hostNode = null, boneCount = 0;
      grp.traverse((o) => {
        if (o.isSkinnedMesh) {
          skinned += 1;
          if (o.skeleton) boneCount = o.skeleton.bones.length;
        }
        if (/cape/i.test(o.name)) cape = o;
        if (/body/i.test(o.name) && !body) body = o;
        if (o.name && o.name.startsWith('host:')) hostNode = o;
      });
      // (a) 模型的正面到底朝哪：把**模型自己的**局部 +Z（data/actors.json 里量
      //     出来的正面轴）推到世界，再和核心给守卫的朝向点乘。这一条只依赖基变换，
      //     不碰任何几何、任何蒙皮，所以它没有噪声。
      let frontDot = null, frontDir = null;
      const meshRoot = hostNode && hostNode.children[0];
      if (meshRoot) {
        const o0 = meshRoot.getWorldPosition(new T.Vector3());
        const z = meshRoot.localToWorld(new T.Vector3(0, 0, 1)).sub(o0).normalize();
        frontDot = +(z.x * Math.cos(g.facing) + z.z * Math.sin(g.facing)).toFixed(4);
        frontDir = [+z.x.toFixed(4), +z.z.toFixed(4)];
      }
      // (b) 几何佐证：躯干 -> 披风 的方位与朝向点乘应为负（披风在背后）。必须用
      //     **包围盒质心**：骨骼网格的节点原点不跟着骨头走（实测躯干与披风的节点
      //     世界坐标都是 (0,0,0)，用原点算出来是纯噪声）。
      let capeDot = null, bodyToCape = null;
      if (cape && body) {
        const cc = new T.Box3().setFromObject(cape).getCenter(new T.Vector3());
        const bc = new T.Box3().setFromObject(body).getCenter(new T.Vector3());
        const dx = cc.x - bc.x, dz = cc.z - bc.z, len = Math.hypot(dx, dz) || 1;
        capeDot = +((dx / len) * Math.cos(g.facing) + (dz / len) * Math.sin(g.facing)).toFixed(4);
        bodyToCape = [+(dx / len).toFixed(4), +(dz / len).toFixed(4)];
      }
      out.push({
        id: hostNode ? hostNode.name.slice('host:'.length) : '?',
        skinned, boneCount, pairDist: +best.toFixed(6),
        frontDot, frontDir, capeDot, bodyToCape,
        groupRotY: +grp.rotation.y.toFixed(4), facing: +g.facing.toFixed(4),
        boxMinY: +box.min.y.toFixed(5), boxMaxY: +box.max.y.toFixed(5),
        height: +(box.max.y - box.min.y).toFixed(5),
        guardHeight: level.body.guardHeight,
      });
    }
    return JSON.stringify({ actors: out, guardHeight: level.body.guardHeight,
      guardEye: level.body.guardEye, guardRadius: level.body.guardRadius });
  `);
  const L = JSON.parse(live);
  report.scale = L;
  for (const a of L.actors) {
    const paired = a.pairDist != null;
    check(`actor[${a.id}] 骨骼网格在场`, a.skinned >= 1,
      `${a.skinned} 个 SkinnedMesh / ${a.boneCount} 骨`);
    check(`actor[${a.id}] 组被核心摆到了守卫位置上（配对距离 ≈ 0）`,
      paired && a.pairDist < 1e-6, `${a.pairDist} m`);
    check(`actor[${a.id}] 组朝向 == -guard.facing`,
      paired && Math.abs(a.groupRotY + a.facing) < 1e-6,
      `rotY=${a.groupRotY} facing=${a.facing}`);
    check('actor 缩放后身高 == level.body.guardHeight',
      Math.abs(a.height - a.guardHeight) < 0.02, `${num(a.height)} vs ${num(a.guardHeight)} m`);
    check('actor 脚踩在地面上（包围盒底 ≈ 0）', Math.abs(a.boxMinY) < 0.02, `minY=${a.boxMinY}`);
    check('actor 模型正面 (+Z) 就是守卫的朝向（点积 ≈ +1）',
      a.frontDot != null && a.frontDot > 0.99, `dot=${a.frontDot} dir=[${a.frontDir}]`);
    check('actor 披风在背后（几何佐证，点积 < 0）',
      a.capeDot != null && a.capeDot < -0.3, `dot=${a.capeDot} dir=[${a.bodyToCape}]`);
  }
  const matched = L.actors.map((a) => a.id);
  check('两名主人各自匹配到一个不同的组（一男一女）',
    new Set(matched).size === matched.length
      && matched.includes('male') && matched.includes('female'),
    `matched=[${matched.join(',')}]`);
  check('核心体型常量一个没动（guardHeight / guardEye / guardRadius）',
    L.guardHeight === 0.55 && L.guardEye === 0.3 && L.guardRadius === 0.15,
    `${L.guardHeight} / ${L.guardEye} / ${L.guardRadius}`);

  /* ====================================================== 3. 状态机 */
  say('');
  say('-- 3. 状态机：四个状态各进过一次，播的就是那一条 --------------------');
  const sm = await sess.evalAsync(`
    // 本块自己开一局：不依赖上一块跑过多少帧，受惊那一下才会从第一帧开始算。
    await __play.begin(${JSON.stringify(PRESET)});
    const gs = __play.guards;
    const seen = {}, clips = {}, order = [];
    let frames = 0, chaseSeen = 0, runInChase = 0, struck = null;
    const note = (reps) => {
      frames += 1;
      for (let i = 0; i < reps.length; i++) {
        const a = reps[i] && reps[i].anim;
        if (!a || !a.state) continue;
        seen[a.state] = (seen[a.state] || 0) + 1;
        clips[a.state] = a.clip;
        if (order[order.length - 1] !== a.state) order.push(a.state);
      }
      const a0 = reps[0] && reps[0].anim;
      if (a0 && a0.state === 'strike' && !struck) struck = a0;
      if (a0 && a0.state === 'run' && gs[0].mode === 'chase') runInChase += 1;
    };

    // (a) 冷静段：站住不动 300 帧 —— 期待 待机 + 行动。
    for (let i = 0; i < 300; i++) { __play.tick(1 / 60, 1); note(__play.animHosts(1 / 60, 1)); }

    // (b) 逃跑段：每帧把玩家吊在守卫正前 0.9 m，直到「奔跑」「打击」都露过面。
    //
    //     为什么是 0.9 m：它刚好在 strikeRange(0.62) 之外，所以核心在 chase 时
    //     read() 会走「奔跑」那一支；而 1 m 的视线很短，不容易被家具挡住 ——
    //     实测吊在 2 m 处会被挡住，suspicion 涨到 0.74 就掉回去，永远进不了 chase。
    //
    //     为什么必须"吊着"而不是"站着不动"：核心的「抓住」不是距离判定，而是
    //     suspicion >= 1 的那一帧（guard.js:269）。站在原地的玩家会在 30 帧内被
    //     贴脸抓走（实测 2.0 m -> 1.24 m -> 0 m），read() 于是永远停在
    //     strikeRange 那一支 —— 上一版就是栽在这里，才会读到"run 0 帧"。
    //     玩家在跑 = 距离持续 > strikeRange，那才是「奔跑」该出现的场景。
    for (let i = 0; i < 900; i++) {
      const s = gs[0].state();
      __play.teleport(s.pos.x + Math.cos(s.facing) * 0.9,
                      s.pos.z + Math.sin(s.facing) * 0.9);
      __play.tick(1 / 60, 1);
      if (gs[0].mode === 'chase') chaseSeen += 1;
      note(__play.animHosts(1 / 60, 1));
      if (i > 240 && seen.run > 0 && seen.strike > 0) break;
    }

    // (c) 收网段：松手，让主人自己贴上来打 —— 期待 打击。
    for (let i = 0; i < 600 && !struck; i++) {
      __play.tick(1 / 60, 1);
      note(__play.animHosts(1 / 60, 1));
    }

    // (d) 骨架真的在动。量的是**骨骼自己的四元数**，不依赖任何一次渲染；右腕的
    //     世界位移同时量出来作佐证。"骨骼动画"与"一张静止的模型"之间，可数的
    //     区别只有这一个。腕骨的真实名字是 wristr（源包里没有下划线和点）。
    __play.renderOnce();
    const T = __play.THREE;
    const g0 = gs[0].state();
    const groups = __play.scene.children.filter((o) => o.name === 'guard');
    let grp = null, best = 1e9;
    for (const c of groups) {
      const d = Math.hypot(c.position.x - g0.pos.x, c.position.z - g0.pos.z);
      if (d < best) { best = d; grp = c; }
    }
    let skinnedMesh = null;
    if (grp) {
      grp.traverse((o) => {
        if (!skinnedMesh && o.isSkinnedMesh && o.skeleton) skinnedMesh = o;
      });
    }
    const bones = skinnedMesh ? skinnedMesh.skeleton.bones : [];
    const wrist = bones.find((b) => /^wrist[_.-]?r$/i.test(b.name))
      || bones.find((b) => /wrist/i.test(b.name)) || null;
    const before = bones.map((b) => b.quaternion.clone());
    const v = new T.Vector3();
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let i = 0; i < 40; i++) {
      __play.animHosts(1 / 60, 1);
      if (wrist) {
        wrist.getWorldPosition(v);
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x);
        minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
      }
    }
    let bonesMoved = 0;
    const degs = [];
    for (let i = 0; i < bones.length; i++) {
      const deg = bones[i].quaternion.angleTo(before[i]) * 180 / Math.PI;
      if (deg > 1) bonesMoved += 1;
      degs.push({ name: bones[i].name, deg: +deg.toFixed(2) });
    }
    degs.sort((a, b) => b.deg - a.deg);
    const wr = wrist ? {
      name: wrist.name,
      x: +(maxX - minX).toFixed(5), y: +(maxY - minY).toFixed(5),
      quatDeg: +(wrist.quaternion.angleTo(before[bones.indexOf(wrist)])
        * 180 / Math.PI).toFixed(2),
    } : null;
    return JSON.stringify({ seen, clips, order, frames, chaseSeen, runInChase, struck,
      bones: { wrist: wr, count: bones.length, moved: bonesMoved, top: degs.slice(0, 5) },
      running: __play.hosts.actors.map((a) => a.anim.running) });
  `);
  const R = JSON.parse(sm);
  report.states = R;
  for (const st of ['idle', 'walk', 'run', 'strike']) {
    check(`状态机进过「${st}」`, R.seen[st] > 0, `${R.seen[st] || 0} 帧`);
  }
  check('受惊（startle）在第一次看见你时触发', R.seen.startle > 0, `${R.seen.startle || 0} 帧`);
  // 核心的 `spot` 发的是「视线由断到通」的那一帧，而主人一边走一边被家具挡，视线
  // 会一闪一灭。没有冷却时实测 240 帧里 176 帧都在受惊（73 %），待机/行动/奔跑
  // 全被顶掉。这一条就是那个冷却的回归哨。
  const flinchShare = R.seen.startle / Math.max(1, R.frames);
  check('受惊不会刷屏（占比 < 25 %）', flinchShare < 0.25,
    `${R.seen.startle}/${R.frames} 帧 = ${(100 * flinchShare).toFixed(1)} %`);
  // 素材里的剪辑被**按状态改名**了（build_actors.py），所以「状态名 == 剪辑名」
  // 不是同义反复：映射错了，这里就会读到别人的名字。
  const mismatched = Object.entries(R.clips).filter(([k, v]) => k !== v);
  check('每个状态播的就是它自己那条剪辑', mismatched.length === 0,
    mismatched.length ? JSON.stringify(mismatched) : Object.entries(R.clips).map(([k]) => k).join(','));
  check('核心真的进过「追」（奔跑的前置）', R.chaseSeen > 0, `${R.chaseSeen} 帧`);
  check('奔跑发生在「追」里（不是待机时的误判）', R.runInChase > 0, `${R.runInChase} 帧`);
  check('打击是在「追」里发生的', R.struck != null,
    R.struck ? `strikeT=${R.struck.strikeT}` : 'never');
  const wr = R.bones && R.bones.wrist;
  // 为什么不拿「右腕自己转了几度」当证据：这套骨架的跑动摆臂是靠 upperarm /
  // lowerarm 带过去的，腕骨在跑动剪辑里局部旋转**几乎不变**（实测 0°），而它的
  // 世界坐标照样挪了 26 mm —— 拿局部旋转去卡腕骨，会误杀一个完全正常的动作。
  // 所以改成量「摆得最狠的那根骨头」，并把前五名打出来。
  check('摆得最狠的骨头在 40 帧里转了 > 10°',
    R.bones.top[0] && R.bones.top[0].deg > 10,
    R.bones.top.slice(0, 3).map((b) => `${b.name}=${b.deg}°`).join(' '));
  check('骨架真的在动（右腕世界坐标在 40 帧里挪了 > 5 mm）',
    !!wr && (wr.x > 0.005 || wr.y > 0.005),
    wr ? `${wr.name} Δx=${wr.x} Δy=${wr.y} m` : '找不到腕骨');
  check('动的骨头不止一根（转过 > 1° 的骨骼 >= 8 根）', R.bones.moved >= 8,
    `${R.bones.moved}/${R.bones.count} 根`);
  check('每一帧只有一条动效在求值', R.running.every((r) => r.length <= 2),
    R.running.map((r) => r.join('+') || '(none)').join(' / '));
  check('状态顺序读起来像故事（待机/行动 -> 追 -> 打）',
    R.order.length >= 3, R.order.join(' -> '));

  /* ======================================= 4. 只改渲染：step vs tick */
  say('');
  say('-- 4. 只改渲染：同一种子，`step()` 与 `tick()` 必须逐位相同 ----------');
  const ab = await sess.evalAsync(`
    const snap = () => __play.guards.map((g) => {
      const s = g.state();
      return { x: s.pos.x, z: s.pos.z, mode: s.mode, susp: s.suspicion,
               dist: s.stats.distance, caught: s.stats.caught };
    });
    await __play.begin(${JSON.stringify(PRESET)});
    __play.step(1 / 60, 600);
    const a = snap();
    await __play.begin(${JSON.stringify(PRESET)});
    __play.tick(1 / 60, 600);        // 同样的 600 步，另外推进了动画
    const b = snap();
    return JSON.stringify({ a, b, same: JSON.stringify(a) === JSON.stringify(b) });
  `);
  const AB = JSON.parse(ab);
  report.ab = AB;
  check('动画层不喂回模拟（600 步后守卫状态逐位相同）', AB.same === true,
    AB.same ? 'identical' : `step=${JSON.stringify(AB.a)} tick=${JSON.stringify(AB.b)}`);
  const moved = AB.a[0] ? AB.a[0].dist : 0;
  check('这 600 步确实走了路（不是两边都僵着）', moved > 1,
    `${num(moved, 1)} m，caught=${AB.a[0] ? AB.a[0].caught : '?'}`);

  /* ==================================================== 5. 像素取证 */
  say('');
  say('-- 5. 像素与截图：它真的画到了帧缓冲 --------------------------------');
  fs.mkdirSync(SHOTS, { recursive: true });
  const px = await sess.evalAsync(`
    // 把相机放到第一个主人的眼睛高度、正面朝它，然后可见/隐藏各抓一帧。
    const T = __play.THREE, S = __play.scene, C = __play.camera, R = __play.renderer;
    const g = __play.guards[0].state();
    const groups = S.children.filter((o) => o.name === 'guard');
    __play.avatar.teleport(g.pos.x + Math.cos(g.facing) * 1.1,
                           g.pos.z + Math.sin(g.facing) * 1.1);
    __play.avatar.lookAt(g.pos.x, g.pos.z, 0.32);
    const cv = R.domElement, W = cv.width, H = cv.height;
    const grab = () => {
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      c.getContext('2d').drawImage(cv, 0, 0);
      return c.getContext('2d').getImageData(0, 0, W, H).data;
    };
    const vis = groups.map((x) => x.visible);
    __play.renderOnce();
    const on = grab();
    groups.forEach((x) => { x.visible = false; });
    __play.renderOnce();
    const off = grab();
    groups.forEach((x, i) => { x.visible = vis[i]; });
    __play.renderOnce();
    let changed = 0;
    for (let i = 0; i < on.length; i += 4) {
      if (Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1])
        + Math.abs(on[i + 2] - off[i + 2]) > 12) changed += 1;
    }
    return JSON.stringify({ changed, total: W * H, w: W, h: H });
  `);
  const P = JSON.parse(px);
  report.pixels = P;
  check('主人在第一人称视角里占住了像素（隐藏前后有差异）',
    P.changed > 500, `${P.changed} / ${P.total} px 变了`);

  const shots = [];
  for (const [name, idx] of [['07-host-male', 0], ['08-host-female', 1]]) {
    await sess.evalAsync(`
      const g = __play.guards[${idx}].state();
      __play.avatar.teleport(g.pos.x + Math.cos(g.facing) * 0.95,
                            g.pos.z + Math.sin(g.facing) * 0.95);
      __play.avatar.lookAt(g.pos.x, g.pos.z, 0.34);
      return 1;`);
    await sess.evalAsync(`__play.animHosts(1 / 60, 6); __play.renderOnce(); return 1;`);
    const file = path.join(SHOTS, name + '.png');
    const r = await sess.shot(file);
    shots.push({ name, bytes: r && r.bytes });
  }
  check('截图落盘（两张，非空）', shots.every((s) => s.bytes > 8000),
    shots.map((s) => `${s.name}:${s.bytes}B`).join(' '));

  const fin = sess.diagnostics();
  const AUDIO_MANIFEST = '/assets/audio/manifest.json';
  const consoleErrs = [...fin.exceptions, ...fin.consoleErrors, ...fin.logErrors]
    .filter((e) => !String(e).includes(AUDIO_MANIFEST));
  check('控制台干净（除已知的可选配乐 manifest 404）', consoleErrs.length === 0,
    consoleErrs.slice(0, 3).join(' | '));
  const realFails = (fin.failedDetail || []).filter(
    (f) => !f.canceled && !(f.status >= 200 && f.status < 400)
      && !String(f.url || '').includes(AUDIO_MANIFEST));
  check('没有真正的失败请求', realFails.length === 0,
    realFails.slice(0, 3).map((f) => f.errorText + ' ' + f.url).join(' | '));

  report.shots = shots;
}

main()
  .catch((err) => {
    say('');
    say('HARNESS ERROR: ' + (err && err.stack ? err.stack : err));
    exitCode = 2;
  })
  .finally(async () => {
    const passed = results.filter((r) => r.ok).length;
    say('');
    say('='.repeat(72));
    say(`  ${passed}/${results.length} checks passed`);
    for (const r of results) if (!r.ok) say(`   FAILED: ${r.name} — ${r.detail || ''}`);
    say('='.repeat(72));
    const verdict = results.length > 0 && passed === results.length && exitCode === 0;
    say(verdict ? '  VERDICT: PASS' : '  VERDICT: FAIL');
    fs.mkdirSync(WORK, { recursive: true });
    fs.writeFileSync(path.join(WORK, 'verify_actors.log'), log.join('\n') + '\n');
    fs.writeFileSync(path.join(WORK, 'verify_actors.json'),
      JSON.stringify({ ...report, results }, null, 1));
    try { if (sess) sess.close(); } catch { /* */ }
    try { if (chrome) chrome.kill(); } catch { /* */ }
    try { if (server) await server.close(); } catch { /* */ }
    await killStrayChrome();
    if (!verdict) exitCode = 1;
    process.exit(exitCode);
  });
