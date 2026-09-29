# DSH 鲸鱼娘桌宠 · Steam Deck 插件

把 **DSH（DeepSeek Harness）** 和 **鲸鱼娘 Live2D 桌宠** 一起搬进 Steam Deck 的 Game Mode：
截图问攻略、语音提问、桌宠悬浮在游戏画面上、大模型 API 随时可换。

> 这是 [dsh-whale-girl-live2d](https://github.com/Andersen216/dsh-whale-girl-live2d) 的 Steam Deck 移植外壳：
> 桌宠本体还是那份 DSH 插件，本仓库负责在 Deck 上把 DSH 跑起来、把她送到屏幕上、再给 Game Mode 补上截图和语音。

## 它做什么

| 需求 | 实现 |
|---|---|
| 截图 | 后端按 `grim → spectacle → 桌面门户 → Steam 截图目录` 顺序尝试；Game Mode 下按 `Steam + R1` 截图后自动抓最新一张 |
| 语音输入 | `pw-record` 录音 → 可配置的 OpenAI 兼容 `/audio/transcriptions` 转写 → 直接问她 |
| 鲸鱼娘语气 | 人设取自她本体的 `skill/SKILL.md`（称呼「主人」、自称「人家/本鲸」、傲娇嘴甜、贪吃白米），
同时写进 `system-prompt` 补丁**和**她工作区的 `AGENTS.md`（后者才不会被 agent preset 遮蔽，实测过） |
| 游戏大师职责 | 同一段人设里的职责部分：看图 → 判断卡点 → 搜攻略 → 只给 2-3 步可执行建议 |
| 截图搜攻略 | 走她自己的通道 `POST /dsh-pet/say`（官方 sessionController，有记忆、她窗口里同步说话+做表情），回复从 `/dsh-pet/events` 的 SSE 里取；不通时退回 `headless` 一次性问答 |
| 自动补搜 | `auto_search` 三档：`strong`（默认：先判断卡点 → 至少搜一轮 → 只给 2-3 步 + 说明来源）/ `normal` / `off`；实测强模式下她会自己 `web_search` + `web_fetch` 核实 |
| 实时反馈 | 她把话说着说着，QAM 里边长字（`stream`）；调工具时显示「💭 在搜攻略…」（`activity`） |
| 常驻悬浮 | Electron 透明置顶窗，鼠标不在她身上时自动点击穿透（Game Mode 由 gamescope 合成） |
| 换模型 API | QAM 设置页：provider / 模型名 / API Base / API Key，写进 profile 补丁 + `~/.dsh/.credentials.yaml` |

## 快速开始（在 Deck 上）

**装插件（两种都行）**

* 从 Release 直接下载：
  [`dsh-deck-pet.zip`](https://github.com/228co/dsh-deck-pet/releases/latest/download/dsh-deck-pet.zip)
  → Decky 设置 → **Install Plugin from ZIP file**
* 或者在 Decky 设置里 **Install Plugin from URL**，粘这个直链（以后发新版直接覆盖安装）：
  `https://github.com/228co/dsh-deck-pet/releases/latest/download/dsh-deck-pet.zip`

**然后四步用起来**

1. 装好 [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader)，设置里打开 **Developer Mode**
2. 打开 QAM 里的「DSH 鲸鱼娘桌宠」，按顺序点：
   - ① 安装运行时（Node + dsh CLI，约 60 MB）
   - ② 安装鲸鱼娘插件到 web profile（会去 GitHub 拉 `dsh-whale-girl-live2d`）
   - ③ 启动 DSH 服务（`127.0.0.1:3080`）
   - ④ 让桌宠悬浮在屏幕上（第一次会下 Electron，约 100 MB）
3. 想打字聊天：QAM 里点「在 QAM 里看她（完整界面）」
4. 想换模型：QAM 设置页里改 provider / 模型名 / API Base / API Key

详细步骤、截图/语音用法、换 API、排错见 **[docs/安装与使用.md](docs/安装与使用.md)**；
能做到什么程度、哪些必须上机验证见 **[docs/架构与限制.md](docs/架构与限制.md)**。

## 目录结构

```
dsh-deck-pet/
├── plugin.json          # Decky 插件元数据（api_version 1，不带 _root）
├── main.py              # Python 后端：运行时/服务/截图/语音/悬浮
├── src/index.tsx        # QAM 前端（React，单文件 bundle）
├── overlay/             # 透明置顶的悬浮外壳（Electron）
├── defaults/            # 默认设置 + 默认人设
├── scripts/             # 构建 / 推到 Deck 的脚本
└── docs/                # 安装使用 & 架构限制
```

## 本地构建

```bash
pnpm install
pnpm run build          # 产出 dist/index.js
bash scripts/build.sh   # 再打成符合 Decky 规范的 zip（out/dsh-deck-pet.zip）
```

## 许可

MIT（见 [LICENSE](LICENSE)）。Live2D 模型素材非商业、CC BY-NC-SA 4.0，版权归原作者，不在本仓库许可范围内。
