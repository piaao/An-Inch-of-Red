# 《一寸红》配乐设计书 · MUSIC.md

> **七首曲子，一条总线，零依赖。**
> 曲目由阿里云百炼 **`fun-music-v1`** 生成（prompt 就是下面 §3 的原文），
> 生成脚本 `scripts/gen_music.py`，运行时 `game/play/music.js`，
> 阈值集中在 `game/play/config.js` 的 `MUSIC`。
>
> 本仓库存过一条纪律：**音频靠 WebAudio 合成，不引入素材**（`audio.js` 的四个音效）。
> 配乐是这条纪律的**例外**，而且是被明确写下来的例外 —— 因为四个几十毫秒的脉冲
> 用振荡器合成很便宜，而七段 60–90 秒的循环织体不能。例外的代价用**生成而非入库**
> 来偿还：仓库里仍然没有一个二进制。

---

## 0. 结论先行

| | 值 |
|---|---|
| **数量** | **7 首** = 4 首循环铺底 + 3 首一次性 sting |
| 模型 | `fun-music-v1`（百炼，华北2·北京，邀测模型） |
| 格式 | `mp3`，单声道人声留空（全部纯器乐，**prompt 里明确写"无人声、不要唱词"**） |
| 落盘 | `assets/audio/01_menu.mp3` … `07_lose.mp3` + `manifest.json` |
| 总时长 | 约 6–7 分钟 ⇒ 按 0.002 元/秒 ≈ **0.8–0.9 元** |
| 关键约束 | **没有 manifest 就没有音乐**（§5），缺了它游戏照跑，只是安静 |
| 状态 | ⚠️ **尚未生成** —— 账号侧有两个权限闸门未开，见 §8 |

### 为什么是 7 首，而不是 3 首或 15 首

**少于此，游戏的情绪是平的。** 「找红包」本身没有戏剧结构，戏剧结构只有三处：
**还安全** → **被逼近** → **来不及了**。去掉任意一层，玩家走过整局就只有一个心情。

**多于此，是在为一套一局 3 分钟的小游戏写交响乐。** 每多一首就多一个交叉淡变
边、多一个和玩家状态对不上的机会。7 首覆盖了游戏**全部**可分辨的情绪相位，
且每一首都能指着 `play.js` 里一行代码说「就是它触发的」。

---

## 1. 触发点表（这是本设计书的正文）

条件一律用 `play.js` 的真实字段书写。`S.phase` ∈ `ready | playing | paused | won | lost`。

| # | id | 类型 | 触发条件（代码级） | 基准音量 |
|---|---|---|---|---|
| 1 | `menu` | 循环 | `S.phase === 'ready'`（开始页、以及从结算页点「换难度」回到菜单） | 0.50 |
| 2 | `explore` | 循环 | `S.phase === 'playing'` 且 **不满足**下述危险与超时条件 | 0.40 |
| 3 | `danger` | 循环 | `S.phase === 'playing'` 且 `guard` 存在 且（`dist(guard, player) < 5.0 m` **或** `guard.mode !== 'patrol'`） | 0.46 |
| 4 | `lastcall` | 循环 | `S.phase === 'playing'` 且 `preset.budget - S.elapsed <= 30 s` | 0.52 |
| 5 | `caught` | 一次性 | 守卫事件 `ev.type === 'caught'`（`onGuardEvent`） | 0.62 |
| 6 | `win` | 一次性 | `finish(true)` —— 找齐 `prizes.length` 个红包 | 0.58 |
| 7 | `lose` | 一次性 | `finish(false)` —— 时钟归零（`remaining <= 0`） | 0.55 |

### 优先序（同一帧内只能有一首铺底）

```
一次性 sting（caught / win / lose）   ← 抢走前台，把铺底压低 1.2 s
        >
lastcall   ← 剩余 ≤ 30 s：这时"危险"已经不重要了，时间才是敌人
        >
danger     ← 守卫在 5 m 内，或已经在找你
        >
explore    ← 默认状态
```

> **为什么 `dangerM = 5.0` 而不是守卫视锥的 4.2 m？**
> 因为音乐要**先于危险**到达。5.0 > 4.2，意味着灯光逼近到 5 米时弦乐就开始绷，
> 而它**还**看不见你。这段 0.8 米的提前量，把音乐从「第二条探测通道」
> 变成了「你自己的神经」。若设成 < 4.2，音乐就变成了"你已被发现"的播报，
> 玩家会学会拿它当外挂 —— 那是设计事故，不是音效。
>
> 这一段**没有任何反馈回路**：`danger` 读的是 `guard.state().pos` 与 `mode`，
> `low` 读的是 HUD 同一个时钟。音乐改不了模拟，所以整套配乐可以纯凭耳朵调，
> 而 `game/VERDICT.md` 里任何一个胜率都不作废。

### 两个"不该有音乐"的相位，是刻意的

| 相位 | 处理 | 理由 |
|---|---|---|
| `paused` | 铺底**继续**，但压到 30% | 暂停是"我离开一下"，不是"剧情中断"。留一丝底噪，回来时不会像重新开局。 |
| `won` / `lost` | 铺底**停**，只留 sting | 结算页的那一下重音需要安静来支撑。玩家点「换难度」回到 `ready` 时，`menu` 才接上。 |

---

## 2. 铺底状态机

```
                 ┌──────────────────────────── ready ──────────────────────────┐
                 │                          【menu】循环                        │
                 └───────────────────────────────┬────────────────────────────┘
                     beginRun()  →  S.phase='playing'
                                                 ▼
        ┌────────────────────────────────────────────────────────────────┐
        │  剩余 > 30s 且守卫远                         剩余 ≤ 30s          │
        │     【explore】循环  ──── 守卫进入 5m / 察觉 ──▶【danger】循环    │
        │          ▲                                    │        │       │
        │          └──────── 守卫走远 / 回到巡逻 ─────────┘        │       │
        │                                                          ▼       │
        │                                              【lastcall】循环 ─────┘
        └────────────────────────────────────────────────────────────────┘
                        │                                    │
              finish(true)│                        finish(false)│
                        ▼                                    ▼
                   【win】sting                          【lose】sting
                        └────────── 点「换难度」→ ready ──────────┘
                                            ▼
                                        【menu】
```

任何一次切换都是 **1.1 s 线性交叉淡变**（`MUSIC.crossfadeS`），不是硬切 ——
硬切会在每一次守卫靠近时"啪"一下，几十局下来就是折磨。

---

## 3. 每首的生成要求

prompt **逐字**取自 `scripts/gen_music.py` 的 `TRACKS`（那份表是唯一真源，
本节的表格是它的可读投影，两者由 `scripts/verify_music.mjs` 对账）。
每一条都写了**乐器 / 速度 / 情绪 / 用途**四要素 —— 官方指南的原话是
「更具体的 prompt 得到更准确的结果」，「忧郁的音乐」这种写法是被点名的反例。

| id | 文件 | loop | gain | 时长目标 | prompt 要点 |
|---|---|---|---|---|---|
| `menu` | `01_menu.mp3` | ✔ | 0.50 | 60–90 s | 悬疑中式氛围；古琴+箫；极轻电底+风铃；BPM 70 小调；**无鼓点、无起伏** |
| `explore` | `02_explore.mp3` | ✔ | 0.40 | 90–120 s | 中式轻电子；古筝短句循环+合成器 pad+环境声；BPM 85；**无鼓组、不做高潮** |
| `danger` | `03_danger.mp3` | ✔ | 0.46 | 45–60 s | 潜行张力；持续弦乐 tremolo+心跳低频；BPM 95；**无旋律主线，以织体压人** |
| `lastcall` | `05_lastcall.mp3` | ✔ | 0.52 | 30–40 s | 中式冲刺；中国大鼓+快板竹笛；BPM 140 小调；**层层加码、保持可循环** |
| `caught` | `04_caught.mp3` | ✘ | 0.62 | 3–5 s | 打击乐 sting；大锣闷响+琵琶扫弦+低频冲击；**5 秒内快速衰减归零** |
| `win` | `06_win.mp3` | ✘ | 0.58 | 5–8 s | 欢快五声；竹笛+琵琶上行+鼓点铃铛；**末尾干净收束** |
| `lose` | `07_lose.mp3` | ✘ | 0.55 | 5–8 s | 失落收束；独奏二胡下行叹息+古琴余韵；**慢慢淡出** |

> **一次性 sting 必须短。** `caught` / `win` / `lose` 是"事件"，不是"段落"。
> 若生成出 30 秒的版本，它会在玩家已经重新走起来之后还在响 ——
> 运行时的 `_stepSting` 按 `el.duration` 的**最后 0.7 s** 淡出，
> 所以长版本不会"卡住"，但会明显拖沓。这就是 prompt 里把秒数写死的原因。

### 全曲共用的三条硬要求

1. **纯器乐，无人声，不要唱词。** 模型默认会写歌词并演唱（`gender` 参数就是给它用的）。
   我们要的是背景床，不是主题歌 —— 所以每条 prompt 都显式禁人声。
2. **不写具体秒数以外的结构指令。** 不写"前奏 8 小节"之类：`fun-music-v1` 是端到端
   歌曲模型，结构会自己长；我们只需要给足**乐器 + 速度 + 情绪 + 用途**。
3. **可循环。** 三条铺底曲的 prompt 里明确写"适合循环 / 保持可循环"，
   因为运行时用 `el.loop = true` 硬循环，接缝处的突兀只能靠 prompt 提前规避。

---

## 4. 混音规则

| 参数（`config.js` 的 `MUSIC`） | 值 | 作用 |
|---|---|---|
| `master` | 1.0 | 音乐总线基准。**不再是 0.55**，也不和 `audio.js` 的 SFX 总线 0.35 共用——见 §11 |
| `crossfadeS` | 1.1 | 两首铺底交接的时长（线性，两端同时动） |
| `duckS` | 0.22 | 压低系数逼近目标的速度 |
| `stingDuck` / `stingDuckS` | 0.34 / 1.2 | sting 期间铺底降到 34%，持续 1.2 s |
| `stingAttack` / `stingRelease` | 0.06 / 0.70 | sting 自身的淡入 / 尾部淡出 |
| `pauseDuck` | 0.30 | 暂停时铺底降到 30% |
| `dangerM` / `lowSeconds` | 5.0 m / 30 s | 两个**读取**玩家状态的门槛 |

**唯一的静音键是 `M`**，同时关掉音效与音乐（`audio.setMuted` + `music.setMuted`）。
两个静音键是个陷阱：玩家会关掉音效、留着音乐，然后断定音乐坏了。

**音量是每帧逼近的，不是设一次。** `music.js` 的 `update()` 每帧把每个元素的
`volume` 朝目标推 `dt / crossfadeS`。这带来两个免费的好处：
浏览器标签切走时 `requestAnimationFrame` 暂停，音量就**冻结在中途**，
回来时不会"啪"地跳到目标。

---

## 5. 降级与"零 404"

音频文件**不在仓库里**（它们是生成物）。于是走一条**三段式**的降级链：

```
music.load()  ──fetch──▶  assets/audio/manifest.json
                              │
                    ┌─────────┴──────────┐
             不存在/空/解析失败        存在且 tracks 非空
                    │                    │
        PROCEDURAL.enabled ?          source = 'files'
          │            │               按 tracks 建池放 mp3
        true          false
          │            │
  source='procedural'  enabled=false
  零请求 · 浏览器内合成   一个 mp3 请求都不发
```

**第一段（files）**：`manifest.json` **只收录磁盘上确实存在且通过 mp3 头校验的
曲目**（`gen_music.py --check` 会重写它）。

**第二段（procedural）**：没有 mp3 时，不再一律静音——`music.js` 转到
`game/play/procedural.js`，用振荡器**现场合成**那七段（见 §10）。这条路径
**不发任何网络请求**，所以零 404 铁律仍然成立；它复用 `audio.js` 那**唯一一个**
AudioContext，所以"全仓仅一个 AudioContext"的纪律也没被破坏。当前仓库正处在
这一段（音乐模型未开通，§8）。

**第三段（silent）**：把 `PROCEDURAL.enabled` 置 false，且没有 mp3，就回到最初
的"安静但正常"。

- **刚 clone 的仓库**：没有 `assets/audio/`，走第二段——有音乐，控制台干净。
- **只生成了 3 首 mp3**：走第一段，只放那 3 首；`want` 落到不存在的 id 时
  `update()` 退回 `explore`，再退不到就整段不出声——不抛、不 404。
- **`verify_play.mjs` 的"干净控制台"断言**：manifest 的那一次探测 404 是
  **唯一被允许的 4xx**，在套件里被显式白名单（见该文件 `isExpectedAudioAbsence`），
  且只白名单这一个 URL 的 404，别的文件、别的状态码一概不行。

---

## 6. 验收

无需浏览器、无需生成音频即可跑（静态接线 + manifest 一致性）：

```bash
node scripts/verify_music.mjs
```

它断言：

| # | 断言 | 为什么它是可数事实 |
|---|---|---|
| A1 | `gen_music.py` 的 id 集合 **==** 本文档 §3 表格的 id 集合 | 文档与生成器不许各说各话 |
| A2 | 7 个 id、4 循环 / 3 一次性，与 §0 的数字一致 | 数量是一个可以数错的东西 |
| A3 | 每条 prompt 都含"无人声"或"不要唱词" | 这条最容易被下一次编辑悄悄丢掉 |
| A4 | `config.js` 导出 `MUSIC`，且含全部 8 个键 | 运行时依赖的旋钮一个不少 |
| A5 | `play.js` 静态接线：引用 `MUSIC` 与 `music.js`；存在 `musicTick`；调用了 `music.sting('caught')`、`music.sting(win ? 'win' : 'lose')`、`music.setMuted` | 五个触发点挂上去了（**静态**断言，如实标注） |
| A6 | `music.js` 的 `update()` 里 `lastcall` 的判定**先于** `danger`，`danger` 先于 `explore` | 优先级不是注释，是可检查的顺序 |
| A7 | 若 `manifest.json` 存在：其中每个 `file` 都在磁盘上、且通过 mp3 头校验 | 防"写了 manifest 却没有文件" |
| A8 | 若 `manifest.json` **不**存在：`assets/audio/` 下不得有任何 `.mp3` | 防"有文件却漏写了 manifest"——那才是会 404 的状态 |
| **A9** | **行为测试**：用桩替身（stub `fetch` / `Audio`）**真的跑一遍 `Music`**，喂进五种相位与两个危险信号，读回铺底 | 优先级、缺失曲目的回退、静音、无 manifest 不抛 —— 全部按**行为**验证 |

A9 的十一条子断言（首次实测 **19/19 PASS**，`work/verify_music.txt`）：

```
A9.1  load() 读到 manifest 后启用           A9.7  phase=won → 铺底全体让位（bed=null）
A9.2  phase=ready            → bed menu     A9.8  sting('caught') 抢前台并把铺底压到 0.545
A9.3  playing 无危险 不超时   → bed explore  A9.9  ~3 秒后压低系数回到 1
A9.4  守卫进入 5 m            → bed danger   A9.10 静音后每一轨音量归零
A9.5  剩余 ≤30 s 压过 danger  → bed lastcall A9.11 无 manifest：mixer 关闭，update/sting 都不抛
A9.6  守卫离开                → bed explore
```

> A5 是**静态**断言：它证明代码里**写了**这些调用，不证明它们在第 60 帧真的发生了。
> **A9 补上了这一半** —— 它在 Node 里真的实例化 `Music`、真的喂状态、真的读回铺底，
> 所以"优先级顺序"和"缺曲回退"是按行为验证的，不是按正则。
>
> 仍然验证不了的只有一件事：**好不好听**。那需要耳朵，而耳朵不在 CI 里。
> 这也是为什么每条 prompt 都把乐器、速度、情绪写死 ——
> 把不可验证的那一步，尽量押在可复现的输入上。

---

## 7. 复现命令

```bash
# 0) 看货架：百炼的音乐生成只有两个模型，各自的免费额度与限制（§8.4）
python scripts/gen_music.py --models

# 0.5) 体检：逐个探路「全部」音乐模型，把「密钥无效」和「权限没开」分开（§8 的固化版）
python scripts/gen_music.py --doctor

# 1) 探路：只发一个最小请求，验证密钥/模型/网络
python scripts/gen_music.py --probe

# 2) 看曲目表（id、文件、循环与否、基准音量、触发点）
python scripts/gen_music.py --list

# 3) 生成（已存在的自动跳过，可断点续传；--force 强制重生成）
python scripts/gen_music.py
python scripts/gen_music.py --only menu      # 只重做其中一首
python scripts/gen_music.py --model fun-music-preview   # 换模型生成（preview 有免费额度）

# 4) 校验下载物 + 重写 manifest（一首都没有时会删掉 manifest，保持"关闭"状态）
python scripts/gen_music.py --check

# 5) 静态 + 行为验收（19 条，零浏览器）
node scripts/verify_music.mjs
```

生成完成后 `assets/audio/manifest.json` 会自动写好；**刷新 `play.html` 即有声**，
无需改任何代码。

---

## 8. ⚠️ 第一次生成的前置条件（实测拦路记录）

> 2026-09-26 实测：**百炼「音乐生成」品类下的全部两个模型 —— `fun-music-v1` 与
> `fun-music-preview` —— 调用都返回 `403 AccessDenied`，两个闸门未开。**
> 这不是脚本或网络问题 —— 证据如下，且都可复现。

### 8.1 证据

```
$ python scripts/gen_music.py --probe
[probe] HTTPError 403 Forbidden
{"code":"AccessDenied","message":"Access denied. ...","request_id":"..."}
```

交叉验证（同一把密钥，四个不同端点）：

| 探针 | 结果 | 读法 |
|---|---|---|
| `GET /api/v1/models` | **200 OK**，返回 **518 个模型**，其中**含** `fun-music-v1` | ✅ **密钥本身有效**，且模型在名册里 |
| `POST .../text-generation`（qwen-turbo） | 403 `AllocationQuota.FreeTierOnly` | ⛔ 账户处于**"仅使用免费额度"**模式且额度已耗尽 |
| `POST .../music-generation`（fun-music-v1） | 403 `AccessDenied` | ⛔ 模型**无权访问**（邀测未申请 / 未开通） |
| `POST .../music-generation`（fun-music-preview） | 403 `AccessDenied` | 同样未开通；但**它自带 1,000 秒新人免费额度**（见 §8.4） |

### 8.2 根因（两个，互相独立，都要解决）

1. **`fun-music-v1` 未开通。** 官方文档：该模型**处于邀测阶段**，需前往
   **百炼控制台 → 模型广场** → 该模型卡片 → **立即申请**开通后方可使用。
   它是**纯付费**模型（`免费额度 不支持开启，0/0`），0.002 元/秒。
2. **账户额度模式。** `AllocationQuota.FreeTierOnly` 的原文是
   *"Free quota exhausted. To continue accessing the model on a paid basis,
   please add funds or disable the 'use free tier only' mode"*。
   即使第 1 条开通了，**付费模型在"仅用免费额度"模式下仍然调不通**。

### 8.3 修法（按顺序，缺一不可）

| 步 | 在哪做 | 做什么 |
|---|---|---|
| 1a | 百炼控制台 → 模型广场 → 搜 `fun-music-preview` | 点「立即申请」提交邀测申请。**优先申请这个**：自带 1,000 秒免费额度，够生成全部七首 |
| 1b | 同上 → 搜 `fun-music-v1` | 可选。无免费额度（0.002 元/秒），但音质更好、且支持 `gender` 选男女声 |
| 2 | 阿里云费用中心 | 确认账户有可用余额（音乐按秒计费） |
| 3 | 百炼控制台 → 费用与配额 / 账户设置 | **关闭「仅使用免费额度」开关**（或改为按量付费） |
| 4 | 本机 | `python scripts/gen_music.py --probe` 应返回 200 与 `output.audio.url` |
| 5 | 本机 | `python scripts/gen_music.py` 一次生成七首 |

> **为什么写进设计书而不仅仅是聊天里：** 这个坑不写下来，下一次任何人想给这个游戏
> 配乐，都会重新撞一次 403，并且很可能把它误诊成"密钥过期"而白换一把钥匙。
> **钥匙没问题 —— 是这扇门没给这把钥匙开。**

---

### 8.4 音乐模型全景：全平台只有两个，且都不在 Token Plan 里

**这是实测结论，不是推测。** 三路取证的交叉点：

| 取证 | 结论 |
|---|---|
| 本机 `GET /api/v1/models`（这把密钥，逐页翻完） | 518 个模型里与音乐相关的**只有** `fun-music-v1` 与 `fun-music-preview` |
| 官方「选择模型」页的 **音乐生成** 品类 | 展开后同样只有这两个 |
| Fun-Music API 参考的 `model` 字段 | `allowed values: fun-music-v1; fun-music-preview` |

**Token Plan（订阅制）不包含音乐生成。** 它的官方覆盖范围原文是：

> 支持文本生成、图像生成、视频生成、语音识别、实时语音对话等多种模型

（个人版文档另补一项"语音合成"。）音乐生成**不在其中** —— 套餐 Credits 抵扣不到
`fun-music-*`。旁证：订阅专属 Key（`sk-sp-` 前缀）的 FAQ 明确说明，图像/视频这类
**多模态生成模型无法经由 Token Plan 的文本 Base URL 调用**，必须走工具的
Skill / Slash Command / Agent 扩展机制；而官方给出的三个扩展示例恰好是
**文生图、文生视频、语音合成** —— 没有音乐。

两个模型的差异（这决定该申请哪一个）：

| | `fun-music-v1` | `fun-music-preview` |
|---|---|---|
| 单价 | 0.002 元/秒 | 0.005 元/秒 |
| 免费额度 | **无**（控制台显示"不支持开启"） | **1,000 秒**（新人，90 天有效） |
| `gender` 参数 | 支持（男/女声） | **不支持** —— 传了会被拒 |
| `prompt` / `lyrics` | 二选一 | `prompt` **必填**，`lyrics` 可选 |
| 是否邀测 | 是 | 是 |

**结论：先申请 `fun-music-preview`。** 1,000 秒 ≈ 16 分 40 秒，而本项目七首的合计
目标时长约 4–6 分钟 —— 免费额度足够一次成片。`v1` 先放着，等确认音质不满意再申请。

> ⚠️ 给 preview 生成时**不能带 `gender`**。`gen_music.py` 已按模型自动决定是否附带该
> 参数（`supports_gender()`），所以换模型不必改代码：
> `python scripts/gen_music.py --model fun-music-preview`

#### 一条旁路：用 Token Plan 的额度换 BGM

如果**不愿**为音乐单独付费、且已订阅 Token Plan，存在一条绕路：
`wan3.0-video` 是「原生生成音画」的视频模型 —— 官方描述为**原生输出台词、BGM 和音效**，
而**视频生成确实在 Token Plan 的抵扣范围内**。

代价必须说清楚，否则它不算一条建议：

1. 产出是 **mp4** 而不是音频文件，得自己抽音轨（`ffmpeg -vn -acodec copy`）。
2. 粒度是**"视频场景"而非"音乐床"** —— 你描述的是画面，BGM 是副产品，不可无缝循环。
3. 七首里最吃音乐感的两条（要长循环的 `explore`、`lastcall`）几乎拿不到好结果。

所以它只适合"先听个大概气氛"，不适合当最终交付。本项目仍以 `fun-music-preview` 为正路。

---

## 9. 一句话记住这套设计

> **还安全**是古筝，**被逼近**是弦乐，**来不及了**是大鼓；
> 一旦失手，一声锣把这三种心情全部打断。

---

## 10. 程序化回退：不用 API 也有音乐（2026-09-26 加入）

### 10.1 为什么会有这一节

`fun-music-v1` 与 `fun-music-preview` **都未开通**（§8），生成的 mp3 拿不到。
于是游戏本来是**哑的**。玩家要的是"给游戏配上音乐，先不用 api"——那就让浏览器
自己合成：`game/play/procedural.js`。

**它不是一个采样循环，而是一个调度乐团。**

### 10.2 架构：三段文件各管一件事

| 文件 | 职责 | 不做什么 |
|---|---|---|
| `config.js` 的 `PROCEDURAL` + `PROCEDURAL_TRACKS` | 旋钮（电平、包络、张力）与**七段的曲谱数据**（和弦表：根音 + 三和弦质量） | 不出声 |
| `procedural.js` | 把曲谱排成音符、钉在**音频时钟**上、收尾 | 不决定该放哪一首 |
| `music.js` | **唯一的决策点**：这一帧该放哪一段（优先级不变） | 不合成 |

"该放哪一首"永远只有一个答案（`music.js` 的 `update()`），这点与 mp3 路径完全
一致——`procedural.js` 只服从。

### 10.3 三条硬约束

1. **绝不 `new AudioContext()`。** 全仓库只有一个，在 `audio.js`。`music.attach(ctx)`
   是程序化引擎拿到它的**唯一入口**，由 `play.js` 的 `unlockAudio()`（用户手势后）
   调用。这条纪律的动机是实的：两个 context 各跑各的时钟、各占资源。
2. **零请求。** 合成不发任何网络请求，所以 §5 的零 404 铁律天然成立。
3. **前视调度，不跟帧率。** 音符提前钉在 `ctx.currentTime + lookahead` 上。
   `A Tale of Two Clocks`：跟着 `requestAnimationFrame` 走的节拍，会在守卫相遇、
   红包拾取这些吃帧的事件上抖。挂在音频时钟上，游戏再卡，拍子都准。

### 10.4 曲谱长什么样

每段是 `[根音半音偏移, 三和弦质量]` 的序列。三支振荡器：两根微失谐的 saw（合唱
垫底）、一支 triangle（铃，走高音）、一支 sine（低音，根音下一个八度）。张力只给
`danger` / `lastcall`，就是一个整体音高偏置——"紧"，但不是变调。

### 10.5 与 mp3 的关系：等文件来了就自动让位

`music.load()` 先试 manifest。**只要有 mp3，就走第一段**，`procedural.js` 整个
不启动。所以这一节是**过渡**，不是替代——`fun-music-preview` 一旦开通、七首生成
出来，本节的代码就变成一条"永不执行的兜底"。这正是设计意图。

### 10.6 验收

`scripts/verify_music.mjs` 现在 **28 条**（原 19 + 9 条程序化）：
A9.11 起断言"没有 mp3 时走程序化、且零音频请求、且状态机照常"；
A10 用一个 **stub WebAudio** 真正跑 `Procedural`——排程、发 voice、sting、silence
全查一遍。**它证明的不是"好不好听"（那要耳朵），而是"排程对不对、时钟准不准、
停不停得下来"。**

### 10.7 一个顺手修掉的老 bug

`play.js` 的 `musicTick` 原先读 `MUSIC.lowSeconds`——**这个键从来不存在**，
于是 `remaining <= undefined` 恒为 `false`，`lastcall`（"来不及了"那一段）**永远
不可能触发**。`config.js` 的注释白纸黑字写着它应该等于 `FEEL.lowTime`。已改为读
`FEEL.lowTime`，与 HUD 时钟变红是同一个数。这类"键名打错 → 一条 cue 静默死掉"
的 bug，正是 `verify_music` 的 A9.5/A9.14 存在的理由。

---

## 11. 音量修正确认（2026-09-26 加入）

### 11.1 病灶：一条三层衰减的增益链

玩家报告"我没有听到游戏声音，是不是声音太小了"。**不是解锁问题**——`beginRun()`
与 canvas 点击都调 `unlockAudio()`，`ctx` 确实建出来了。问题在增益链上：床的每一
支振荡器要走完四道衰减才到扬声器。

修复前（`explore` 段）：

```
padGain/3 (0.045/3 = 0.015)
  x track.gain (0.48)
  x PROCEDURAL.master (0.40)
  x MUSIC.master (0.55)
  x audio.master (0.35)          <- SFX 的余量，音乐白白再吃一道
= 约 4e-3 峰值
```

4e-3 是什么概念：**把系统音量拉满、把耳朵贴到音箱上，才刚刚有一丝**。
玩家说"听不到"，是准确的描述。

### 11.2 两个独立的原因，两个独立的修法

**原因 A：音乐和音效共用 `audio.master`（0.35）。**
0.35 是给**音效**留的余量——一声 cue 自己的 gain 是 0.4~0.5，乘 0.35 落在 0.15
附近，响而不炸。但配乐不是这个量级，它本来就由六支振荡器乘性叠出来，再被砍
一刀就直接进了听不见的区间。

**修法**：给音乐一条**自己的总线** `audio.musicBus`（gain 1.0），与 SFX 并列挂在
`master` 下。这样：

- 音效电平**一点没变**（`verify_music` A11.2 断言 cue 仍在 0.175）
- 音乐不再吃那 0.35
- **`M` 键仍然是唯一的静音键**：`master.gain = 0` 会同时哑掉两条总线

**原因 B：`procedural.js` 的 `bus` 有两条路到 `dest`。**

```js
this.bus.connect(dest);            // 直连
this.bus.connect(this.filter);     // 经低通
this.filter.connect(dest);         // 低通再到 dest
```

信号在 `dest` 上叠加两次，而且**直连那条绕过了低通**——saw 的全部刺耳高频从旁路
漏出去，"低通让合成声不那么电子蜂鸣"这个设计等于白装。删掉直连那条，路径只剩
`bus -> filter -> dest`（`verify_music` A11.4 用正则守住这一点）。

### 11.3 抬到多少，以及为什么是这个数

| 旋钮 | 修前 | 修后 | 依据 |
|---|---|---|---|
| `PROCEDURAL.master` | 0.40 | **1.0** | 这是引擎自己的天花板，1.0 是自然上限；衰减交给下游 |
| `PROCEDURAL.padGain` | 0.045 | **0.20** | 六支 saw 同发，`padGain/3` 是**每支**的电平 |
| `PROCEDURAL.bellGain` | 0.030 | **0.10** | 铃走高音，人耳敏感，不必给太多 |
| `PROCEDURAL.bassGain` | 0.060 | **0.26** | sine 低音能量大但感官上不显，要给足 |
| `MUSIC.master` | 0.55 | **1.0** | 音乐总线的基准，配合 `musicBus` 独立 |
| `audio.master` | 0.35 | **0.35（不动）** | 音效余量，改了会炸 |

### 11.4 验收：从"算得对"到"真的在响"

这次教训是**行为对了不等于听得见**。原有的 A9/A10 全部在问"该放哪一首、时钟准不
准、停不停得下来"——它们在音量小到 1e-3 的时候**照样全绿**。所以补了两层：

**纸上算（`verify_music.mjs` A11，纯 Node，快）**
用一个**记录 gain 的 stub** 把链条乘出来，断言峰值跨过 5e-3 的可闻下限。
实测 **6.72e-2**，修复前约 4e-3——**抬了约 17 倍**。

**真波形（`verify_play.mjs` 5d，浏览器）**
headless Chrome **没有声卡**，所以用 `AnalyserNode` 去听真实输出只会读到静音——
那是"没有扬声器"，不是"没有信号"（第一次这么写就是这么翻车的）。正确的量具是
`OfflineAudioContext`：让音频引擎把 3 秒渲染成 PCM，直接数采样。实测：

```
132300 frames @ 44.1 kHz
peak 0.2996, RMS 0.0787, 98.3% 非零采样
到扬声器（x0.35）: peak 0.105, RMS 0.0275
```

**98.3% 的采样非零**是关键——它证明这是**持续的信号**，不是一个偶发的 click。

### 11.5 一条容易再犯的坑：模板字符串里的反引号

`scripts/verify_play.mjs` 的断言体是**塞在反引号模板字符串里的 JS**。在里面的
**注释**中写 `` `doorLeft` `` 这类行内代码，会**提前终止外层字符串**，报
`SyntaxError: missing ) after argument list`——而报错位置（`evalAsync(`）离真正的
元凶有几十行。本轮为此返工四次。

**规则**：模板字符串内部一律不用反引号，注释里要提名字就**直接写名字**。
