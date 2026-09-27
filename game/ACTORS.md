# ACTORS.md — 男女主人（骨骼动画 + 四态状态机）

> 这一局的设定是**闯空门**：你是一只 42 cm 的小东西，溜进别人家里偷红包。
> 屋里原来站着的是一对**程序化小机器人**（圆柱 + 球罩 + 一颗灯眼）；这一版把
> 它们换成一对**有骨架的主人** —— 男主人与女主人，各自一台状态机，
> **待机 / 行动 / 奔跑 / 打击**（外加一个受惊的过渡态），而玩法一个字没改。

---

## 0. 结论先行

| 问题 | 答案 | 可数证据 |
|---|---|---|
| 换了吗 | 换成了两副**真骨架**（各 41 骨） | `hosts.source === 'files'`，两个 actor 的 `body === 'skeletal'` |
| 素材多重 | 7,275,816 B → 878,992 B（**12.1 %**） | `data/actors.json` 的 `sourceBytes` / `bytes` |
| 有几个状态 | 5（四态 + 受惊），优先级 `strike > startle > run > idle/walk` | `actors.js` 的 `HostBody.read()` |
| 真的在动吗 | 40 帧里 20/41 根骨头转过 > 1°；最大 147.72° | `verify_actors.mjs` §3 |
| 会不会偷偷改玩法 | **不会**：同一个种子，`step()` 与 `tick()` 600 步后逐位相同 | `verify_actors.mjs` §4 |
| 验收 | **59/59 PASS** | `work/verify_actors.log` |

一句话：**它只是换了一身皮和一套动作，一分钱玩法都没动。**

---

## 1. 为什么把机器人换掉

三个理由，从叙事到工程：

1. **叙事**。机器看不出你是在"躲"，只看得出你在躲"某个转着的东西"。屋里有人，
   而且是**这屋的主人**，被抓这件事才有分量 —— 被抓的罚时不是"被系统扣了 15 秒"，
   是"主人发现你了"。
2. **可读性**。`game/core/guard.js` 的设计原则写着：守卫必须**可读**，否则被抓
   像是随机的。一个会用身体语言表达状态的东西（停下来扫视、撒腿就追、抬手就打）
   比一颗变色的灯眼好读得多。
3. **它是一次干净的替换**。`scene.js` 的 `GuardActor` 从第一天起就把"身体"和
   "视锥 / 地灯 / 感叹号"分开：身体换成骨骼网格，扇区、光斑、告警符号**一个都不动** ——
   因为 `game/VERDICT.md` 里每一个胜率都是在「走多快、看多远、罚多少」这套事实上测的。

### 三段降级链（与配乐 `music.js` 同一套规矩）

```
① data/actors.json 在 + GLB 在 + 五条剪辑齐  ⇒ source:'files'       真人出场
② 否则（manifest 缺 / 解析失败 / 缺剪辑 / 加载报错）⇒ source:'none'   退回程序化机器人
③ 再否则：连机器人都没有，只剩视锥与地灯（游戏照常跑）
```

**零 404**：只请求 `data/actors.json` 点名的那两个文件。manifest 不在，一个 GLB
请求都不会发出去 —— 和 `music.js` 只认 `audio/manifest.json` 是同一条规矩。

---

## 2. 素材：挑了 KayKit，以及为什么不是 Bodiez / Mixamo

需求是"**有骨骼、有动画、许可干净、能直链下载**"，四条同时满足才算过关：

| 候选 | 有什么 | 为什么没用 |
|---|---|---|
| **Bodiez 系** | 干净的 Blender 骨架基础网格 | **没有动画**。骨骼动画的全部难点在剪辑，而不是在骨架 —— 给了骨架等于把活全留下 |
| **Mixamo** | 成套的人形动画 | **需要登录**，没有可直链下载的 URL。构建链必须能无人值守重跑 |
| **KayKit Character Pack: Adventurers 1.0** | 骑士 / 盗贼等 7 个角色，**同一套 41 骨骨架**，每人 76 条剪辑 | ✅ 全中 |

KayKit 最后一条还有额外好处：**低多边形 + 平面着色**，和屋里的 Kenney 家具
（`assets/models/`）是同一个视觉路数。换一套写实人物进来，画面会立刻分成两层。

- 作者：**Kay Lousberg**（<https://kaylousberg.com>）
- 授权：**CC0 1.0（公有领域）**，原文随素材存放：
  [`assets/actors/LICENSE-kaykit.txt`](../assets/actors/LICENSE-kaykit.txt)
- 本项目收编：`assets/actors/host_male.glb`（骑士 → 男主人）、
  `assets/actors/host_female.glb`（盗贼 → 女主人）

> 出处与授权全文另见 [`CREDITS.md`](../CREDITS.md)。

### 为什么两个人能共用同一批动画

两个人的**骨数、骨名、剪辑名完全一致**（41 / 41，五条剪辑同名），所以"换一身衣服"
不需要重配任何一条动画 —— `verify_actors.mjs` 有一条断言专门钉这件事。
按名册发身体（`HOST_ORDER = ['male', 'female']`），名册上只剩一个时两个人共用
同一副身体：**少一个人，也比退回两个机器人更像话**。

---

## 3. 构建链：7.28 MB → 0.88 MB

源包每人 3.6 MB，76 条剪辑、还拎着剑盾弩刀。真正用得上的只有 **5 条剪辑 + 一副裸身体**。

```
python scripts/build_actors.py [--force]
  ├─ 下载源 GLB 到 work/src_actors/（不入库）
  ├─ 生成并驱动 work/build_actors_blender.py（Blender 无头）
  │    ├─ 丢掉手里的道具（挂点骨骼上的孩子）
  │    ├─ 丢掉无骨骼的杂件（源包里有个 2 m 的 Icosphere）
  │    ├─ 把 5 条剪辑按**状态名**改名，其余全删
  │    ├─ 量：身高 / 颈骨高 / 披风相对躯干的向量 / 正面轴
  │    └─ 导出 assets/actors/host_*.glb
  ├─ 用**纯标准库**读回导出文件，独立交叉核对（身高差 > 2 % 就报错退出）
  └─ 写 data/actors.json（实测底账）
```

**为什么要"用另一套实现读回来核对"**：Blender 报的身高和 glTF 文件里的身高，
中间隔着一次导出。让导出方自己证明自己，等于没证明。

| | 男主人（Knight） | 女主人（Rogue） |
|---|---|---|
| 导出 | 453,496 B / 4,712 三角面 / 8 网格 | 425,496 B / 4,347 三角面 / 7 网格 |
| 骨架 | 41 骨 / 1 skin / 1 材质 / 1 贴图 | 41 骨 / 1 skin / 1 材质 / 1 贴图 |
| 源身高 | 2.4666 m（Blender 报 2.4614 m） | 2.1870 m（Blender 报 2.1739 m） |
| 丢掉的 | 7 件手持 + 1 件杂物 | 5 件手持 + 1 件杂物 |
| 缩放 | ×0.2230 → 0.55 m | ×0.2515 → 0.55 m |

五条剪辑与时长（`data/actors.json`）：

| 状态名 | 源剪辑名 | 时长 |
|---|---|---|
| `idle` | `Idle` | 1.0417 s |
| `walk` | `Walking_A` | 1.0417 s |
| `run` | `Running_A` | 0.7917 s |
| `strike` | `Unarmed_Melee_Attack_Punch_A` | 1.4583 s |
| `startle` | `Hit_A` | 0.6667 s |

### 3.1 三个坑（都是实测撞出来的）

**① 挂点骨骼不在 `o.parent` 链上。**
第一版用 `o.parent` 找 `handslot`，一件道具都没删掉 —— 剑还挂在手里。
glTF 导入 Blender 后，挂在 `handslot.r` 上的孩子**不是** `handslot.r` 的子物体，
而是 `parent_type='BONE'`、`parent_bone='handslot.r'`、parent 直接是 armature。
判据要读 `parent_bone`，不能读 `o.parent`。

**② background 模式下删完物体，剩下的物体会暴露单位矩阵。**
`bpy.data.objects.remove()` 之后 `view_layer.update()` 修不好求值器（无头模式尤其），
于是"量身高"量到了 1.0。修法不是加一次 update，而是**先量后删**：所有量测都在删之前做完。

**③ 轴。** glTF 竖直是 +Y，Blender 竖直是 +Z。源文件进 Blender 后是 **Z 朝上**，
所以这里要同时打印两个数：

```
HEIGHT_Y 1.2904 | HEIGHT_Z 2.4614      ← 男主人
```

`HEIGHT_Y` 量的是**进深**（1.29 m），`HEIGHT_Z` 才是身高（2.46 m）。
拿错那个数，`data/actors.json` 里的缩放依据就是错的，人物会矮一半。
最终身高以**读回导出文件**的 glTF +Y 为准，Blender 那两个数只用于交叉核对。

---

## 4. 四态状态机

状态机在 `game/play/actors.js` 的 `HostBody.read(guard)`。**它只读**：

| 状态 | 判定（全部来自 core 已有的值） | 剪辑 | 循环 |
|---|---|---|---|
| `strike` | `strikeT > 0`（刚被抓到，或追击中贴进 `strikeRange = 0.62 m` 且冷却过了） | 挥拳 | 一次性 |
| `startle` | `startleT > 0`（看见你的第一帧），且 `startleCooldown = 2.5 s` 已过 | 被打一下 | 一次性 |
| `run` | `guard.mode === 'chase'` 且距离 > `strikeRange` | 奔跑 | 循环 |
| `idle` | `guard.mode === 'alert'`（停下盯着）/ `scanPhase > 0`（在路点上扫视）/ 位移静默 > 0.35 s | 待机 | 循环 |
| `walk` | 其余：在巡逻路上走 | 行走 | 循环 |

优先级自上而下。两个一次性动作 `LoopOnce + clampWhenFinished`，结束后再交叉淡出
（`fade = 0.16 s`）回到循环态 —— 否则挥到一半就被循环态抢回去，看起来像"打了个哆嗦"。

### 4.1 「打击」为什么挂在 `caught` 事件上

核心的判定只有一句（`game/core/guard.js`）：

```js
if (this.suspicion >= 1) {
  this.stats.caught += 1;
  this.events.push({ type: 'caught', penalty: cfg.penalty, ... });
  this.suspicion = 0; this.mode = 'chase';
}
```

**「抓住」不是距离判定，而是视线充能满的那一帧。** 所以把挥拳挂在这一帧上，
玩家看到的因果就是对的：**它抬手的那一下，时间被扣掉了。** 而且是同帧，不是"先扣时再挥拳"。

### 4.2 受惊冷却：一个**量出来的**必需项

核心的 `spot` 事件发的是"视线由断到通"的那一帧。问题在于主人一边走一边被家具挡，
视线会一闪一灭，`spot` 就被反复发出来。实测（把玩家吊在守卫正前 2 m，240 帧）：

| | 受惊占比 |
|---|---|
| 没有冷却 | **176 / 240 = 73 %** |
| 加了 2.5 s 冷却 | 52 / 542 = **9.6 %** |

73 % 的意思是：待机、行动、奔跑全被"受惊"顶掉，屏幕上的人在**打摆子**。
所以 `HOSTS.startleCooldown` 不是手感调料，是一条修掉可视缺陷的硬参数。
`verify_actors.mjs` 留了一条回归哨（`受惊不会刷屏（占比 < 25 %）`）。

### 4.3 朝向只有一个来源

模型局部的正面轴是 **+Z**，这不是猜的：`build_actors.py` 用**披风质心减躯干质心**
量出 `CAPE_DELTA`，z 分量为负 ⇒ 背面是 −Z ⇒ 正面 +Z（量测落在 `data/actors.json`
的 `front` 字段）。

而 `GuardActor.group` 的约定是"局部正面 = +X"（视锥、聚光灯、感叹号都照这个摆），
两者的夹角正好 90°，所以模型在组内被转 `modelYaw = +π/2`。推导：

```
组朝向  θ_g = -facing                        (scene.js: this.group.rotation.y = -guard.facing)
模型正面 = R_y(-facing) · R_y(modelYaw) · (+Z)
令它等于 (cos facing, sin facing)      ⇒  modelYaw = +π/2
```

验收里钉的是最原始的那一条：把**模型自己的**局部 +Z 推到世界，与 `guard.facing`
点乘，实测 **1.0000**；几何佐证是躯干→披风的方位点乘 **−0.9959 / −0.9591**（两个角色各一次）。

---

## 5. 不可越过的线：只改渲染，不改物理

`game/VERDICT.md` 里每一个胜率，都是在「守卫的速度 / 视锥 / 惩罚」这套固定事实上
测出来的。所以这一层**一个字段都不写回核心**：

- 状态机决定"播哪条动画"，不决定"走多快、看不看得见你"；
- `打击` 是渲染层的加注，罚时仍然只由 `suspicion` 满格触发，与这里无关；
- 动画在播时主人**照常平移**（没有 root motion），不会因为它挥拳就少走两米；
- `HOSTS` 的两个速度参数只用于算**播放倍速**，不改 `guard.cfg.speed`。

**这条线是被断言钉住的，不是被注释保证的**：

```
同一个种子 → step(1/60, 600)  → 快照 a
同一个种子 → tick(1/60, 600)  → 快照 b（tick 多推进了动画层）
a 与 b 逐位相同  ⇒  identical      （600 步走了 7.6 m，不是"两边都僵着"）
```

`__play.tick()` 与 `__play.step()` 的唯一区别就是 `tick` 会调 `propsTick` /
`musicTick` / `hostsTick`。动画只要偷偷喂回模拟，这一条立刻红。

### 5.1 如果哪天真要让挥拳影响玩法

比如"击中你时原地停顿 0.3 s"。正确做法**不是**在 `actors.js` 里改，
而是把它提升进 `game/core/guard.js`，然后：

1. 重跑 `scripts/measure_surveil.mjs`（守卫速度/停顿时长会改变胜率）；
2. 更新 `game/VERDICT.md` 里的数字；
3. 之前所有"引用旧胜率"的地方一起作废。

这是账单，不是建议。

---

## 6. 验收：`node scripts/verify_actors.mjs`（59 条）

| 组 | 判什么 |
|---|---|
| **0 素材** | 底账在、CC0 原文在、每人 41 骨、五条剪辑齐且都有时长、**手里的道具一件不剩**（只数带几何的节点）、一材质一贴图、裁剪后 < 700 KB、两条骨架可互换、**源包字节数从底账读** |
| **1 上场** | `source === 'files'`、`tight` 档两男一女、两个 actor 都是 `skeletal` 且机器人已隐藏 |
| **2 尺度 / 朝向** | 量前先 `renderOnce()`；**组被核心摆到了守卫位置上（配对距离 0）**、`rotY == -facing`、身高 == `level.body.guardHeight`、脚底 y == 0、**模型 +Z 就是朝向（点积 1.0000）**、披风在背后（< 0）、两名主人匹配到**两个不同的组**、`guardHeight/guardEye/guardRadius` 一个没动 |
| **3 状态机** | 四态各进过一次、受惊触发过、**受惊占比 < 25 %**、每个状态播的就是它自己那条剪辑、核心真的进过 `chase`、**奔跑发生在 chase 里**、打击发生在追里、**最大摆幅骨头 > 10°**、右腕世界位移 > 5 mm、转过 > 1° 的骨头 ≥ 8 根、每帧只有一条动效在求值、状态顺序像故事 |
| **4 只改渲染** | `step` vs `tick` 逐位相同 + 这 600 步确实走了路 |
| **5 像素** | 主人在第一人称里占住像素（隐藏前后 360,128 px 有差异）、两张截图落盘、控制台干净、没有真正的失败请求 |

外加 `scripts/verify_play.mjs` 的 **83/83**：整个 `game/play/` 与无头矩阵仍是同一个游戏。

---

## 7. 量测本身的五个坑

写这一套断言时踩的，都留在这儿，免得下次重踩：

1. **`GuardActor.update()` 挂在 `render()` 上。** 而 `step()` / `tick()` 都**不画**。
   量之前不 `renderOnce()`，量到的是"还没摆过去"的静态变换（`rotY = 0`、位置在原点），
   朝向断言读到的是一段噪声 —— `dot = 1` 正是退化向量被 `|| 1` 兜底之后的指纹。
2. **骨骼网格的节点原点不跟着骨头走。** 实测躯干与披风的节点世界坐标都是 `(0,0,0)`；
   要判方位必须用**包围盒质心**，或者干脆用基变换（把模型自己的 +Z 推到世界）。
3. **站在原地的玩家看不到「奔跑」。** 因为"抓住"是 `suspicion` 满，站着不动会在
   30 帧内被贴脸抓走（实测 2.0 m → 1.24 m → 0 m）。要看到奔跑，玩家必须**在跑** ——
   验收里用"每帧把玩家吊在守卫正前 0.9 m"来模拟，0.9 刚好在 `strikeRange` 之外。
   顺带一个反直觉的实测：吊在 2 m 处会被**家具挡住视线**，`suspicion` 涨到 0.74
   就掉回去，永远进不了 chase。
4. **别拿腕骨的局部旋转当"骨架在动"的证据。** 这套骨架的摆臂靠 `upperarm` /
   `lowerarm` 带过去，`wristr` 在跑动剪辑里局部旋转实测 **0°**，而它的世界坐标
   照样挪了 26 mm。挑错骨头会误杀一个完全正常的动作。
5. **JS 模板字面量体内的注释不许出现反引号。** `sess.evalAsync(\`...\`)` 里写
   markdown 风格的 `` `foo()` `` 会**提前终止模板**，而报错位置指向 `evalAsync`
   那一行 —— 和真正出错的注释隔了几十行。

---

## 8. 已知限制 / 下一版可做

- **步频与速度是解耦的。** 核心给守卫的速度是 1.05 / 1.75 m/s，而主人只有 0.55 m
  高 —— 要让 55 cm 的小人真的用这个速度走，步频得翻两倍，腿会糊成一片。所以
  `stridePerHeight` 取的是"看着像在走"的值，再把倍速**封顶**（walk 1.9×、run 1.7×）：
  宁可脚底滑一点，也不要一台高频抖腿。真要根治，得让守卫的速度随身高走 ——
  而那要重测整套胜率（见 §5.1）。
- **没有 root motion**，所以"挥拳"完全不影响移动。这是刻意的（§5）。
- **`neckFrac` / `eyeFrac` 只记录、不参与运行时。** 眼高仍然由 core 的
  `cfg.eyeY` 决定；把它们记进底账是为了以后要让"视觉眼高"和"碰撞眼高"对齐时
  有据可依，现在**没有**用它。
- **没有脸 / 没有手指。** 低多边形风格如此；头盔把脸挡住反而是好事（不需要做表情）。
- **没有脚步声。** `audio.js` 是瞬时音效、`music.js` 是织体，加脚步要动音频层，
  不属于这一版的范围。

---

## 9. 复现命令

```bash
# 素材（需要 Blender；本机路径可用 BLENDER 环境变量覆盖）
python scripts/build_actors.py            # 已有缓存时不会重新下载
python scripts/build_actors.py --force    # 重新下载 + 重建

# 验收
node scripts/verify_actors.mjs            # 59 条；报告 work/verify_actors.log
node scripts/verify_play.mjs              # 83 条；回归（确保玩法没被动画碰过）
```

产物与底账的归属：

| 路径 | 入库 | 说明 |
|---|---|---|
| `assets/actors/host_*.glb` | ✅ | 收编的素材（12.1 % 的裁剪结果） |
| `assets/actors/LICENSE-kaykit.txt` | ✅ | CC0 原文，随素材存放 |
| `data/actors.json` | ✅ | 实测底账（含 `sourceBytes`） |
| `scripts/build_actors.py` | ✅ | 可反复跑的构建链 |
| `work/src_actors/*.glb` | ❌ | 源包缓存，跑一次就有（7.28 MB） |
| `work/build_actors_blender.py` | ❌ | 生成物 |
| `work/_build_actors.log` | ❌ | 构建日志（`KEPT` / `DROPPED` / `HEIGHT_*` 都在里面） |
