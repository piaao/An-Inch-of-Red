/**
 * actors.js — 男女主人：一副真骨架、一台四态状态机。
 *
 * ── 为什么换了身体 ─────────────────────────────────────────────────────────
 * 守卫原先是一个程序化的小机器人（圆柱 + 球罩 + 一颗灯眼），它便宜、能读、也
 * 确实把"搜索"变成了"潜行"。但这一局的设定是**闯空门**：你是一只 42 cm 的小
 * 东西，溜进别人家里偷红包，而屋里有**人**。主人不该是台机器 —— 机器看不出
 * 你是在"躲"它，只看得出你在躲"某个转着的东西"。
 *
 * 所以这一版把两台机器人换成**一对主人**：男主人与女主人，各有自己的骨架动画
 * 与状态机。素材来自 KayKit Adventurers（CC0，出处见 `CREDITS.md`），
 * 只用 41 根骨的同一套骨架 —— 两个人**共用同一批剪辑**，所以"换一身衣服"
 * 不需要重配任何动画。
 *
 * ── 一条不可越过的线：只改渲染，不改物理 ───────────────────────────────────
 * `game/VERDICT.md` 里每一个胜率，都是在「守卫的速度 / 视锥 / 惩罚」这一套固定
 * 事实上测出来的。本模块**只读** `Guard` 的状态（`mode` / `pos` / `facing` /
 * `scanPhase`），一个字段都不写：
 *
 *   - 状态机决定"播哪条动画"，不决定"走多快、看不看得见你"；
 *   - `打击` 是一次**渲染层的加注**（贴到 `strikeRange` 内挥一拳），核心的罚时
 *     仍然只由 `suspicion` 满格触发，与这里无关；
 *   - 动画在播时主人**照常平移**（没有 root motion），所以不会因为它挥拳而
 *     少走两米、少看见你一次。
 *
 * 要让"挥拳"真的影响玩法（比如击中你时原地停顿 0.3 s），正确做法是把它提升进
 * `game/core/guard.js`，然后重跑 `scripts/measure_surveil.mjs` 并更新
 * `game/VERDICT.md`。那份账记在 `game/ACTORS.md` §5。
 *
 * ── 三段降级链（与配乐同一套做法）─────────────────────────────────────────
 *   ① `data/actors.json` 在、GLB 在、五条剪辑齐 ⇒ `source:'files'`，真人出场；
 *   ② 否则（manifest 缺 / 解析失败 / 缺剪辑 / 加载报错）⇒ `source:'procedural'`，
 *      退回程序化机器人（`scene.js` 的 `GuardActor` 本体），游戏照常跑；
 *   ③ 再否则关掉身体，只留视锥与光斑。
 *
 * **零 404**：只请求 `data/actors.json` 里点名的文件。manifest 不在就一个 GLB
 * 请求都不发 —— 和 `music.js` 只认 `audio/manifest.json` 是同一条规矩。
 *
 * ── 朝向：+Z 是量出来的，不是猜的 ─────────────────────────────────────────
 * 模型局部正面是 **+Z**。依据不是"看起来像"，是 `scripts/build_actors.py` 用
 * 披风网格质心减躯干质心量出来的方向（量测落在 `data/actors.json` 的
 * `cape*` 字段上）。而 `GuardActor.group` 的约定是"局部正面 = +X"（视锥、聚光
 * 灯、感叹号都照这个摆），所以模型在组内要被转 **+90°**：
 *
 *     model.rotation.y = HOSTS.modelYaw   // +pi/2，把模型的 +Z 拧成组内的 +X
 *
 * 这样"哪边是前"仍然只有一个来源 —— `guard.facing` —— 不会出现第二套朝向推导。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HOSTS } from './config.js';

/** 状态机的状态名，顺序 = 优先级（越靠前越"压得住"）。 */
export const HOST_STATES = ['strike', 'startle', 'run', 'walk', 'idle'];

const MANIFEST = 'data/actors.json';

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 把 `data/actors.json` 与它点名的 GLB 读进来。
 *
 * 返回 `{ source, cast }`：`source` 是 'files' | 'none'，`cast` 是 id -> 定义
 * 的 Map（含 `gltf`）。任何一步不成立都返回 `source:'none'` —— 调用方据此退回
 * 程序化身体，而不是抛异常把整个游戏带走。
 */
export async function loadHostCast({ url = MANIFEST } = {}) {
  let ledger;
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) return { source: 'none', cast: new Map(), why: `${url} → ${res.status}` };
    ledger = await res.json();
  } catch (err) {
    return { source: 'none', cast: new Map(), why: String(err && err.message) };
  }
  const entries = Array.isArray(ledger.cast) ? ledger.cast : [];
  if (!entries.length) return { source: 'none', cast: new Map(), why: 'manifest has no cast' };

  const need = Object.keys(HOSTS.clips);
  const loader = new GLTFLoader();
  const cast = new Map();
  for (const def of entries) {
    try {
      const gltf = await loader.loadAsync(def.file);
      const byName = new Map(gltf.animations.map((a) => [a.name, a]));
      const missing = need.filter((k) => !byName.has(HOSTS.clips[k]));
      if (missing.length) {
        console.warn(`[actors] ${def.id}: 缺少剪辑 ${missing.join(', ')} —— 该角色退回程序化身体`);
        continue;
      }
      cast.set(def.id, { def, gltf, clips: byName });
    } catch (err) {
      console.warn(`[actors] ${def.id}: 加载失败 ${err && err.message}`);
    }
  }
  if (!cast.size) return { source: 'none', cast, why: 'no usable character' };
  return { source: 'files', cast, ledger };
}

/**
 * 一副会动的身体。
 *
 * 它自己不知道什么是"守卫"，只知道：**给我当前是第几状态，我把这一状态演出来**。
 * 状态由 `HostBody.read()` 从核心的 `Guard` 里读出来 —— 只读。
 */
export class HostBody {
  /**
   * @param def   `data/actors.json` 里的那一条（含 heightM / joints / file）
   * @param gltf  GLTFLoader 的结果
   * @param body  `level.body`（guardHeight 是唯一的缩放依据）
   * @param clips 剪辑表：状态名 -> THREE.AnimationClip
   */
  constructor(def, gltf, body, clips, { envIntensity = 0.8 } = {}) {
    this.def = def;
    this.body = body;
    this.state = null;
    this.stateSince = 0;
    this.strikeT = 0;
    this.startleT = 0;
    this.cooldown = 0;
    this.flinchCd = 0;      // 「受惊」的冷却：同一次追捕只该惊一次
    this.distance = Infinity;
    this.seconds = 0;
    this.transitions = 0;
    this.playCount = Object.create(null);
    this.lastMoved = 0;
    this._last = null;

    // 缩放到 `level.body.guardHeight`，脚底落在 y = 0。**不改 body** ——
    // guardRadius / guardEye 是碰撞与视线的输入，动它们要重测胜率。
    const root = gltf.scene;
    const box = new THREE.Box3().setFromObject(root);
    const height = Math.max(1e-6, box.max.y - box.min.y);
    const scale = body.guardHeight / height;
    root.scale.setScalar(scale);
    root.position.y = -box.min.y * scale;
    root.rotation.y = HOSTS.modelYaw;      // 模型的 +Z 正面 -> 组内的 +X 正面

    root.traverse((o) => {
      if (!o.isMesh && !o.isSkinnedMesh) return;
      o.castShadow = true;
      o.receiveShadow = true;
      // 与 Kenney 家具同一档的环境光强，否则人物会比家具亮一大截。
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        m.envMapIntensity = envIntensity;
        m.needsUpdate = true;
      }
    });

    this.group = new THREE.Group();
    this.group.name = `host:${def.id}`;
    this.group.add(root);

    this.mixer = new THREE.AnimationMixer(root);
    this.actions = Object.create(null);
    for (const [state, clip] of Object.entries(clips)) {
      const a = this.mixer.clipAction(clip);
      a.name = state;
      // 循环态与一次性态：一次性态 clamp 在末帧，回到循环态时再交叉淡出去。
      const once = state === 'strike' || state === 'startle';
      a.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
      a.clampWhenFinished = once;
      this.actions[state] = a;
    }
    this.durations = Object.create(null);
    for (const [state, clip] of Object.entries(clips)) this.durations[state] = clip.duration;

    // 量出来的三个数：缩放、脚底、骨数。放进 userData，验证脚本直接读。
    this.group.userData.actor = {
      id: def.id,
      role: def.role,
      file: def.file,
      scale,
      scaledHeight: height * scale,
      feetY: root.position.y,
      joints: def.joints,
      states: Object.keys(clips),
      modelYaw: HOSTS.modelYaw,
    };
  }

  /** 当前状态的动画名（验证脚本用它来核对"状态 ≠ 剪辑"这类错配）。 */
  activeClip() {
    const a = this.actions[this.state];
    return a ? a.getClip().name : null;
  }

  /**
   * 核心的 `Guard` 事件 → 动画层的加注。
   *
   * `spot` 是"第一次看见你"：主人会激灵一下。这是全场唯一一个**只有动画层知道**
   * 的节拍，因为核心的 `spot` 事件本来就带这个语义（`guard.js` 里只在
   * `_seenLast` 由 false 翻 true 的那一帧发一次）。
   */
  onEvent(ev) {
    if (ev.type === 'spot') {
      // 只在冷却结束后才激灵。核心的 `spot` 发的是「视线由断到通」的那一帧，
      // 而主人一边走一边被家具挡，视线一闪一灭就会把这一帧反复发出来 ——
      // 实测把玩家吊在正前 2 m，240 帧里有 176 帧都在受惊（73 %），待机、
      // 行动、奔跑全被它顶掉，看着像在打摆子。同一次追捕只该惊一次，
      // 后面反复「又看见你了」由 alert / run 自己表达。
      if (this.flinchCd > 0) return;
      this.startleT = HOSTS.startleFor;
      this.flinchCd = HOSTS.startleCooldown;
    } else if (ev.type === 'caught') {
      // 抓到你 = 打你。这是"打击"最该出现的一帧，而且它和罚时同帧，
      // 所以玩家看到的因果是对的：**它挥拳的那一下，时间被扣掉了**。
      this.strikeT = this._onceSeconds('strike');
      this.cooldown = HOSTS.strikeCooldown;
    }
  }

  /** 一次性动作要占多久（= 剪辑自己的长度；一次性动作一律 1 倍速）。 */
  _onceSeconds(state) {
    const a = this.actions[state];
    return a ? a.getClip().duration : 0.8;
  }

  /**
   * 推进一帧。
   *
   * @param dt     秒
   * @param guard  核心的 `Guard`（**只读**）
   * @param player `{x, z}`，用来算"贴多近该出手"
   */
  update(dt, guard, player) {
    this.seconds += dt;
    if (this.strikeT > 0) this.strikeT = Math.max(0, this.strikeT - dt);
    if (this.startleT > 0) this.startleT = Math.max(0, this.startleT - dt);
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.flinchCd > 0) this.flinchCd = Math.max(0, this.flinchCd - dt);

    // 「动了没有」是渲染层自己量的位移，不是问核心。核心不提供速度字段，
    // 因为它不需要 —— 这里需要，就自己算，但一枚字段都不写回去。
    const moved = this._last
      ? Math.hypot(guard.pos.x - this._last.x, guard.pos.z - this._last.z) : 0;
    this._last = { x: guard.pos.x, z: guard.pos.z };
    if (moved > 1e-4) this.lastMoved = this.seconds;

    if (player) {
      this.distance = Math.hypot(player.x - guard.pos.x, player.z - guard.pos.z);
    }

    const state = this.read(guard);
    if (state !== this.state) this._enter(state);

    // 逐状态的播放速率：让步频对上核心速度，而不是各走各的。
    const a = this.actions[this.state];
    if (a) {
      if (this.state === 'walk') a.setEffectiveTimeScale(this._cadence('walk', guard.cfg.speed));
      else if (this.state === 'run') a.setEffectiveTimeScale(this._cadence('run', guard.cfg.chaseSpeed));
      else a.setEffectiveTimeScale(1);
    }
    this.mixer.update(dt);
    return this.state;
  }

  /**
   * 状态机本体。**它只读**，而且读的都是核心已经在算的东西。
   *
   *   strike  刚抓到你，或追击中贴进了 `strikeRange`（有冷却）
   *   startle 第一次看见你的那个激灵
   *   run     核心在 `chase`
   *   idle    核心在 `alert`（停下盯着），或在路点上扫视（`scanPhase > 0`），
   *           或者干脆没动
   *   walk    其余：在巡逻路上走
   */
  read(guard) {
    if (this.strikeT > 0) return 'strike';
    if (this.startleT > 0) return 'startle';
    if (guard.mode === 'chase') {
      if (this.distance <= HOSTS.strikeRange && this.cooldown <= 0) {
        this.strikeT = this._onceSeconds('strike');
        this.cooldown = HOSTS.strikeCooldown;
        return 'strike';
      }
      return 'run';
    }
    if (guard.mode === 'alert') return 'idle';
    if (guard.scanPhase > 0) return 'idle';
    if (this.seconds - this.lastMoved > HOSTS.stillAfter) return 'idle';
    return 'walk';
  }

  /**
   * 一个循环 → 走了多少米，进而算出该以几倍速播。
   *
   * 这里有一个**写在明处的取舍**：本项目的主人只有 0.55 m 高，而核心给守卫的
   * 巡逻速度是 1.05 m/s（≈ 每秒 1.9 个身高）。要让一个 55 cm 的小人真的用这个
   * 速度走，步频得翻两倍还多，腿会糊成一片。所以 `stridePerHeight` 取的是
   * "看着像在走"的值，再把倍速**封顶**在 `maxTimeScale`：宁可让脚底滑一点，
   * 也不要一台高频抖腿。真要根治，得让守卫的速度随身高走 —— 而那要重测整套
   * 胜率，账记在 `game/ACTORS.md` §5。
   */
  _cadence(kind, speed) {
    const stride = (HOSTS.stridePerHeight[kind] || 1) * this.body.guardHeight;
    const dur = this.durations[kind] || 1;
    const natural = stride / dur;                       // m/s the clip implies
    const ts = speed / Math.max(1e-3, natural);
    const cap = (HOSTS.timeScaleCap && HOSTS.timeScaleCap[kind]) || HOSTS.maxTimeScale;
    return clamp(ts, 0.55, cap);
  }

  _enter(name) {
    const next = this.actions[name];
    if (!next) return;
    const prev = this.state ? this.actions[this.state] : null;
    if (name === 'strike' || name === 'startle') {
      next.reset();
      next.setEffectiveTimeScale(1);
      next.setEffectiveWeight(1);
      next.play();
      // 一次性动作从上一状态**淡进来**，但必须在自己的时长内结束并夹在末帧，
      // 否则挥到一半就被循环态抢回去，看起来像"打了个哆嗦"。
      if (prev && prev !== next) prev.crossFadeTo(next, HOSTS.fade, false);
    } else {
      next.enabled = true;
      next.reset();
      next.setEffectiveWeight(1);
      next.play();
      if (prev && prev !== next) prev.crossFadeTo(next, HOSTS.fade, false);
    }
    this.state = name;
    this.stateSince = this.seconds;
    this.transitions += 1;
    this.playCount[name] = (this.playCount[name] || 0) + 1;
  }

  /** 交给测试钩子读的一份快照：状态、正在播的剪辑、权重、进入次数。 */
  report() {
    return {
      state: this.state,
      clip: this.activeClip(),
      seconds: this.seconds,
      transitions: this.transitions,
      playCount: { ...this.playCount },
      strikeT: this.strikeT,
      startleT: this.startleT,
      flinchCd: this.flinchCd,
      distance: Number.isFinite(this.distance) ? this.distance : null,
      weights: Object.fromEntries(
        HOST_STATES.filter((s) => this.actions[s])
          .map((s) => [s, Number(this.actions[s].getEffectiveWeight().toFixed(4))])),
      // 交叉淡变期间会有两条动作同时有非零权重，所以"只有一条在跑"不能用权重
      // 去数 —— 但 `isRunning()` 说的是另一件事：**这条动作正在被求值**。
      running: HOST_STATES.filter((s) => this.actions[s] && this.actions[s].isRunning()),
    };
  }
}
