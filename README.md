# 《一寸红》 · An Inch of Red

> **你是一只 42 cm 高的小东西。红包永远不在低处 —— 而守卫的光永远在地上。**

第一人称、限时找齐 **6 个红包**，同时避开巡逻守卫。在一间剖开的公寓里，
红包只出现在桌面、台面、柜顶，或者塞进柜子里、夹在两件东西中间；
而守卫脚下那片扇形光斑，始终落在地板上。

![游戏开始页](renders/play/00-menu.png)

命名由来、落选方案、以及改名清单见 [`game/NAME.md`](game/NAME.md)。
内部代号 `寻红` / `xunhong` **保留没删** —— 它在源码、日志与验证报告里是**测量记录的一部分**，
整库替换等于篡改历史。

---

## 一键跑起来

**Windows：双击本仓库根目录的 `start.bat`**。
它会：

1. 找一个**真能跑**的 Python（依次试 `py -3` / `python` / `python3`，
   并且每个候选都真的执行一次才算数 —— Windows 自带那个只会弹应用商店的假 `python` 会被淘汰）；
2. 起本地静态服务（端口被占用会自己往后挪）；
3. **等服务端口真的应答 HTTP 之后**才打开浏览器 —— 不是"等固定 0.8 秒"；
4. **默认直接打开游戏**：`http://127.0.0.1:8777/play.html`。

```bat
start.bat              :: 开局（默认打开游戏 play.html）
start-workbench.bat    :: 户型工作台 procgen.html
start-viewer.bat       :: 场景查看器 index.html
start.bat 9000         :: 换端口
```

手动也行（零依赖，只用 Python 标准库）：

```bash
python serve.py                  # 游戏    http://127.0.0.1:8777/play.html
python serve.py --workbench      # 工作台  http://127.0.0.1:8777/procgen.html
python serve.py --viewer         # 查看器  http://127.0.0.1:8777/
python serve.py 9000 --no-open   # 换端口、不自动开浏览器
```

> **不能直接双击 `procgen.html` / `play.html` / `index.html` 本身。** 浏览器禁止
> `file://` 下的 ES 模块与 `fetch`，页面会渲染成一个「看着正常、其实一行都没跑」的空壳 ——
> 参数面板是空的、状态永远停在「准备中…」。三个页面现在都会**自己**在屏幕上说清这件事
> 并给出正确命令（`js/open-guard.js`），但双击上面那三个 `.bat` 才是最短的路。

### 操作

| 键 | 效果 |
|---|---|
| `W` `A` `S` `D` | 前后左右（贴墙会滑行，不会卡住） |
| **鼠标** | **唯一的转向方式**（点画面锁定指针） |
| `空格` | 跳跃，峰值 0.441 m；**`空格` + `W` 跳上家具**（茶几 / 浴缸 / 沙发 / 书桌 / 台面） |
| `G` | 红点提示开关（关掉就是硬核模式） |
| `M` | 静音　`Esc` / `P`：暂停 |

---

## 目录

```
An-Inch-of-Red/            ← 本目录就是仓库根
├── start.bat              双击即开局（默认打开游戏 play.html）
├── start-workbench.bat    双击 → 户型工作台 procgen.html
├── start-viewer.bat       双击 → 场景查看器 index.html
├── serve.py               本地静态服务（零依赖，仅标准库）
├── play.html              ★ 游戏入口
├── procgen.html           ★ 户型工作台（调参 → 生成 → 预览 → 走进去玩）
├── index.html             场景查看器（旋转 / 缩放 / 点房间飞掠聚焦）
├── README.md              你正在看的这一页
├── SCENE.md               场景与工具的完整说明（六个房间、四类踩过的坑、全部读数）
├── CREDITS.md             素材授权与出处
├── GAME_DESIGN.md         玩法设计与其被实测推翻的假设
├── game/                  ★ 玩法
│   ├── core/              纯逻辑核心：导航 / 视锥 / 藏点 / 守卫 / 模拟（零 three.js / DOM）
│   ├── arena/fromLayout.js   唯一知道「这是一间公寓」的适配器
│   ├── arenas/room_scene.json 场景快照（70 KB，换一栋楼只换它）
│   ├── procgen/           ★ 参数化户型生成：floorplan / pipeline / draw / playground
│   └── play/              渲染层：输入→意图、状态→画面、结束判定
├── js/  css/              查看器与 HUD：模型装载 / 布局数据 / 场景图 / 环境 / 打开守卫
├── assets/models/         140 个 .glb（1.87 MB）
├── vendor/                Three.js（模块版 + OrbitControls / GLTFLoader / BufferGeometryUtils）
├── data/                  ★ 实测底账：重建场景快照所需的量测数据
├── scripts/               ★ 验证 / 诊断 / 派生工具（索引见 scripts/README.md）
├── reports/               ★ 关键验收报告快照
├── renders/               交付截图与取证（查看器 8 · 游戏 7 · 世界一致性 7 · 打开方式 6）
└── work/                  本地中间产物（**不入库**，跑一次就重生成）
```

**为什么 `data/` 与 `work/` 要分开**：`data/` 里是**量出来的事实**（浏览器 `Box3` 量的模型尺寸、
从 GLB 里读出的红槽位与墙体开口），它们是「换一栋楼只换快照」这条链的输入，必须跟着仓库走；
`work/` 里是**跑一次就会重新生成**的日志与取证图，全部 gitignore —— 所以 `git status` 永远干净。

---

## 验收

整套工具**零第三方依赖**（Node 只用内置 `http` / `fetch` / `WebSocket`）。

```bash
# 游戏：70 条断言（同世界 / 碰撞不变量 / 拾取 / 守卫 / 跳跃契约 / 跳上家具 /
#       红包要爬上去取 / 红包不在任何地上 / 鼠标是唯一转向 / 每局随机且种子可复现 /
#       缩略图字号 / 难度双旋钮 / 光的 A/B 像素差 / 开始页确实在屏幕上 / 像素统计）
node scripts/verify_play.mjs

# 世界一致性：25 条断言 —— 看到的房子 == 玩的房子。三栋楼（10×8 六房 /
#       16×14 十房 / 9×9 五房）逐栋比对包围盒、房间 id、地砖·门·家具的 1:1 计数，
#       并从出生点垂直打一条射线，确认脚下是这栋楼自己的地板
node scripts/verify_world.mjs

# 命名：25 条断言（标题、题字、CSS 规则、package.json、命名决定书、仓库门面，
#       以及「代号没有从该留的地方消失」）
python scripts/verify_name.py

# 启动器本身：起服务、抓 16 个资源、核对 MIME 与字节数、缺失文件必须 404
python scripts/smoke_serve.py

# 查看器：静态检查 → 无头渲染 → 断言 → 8 张截图 → 干净度
node scripts/shoot.js

# 打开方式：三个页面 × file:// 与 http:// 各一遍（共 32 条）—— file:// 下必须
#       看得见「该双击哪个 .bat」且页面真实内容为 0，http:// 下必须看不见且内容 > 0
node scripts/verify_open.mjs

# 户型生成器：12 组参数的扫描（每组 9 项管线检查，证据在 reports/procgen.*）
node scripts/procgen.mjs --sweep

# 玩法设计：可达性 + 藏点普查 + 预算×配置矩阵
node scripts/verify_game.mjs 24
```

最近一次读数（GPU = GTX 1660 SUPER）：

```
verify_play.mjs     70/70 PASS      红包 6/6 都不在房间地板上，6/6 都够得着，其中 3 个必须爬
verify_world.mjs    25/25 PASS      三栋楼三个平面：包围盒 == 平面 + 墙厚，房间 id 逐个点名
verify_name.py      25/25 PASS      代号 寻红 6/6 处点名命中，仓库门面带着名字
smoke_serve.py      SMOKE PASS      16 个资源 MIME 与字节数全部与磁盘一致，缺失文件 404
```

快照可从底账重建，而且**逐字节可对账**（改过 `data/` 路径之后实测：与入库版仅差
`provenance` 里那 12 个字符，其余完全相同）：

```bash
node scripts/snapshot_arena.mjs      # 读 data/ → 写 game/arenas/room_scene.json
```

---

## 难度

| 难度 | 预算 | 监控区（扇区 = 投光） | 红包 | 24 种子 × 玩家型人格 |
|---|---|---|---|---|
| 见习 `solo` | 240 s | 无守卫 | 18.4 × 11.5 cm | 66.7 % · 收 5.67/6 |
| **标准 `patrol`** | 180 s | 74° × 4.2 m（11.4 m²） | 16.0 × 10.0 cm | 33.3 % · 收 4.83/6 |
| 紧张 `tight` | 180 s | 88° × 5.0 m（19.2 m²） | 13.6 × 8.5 cm | 29.2 % · 收 4.88/6 |
| 硬核 `hunter` | 180 s | 96° × 6.0 m（30.2 m²） | 11.2 × 7.0 cm | 12.5 % · 收 3.54/6 |

红包尺寸**不是装饰**：察觉距离由红包自身的面积推出，所以缩小红包会连同
「AI 与玩家在多远处能发现它」一起缩小。**动过旋钮的难度必须重新量胜率。**
这套数字怎么来的、以及哪一版被哪次实测推翻，都在
[`game/VERDICT.md`](game/VERDICT.md)。

---

## 授权

游戏素材来自 [Kenney Furniture Kit](https://kenney.nl/assets/furniture-kit)，
**CC0 1.0 公有领域**，可自由用于商业项目，无需署名。
授权原文一并留档：[`CREDITS.md`](CREDITS.md) ·
[`assets/LICENSE-kenney.txt`](assets/LICENSE-kenney.txt)。
