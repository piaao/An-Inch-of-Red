# 素材授权与出处

本仓库的 3D 素材**全部来自第三方**，此处留档，以正出处。

---

## Kenney Furniture Kit（2.0）

- 作者／分发：**Kenney** · <https://www.kenney.nl>
- 素材页：<https://kenney.nl/assets/furniture-kit>
- 制作日期：2018-10-20
- 授权：**Creative Commons Zero（CC0 1.0 公有领域）**
  <https://creativecommons.org/publicdomain/zero/1.0/>

> This content is free to use in personal, educational and commercial projects.
> Support us by crediting Kenney or www.kenney.nl (this is not mandatory)

**授权原文**（逐字复制，另有一份随素材存放）：
[`assets/LICENSE-kenney.txt`](assets/LICENSE-kenney.txt)

```
	Furniture Kit (2.0)

	Created/distributed by Kenney (www.kenney.nl)
	Creation date: 20-10-2018 16:21

			------------------------------

	License: (Creative Commons Zero, CC0)
	http://creativecommons.org/publicdomain/zero/1.0/

	This content is free to use in personal, educational and commercial projects.

	Support us by crediting Kenney or www.kenney.nl (this is not mandatory)

			------------------------------

	Donate:   http://support.kenney.nl
	Request:  http://request.kenney.nl
	Patreon:  http://patreon.com/kenney/

	Follow on Twitter for updates:
	http://twitter.com/KenneyNL
```

### 仓库里留了什么、没留什么

本仓库**只收编了要用的那 140 个 `.glb`**（`assets/models/`，1.87 MB），
没有把原始套件整包放进来 —— 原始包是同一批 140 个模型的 5 种格式
（GLB / DAE / FBX / OBJ+MTL / STL）加上 700 张预览图，整包 16.85 MB，对运行和迭代都是重复。

这个取舍是**实测**过的，不是估计：

- 套件的 `Models/GLTF format/` 与 `assets/models/` 是 **140 : 140**，
  **零缺口、零多余**（按文件名逐个求差集）；
- 两者**逐字节相同**（140/140 个文件 SHA-256 一致）；
- 因此解析模型的自检工具已经改读游戏自己收编的那一份
  （`scripts/probe_kit.py` / `probe_world.py` / `derive_redbox.py` 里的 `KIT` 指向
  `assets/models/`）—— 删掉原始套件，工具链一样能跑。

如果以后要换素材：从上面的素材页重新下载即可，CC0 允许任意用途。
被收编的 140 个模型的量测结果留在 `data/`（见该目录与
[`scripts/README.md`](scripts/README.md)）。

---

## Three.js

`vendor/` 内的 Three.js 及其 addons（OrbitControls / GLTFLoader /
BufferGeometryUtils）由 MIT 授权，版权归 Three.js 作者所有：
<https://github.com/mrdoob/three.js> · <https://github.com/mrdoob/three.js/blob/dev/LICENSE>
