# PROPS.md — 可互动道具（开门 / 推柜）

> 状态：**v1 已落地**，**v1.1（2026-09-26）修正了"整件家具消失"**。`E` 键互动；
> **只改渲染，不改物理**。
> 代码：`js/build.js`（拆分主角道具）、`game/play/props.js`（互动引擎）、
> `game/play/play.js`（接线 + `E` 键 + 准星提示）、`css/play.css`（提示样式）。

---

## 1. 一句话

> 合并掉的家具只剩一坨几何体，**没有东西可以开**；所以"互动"不是"给网格做动画"，
> 而是**在建造时挑出一小批值得各占一个 draw call 的主角道具**。

---

## 2. 为什么需要这一层：合并的代价

`js/build.js` 把一间屋的家具按材质合并成几个网格（`mergePlaced`）。这是全场只有
几十个 draw call 的原因，代价是：**单独一个柜子不再是场景对象**——没有东西可以
转、可以推、可以高亮。

于是引入 `HERO_MODELS`：一份**模型名白名单**。名单内的模型在 `buildRoom()` 里
**不参与合并**，各自成为一个独立 `THREE.Group`，挂在 `apartment.props` 下，
并在 `userData.prop` 上带一份元数据（模型名、房间、`kind`、初始变换）。

**名单之外的一切，合并方式一字未改**——所以这个功能对 draw call 预算的影响，
就是"名单里有多少个道具"这一个数（当前出厂户型 **38 个**）。

名单（节选，完整见 `js/build.js`）：门（`doorway*`）、柜（`cabinet*`、
`bookcase*`、`bathroomCabinet*`、`kitchenCabinet*`）、抽屉（`*Drawer`）、
箱（`cardboardBox*`）、电器（`fridge*`、`washer`、`dryer`、`hood*`），
以及出厂户型里真实存在的 `sideTable*` / `trashcan` / `coatRackStanding`。

---

## 3. 三种动作，由模型名推导

`propKindOf(model)` 把模型名映射成一种动作——**不做 per-instance 标记**，
因为 `room.items` 是布局数据、没有位置放动画提示，而模型名已经足够具体
（`cabinetBedDrawer` vs `cabinetBed` 一眼可分）。

| kind | 触发名 | 动作 |
|---|---|---|
| `swing` | 门、柜门 | 门扇绕**合页**转 84°（让出通道） |
| `slide` | `*drawer` | 抽屉沿**柜子正面（局部 +Z）**滑出，行程按柜深自适应 |
| `lid` | `*box` | 盖子绕**后棱**掀 56° |
| `none` | `hood*` | 不做开合，改为**推动**（见 §5） |

### 3.1 动的是**子网格**，永远不是整件家具（v1.1 的核心修正）

**v1 的 bug：按 `E` 之后整件家具消失了。**

根因不在互动逻辑，而在 `Kit.load()` 的几何归一化约定：

```js
// js/kit.js —— 每个模型都被按包围盒质心居中、底座压到 y=0
root.position.set(-c.x, -box.min.y, -c.z);
```

于是每个 hero group 的**原点 ≈ 包围盒中心**，而不是门的合页、抽屉的正面。
对 group 做 `rotation.y += 84°`，等于让整扇门**绕它自己的中点**打转——
转完门横穿墙体飞到房间外，玩家的观感就是"物体不见了"；再按一次 `E`
也回不来，因为它只是转到了另一个离谱的角度。

**修法：整件家具只吃"推动"位移，永不旋转；开合全部交给子网格。**

好消息是 Kenney 素材的可动部件**本来就自带正确的铰链原点**——实测
（`scripts/probe_parts.py` → `data/prop_parts.json`）部件 mesh / Group 的
局部原点就压在铰链线上，所以直接转它即可，不需要自己算枢轴：

| 模型 | 可动部件 | 铰链位置 | 动作轴 |
|---|---|---|---|
| `doorway` / `doorwayFront` | `Mesh door` | `min.x = 0`（左铰） | `rotation.y` |
| `bookcaseClosedDoors` | `Group doorLeft` / `doorRight` | `min.x = 0` / `max.x = 0` | `rotation.y` |
| `kitchenCabinetUpperDouble` | `doorLeft` / `doorRight` | 同上 | `rotation.y` |
| `cabinetTelevisionDoors` | `doorLeft` / `doorRight` | 同上 | `rotation.y` |
| `kitchenCabinet` | `Mesh door` | `min.x = 0` | `rotation.y` |
| `*Drawer` | `Mesh drawer` / `drawerTop` | 沿局部 **+Z** 拉出 | `position.z` |
| `washer` / `dryer` | `washerDoor` / `dryerDoor` | 圆门，水平轴 | `rotation.x` |
| `hookModern` / `bookcaseClosed` / `cardboardBox*` | **单 mesh，无子部件** | —— | 降级为整件轻推 |

三条实测踩出来的教训（都已钉进代码）：

1. **`partRole` 必须先归一化 `_N` 分片后缀。** 一扇门在 glTF 里常是多块材质
   分片（`Mesh_doorLeft` + `Mesh_doorLeft_1`）。不归一化就会"只转一半、
   门裂成两半"。
2. **`_collectMovers` 要遍历所有节点，并优先收 Group 而不是 Mesh。**
   `bookcaseClosedDoors` 的树是
   `Mesh body → Group doorLeft → [Mesh_doorLeft, Mesh_doorLeft_1]`；
   转一次 `Group doorLeft` 带动两片，比注册两个 mesh 干净。
3. **`isBody()` 排除家具本体。** `Mesh_sideTableDrawers` 会误配 `/drawer/i`，
   结果把整个柜体当抽屉滑出去 0.44 m（= 两倍柜深）。名字归一化后**等于模型名**
   的 mesh 一律视作本体，不参与开合。

抽屉行程不再写死 0.20 m，而是用实测柜深夹住：

```js
// 行程 = min(2.2 × slideM, 柜深 × 0.55)
const span = Math.min(this.slideM * 2.2, (p.depth || this.slideM * 2.2) * 0.55);
```

`p.depth` 在构造时用**世界 AABB 按 `yaw` 投影回局部**、再除掉
`h.scale.x` 得到（见 `props.js` 构造函数）。实测 `sideTableDrawers` 0.122 m、
`kitchenCabinetDrawer` 0.248 m——各自贴合自己的柜体。

---

## 4. 选中的是"你在看的那个"：射线，不是最近距离

贴着墙的柜子，用"最近距离"会选中它，哪怕你的准星对着窗外。所以用**从眼睛发出的
射线**（`THREE.Raycaster`，`far = reach = 1.25 m`）——"你在看的东西"才是玩家预期，
也才和准星截图里那行提示一致。命中后向上找到带 `userData.prop` 的 hero group。

**提示与动作读的是同一个变量。** HUD 那行 `E 打开/关上/拉开/推回` 的动词，来自
`props.focus` 的 `kind` 与 `open`——和 `E` 键实际执行的那一次 `activate()` 是同一份
数据。**一个说"打开"、按下去却是"关上"的提示，就是这套工程一直在拒绝发布的那种小谎。**

---

## 5. 不可越过的线：只改渲染，不改物理

**`props.js` 不碰碰撞，也不碰视线。**

`game/VERDICT.md` 里每一个胜率，都是在"家具挡住移动（`nav.clear` 读
`level.solids`）、挡住视线（`blocksSight` 读 `level.solids`）"这套固定事实下测出来的。
一旦开门改变了某件家具的占格或遮挡，**那些数字全部作废**——而重测要跑整套 24 种子
的矩阵。

所以 v1 的取舍是：**开关只改 transform，`level.solids` 一动不动。**
门看起来开了（叶片转到一边），但它"挡不挡路/挡不挡视线"仍按原值算。

**这是刻意的取舍，不是能力不足。** 玩家得到可读的反馈与一点恶作剧的乐趣，
代价是**不动一个胜率**。这条不变量被 `verify_play.mjs` 直接钉住：

```
props: opening changes NOTHING in the core (nav + prizes identical)
```

它对比开门前后的 `nav.walkable / w / d` 与每一个红包的 `x/z/y`，要求**逐位相同**。

### 5.1 如果哪天真要让门改变通行

正确做法（留给下一版，此处记账）：

1. 把门状态**提升进 `level.solids`**——那里 `kind: 'door'` 已经带着 `blocksMove` /
   `blocksSight`，改的是这两个布尔，不是新建一套模型。
2. 重建 `nav`（`rebuildCore()` 已经能重跑；注意 `good→bad` 的泛洪顺序陷阱，
   见 `nav.js`）。
3. **重跑 `scripts/measure_surveil.mjs` 与 `scripts/verify_play.mjs`**，
   按新事实更新 `game/VERDICT.md`。
4. 上面那条"opening changes NOTHING"的断言必须改成"opening changes EXACTLY what
   重测所声称的量"。

在那之前，线条是硬的。

---

## 6. 生命周期

- **构建**：`buildApartment()` 返回 `heroes`（扁平数组）与 `apartment.props` 组。
- **每局复位**：`resetRun()` 调 `props.reset()`——上一局开着的柜子不能残留到这一局。
  道具只建一次、跨局复用（重建要重载整个 kit），所以复位是"一页多局"诚实的保证。
- **每帧**：`propsTick(dt)` 推进动画；**只在 `playing` 时**才发射线并报提示。
  暂停时动画照样推进，否则门会停在半开位置。
- **纯渲染**：`propsTick` 不调用 `stepSim` 的任何东西，`stepSim` 也从不读 `props`。

---

## 7. 验收

`scripts/verify_play.mjs` 的 props 段分两批：

### 7.1 基础行为（v1）

| 断言 | 说明 |
|---|---|
| `props: the flat ships interactive props` | `heroes` 非空（当前 38） |
| `props: aiming at a prop finds it` | 射线命中，且命中的就是瞄的那个 |
| `props: E opens the prop it is aimed at` | `interact()` 把它打开（`open > 0.5`） |
| `props: opening changes NOTHING in the core` | **开门前后 nav 与红包逐位相同** |

第 4 条是这套设计的心脏。

### 7.2 动对了部件（v1.1，量的是真实位移）

这 6 条是"消失 bug 不会再回来"的护栏。量测方式：对**全部 38 个** hero 道具
开/关各一次，用 `api.animProps(dt)` **只推进道具动画**（冻结 sim 与守卫），
再比较变换矩阵。

| 断言 | 量到的量 | 当前值 |
|---|---|---|
| `props: the movers are found on the real models (leaf/draw/lid)` | 分类计数 | leaf 7 / draw 9 / lid 0 / 整件轻推 22 |
| `props: opening NEVER rotates the whole prop` | 整件家具的旋转角 | **0.0e+0** |
| `props: opening the door does not move its FRAME` | 门框位移 | **0.0e+0** |
| `props: the door leaf turns about its hinge, it does not fly off` | 门扇位移 | 0.252 m（≤ 门宽 0.43） |
| `props: the drawer slides along the cabinet's own front (+Z)` | 行程方向与 +Z 的点积 | **1.0000** |
| `props: reset() restores every sub-mesh exactly` | 复位后的残差 | **0.0e+0** |

> **量测陷阱**：`Box3.setFromObject(柜体Mesh)` 会把它的**子节点**
> （`doorLeft` / `doorRight`）也算进去，门一转柜体包围盒就变——这是**测量假象**，
> 不是真位移。5c 用 `kinOfMover(o)`（mover 是自己 / 祖先 / 后代都算）把这些
> 排除掉，才得到"门框真的没动"这个诚实结论。

### 7.3 照片证据，以及它自己的坑（`scripts/probe/shoot_props.mjs`）

数值断言证明"几何动了"；玩家报的是"我看它消失了"，所以要有一张**看得见**的照片。
脚本对每个道具拍一对 `-a-shut` / `-b-open`，并**字节比对两张图**：一模一样就说明
机位根本没拍到动作。

这个自检在开发中连抓到三次**机位错误**，每次都长着一副"证据"的样子：

1. **站太近、正对**（0.7 m）：门扇转到两边正好转出画面 → 一对几乎相同的图。
2. **按"离包围盒中心 1.6 m"站位**：柜子的包围盒中心在**家具内部**，人站进了柜子里。
3. **一个斜角**：躲到了墙柱后面，拍的是空走廊。

于是最终规则是：**从道具"正面 + 自身深度的一半 + 余量"退开，且要求从眼睛到道具中心的
射线第一命中就是这件道具**（和游戏自己的瞄准同一个判据），并拒绝落在道具 XZ 足迹内的点。

> ⚠️ **有一件拍照拍不出来**：`bathroomCabinetDrawer` 的抽屉沿 **+Z 滑出**，
> 而唯一合法的站位恰好让它**朝着镜头滑**——投影几乎不变，两张图字节相同。
> 这不是"没修好"，是**这个角度看不出来**。脚本会如实打印
> `1 prop(s) could not be framed moving from a legal stand` 并提醒
> "motion is still proven numerically by verify_play 5c"。
> **不要因为照片里看不出来就以为它在动 / 不动，也不要拿 `-b` 当证据。**
> 当前照片实况：**3 / 4 可见地动起来**（衣柜门、边桌抽屉、厨房抽屉）。

跑法见 `scripts/README.md`，或直接：

```bash
node scripts/verify_play.mjs              # 数值：83/83
node scripts/probe/shoot_props.mjs        # 照片：3/4 可见
```

---

## 8. 已知限制 / 下一版可做

- **推动只改渲染**：被推开的柜子物理上仍占原格，所以玩家不能靠它穿墙。
- **无子部件的道具只能整件轻推**：`cardboardBox*` / `bookcaseClosed` /
  `hookModern` 在素材里是**单个 mesh**，没有独立的盖 / 门可以转。当前降级为
  整件轻推；要"掀盖"就得手工加一个枢轴节点（下一版可做）。
- **门的开合方向是全局的**：84° 对左开 / 右开门一视同仁。视觉上够用，
  但不是每扇门都"朝外开"。
- **不落物**：开抽屉/开箱子**不掉红包**——红包由核心的 `placePrizes` 决定，
  与道具状态无关。要做"藏在柜子里的红包"，需要把道具状态喂进 `place.js`，
  并且**会动胜率**（更多藏点 = 更难找），必须重测。
- **没有"关上"的碰撞后果**：一扇关着的门从一开始就按 `level.openings` 算死活，
  运行时开关不改它。
- **提示只在中屏**：没有世界坐标的悬浮标签。够用，但不算精致。
