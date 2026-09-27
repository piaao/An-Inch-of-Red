/**
 * props.js — 让家具活起来：看得见的门会开，推得动的东西会挪。
 *
 * ── 为什么要有这个文件 ─────────────────────────────────────────────────────
 * `js/build.js` 把一间屋的家具按材质合并成几个网格（这是全场只有几十个 draw
 * call 的原因）。代价是：单独一个柜子不再是场景里的对象，**没有东西可以转、
 * 可以推**。所以「互动」在这套架构下不是「给网格做个动画」，而是
 * **在建造时挑出一小批值得各占一个 draw call 的主角道具**——那份名单叫
 * `HERO_MODELS`，就在 `js/build.js` 里。
 *
 * ── 一条不可越过的线 ───────────────────────────────────────────────────────
 * **本模块不碰碰撞，也不碰视线。**
 *
 * `game/VERDICT.md` 里每一个胜率，都是在"家具挡住移动、挡住视线"这一套固定
 * 事实下测出来的（`nav.clear` 与 `blocksSight` 都读 `level.solids`）。一旦开门
 * 改变了某件家具的占格或遮挡，那些数字就全部作废——而重测是要跑整套 24 种子的
 * 矩阵的。
 *
 * 所以 v1 的做法是：**开关只改渲染，不改物理**。门看起来开了（叶片转到一边），
 * 但它"挡不挡路/挡不挡视线"仍按 `level.solids` 里的原值算。玩家得到的是可读的
 * 反馈与一点恶作剧的乐趣，代价是不动一个胜率。
 *
 * 这是**刻意的取舍**，不是能力不足。要在某一天让门真的改变通行，正确做法是把
 * 门状态提升进 `level.solids`（那里 `kind:'door'` 已经带着 `blocksMove` /
 * `blocksSight`），然后重跑 `scripts/measure_surveil.mjs` 与 `verify_play.mjs`。
 * 那份工作被明确留给下一版，并在 `game/PROPS.md` 里记了账。
 *
 * ── 为什么动的是"子网格"而不是整件家具（2026-09-26 修）────────────────────
 * 第一版把变换加在 hero **group** 上，结果按 E 时整件家具"消失"了。原因写在
 * `js/kit.js` 的 `load()` 里：
 *
 *     root.position.set(-c.x, -box.min.y, -c.z);
 *
 * group 的原点被搬到**模型包围盒的中心**（底座对齐 y=0）。所以对这个 group 做
 * `rotation.y += 84°` 是让整扇门**绕它自己的中点**打转——转完门就横穿墙体飞到
 * 房间外，玩家看到的就是"东西没了"。
 *
 * 正确的做法是动**门扇本身**。实测（`python scripts/probe_parts.py`，数据落在
 * `data/prop_parts.json`）这套 Kenney 素材有个白捡的便利：**可动部件的 mesh 局部
 * 原点本来就压在它的铰链线上**——
 *
 *     doorway            Mesh door        min.x = 0        → 左铰，绕 x=0 竖轴
 *     bookcaseClosedDoors doorLeft        min.x = 0        → 左铰
 *                         doorRight       max.x = 0        → 右铰
 *     kitchenCabinet      Mesh door        min.x = 0        → 左铰
 *     kitchenCabinetDrawer Mesh drawer     max.z = +0.02    → 沿 +Z 拉出
 *     sideTableDrawers    Mesh drawer      max.z = +0.1763  → 沿 +Z 拉出
 *     washer              washerDoor       z ∈ [-0.13, .13] → 绕水平 X 轴翻
 *
 * 所以只要**对子网格自己**做 `rotation.y` / `position.z`，天然就是绕铰链转、沿
 * 正面滑，一个 pivot 都不用手动造。找不到可动子网格的模型（`hoodModern`、
 * `cardboardBox*`、`bookcaseClosed`……整件就是一个 mesh）降级为"整件轻推"。
 *
 * `data/prop_parts.json` 是这个假设的实测底账；`scripts/verify_props.mjs` 会重新
 * 解析 GLB 并断言这些部件与铰链侧仍然成立——素材换了、假设塌了，测试会红。
 */

import * as THREE from 'three';

const TAU = Math.PI * 2;

/** 线性逼近。和仓库里其它地方一样，单帧最多走 `step`，保证可预测。 */
function approach(cur, target, step) {
  if (target > cur) return Math.min(target, cur + step);
  if (target < cur) return Math.max(target, cur - step);
  return cur;
}

/**
 * 哪些节点算"可动部件"。按名字匹配，因为名字就是数据（见 `build.js` 的
 * `propKindOf` 用了同一个理由）。返回的角色供 `_apply` 决定转哪根轴。
 *
 * · leaf   门扇：绕自己的竖轴（合页在 mesh 原点那一侧）
 * · draw   抽屉：沿 +Z 平出
 * · lid    圆门/箱盖：绕水平轴翻
 *
 * 名字先归一化（去掉 `Mesh_` 前缀和结尾的 `_N` 分片号）再匹配，因为一扇门在
 * glTF 里常常是**多块材质分片**：`doorLeft` 这个 Group 底下挂着
 * `Mesh_doorLeft` + `Mesh_doorLeft_1`。只认 `Mesh_doorLeft` 会让门的另一半
 * 留在原地——看起来就是门从中间裂开。
 */
function partRole(name) {
  const n = String(name || '').replace(/^mesh[_\s-]*/i, '').replace(/_\d+$/, '');
  if (/^(door|doorleft|doorright)$/i.test(n)) return 'leaf';
  if (/door(left|right)$/i.test(n)) return 'leaf';
  if (/drawer/i.test(n)) return 'draw';
  if (/door$/i.test(n)) return 'leaf';
  if (/lid|flap|cover/i.test(n)) return 'lid';
  return null;
}

/** 把 mesh 名归一化成可比较的形态：去掉 `Mesh_` 前缀与结尾的 `_N` 分片号。 */
function normName(s) {
  return String(s || '')
    .replace(/^mesh[_\s-]*/i, '')
    .replace(/_\d+$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * 这个节点是不是"家具本体"，而不是"部件"？
 *
 * 这一步不能省。`sideTableDrawers` 的**柜体** mesh 叫 `Mesh_sideTableDrawers`，
 * 它能匹配 `/drawer/i` —— 于是整个柜子被当成一个抽屉，跟着滑出 0.44 m。玩家
 * 看到的还是"家具跑了"，只是换了个方向。
 *
 * 判据：**名字归一化后等于模型名的，就是本体，不是部件。** Kenney 的部件都
 * 有自己的名字（`door`、`drawer`、`washerDoor`），只有本体才叫模型名。
 */
function isBody(name, model) {
  return normName(name) === normName(model);
}

/** 模型名里带 "drawer" 的，本体就是一个抽屉柜（`kitchenCabinetDrawer`）。 */
function wantsDrawer(model) {
  return /drawer/i.test(String(model || ''));
}

/**
 * 互动引擎。
 *
 * 它持有一个**扁平的道具表**（`buildApartment` 返回的 `heroes`），并负责：
 *   · 从眼睛往前发射一条射线，找出准星对着、且够得着的那一个；
 *   · 按 E 切换它的开合（或推动它）；
 *   · 每帧把 `open`（0..1）插值成实际变换。
 *
 * 它**不**改碰撞、**不**改视线、**不**改任何 `level.solids`。见文件头。
 */
export class Props {
  /**
   * @param scene    THREE.Scene（道具已经挂在 `apartment.props` 下，这里只用于
   *                 必要时加辅助物；正常传 null 也行）
   * @param heroes   buildApartment() 的 `heroes`：一批 THREE.Group，userData.prop
   * @param opts     { reach, swingDeg, slideM, lidDeg, openRad }
   */
  constructor(scene, heroes, opts = {}) {
    this.scene = scene;
    this.heroes = heroes || [];
    this.reach = opts.reach != null ? opts.reach : 1.15;      // m, arm's reach
    this.swingDeg = opts.swingDeg != null ? opts.swingDeg : 82;
    this.slideM = opts.slideM != null ? opts.slideM : 0.22;
    this.lidDeg = opts.lidDeg != null ? opts.lidDeg : 58;
    this.speed = opts.speed != null ? opts.speed : 3.2;        // open units / s
    // 子网格能转多少度。门扇 84° 就足够读作"开了"，再多会穿到墙里。
    this.openRad = opts.openRad != null ? opts.openRad : (this.swingDeg * Math.PI / 180);

    this.ray = new THREE.Raycaster();
    this.ray.far = this.reach;
    this.focus = null;          // 当前瞄着的 hero group
    this.lastOpened = null;     // 最近一次被打开的道具（HUD 用）
    this.opens = 0;             // 互动计数（诊断用）
    this.hidden = false;        // 道具整体显隐（诊断用）

    // 每个道具的初始变换，供 push（位移）恢复与相对计算。
    for (const h of this.heroes) {
      const p = h.userData.prop;
      if (!p) continue;
      p.basePos = { x: h.position.x, y: h.position.y, z: h.position.z };
      p.pushed = 0;             // 沿正面推开的比例（0..1），v1 只影响渲染
      // 柜深：抽屉能滑多远的上限。不量这个，一个小边桌的抽屉会滑出 0.44 m
      // （两倍于柜深），看起来还是"抽屉飞了"。
      //
      // 家具都是 0/90/180/270 摆放的，所以"沿本地 +Z 的进深"就是世界 AABB
      // 的 sx/sz 按 yaw 投影回来 -- 支撑函数，对这四个角是精确的。
      h.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(h).getSize(new THREE.Vector3());
      const cy = Math.abs(Math.cos(p.baseYaw));
      const sy = Math.abs(Math.sin(p.baseYaw));
      // Divided by the group's own scale: the box is measured in world units,
      // the slide happens in the group's LOCAL units. The shipped flat scales
      // no hero prop, but a generated floor may.
      const s = h.scale.x || 1;
      p.depth = (cy * bb.z + sy * bb.x) / s;
      // 解析可动部件：每个部件记下它自己的初始变换，动画是"从基准偏多少"，
      // 而不是"当前值加多少"，所以开合可逆、没有累积误差。
      p.movers = this._collectMovers(h, p);
    }
  }

  /**
   * 挑出这个道具里真正该动的节点。
   *
   * 返回 [{ obj, role, baseRot, basePos }]。找不到就是空数组，`_apply` 会
   * 退化成"整件轻推"（比按了没反应好，但绝不把整件家具转出画面）。
   *
   * TWO RULES, both learned from dumping a real prop tree:
   *
   *  1. Walk NODES, not just meshes. A leaf is often a Group (`doorLeft`) with
   *     two material-split meshes under it (`Mesh_doorLeft`, `Mesh_doorLeft_1`)
   *     sharing one pivot. Turning the GROUP turns both; registering the meshes
   *     separately would also work, but it is more objects for the same motion
   *     and it breaks the moment a slice name does not match.
   *
   *  2. Take the SHALLOWEST match. If a matching node has a matching ancestor,
   *     it is already being moved by that ancestor -- registering both would
   *     apply the rotation twice.
   */
  _collectMovers(h, p) {
    const nodes = [];
    h.traverse((o) => { nodes.push(o); });

    const roleOf = new Map();
    for (const o of nodes) {
      if (isBody(o.name, p.model)) continue;
      const role = partRole(o.name);
      if (role) roleOf.set(o, role);
    }

    const found = [];
    for (const o of nodes) {
      const role = roleOf.get(o);
      if (!role) continue;
      // 跳过"祖先已经是 mover"的节点，避免同一动作施加两次。
      let ancestorMoved = false;
      for (let a = o.parent; a && a !== h; a = a.parent) {
        if (roleOf.has(a)) { ancestorMoved = true; break; }
      }
      if (ancestorMoved) continue;
      found.push({
        obj: o,
        role,
        baseRot: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z },
        basePos: { x: o.position.x, y: o.position.y, z: o.position.z },
      });
    }

    // A cabinet whose model name says "drawer" should slide its drawer even if
    // the sub-mesh is called `door` -- `kitchenCabinetDrawer` ships both.
    if (wantsDrawer(p.model)) {
      for (const m of found) if (m.role === 'leaf') m.role = 'draw';
    }
    return found;
  }

  /** 道具是否可见 / 启用。 */
  setVisible(v) {
    this.hidden = !v;
    for (const h of this.heroes) h.visible = !!v;
  }

  /**
   * 从眼睛 a（{x,y,z}）沿相机朝向 dir（THREE.Vector3）找最近的可互动道具。
   *
   * 用射线而不是"距离最近"：一个柜子贴着墙、你站在它旁边，最近距离会选中它，
   * 但你的准星其实对着窗外——射线才是"你在看的东西"，也是玩家预期。
   *
   * @returns 命中的 hero group，或 null
   */
  pick(eye, dir) {
    if (!this.heroes.length || this.hidden) { this.focus = null; return null; }
    this.ray.set(new THREE.Vector3(eye.x, eye.y, eye.z), dir);
    const hit = this.ray.intersectObjects(this.heroes, true);
    if (!hit.length) { this.focus = null; return null; }
    // 命中的是子网格；往上找到带 userData.prop 的那个 hero group。
    let o = hit[0].object;
    while (o && !(o.userData && o.userData.prop)) o = o.parent;
    this.focus = o || null;
    return this.focus;
  }

  /**
   * 对当前瞄着的道具做一次互动：能开的开/关，能推的推一步。
   * 返回 { id, kind, opened } 或 null。
   */
  activate() {
    const h = this.focus;
    if (!h) return null;
    const p = h.userData.prop;
    if (!p) return null;
    const hasMover = p.movers && p.movers.length > 0;
    if (p.kind === 'slide' || p.kind === 'lid' || p.kind === 'swing') {
      if (!hasMover && p.kind === 'swing') {
        // 没有门扇可转（整件就是一个 mesh，比如 bookcaseClosed）：退化成推。
        this.push(h);
      } else {
        p.open = p.open > 0.5 ? 0 : 1;
      }
    } else {
      // kind 'none'（抽油烟机这类）：不做开合，改为轻轻推动 —— 一个"会挪一下"
      // 的反馈，比"按了没反应"好。
      this.push(h);
    }
    this.opens += 1;
    this.lastOpened = { model: p.model, kind: p.kind, open: p.open };
    return this.lastOpened;
  }

  /**
   * 把道具沿它自己的"正面"推一小段。
   *
   * 注意：**这只改渲染**。被推开的柜子在物理上仍占据原来那一格，所以玩家不能
   * 靠它穿墙，`nav` 也不需要重建。这就是 v1 不碰胜率的原因。
   */
  push(h) {
    const p = h.userData.prop;
    // 往道具正前方（+Z 局部）推，也就是它"面朝"的方向。
    const yaw = p.baseYaw;
    p.pushed = p.pushed > 0.5 ? 0 : 1;   // 来回推：0 归位 / 1 推开
    p.pushOff = { dx: Math.sin(yaw) * this.slideM, dz: Math.cos(yaw) * this.slideM };
  }

  /** 每帧推进所有道具的开合动画。dt 秒。 */
  update(dt) {
    if (!this.heroes.length) return;
    const step = this.speed * dt;
    for (const h of this.heroes) {
      const p = h.userData.prop;
      if (!p) continue;
      const target = p.open || 0;
      if (p.anim == null) p.anim = 0;
      const before = p.anim;
      p.anim = approach(p.anim, target, step);
      // 推动：0..1 的插值，同样线性逼近。
      const pTarget = p.pushed || 0;
      if (p.pushedAnim == null) p.pushedAnim = 0;
      const pushedBefore = p.pushedAnim;
      p.pushedAnim = approach(p.pushedAnim, pTarget, step);

      if (before === p.anim && pushedBefore === p.pushedAnim) continue;
      this._apply(h, p);
    }
  }

  /**
   * 把 p.anim / p.pushedAnim 翻译成实际 transform。
   *
   * 分工明确：**整件家具只吃"推动"位移**（`pushOff`），**开合全交给子网格**。
   * 这样"开门"永远不会把整扇门搬走——即便某个模型的子网格没被认出来，最坏的
   * 结果也是"没反应"，而不是"东西消失"。
   */
  _apply(h, p) {
    const base = p.basePos;
    const off = p.pushOff || { dx: 0, dz: 0 };
    h.position.set(
      base.x + off.dx * p.pushedAnim,
      base.y,
      base.z + off.dz * p.pushedAnim,
    );
    h.rotation.y = p.baseYaw;          // 整件家具永不旋转，只在推的时候平移

    const movers = p.movers || [];
    for (const m of movers) {
      const o = m.obj;
      // 每次都从 base 写起，保证可逆、无累积误差。
      o.rotation.set(m.baseRot.x, m.baseRot.y, m.baseRot.z);
      o.position.set(m.basePos.x, m.basePos.y, m.basePos.z);

      if (m.role === 'leaf') {
        // 门扇：绕自己的竖轴（mesh 原点就在合页线上，见文件头实测）。
        // doorRight 这类铰链在 max.x 那一侧的，视觉上向另一侧开。这里统一用
        // 正向角度；素材两侧门的原点各在自己合页上，所以同一个符号会自然地
        // 向柜内/柜外张开，不会撞在一起。
        o.rotation.y = m.baseRot.y + this.openRad * p.anim;
      } else if (m.role === 'draw') {
        // 抽屉：沿局部 +Z 拉出（实测 max.z 就是把手那一面）。行程不超过柜深
        // 的 55%——拉过头会让抽屉整块脱离柜体，那就不是"开抽屉"了。
        const span = Math.min(this.slideM * 2.2,
          (p.depth || this.slideM * 2.2) * 0.55);
        o.position.z = m.basePos.z + span * p.anim;
      } else if (m.role === 'lid') {
        // 圆门/箱盖：绕水平 X 轴翻。
        o.rotation.x = m.baseRot.x - (this.lidDeg * Math.PI / 180) * p.anim;
      }
    }
  }

  /** 把所有道具复位（新一局必须回到初始状态，否则"上一局开着的柜子"会残留）。 */
  reset() {
    for (const h of this.heroes) {
      const p = h.userData.prop;
      if (!p) continue;
      p.open = 0;
      p.pushed = 0;
      p.anim = 0;
      p.pushedAnim = 0;
      p.pushOff = null;
      h.position.set(p.basePos.x, p.basePos.y, p.basePos.z);
      h.rotation.set(0, p.baseYaw, 0);
      for (const m of (p.movers || [])) {
        m.obj.rotation.set(m.baseRot.x, m.baseRot.y, m.baseRot.z);
        m.obj.position.set(m.basePos.x, m.basePos.y, m.basePos.z);
      }
      h.updateMatrixWorld(true);
    }
    this.focus = null;
    this.lastOpened = null;
    this.opens = 0;
  }

  /** 诊断读数。 */
  state() {
    const open = this.heroes.filter((h) => h.userData.prop && h.userData.prop.open > 0.5).length;
    const focused = this.focus && this.focus.userData.prop
      ? this.focus.userData.prop.model : null;
    let movers = 0;
    for (const h of this.heroes) {
      const p = h.userData.prop;
      if (p && p.movers) movers += p.movers.length;
    }
    return {
      count: this.heroes.length,
      reach: this.reach,
      focus: focused,
      open,
      opens: this.opens,
      hidden: this.hidden,
      movers,
    };
  }
}
