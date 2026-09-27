# -*- coding: utf-8 -*-
"""
gen_music.py — 用阿里云百炼 fun-music-v1 生成《一寸红》的七首配乐。

设计书见 game/MUSIC.md；本脚本只负责「把 MUSIC.md 里的 prompt 送出去、把音频拿回来」。

密钥从仓库根目录 `配置.yaml` 读取（不写死在源码里）。
接口：POST {BASE}/api/v1/services/audio/music/generation
      model = fun-music-v1，返回 24 小时有效的 OSS URL，随即下载到 assets/audio/。

行为：
  * 已存在的曲目默认跳过（可断点续传），--force 强制重生成。
  * 生成成功才把该曲写入 assets/audio/manifest.json。
    运行时的 music.js 只认这份 manifest —— 没有 manifest 就完全不发 mp3 请求，
    所以「还没生成音乐」的仓库里不会有任何 404 噪声。

用法：
    python scripts/gen_music.py --models       # 列出百炼全部音乐模型（只有两个）+ Token Plan 覆盖范围
    python scripts/gen_music.py --doctor       # 逐个探路两个音乐模型，分清「密钥坏了」与「门没开」
    python scripts/gen_music.py --list         # 打印曲目表
    python scripts/gen_music.py --only menu    # 只生成某一条
    python scripts/gen_music.py --check        # 只校验已下载文件的 mp3 头
    python scripts/gen_music.py                # 生成全部（已存在的跳过）
    python scripts/gen_music.py --force        # 强制全部重生成
    python scripts/gen_music.py --model fun-music-preview   # 换模型生成（preview 有免费额度）
"""
import argparse
import datetime
import json
import os
import re
import ssl
import struct
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CONFIG = os.path.join(ROOT, "配置.yaml")
OUTDIR = os.path.join(ROOT, "assets", "audio")
MANIFEST = os.path.join(OUTDIR, "manifest.json")

# ---------------------------------------------------------------------------
# 百炼「音乐生成」品类下**只有这两个模型**（2026-09-26 实测：这把密钥可见的 518 个
# 模型里，与音乐相关的仅此二者）。两者都是**邀测**模型 —— 能在名册里看见，
# 不等于有权调用；未开通时接口一律返回 403 AccessDenied。
#
#   v1       0.002 元/秒   无免费额度                            支持 gender（男/女声）
#   preview  0.005 元/秒   1,000 秒新人免费额度（90 天有效）      必须传 prompt，无 gender
#
# 想省事：先申请 preview，免费额度足够本项目七首曲子；
# 想音质：申请 v1，单价更便宜且可选男女声。
#
# 另：Token Plan（订阅制）**不包含**音乐生成，它的范围是 文本 / 视觉 / 图像生成 /
#     视频生成 / 语音合成 / 语音识别 / 实时语音对话。详见 show_models()。
# ---------------------------------------------------------------------------
MUSIC_MODELS = [
    {"model": "fun-music-v1", "price": "0.002 元/秒", "free_quota": "无",
     "gender": True},
    {"model": "fun-music-preview", "price": "0.005 元/秒",
     "free_quota": "1,000 秒（新人，90 天）", "gender": False},
]

MODEL = "fun-music-v1"          # 默认用哪个模型生成，可用 --model 覆盖
ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/audio/music/generation"

# ---------------------------------------------------------------------------
# 曲目表 —— 与 game/MUSIC.md 的触发点表一一对应。
#   id      运行时点名用的键（music.js 的 bed / sting 都用它）
#   loop    True = 循环铺底；False = 一次性 sting
#   gain    该曲在混音台上的基准音量（0..1），按曲风动态人工给定
#   when    触发点（写进 manifest，供运行时文档与排查用）
# ---------------------------------------------------------------------------
TRACKS = [
    {
        "id": "menu", "file": "01_menu.mp3", "loop": True, "gain": 0.50,
        "when": "开始页 / 结算页（phase = ready | won | lost 的菜单态）",
        "prompt": (
            "悬疑神秘的中式氛围轻音乐，纯器乐，无人声，不要唱词。古琴与箫为主奏，"
            "配以极轻的电子低音铺底与零星的风铃。缓慢、克制、留白多，"
            "像一间剖开的娃娃屋在夜里静静亮着灯。适合解谜游戏主菜单背景循环。"
            "BPM 70，小调，不出现鼓点，不出现强烈起伏。"
        ),
    },
    {
        "id": "explore", "file": "02_explore.mp3", "loop": True, "gain": 0.40,
        "when": "主玩法循环（phase = playing，且无威胁、剩余 > 30s）",
        "prompt": (
            "低调专注的中式轻电子氛围乐，纯器乐，无人声，不要唱词。拨弦古筝短句循环，"
            "古琴散音点缀，底下是一层缓慢的合成器 pad 与极轻的环境声，比如远处雨声和"
            "木质房屋的轻微吱呀。专注、安静、带一点点不安。适合第一人称探索"
            "找东西时长时间循环播放。BPM 85，无鼓组，动态平缓，不做高潮。"
        ),
    },
    {
        "id": "danger", "file": "03_danger.mp3", "loop": True, "gain": 0.46,
        "when": "守卫逼近（playing 且守卫距离 < 5m，或守卫已察觉/追击）",
        "prompt": (
            "紧张压抑的潜行氛围音乐，纯器乐，无人声，不要唱词。低沉的持续弦乐 tremolo "
            "与心跳般的低频脉冲，偶尔一记金属摩擦音。全程紧绷但不爆发，"
            "像被探照灯扫到时屏住呼吸。适合潜行游戏被追捕时循环。BPM 95，"
            "无旋律主线，以织体制造压力。"
        ),
    },
    {
        "id": "lastcall", "file": "05_lastcall.mp3", "loop": True, "gain": 0.52,
        "when": "最后 30 秒倒计时（playing 且 budget - elapsed <= 30）",
        "prompt": (
            "急促紧张的中式冲刺音乐，纯器乐，无人声，不要唱词。密集的中国大鼓与快板"
            "竹笛短句交替推进，节奏紧迫、层层加码，像倒计时在耳边催命。"
            "BPM 140，小调，情绪紧绷但保持可循环，用于限时游戏最后阶段的冲刺。"
        ),
    },
    {
        "id": "caught", "file": "04_caught.mp3", "loop": False, "gain": 0.62,
        "when": "被守卫抓住（一次性 sting，event.type == 'caught'）",
        "prompt": (
            "一次短促的中式打击乐重音 sting，纯器乐，无人声。大锣一记闷响叠上急促的"
            "琵琶扫弦与低频冲击，尖锐、突然、带惩罚感，末尾快速衰减归于寂静。"
            "时长不超过五秒，用于游戏中被抓住的瞬间反馈。"
        ),
    },
    {
        "id": "win", "file": "06_win.mp3", "loop": False, "gain": 0.58,
        "when": "找齐全部红包（一次性，finish(true)）",
        "prompt": (
            "明亮欢快的中式庆祝小乐段，纯器乐，无人声。竹笛与琵琶奏出上扬的"
            "五声音阶旋律，配轻快的鼓点与铃铛，情绪由释然走向欢欣，末尾干净收束。"
            "时长六到八秒，用于通关结算的胜利反馈。"
        ),
    },
    {
        "id": "lose", "file": "07_lose.mp3", "loop": False, "gain": 0.55,
        "when": "时间耗尽未找齐（一次性，finish(false)）",
        "prompt": (
            "低沉失落的中式收束乐段，纯器乐，无人声。独奏二胡拉出一句下行的"
            "叹息旋律，配以极轻的古琴与低频余韵，情绪遗憾、克制、慢慢淡出。"
            "时长六到八秒，用于游戏失败结算。"
        ),
    },
]

BY_ID = {t["id"]: t for t in TRACKS}


def read_key():
    """从 配置.yaml 里抓出第一个 sk- 开头的 token。

    该文件第一行用了全角冒号（`百炼：`），不是合法 YAML，所以按文本抓取，
    而不是冒险用 yaml.safe_load。
    """
    with open(CONFIG, "r", encoding="utf-8") as f:
        text = f.read()
    m = re.search(r"(sk-[A-Za-z0-9._\-]+)", text)
    if not m:
        raise SystemExit("在 %s 里找不到 sk- 开头的密钥" % CONFIG)
    return m.group(1)


def _post(payload, key, timeout):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(ENDPOINT, data=body, method="POST", headers={
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
    })
    with urllib.request.urlopen(req, timeout=timeout,
                                context=ssl.create_default_context()) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def probe(key):
    payload = {"model": MODEL,
               "input": {"prompt": "一到两秒的单一古琴拨弦，安静，无人声", "gender": "female"}}
    t0 = time.time()
    try:
        data = _post(payload, key, 180)
        print("[probe] OK in %.1fs" % (time.time() - t0))
        print("[probe]", json.dumps(data, ensure_ascii=False)[:1500])
    except urllib.error.HTTPError as e:
        print("[probe] HTTPError", e.code, e.reason)
        print("[probe]", e.read().decode("utf-8", "replace")[:2000])
    except Exception as e:
        print("[probe] EXC", type(e).__name__, e)


def _get_json(url, key, timeout=60):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(req, timeout=timeout,
                                context=ssl.create_default_context()) as r:
        return r.status, json.loads(r.read().decode("utf-8", "replace"))


def _post_status(payload, key, timeout=120):
    """返回 (status, body_dict)。HTTP 错误也当作结果返回，不抛。"""
    try:
        return 200, _post(payload, key, timeout)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:600]}
    except Exception as e:
        return 0, {"exception": "%s: %s" % (type(e).__name__, e)}


def _find_model(key, name, max_pages=12, size=100):
    """分页搜到名字为止。返回 (found, total, pages_read)。

    单查第一页会得到假阴性 —— 名册有 500+ 条且排序与模型新旧有关，
    `fun-music-v1` 就不在第一页里。一个会误报「模型不存在」的量具，
    会把排查引向「换个模型名」的死路，比没有量具更糟。
    """
    total, seen = None, 0
    for p in range(1, max_pages + 1):
        try:
            st, body = _get_json(
                "https://dashscope.aliyuncs.com/api/v1/models?page_no=%d&page_size=%d"
                % (p, size), key)
        except Exception:
            return None, total, p
        out = body.get("output") or {}
        if total is None:
            total = out.get("total")
        ms = out.get("models") or []
        seen += len(ms)
        for m in ms:
            if m.get("model") == name:
                return True, total, p
        if not ms or (total is not None and seen >= total):
            break
    return False, total, p


def doctor(key):
    """四路交叉诊断：把「密钥坏了」和「门没开」分开。

    这是把 2026-09-26 那次排查固化成命令 —— 当时音乐接口报 403 AccessDenied，
    最容易的误诊是「密钥过期」然后白换一把钥匙。真相是密钥好得很，
    是模型没开通、且账户处在「仅用免费额度」模式。
    """
    print("=" * 72)
    print("MUSIC DOCTOR —— 区分「密钥无效」与「权限未开」")
    print("=" * 72)

    # 1) 密钥本身：能不能读到模型名册
    st, body = 0, {}
    try:
        st, body = _get_json(
            "https://dashscope.aliyuncs.com/api/v1/models?page_no=1&page_size=100", key)
        total = (body.get("output") or {}).get("total", "?")
        print("[1] 模型名册      HTTP %s   名称总数 %s   -> 密钥有效" % (st, total))
    except urllib.error.HTTPError as e:
        print("[1] 模型名册      HTTP %s   -> 密钥被拒：这把钥匙无效或地域不对" % e.code)
    except Exception as e:
        print("[1] 模型名册      异常 %s: %s" % (type(e).__name__, e))

    # 2) fun-music-v1 是否在这把钥匙的名册里（必须分页搜，见 _find_model）
    if st == 200:
        found, total, pages = _find_model(key, MODEL)
        listed = found
        print("[2] 名册含 %-14s %s   （翻了 %s 页 / 共 %s 条）"
              % (MODEL, "是" if found else "否", pages, total))

    # 3) 一个便宜的文本模型：用来读出「额度模式」
    st2, b2 = _post_status(
        {"model": "qwen-turbo",
         "input": {"messages": [{"role": "user", "content": "hi"}]}}, key)
    code2 = b2.get("code") or (b2.get("error") or {}).get("code")
    print("[3] 文本模型探针   HTTP %s   code=%s" % (st2, code2))
    free_tier_only = code2 == "AllocationQuota.FreeTierOnly"

    # 4) 逐个音乐模型探路 —— 本平台音乐模型只有两个，必须分别验
    print("[4] 音乐接口探路（本平台音乐模型共 %d 个）" % len(MUSIC_MODELS))
    reach, results = [], {}
    for m in MUSIC_MODELS:
        name = m["model"]
        inp = {"prompt": "极短测试音，一声古琴，纯器乐，无人声"}
        if m["gender"]:
            inp["gender"] = "female"       # gender 仅 fun-music-v1 支持
        st4, b4 = _post_status({"model": name, "input": inp}, key)
        code4 = b4.get("code") or (b4.get("error") or {}).get("code")
        msg4 = (b4.get("message") or (b4.get("error") or {}).get("message") or "")[:110]
        url4 = (((b4.get("output") or {}).get("audio")) or {}).get("url")
        results[name] = (st4, code4)
        print("    %-18s HTTP %-4s code=%-22s %s" % (name, st4, code4, msg4))
        print("      价格 %s ｜ 免费额度 %s" % (m["price"], m["free_quota"]))
        if st4 == 200 and url4:
            reach.append(name)

    print("-" * 72)
    if reach:
        print("裁决：✅ 可生成：%s" % "、".join(reach))
        print("      直接跑  python scripts/gen_music.py --model %s" % reach[0])
        return 0

    codes = set(c for (_s, c) in results.values())
    bad_key = ("InvalidApiKey" in codes or "invalid_api_key" in codes
               or any(s == 401 for (s, _c) in results.values()))
    all_down = bool(results) and all(s == 0 for (s, _c) in results.values())

    if "AccessDenied" in codes:
        print("裁决：⛔ 音乐模型未开通（403 AccessDenied）。密钥是好的 —— 是门没开。")
        print("      两个模型都是邀测，需在控制台逐一申请：")
        print("      1. 模型广场 → 搜 fun-music-preview → 「立即申请」")
        print("         ★ 优先申请它：自带 1,000 秒新人免费额度，够生成本项目全部七首")
        print("      2. 也可申请 fun-music-v1（无免费额度，0.002 元/秒，音质更好且支持男女声）")
    if free_tier_only:
        print("      ⚠️  账户处于「仅使用免费额度」模式且额度已耗尽 —— 这个模式会把所有")
        print("          付费调用挡在门外。已认证用户请关闭「免费额度用完即停」开关；")
        print("          未认证用户需先完成实名认证（未认证时该开关由系统强制开启）。")
    if bad_key:
        print("裁决：⛔ 密钥无效。检查 配置.yaml 里的 sk-... 是否完整、地域是否匹配。")
    if all_down:
        print("裁决：⛔ 连不上（网络/代理）。见 docs：错误码排查。")
    print("-" * 74)
    print("另需知道：Token Plan 订阅**不包含**音乐生成（其范围为 文本/视觉/图像生成/")
    print("视频生成/语音合成/语音识别/实时语音对话）。想用订阅额度出 BGM 的唯一旁路是")
    print("wan3.0-video —— 它原生连台词/BGM/音效一起生成，但产出是 mp4，需自行抽音轨。")
    print("      python scripts/gen_music.py --models    # 看完整对照")
    print("      修好后重跑： python scripts/gen_music.py --doctor")
    print("      完整背景：game/MUSIC.md §8")
    return 1



def model_meta(name):
    for m in MUSIC_MODELS:
        if m["model"] == name:
            return m
    return None


def supports_gender(name):
    """gender 参数仅 fun-music-v1 支持；给 preview 传它会被拒。"""
    m = model_meta(name)
    return bool(m and m["gender"])


def show_models():
    print("=" * 74)
    print("百炼「音乐生成」品类 —— 全网只有这两个模型")
    print("=" * 74)
    print("%-18s %-14s %-24s %s" % ("模型", "价格", "免费额度", "备注"))
    print("-" * 74)
    for m in MUSIC_MODELS:
        extra = "支持 gender（男/女声）" if m["gender"] else "必须传 prompt / 无 gender"
        print("%-18s %-14s %-24s %s" % (m["model"], m["price"], m["free_quota"], extra))
    print("-" * 74)
    print("共同点：两者都是**邀测**模型，须先到控制台「模型广场」申请开通；")
    print("        共用同一接口 POST %s" % ENDPOINT)
    print("        音频 URL 有效期 24 小时，按输出音频秒数计费（输入不计费）。")
    print()
    print("Token Plan（订阅制）覆盖范围：文本 / 视觉 / 图像生成 / 视频生成 / 语音合成 /")
    print("语音识别 / 实时语音对话。**不包含音乐生成** —— 套餐 Credits 抵扣不到这两个模型。")
    print()
    print("若想用订阅额度出 BGM，唯一旁路是视频生成模型：")
    print("  wan3.0-video 原生连台词 / BGM / 音效一起生成（视频生成确在 Token Plan 范围内）")
    print("  代价：产出是 mp4，需自行抽音轨；粒度是「视频场景」而非可循环的音乐床。")


def mp3_ok(path):
    """极轻的 mp3 头校验：ID3 标签，或一个合法的 MPEG 帧同步字。"""
    try:
        with open(path, "rb") as f:
            head = f.read(4)
    except OSError:
        return False
    if len(head) < 3:
        return False
    if head[:3] == b"ID3":
        return True
    return head[0] == 0xFF and (head[1] & 0xE0) == 0xE0


def generate_one(track, key, force=False, model=MODEL):
    dest = os.path.join(OUTDIR, track["file"])
    if os.path.exists(dest) and not force:
        print("  skip (exists): %s" % track["file"])
        return "skip"
    inp = {"prompt": track["prompt"]}
    if supports_gender(model):
        inp["gender"] = "female"       # 仅 fun-music-v1 认识这个参数
    payload = {"model": model, "input": inp}
    print("  -> POST %s   [%s]" % (track["id"], model))
    t0 = time.time()
    try:
        data = _post(payload, key, 600)
    except urllib.error.HTTPError as e:
        print("  !! HTTPError %s: %s" % (e.code, e.read().decode("utf-8", "replace")[:600]))
        return "fail"
    except Exception as e:
        print("  !! EXC %s %s" % (type(e).__name__, e))
        return "fail"

    audio = (((data.get("output") or {}).get("audio")) or {})
    url = audio.get("url")
    if not url:
        print("  !! 响应里没有 output.audio.url：",
              json.dumps(data, ensure_ascii=False)[:900])
        return "fail"

    try:
        with urllib.request.urlopen(url, timeout=300,
                                    context=ssl.create_default_context()) as r:
            blob = r.read()
    except Exception as e:
        print("  !! 下载失败 %s %s" % (type(e).__name__, e))
        return "fail"

    with open(dest, "wb") as f:
        f.write(blob)
    ok = mp3_ok(dest)
    print("  ok %s  %.1f KB  mp3头:%s  (%.1fs)"
          % (track["file"], len(blob) / 1024.0, "OK" if ok else "存疑", time.time() - t0))
    return "ok"


def write_manifest(model=MODEL):
    """只把「磁盘上确实存在且通过 mp3 头校验」的曲目写进 manifest。

    一首都没有时**不写 manifest，并删掉旧的** —— 因为运行时的约定是
    「没有 manifest = 音乐关闭」。若留一份 `{"tracks": []}` 在那里，
    「还没生成」就会伪装成「音乐坏了」，而这两件事的排查方向完全相反。
    """
    have = []
    for t in TRACKS:
        dest = os.path.join(OUTDIR, t["file"])
        if os.path.exists(dest) and mp3_ok(dest):
            have.append({
                "id": t["id"], "file": t["file"], "loop": t["loop"],
                "gain": t["gain"], "when": t["when"],
                "bytes": os.path.getsize(dest),
            })
    if not have:
        if os.path.exists(MANIFEST):
            os.remove(MANIFEST)
        print("manifest: 0/%d 首可用 —— 无可用曲目，已移除 manifest（音乐保持关闭）"
              % len(TRACKS))
        return 0

    manifest = {
        "model": model,
        "generated": datetime.datetime.now().isoformat(timespec="seconds"),
        "tracks": have,
    }
    os.makedirs(OUTDIR, exist_ok=True)
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print("manifest: %d/%d 首可用 -> %s" % (len(have), len(TRACKS), MANIFEST))
    return len(have)


def check(model=MODEL):
    bad = 0
    for t in TRACKS:
        dest = os.path.join(OUTDIR, t["file"])
        if not os.path.exists(dest):
            print("%-9s %-18s 缺失" % (t["id"], t["file"]))
            bad += 1
            continue
        ok = mp3_ok(dest)
        print("%-9s %-18s %8.1f KB  mp3头:%s"
              % (t["id"], t["file"], os.path.getsize(dest) / 1024.0, "OK" if ok else "存疑"))
        if not ok:
            bad += 1
    write_manifest(model)
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doctor", action="store_true", help="四路交叉诊断：分清密钥问题与权限问题")
    ap.add_argument("--probe", action="store_true", help="只发一次最小请求验证权限")
    ap.add_argument("--list", action="store_true", help="打印曲目表")
    ap.add_argument("--check", action="store_true", help="校验已下载文件并重写 manifest")
    ap.add_argument("--only", default=None, help="只生成某一条（用 id）")
    ap.add_argument("--force", action="store_true", help="强制重生成")
    ap.add_argument("--models", action="store_true", help="列出百炼全部音乐模型 + Token Plan 覆盖范围")
    ap.add_argument("--model", default=MODEL, help="用哪个音乐模型生成（默认 %s）" % MODEL)
    a = ap.parse_args()

    if a.models:
        show_models()
        return

    if a.list:
        for t in TRACKS:
            kind = "循环" if t["loop"] else "一次性"
            print("%-9s %-18s %-4s gain=%.2f  %s"
                  % (t["id"], t["file"], kind, t["gain"], t["when"]))
        return

    if a.check:
        sys.exit(1 if check(a.model) else 0)

    key = read_key()
    print("key:", key[:14] + "..." + key[-4:], "(%d chars)" % len(key))

    if a.doctor:
        sys.exit(doctor(key))

    if a.probe:
        probe(key)
        return

    known_models = [m["model"] for m in MUSIC_MODELS]
    if a.model not in known_models:
        raise SystemExit("未知音乐模型：%s（可选：%s）"
                         % (a.model, "、".join(known_models)))
    print("model:", a.model,
          "（%s）" % model_meta(a.model)["free_quota"])

    os.makedirs(OUTDIR, exist_ok=True)
    if a.only and a.only not in BY_ID:
        raise SystemExit("未知曲目 id: %s（可选：%s）" % (a.only, ", ".join(BY_ID)))
    tracks = [BY_ID[a.only]] if a.only else TRACKS

    stats = {"ok": 0, "skip": 0, "fail": 0}
    for t in tracks:
        print("[%s] %s" % (t["id"], t["when"]))
        stats[generate_one(t, key, a.force, a.model)] += 1

    n = write_manifest(a.model)
    print("完成：新增/覆盖 %d，跳过 %d，失败 %d；manifest 现有 %d 首。"
          % (stats["ok"], stats["skip"], stats["fail"], n))
    sys.exit(1 if stats["fail"] else 0)


if __name__ == "__main__":
    main()
