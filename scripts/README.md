# scripts/ — 工具索引

60 个自检 / 诊断 / 派生工具（不含 `_*` 开头的一次性脚本）。全部**零依赖**：Python 只用标准库，Node 只用内置模块
（`node:http` / `node:child_process` / 全局 `fetch` / 全局 `WebSocket`，需 Node 22+）。
所有路径都是**相对本仓库**的，clone 下来直接能跑，没有一处写死本机目录。

```bash
python scripts/verify_name.py          # Python 侧：命名普查
node   scripts/verify_play.mjs         # Node 侧：70 条可玩版本验收
```

> 这个仓库的一条硬规矩：**先修量具，再解释数字**。
> 凡是「全表 0.0 %」「所有档位读数相同」「站在它正前方却看不见我」这类荒唐读数，
> 先怀疑尺子。下面 C 组（`diag_*`）几乎每一个都是为某一次「读数荒唐」而写的。

---

## A · 派生链：`data/` 与场景快照从哪来

这一链是**单向**的。除最后两步外，每一步都独立测量、互不依赖；
`snapshot_arena.mjs` 把它们的产物汇成一个 `Level`。

| 顺序 | 工具 | 产出 | 干什么 |
|---|---|---|---|
| 1 | `probe_kit.py` | `data/kit_index.json` | 纯 stdlib 解 GLB：bbox / 材质 / 三角面数 |
| 2 | `probe_world.py` | `data/kit_world.json` | 走完节点层级与全部变换 → **真**世界包围盒（本地 accessor 的 min/max 会漏掉节点缩放） |
| 3 | `measure.js` | `data/kit_three.json` | **权威尺寸源**：在真浏览器里用 `Box3` 量。自己手写的 glTF 矩阵只是复现，不能压在它上面 |
| 4 | `derive_redbox.py` | `data/model_surfaces.json` | 每个模型身上**红色槽**与**玻璃面**的 bbox（红包藏点与「看得见」都靠它） |
| 5 | `probe_passages.js` | `data/passages.json` | 墙体开口 + 门开没开 —— **问渲染器的 raycaster**，不问我的算术 |
| 6 | `derive_wall_gaps.py` | `data/wall_gaps.json` | 每面墙的缝**实际在哪**、多宽 |
| 7 | `gen_manifest.py` | `assets/manifest.json` | 从 `kit_index.json` 出一份只含事实的清单 |
| 8 | ★ `snapshot_arena.mjs` | `game/arenas/room_scene.json` | **唯一知道「这是一间公寓」的一步**：四个独立测得的输入 → 纯适配器 → `Level`。换一栋楼只换它 |
| — | `derive_gamedata.py` | `work/gamedata.json` | 侧链：归属矩阵（从 `layout.js` 反推）+ 颜色普查 + CIE76 色差 |
| — | `fetch_vendor.py` | `vendor/` | 把 three.js + 三个 addon 拉到本地（多镜像依次尝试，已存在则跳过） |
| — | `cdp.js` | — | 复用型无头 Chrome 框架（自带静态服务 + CDP 会话），是其余 `.mjs` 的底座 |

**为什么 `data/` 入库而 `work/` 不入库**：`data/` 是**输入**（重算一次要开浏览器、要几十秒，
且结果就是「这栋楼的事实」）；`work/` 是**每次重跑都会重写的**日志与评估 JSON。

---

## A2 · 生成器：按参数造一栋楼

`procgen.mjs` 是**工具**，不属于上面的派生链。给定整体尺寸 / 房间数 / 物品数 / 种子，
它造出一套户型与家具摆放，然后**用与上架公寓完全相同的管线**去验它。

| 工具 | 产出 | 干什么 |
|---|---|---|
| ★ `procgen.mjs` | `reports/procgen.svg`、`reports/procgen.txt`（`--out-layout` / `--arena` 另写） | `--sweep` 跑 12 组参数，逐组 9 项断言。SVG 按**建好的 `Level`**（游戏眼里的墙 / 门 / 家具）画，不按生成器的意图画 —— 两者不一致时，图会显示不一致 |

```bash
node scripts/procgen.mjs                    # 一次扫描 + 一张 SVG 平面图
node scripts/procgen.mjs --w 12 --d 9 --rooms 7 --items 90 --seed flatA
node scripts/procgen.mjs --sweep            # 12 组参数的完整网格
node scripts/procgen.mjs --out-layout js/layout.gen.js --arena game/arenas/gen.json
```

### A2b · 工作台：在浏览器里调参、生成、预览

`procgen.html` 是**同一个生成器的前端**：左边 13 个旋钮（值直接取自 `floorplan.js` 的
`DEFAULTS`，不在 HTML 里抄第二份），右边是画好的平面图 + 9 项断言 + 读数。
它调用的是 `game/procgen/{pipeline,draw}.js` —— 也就是 `procgen.mjs` 调用的那两个模块，
所以「命令行验过的」和「页面上看到的」不是两份实现。抽出来时以
**`--sweep` 产物逐字节不变**为门禁（`reports/procgen.svg` 323000 B、`procgen.txt` 15305 B，均 IDENTICAL。
那次抽取的结论不受影响；后来加了第 9 项断言「快照自带这一层的 layout」，
所以 `procgen.txt` 现在是 **16964 B**，`svg` 仍是 **323000 B**）。

这条门禁当时只验了「sweep 自己可复现」，**没验「别的脚本别去动它」**：
`verify_playground.mjs` 的**第二组参数**只带了 `--report`、没带 `--svg`，
于是每跑一次验收就把 12 宫格证据盖成一张单图 —— 量出来是 **12 张平面 → 1 张**
（` rooms · ` 标签 12 次 → 1 次、`<g>` 24 → 1、字节 323000 → 31927）。
两处现在都堵上了：`--report` **连平面图一起改道**，`verify_playground.mjs` 另加一条
「跑完复查 `reports/procgen.{txt,svg}` 哈希未变」的断言。
**「一个输出改道了、另一个没有」是这类事故的标准形状** —— 凡是重定向，就把同一次
运行的所有产物一起重定向。

| 模块 | 是什么 |
|---|---|
| `game/procgen/pipeline.js` | 9 项断言的实现（自 `procgen.mjs` 抽出，Node 与浏览器共用） |
| `game/procgen/draw.js` | 平面图 SVG 的绘制（同上；一处绘制，两个出口） |
| `game/procgen/playground.js` | 工作台的界面逻辑，并暴露一个给验收用的 `__procgen` 小接口 |

**「走进去玩」不用落文件**：工作台把已经验过的快照写进 `sessionStorage`，跳到
`play.html?arena=session:procgen`，由 `play.js` 在**本页**把它变成一个 Blob URL ——
浏览器写不了文件，但同源的 Blob URL 和磁盘上的文件一样能用（上一页创建的 Blob URL 会在
导航时失效，所以必须在本页创建）。找不到快照时**抛错**，不退回上架公寓：
静默退回正是 `verify_gen_play.mjs` 存在的原因。

---

## B · 验收：只判 PASS / FAIL，不改任何东西

| 工具 | 判什么 | 报告 |
|---|---|---|
| `smoke_serve.py` | **启动器能不能真的把场景端出去**：状态码 / MIME / 字节数 / 缺文件 404；另加**启动词解析表**（`game` / `viewer` / `workbench` 与端口混写，各自该开哪一页）和工作台三件套的 200 | 直接打印 |
| `shoot.js` | 查看器：STATIC（模块完整性）/ RUNTIME（对象计数）/ CLEAN（零异常零 4xx）/ PIXELS（每个机位尺寸互不相同） | `work/verify_report.json` + `renders/` |
| `verify_game.mjs` | 方案二玩法矩阵：混合可达 / 无不可赢 / 藏点普查 / 分层摆放 / 守卫覆盖 / 预算×配置 | `work/game_eval.json` |
| ★ `verify_play.mjs` | **70 条**：浏览器里跑的 `game/play/` 与无头矩阵**是同一个游戏**（同 nav、同摆放、同巡逻；两个运行时对到 1e-6） | `work/verify_play.log` |
| ★ `verify_gen_play.mjs` | **20 条**：**生成出来的**户型能在真浏览器里启动 / 走 / 渲染，且与 Node 逐坐标对账。含一条**负向对照** ——断言这层楼的导航格数与上架公寓不同；没有它，一个静默退回上架层的页面会全绿通过 | `reports/gen_play.txt` |
| ★ `verify_playground.mjs` | **36 条**：**真实驱动页面 UI**（填参数 → 按「生成」），断言页面与 Node 逐字节相同（交出去的快照 68959 / 68959 字符 `identical`）、**预览跟着旋钮变**（否则屏幕上可能是一张顶着新参数名字的旧图）、**画在平面图上的红包就是游戏会放的六个**（这条是补的：验证器与游戏曾各持一条随机流，17 组参数里 16 组放得不一样，最远差 8.85 m）、以及「走进去玩」落到**当时屏幕上那一层**而不是上架公寓。含一条负向测试：`?arena=session:nope` 必须**响亮地失败**，不许静默退回 | `reports/ui_play.txt` |
| ★ `verify_live.mjs` | **11 条**：对**已经在跑**的服务做同一套对账（`--url` 指哪测哪），起自己的浏览器但**不起服务**。与 `verify_playground` 的分工是「我测过了」和「你眼前这个能用」不是同一句话 | 直接打印 + `renders/ui/02-live-*.png` |
| ★ `verify_world.mjs` | **25 条**：**看到的房子 == 玩的房子**（世界侧唯一判决）。三栋楼（10×8 六房 / 16×14 十房 / 9×9 五房）逐栋比对场景包围盒、房间 id、地砖·门·家具的 1:1 计数，并从出生点垂直打射线确认**脚下是这栋楼的地板**；含负向对照 —— 把 9×9 那层的 `layout` 字段砍掉，页面必须**报错并点名**而不是照常启动。这条断言曾经不存在，代价是一整层楼被画成上架公寓 | `reports/world.txt` + `renders/world/` |
| ★ `verify_open.mjs` | **32 条**：**「打开方式」本身**的验收。三个页面各跑两遍 —— `file://` 下必须**看得见**一段说明、点名双击哪个 `.bat`、且页面真实内容为 **0**（控件 / 平面图 / 启动标志）；`http://` 下必须**看不见**那段说明、真实内容 **> 0**。后者是负向对照：没有它，「把警告永远显示着」也能全绿。另加三个 `.bat` 的行尾（CRLF）/ ASCII 体检、两个包装器确实带了关键字，以及**「代码一行都没执行」必须在屏幕上说出来**
（否则「加载慢」和「根本没跑」看起来是同一句话，而这一页会永远等下去）。这条断言曾经缺席的代价见 `diag_open.mjs` | 直接打印 + `renders/open/` |
| `verify_name.py` | 命名普查：五处接线点 + `MUST_KEEP` 逐点点名（**阈值是尺子，点名才是断言**） | `work/verify_name.txt` |
| `check_eol.py` | 行尾 / BOM / 非 ASCII —— `.bat` 必须 CRLF + 纯 ASCII，编辑器里**看不见**这两个故障 | 直接打印 |

---

## C · 诊断：数字为什么长这样

`diag_*` 全部是**为一个具体困惑而写**的，注释第一段就写着那个困惑。

| 工具 | 回答的问题 |
|---|---|
| `diag_anchors.mjs` | 三个房间为什么永远不放红包？逐级打印三个过滤器各杀掉多少候选（**驱动真枚举器，不用复刻件**） |
| `diag_sight.mjs` | 74 个顶部锚点里 66 个 `cover=0` —— 是「隐蔽」还是**斜向射线打在自己宿主上**？逐个点名是哪块实体挡的 |
| `diag_census.mjs` | 红色普查是**核心**坏了还是**渲染层**喂错了？把纯逻辑搬到 Node 里问，再全场扫一遍看最优读数 |
| `diag_tiers.mjs` | 加了墙遮挡之后，可达到的 cover 分布变了 —— 打印能复现设计配比（20/35/30/15）的**新阈值**，让调参是读数不是口味 |
| `diag_coverage.mjs` | 看全 6 个红包**到底要几次扫视**（贪心集合覆盖）+ 那条巡回的米数与转身耗时：**路线成本 ≠ 关卡成本** |
| `diag_explore.mjs` | 「要看要花 97 s」是**设计事实**还是**我的 AI 太笨**？`random` vs `nearest` 两种探索策略对照 |
| `diag_oracle.mjs` | oracle/blind 到底差在哪？用分支账目（explore / chase-prize / chase-decoy 各占多少秒）证明是**策略差**不是**知识差** |
| `diag_ai_sight.mjs` | 每只红包**能从哪些视角被看见**（地板视角 / 登高视角各命中几次）：判「AI 收不满」是设计问题还是**人格残疾** |
| `diag_guard.mjs` | 守卫**站得合法吗**？（巡逻用的是 RDP 简化过的折线，两个折点之间的弦可能切进门框） |
| `diag_guard_where.mjs` | 那 600 s 花在哪：走 / 扫视 / 卡住 —— 三种花法对应三种完全不同的修法 |
| `diag_edges.mjs` | 导航说这个格子不属于任何房间 —— **是哪块实体干的**？在失败的那个采样点上逐块点名。用法：`node scripts/diag_edges.mjs 5.5 3.5` |
| `diag_resolution.mjs` | 公寓被切成 7 块区域，是**真空隙**还是**1 m 网格的采样假象**？5 cm → 1 m 扫一遍看区域数怎么变 |
| `diag_pickup.mjs` | 玩家**到底能站多近**？竞技场声明 `pickup = 0.42` 但管线里从没验过这个数（摆放用的是 0.55 默认值） |
| `diag_ladder_plan.mjs` | 攀爬图长什么样：每个可站面、它的高度、以及它是从**地板**还是从**另一级**可达 |
| `diag_fridge.mjs` | 逐帧问答：第二级为什么失败（feetY / 中心点支撑面 / 该高度 `nav.clear` / 冰箱足迹到底在哪） |
| `diag_world.mjs` | **「这层楼被盖成了什么？」** —— 打印核心在玩的平面、场景里那栋楼的包围盒、以及两侧的房间 id。BUG 是「plan 16x14 十房 / world 10.14x8.15 六房」；`verify_world.mjs` 是同一次测量的 PASS/FAIL 版。指哪测哪：`--arena work/x.json`，可重复；没有 `layout` 的快照会直接打印页面的拒绝 |
| `diag_open.mjs` | **「为什么我打开后是这样？」** —— 同一个 HTML 用 `file://` 与 `http://` 各开一遍，逐项对账：控件数 / 状态文字 / 平面图 / `__procgen` / 浏览器报错。实测 `file://` 下控件 **0**、状态停在HTML 里的静态文字「准备中…」、控制台是 CORS 拦下 `playground.js`；换成 `http://` 则是控件 14、平面图 1、零报错。**病根在打开方式，不在页面** | 直接打印 + `work/diag/` |

---

## D · 探针：量一件事，多半带 A/B 对照

| 工具 | 量什么 |
|---|---|
| `probe_climb.mjs` | 竖直轴有没有做注释里声称的事：`nav.clear(x,z,r,0)` 是否**逐位等于** `nav.clear(x,z,r)`（在真竞技场上采样三点半径，不在注释里断言） |
| `probe_climb_play.mjs` | **玩家**真的能上家具吗？脚本化输入驱动真 `Avatar`：站近、面向、跳一次、按住前进 1.2 s，读 `groundY` |
| `probe_climb_reach.mjs` | **一个身体**（不是瞬移）能不能拿到每一只红包？§3 原来的写法是「把人瞬移到红包 XZ」，而瞬移解不出 0.45 m 台面 |
| `probe_ladder.mjs` | 同一件事 × 多种子：`climbPlan` 是对**高度**求的不动点，高度本身说不出「跨得过去吗」 |
| `diag_edges.mjs` ↖ | （见 C 组） |
| `probe_place.mjs` | 重写后的藏点是否做到玩家要求的三件事：不在地上 / 能在柜子里 / 能在物品之间 —— **多种子**，不是一次 |
| `probe_guard_render.mjs` | 守卫**有没有被画进画面**：同机位两帧（可见 / 隐藏）逐像素 diff，再拿**差异质心**与守卫**投影坐标**对账 |
| `probe_guard_light.mjs` | 监控灯有没有照到地上：A/B 翻 `spot.visible` vs 扫 `intensity`（后者**永远是 0**，真因见下） |
| `probe_grab_recipe.mjs` | 同一个 A/B 换 **6 种取像素配方**（画布尺寸 × `willReadFrequently` × `renderOnce` 位置）定位是哪一步瞎的 |
| `probe_guard_sight.mjs` | 守卫为什么看不见 0.9 m 正前方的玩家？逐次打印守卫位姿 / 玩家瞬移后的实际落点 / 距离方位 / **核心自己的** `Guard.look()` |
| `probe_doors.py` | `doorway` 是关着的门，还是只是个框？按法线普查面片并量面积 —— 可判定（2026-09-25 修好，见 `GAME_DESIGN.md` 附录 B） |
| `probe_doorways.js` | 门洞到底通不通 —— 问组装好的场景 + three.js 自带 raycaster（**不是**读 GLB 三角形） |
| `probe_faces.py` | 每个图元画的是**哪个面**：按法线分组求面积，于是 `wall` 能解成「`+Z` 面 1.29 m² → `_defaultMat`」 |
| `probe_prims.py` | 同一 GLB 的多材质图元是**共享三角形**还是**互补面**？（重合 = 全部材质都画时 z-fighting） |
| `probe_passages.js` | 每面墙模型的缝在哪多宽 + 组装后哪些门洞真的可通行 |
| `probe_net.js` | 为什么**恰好一个** `.glb` 报 `net::ERR_ABORTED`？重载并录 Network：重复请求 / loadingFailed 全量 / 哪个 `.glb` 从没拿到 200 |
| `probe_closeup.js` | 单件特写：**同一个模型渲两遍** —— 一遍是房间合并时烘上去的（在原位），一遍是 `kit.instance()` 扔在楼外空地上。两者不一致则怪合并，一致则怪模型 |
| `probe_hud.js` | HUD 家具的像素级裁切（`captureScreenshot` 带 clip + 3x 缩放），用来看有没有重影，而不是对着 1080 px 图眯眼 |
| `measure_surveil.mjs` | 难度阶梯**重测胜率**：24 种子 × 4 配置 × 预算 120/180/240，带两个对照人格 |
| `time_boot.mjs` | 可玩层的引导有多贵？300 ms 就在加载页里做，30 s 就得预烘进竞技场 —— **猜这件事本身就是这个脚本存在的理由** |

---

## 四条被这些工具反复证实的教训

1. **有隐式第二难度旋钮时，旧胜率全部作废。** 改红包尺寸会顺手改掉 `noticeRange()`
   （它由**面积**推出）。重测之前先用**没被改动**的配置逐位复现旧表，才算证明了「尺子没动过」。
2. **每一帧都会被渲染路径重算的量，不能从外面扫。** 手改灯光 `intensity` 扫四档全是 0 变化，
   真因是 `GuardActor.update()` 在**每次 `render()` 里**把它重算回默认值 ——
   这种量只有一个外部开关有效：`visible`（没有任何代码重算它）。
3. **「能站的点」和「能走的格子」是两个格上的东西。** `clear(x, z)` 对**任意连续点**回答，
   `walkable[]` 只采样**格心**。于是同一个位置可以「站得住」而「这一格不可走」——
   而 A* 是在格子上搜的。把点直接当格子用，读数会是「从一个合法出生点出发，
   0/23 个航点可达」：它看起来像**关卡坏了**，其实是**路由坏了**。修法在格子边界
   （`nav.nodeOf`），不在调用点 —— `sim.js` 早就手工补过这个洞，第七个调用点没补。
   这是唯一一次「守卫只巡逻 1 个房间」的真因。
4. **解析器不是正确性门禁。** `node --check` 放行过一个第一帧就抛
   `ReferenceError: stepLen is not defined` 的文件（把一个变量挪进了 `if` 块，
   而 20 行之外还在读它）。语法门禁值得留着当**便宜的第一道闸**，
   但「它过了」不能当「它对」—— **真跑一遍那条被改的代码路径**，才是门禁。
