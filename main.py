"""
DSH 鲸鱼娘桌宠 · Decky Loader 后端

职责：
  1. 在 Steam Deck 上把 DSH（DeepSeek Harness）的运行时准备好：Node + dsh CLI + pnpm
  2. 把鲸鱼娘 Live2D 插件装进 DSH 的 web profile，并按设置生成「游戏大师」人设补丁
  3. 起停 `dsh --profile web`（默认 127.0.0.1:3080，桌宠外壳/悬浮窗都认这个端口）
  4. 截图（grim / spectacle / 桌面门户 / Steam 截图目录）/ 录音（pw-record）/ 语音转写
  5. 把截图或问题交给 DSH agent（headless），必要时让它联网搜攻略
  6. 起停悬浮桌宠（Electron 透明置顶窗口）

所有网络与大文件都落在 DECKY_PLUGIN_RUNTIME_DIR 下；设置落在 DECKY_PLUGIN_SETTINGS_DIR。
不往 DECKY_HOME 之外写东西（除了 DSH 自己的 ~/.dsh）。
"""

from __future__ import annotations

import asyncio
import glob
import json
import os
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import decky  # type: ignore  # Decky Loader 注入

# ──────────────────────────────────────────────────────────────────────────────
# 路径与常量
# ──────────────────────────────────────────────────────────────────────────────

PLUGIN_DIR = getattr(decky, "DECKY_PLUGIN_DIR", os.path.dirname(os.path.abspath(__file__)))
SETTINGS_DIR = getattr(decky, "DECKY_PLUGIN_SETTINGS_DIR", os.path.join(PLUGIN_DIR, "settings"))
RUNTIME_DIR = getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", os.path.join(PLUGIN_DIR, "runtime"))
USER_HOME = getattr(decky, "DECKY_USER_HOME", os.path.expanduser("~"))

DSH_HOME = os.path.join(USER_HOME, ".dsh")
DSH_WORKSPACE = os.path.join(USER_HOME, "dsh-deck-workspace")
NODE_VERSION = "v24.18.1"
NODE_DIST = f"https://nodejs.org/dist/{NODE_VERSION}/node-{NODE_VERSION}-linux-x64.tar.xz"

PET_PLUGIN_SPEC = "github:Andersen216/dsh-whale-girl-live2d"

# 她用的工具 → 给主人看的说法（QAM 上显示成「她在搜攻略…」这种）
TOOL_LABELS: Dict[str, str] = {
    "web_search": "在搜攻略",
    "web_fetch": "在翻攻略页",
    "read": "在看图/读文件",
    "read_image": "在看图",
    "glob": "在找文件",
    "grep": "在翻内容",
    "bash": "在跑命令",
    "pwsh": "在跑命令",
    "write": "在写文件",
    "edit": "在改文件",
    "todo_write": "在列计划",
    "subagent": "在喊帮手",
    "workflow": "在开流水线",
    "ask_user_question": "在等主人回话",
}

DEFAULT_SETTINGS: Dict[str, Any] = {
    "model_provider": "deepseek-official",
    "model_name": "deepseek-flash",
    "api_base": "",
    "api_key": "",
    "asr_provider": "openai-compatible",
    "asr_base": "https://api.openai.com/v1",
    "asr_key": "",
    "asr_language": "zh",
    "asr_model": "whisper-1",
    # 鲸鱼娘的语气取自她本体的 skill/SKILL.md：
    #   称呼「主人」，自称「人家」/「本鲸」，傲娇嘴甜、聪明但懒、贪吃白米、不能被叫胖。
    # 下面是「她的语气 + 游戏大师职责」的合成版。
    "persona": (
        "你是「鲸鱼娘」，现在住在主人的 Steam Deck 上，身份是游戏大师。\n"
        "\n"
        "【语气 · 必须一直保持】\n"
        "- 称呼主人为「主人」，自称「人家」或「本鲸」；\n"
        "- 傲娇嘴甜、聪明但懒、贪吃白米；不能被叫胖（被说胖要立刻炸毛反驳）；\n"
        "- 话短、口语化、有情绪起伏，像在跟主人撒娇的搭子，不写说明书、不用小标题；\n"
        "- 可以用一点颜文字或「哼」「欸」「嘛」这类语气词，但别刷屏、别每句都卖萌；\n"
        "- 报告结果时先给结论（能过/不能过、按哪个键），再补一句俏皮话。\n"
        "\n"
        "【职责 · 游戏大师】\n"
        "- 主人发来游戏截图时：先说你在图里看到了什么（界面/角色/关卡/BOSS/道具/数值），"
        "判断他卡在哪一步，再主动联网搜攻略（web_search），只讲最关键的 2-3 步做法；\n"
        "- 不确定就直说「人家看不出来」，不许编造；\n"
        "- 给建议优先给可执行的下一步（按哪个键、去哪、躲什么）。"
    ),
    "port": 3080,
    "dsh_version": "next",
    "auto_start": True,
    "overlay_scale": 0.7,
    # 收到截图后要不要主动联网搜攻略：
    #   strong = 先看图判断游戏/关卡 → 至少搜一轮 → 回答里带来源
    #   normal = 看情况搜（默认）
    #   off    = 只按图说话，不联网
    "auto_search": "strong",
    # 问答走哪条路：
    #   pet      = 走她自己的 /dsh-pet/say + /dsh-pet/events（有上下文、她的窗口里也会说话）
    #   headless = 老的一次性 headless profile（无记忆），作为兜底
    "ask_channel": "pet",
    "reply_timeout": 180,
}


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class Plugin:
    """Decky Loader 反射加载这个类；所有对外方法必须是 async。"""

    # ── 生命周期 ──────────────────────────────────────────────────────────────

    async def _main(self) -> None:
        self.loop = asyncio.get_event_loop()
        self.settings: Dict[str, Any] = self._load_settings()
        self.server_proc: Optional[asyncio.subprocess.Process] = None
        self.overlay_proc: Optional[asyncio.subprocess.Process] = None
        self.rec_proc: Optional[asyncio.subprocess.Process] = None
        self.rec_path: Optional[str] = None
        self.busy: Optional[str] = None
        self.last_error: Optional[str] = None
        self.web_token: Optional[str] = None
        self.answers: List[Dict[str, str]] = []
        self.lock = asyncio.Lock()
        # 她自己的通道：SSE 事件流 + /dsh-pet/say
        self.pet_task: Optional[asyncio.Task] = None
        self.pending_reply: Optional[asyncio.Future] = None
        self.stream_buf: List[str] = []
        self.stream_emit_at = 0.0
        self.pet_busy = False
        for d in (SETTINGS_DIR, RUNTIME_DIR, DSH_WORKSPACE, self.screenshots_dir, self.voice_dir):
            os.makedirs(d, exist_ok=True)
        decky.logger.info("dsh-deck-pet ready: plugin_dir=%s runtime=%s", PLUGIN_DIR, RUNTIME_DIR)
        if self.settings.get("auto_start"):
            self.loop.create_task(self._autostart())

    async def _unload(self) -> None:
        await self._stop_process("server")
        await self._stop_process("overlay")
        if self.pet_task:
            self.pet_task.cancel()
        decky.logger.info("dsh-deck-pet unloaded")

    async def _uninstall(self) -> None:
        decky.logger.info("dsh-deck-pet uninstalled (runtime files kept under %s)", RUNTIME_DIR)

    async def _migration(self) -> None:
        # 目标目录已存在就不动（幂等）
        return

    # ── 小工具 ────────────────────────────────────────────────────────────────

    @property
    def screenshots_dir(self) -> str:
        """截图放她会话的工作区里：她能用相对路径直接读到，模型也更容易定位。"""
        return os.path.join(DSH_WORKSPACE, "screenshots")

    @property
    def voice_dir(self) -> str:
        return os.path.join(RUNTIME_DIR, "voice")

    def _settings_path(self) -> str:
        return os.path.join(SETTINGS_DIR, "settings.json")

    def _load_settings(self) -> Dict[str, Any]:
        data = dict(DEFAULT_SETTINGS)
        for path in (os.path.join(PLUGIN_DIR, "defaults", "defaults.json"), self._settings_path()):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    merged = json.load(fh)
                if isinstance(merged, dict):
                    data.update(merged)
            except FileNotFoundError:
                pass
            except Exception as exc:  # noqa: BLE001
                decky.logger.warning("settings %s unreadable: %s", path, exc)
        return data

    def _save_settings(self) -> None:
        tmp = self._settings_path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(self.settings, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, self._settings_path())

    def _runtime_bin(self, name: str) -> Optional[str]:
        for candidate in (
            os.path.join(RUNTIME_DIR, "node", "bin", name),
            os.path.join(RUNTIME_DIR, "dsh-tree", "bin", name),
        ):
            if os.path.exists(candidate):
                return candidate
        return None

    def _env(self) -> Dict[str, str]:
        env = dict(os.environ)
        extra = [
            os.path.join(RUNTIME_DIR, "node", "bin"),
            os.path.join(RUNTIME_DIR, "dsh-tree", "bin"),
        ]
        env["PATH"] = os.pathsep.join(extra + [env.get("PATH", "")])
        env["HOME"] = USER_HOME
        env["DSH_HOME"] = DSH_HOME
        env.setdefault("LANG", "zh_CN.UTF-8")
        return env

    async def _shell(self, args: List[str], cwd: Optional[str] = None, timeout: int = 600) -> Dict[str, Any]:
        """跑一条命令并收回输出（不阻塞事件循环）。"""
        decky.logger.info("run: %s", " ".join(args))
        proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=cwd or DSH_WORKSPACE,
            env=self._env(),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            return {"code": 124, "out": f"timeout after {timeout}s"}
        return {"code": proc.returncode or 0, "out": (out or b"").decode("utf-8", "replace")}

    def _status(self) -> Dict[str, Any]:
        node = self._runtime_bin("node")
        dsh = self._runtime_bin("dsh")
        port = int(self.settings.get("port") or 3080)
        return {
            "runtime_ready": bool(node and dsh),
            "node": node,
            "dsh": dsh,
            "plugin_installed": self._pet_plugin_installed(),
            "server_running": bool(self.server_proc and self.server_proc.returncode is None),
            "server_port": port,
            "pet_url": self._pet_url(),
            "overlay_running": bool(self.overlay_proc and self.overlay_proc.returncode is None),
            "recording": bool(self.rec_proc and self.rec_proc.returncode is None),
            "busy": self.busy,
            "last_error": self.last_error,
            "pet_busy": self.pet_busy,
            "pet_token": bool(self._pet_token()),
            "ask_channel": str(self.settings.get("ask_channel") or "pet"),
        }

    async def _emit_state(self) -> None:
        try:
            await decky.emit("dsh_deck_pet/state", self._status())
        except Exception as exc:  # noqa: BLE001
            decky.logger.debug("emit state failed: %s", exc)

    async def _log(self, text: str) -> None:
        decky.logger.info(text)
        try:
            await decky.emit("dsh_deck_pet/log", text)
        except Exception:  # noqa: BLE001
            pass

    async def _push_answer(self, kind: str, text: str) -> None:
        item = {"at": _now(), "kind": kind, "text": text}
        self.answers = ([item] + self.answers)[:5]
        try:
            await decky.emit("dsh_deck_pet/answer", item)
        except Exception:  # noqa: BLE001
            pass

    # ── RPC：状态与设置 ───────────────────────────────────────────────────────

    async def get_state(self) -> Dict[str, Any]:
        return {"status": self._status(), "settings": self.settings, "answers": self.answers}

    async def save_settings(self, patch: Dict[str, Any]) -> Dict[str, Any]:
        if isinstance(patch, dict):
            for key, value in patch.items():
                if key in DEFAULT_SETTINGS:
                    self.settings[key] = value
        self._save_settings()
        self._write_model_patch()
        self._write_persona_patch()
        await self._emit_state()
        return self.settings

    # ── RPC：运行时安装 ───────────────────────────────────────────────────────

    async def install_runtime(self) -> Dict[str, Any]:
        if self.busy:
            return self._status()
        self.loop.create_task(self._install_runtime_task())
        return self._status()

    async def _install_runtime_task(self) -> None:
        async with self.lock:
            self.busy = "安装运行时…"
            self.last_error = None
            await self._emit_state()
            try:
                await self._ensure_node()
                await self._ensure_dsh()
                await self._log("运行时就绪 ✅")
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"运行时安装失败：{exc}"
                decky.logger.error("runtime install failed: %s", exc)
            finally:
                self.busy = None
                await self._emit_state()

    async def _ensure_node(self) -> None:
        node = self._runtime_bin("node")
        if node:
            return
        target = os.path.join(RUNTIME_DIR, "node")
        await self._log(f"下载 Node {NODE_VERSION} …")
        os.makedirs(target, exist_ok=True)
        with tempfile.TemporaryDirectory() as tmp:
            archive = os.path.join(tmp, "node.tar.xz")
            await asyncio.to_thread(self._download, NODE_DIST, archive, "Node")
            await self._log("解包 Node …")
            await asyncio.to_thread(self._extract_node, archive, target)
        if not self._runtime_bin("node"):
            raise RuntimeError("Node 解包后仍找不到 bin/node")

    @staticmethod
    def _download(url: str, dest: str, label: str) -> None:
        with urllib.request.urlopen(url, timeout=120) as resp, open(dest, "wb") as fh:
            total = int(resp.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = resp.read(1 << 20)
                if not chunk:
                    break
                fh.write(chunk)
                done += len(chunk)
                if total and done % (8 << 20) < (1 << 20):
                    decky.logger.info("%s: %d%%", label, int(done * 100 / total))

    @staticmethod
    def _extract_node(archive: str, target: str) -> None:
        with tarfile.open(archive, "r:xz") as tar:
            members = tar.getmembers()
            root = members[0].name.split("/")[0] if members else ""
            for member in members:
                rel = member.name[len(root) + 1 :] if member.name.startswith(root + "/") else ""
                if not rel:
                    continue
                member.name = rel
                tar.extract(member, target, filter="data")

    async def _ensure_dsh(self) -> None:
        if self._runtime_bin("dsh"):
            return
        node = self._runtime_bin("node")
        if not node:
            raise RuntimeError("先装 Node")
        npm = os.path.join(os.path.dirname(node), "npm")
        prefix = os.path.join(RUNTIME_DIR, "dsh-tree")
        os.makedirs(prefix, exist_ok=True)
        version = str(self.settings.get("dsh_version") or "next")
        await self._log(f"安装 dsh CLI（@deepseek-ai/dsh@{version}）…")
        res = await self._shell(
            [npm, "install", "-g", "--prefix", prefix, f"@deepseek-ai/dsh@{version}", "pnpm@11"],
            cwd=RUNTIME_DIR,
            timeout=1800,
        )
        if res["code"] != 0 or not self._runtime_bin("dsh"):
            raise RuntimeError(f"npm 安装 dsh 失败：{res['out'][-500:]}")

    # ── RPC：把鲸鱼娘插件装进 web profile ─────────────────────────────────────

    def _pet_plugin_installed(self) -> bool:
        manifest = os.path.join(DSH_HOME, "profiles", "web", "package.json")
        try:
            with open(manifest, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            return "dsh-whale-girl-live2d" in (data.get("dependencies") or {})
        except Exception:  # noqa: BLE001
            return False

    async def install_pet_plugin(self) -> Dict[str, Any]:
        if self.busy:
            return self._status()
        self.loop.create_task(self._install_pet_task())
        return self._status()

    async def _install_pet_task(self) -> None:
        async with self.lock:
            self.busy = "安装鲸鱼娘插件…"
            self.last_error = None
            await self._emit_state()
            try:
                await self._ensure_node()
                await self._ensure_dsh()
                if self._pet_plugin_installed():
                    await self._log("鲸鱼娘插件已经装过了")
                else:
                    dsh = self._runtime_bin("dsh")
                    node = self._runtime_bin("node")
                    assert dsh and node
                    await self._log(f"dsh plugin --profile web add {PET_PLUGIN_SPEC}")
                    res = await self._shell(
                        [node, dsh, "plugin", "--profile", "web", "add", PET_PLUGIN_SPEC], timeout=1800
                    )
                    if res["code"] != 0:
                        raise RuntimeError(res["out"][-800:])
                    await self._log("插件装好了 ✅")
                self._write_persona_patch()
                self._write_model_patch()
            except Exception as exc:  # noqa: BLE001
                self.last_error = f"安装桌宠插件失败：{exc}"
                decky.logger.error("install pet plugin failed: %s", exc)
            finally:
                self.busy = None
                await self._emit_state()

    # ── profile 补丁：人设 + 模型 ─────────────────────────────────────────────

    def _patch_path(self, name: str) -> str:
        return os.path.join(RUNTIME_DIR, name)

    def _write_persona_patch(self) -> None:
        persona = str(self.settings.get("persona") or "").strip()
        if not persona:
            return
        body = "\n".join("      " + line for line in persona.splitlines())
        text = (
            "# 由 dsh-deck-pet 生成：游戏大主人设（改设置会覆盖这一份）\n"
            "- id: system-prompt\n"
            "  config:\n"
            "    personaPrefix: |\n"
            f"{body}\n"
        )
        with open(self._patch_path("persona.patch.yml"), "w", encoding="utf-8") as fh:
            fh.write(text)
        self._write_workspace_instructions(persona)
        self._write_credentials()

    def _write_workspace_instructions(self, persona: str) -> None:
        """
        把人设同时写进桌宠工作区的 AGENTS.md。

        为什么要两份：web profile 的 agent preset 里有作用域内的 `persona` 行，
        按 DSH 的规则它会遮蔽全局 `system-prompt.personaPrefix`（实测过：只打补丁时
        她还是用通用口气说话）。而 dsh-agent-instructions 会把「会话工作目录下的
        AGENTS.md」作为工作区指引注入每一轮，不受 preset 遮蔽 —— 这条路实测有效。
        只写在她自己的工作区里，不碰 ~/.dsh/AGENTS.md，不影响主人其他会话。
        """
        os.makedirs(DSH_WORKSPACE, exist_ok=True)
        path = os.path.join(DSH_WORKSPACE, "AGENTS.md")
        begin, end = "<!-- dsh-deck-pet:persona 开始（插件自动生成，勿手改） -->", "<!-- dsh-deck-pet:persona 结束 -->"
        block = (
            f"{begin}\n"
            "# 你是「鲸鱼娘」（Steam Deck 桌宠）\n\n"
            "下面这段是你的固定人设，任何情况下都按它说话，优先级高于通用编码助手风格：\n\n"
            f"{persona}\n"
            f"{end}\n"
        )
        old = ""
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                old = fh.read()
        if begin in old and end in old:
            head, rest = old.split(begin, 1)
            _, tail = rest.split(end, 1)
            new = head + block + tail.lstrip("\n")
        else:
            new = (old.rstrip() + "\n\n" if old.strip() else "") + block
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(new)
        os.replace(tmp, path)

    def _write_model_patch(self) -> None:
        provider = str(self.settings.get("model_provider") or "")
        model = str(self.settings.get("model_name") or "")
        patch = [
            "# 由 dsh-deck-pet 生成：默认模型（改设置会覆盖这一份）",
            "- id: agent-default-model",
            "  config:",
            f"    provider: {json.dumps(provider)}",
            f"    model: {json.dumps(model)}",
        ]
        if self.settings.get("api_base"):
            patch.append(f"    baseURL: {json.dumps(self.settings['api_base'])}")
        with open(self._patch_path("model.patch.yml"), "w", encoding="utf-8") as fh:
            fh.write("\n".join(patch) + "\n")
        self._write_credentials()

    def _write_credentials(self) -> None:
        """把 API key 写进 DSH 自己的凭据文件（只在本地，权限 600）。"""
        key = str(self.settings.get("api_key") or "").strip()
        if not key:
            return
        os.makedirs(DSH_HOME, exist_ok=True)
        path = os.path.join(DSH_HOME, ".credentials.yaml")
        doc = {
            "version": 1,
            "refs": {"DEEPSEEK_API_KEY": "deepseek-api-key"},
            "records": {
                "deepseek-api-key": {
                    "kind": "api-key",
                    "payload": {"provider": "deepseek"},
                    "version": 1,
                    "secret": key,
                }
            },
        }
        try:
            import yaml  # SteamOS 自带 PyYAML；没有就退化成 JSON-ish 文本

            text = yaml.safe_dump(doc, allow_unicode=True, sort_keys=False)
        except Exception:  # noqa: BLE001
            text = json.dumps(doc, ensure_ascii=False, indent=2)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.chmod(path, 0o600)

    # ── RPC：服务起停 ─────────────────────────────────────────────────────────

    async def start_server(self) -> Dict[str, Any]:
        if self.server_proc and self.server_proc.returncode is None:
            return self._status()
        node, dsh = self._runtime_bin("node"), self._runtime_bin("dsh")
        if not node or not dsh:
            self.last_error = "运行时还没装好"
            await self._emit_state()
            return self._status()
        os.makedirs(DSH_WORKSPACE, exist_ok=True)
        self._write_persona_patch()
        self._write_model_patch()
        port = str(int(self.settings.get("port") or 3080))
        # ⚠️ 顺序要紧：--profile/--patch 是 launcher 自己的旗标，必须放在最前；
        #    --no-open/--port 属于 web app 的「内部参数」，第一个不被 launcher 认识的
        #    token 之后的所有东西都会原样转交给 app，所以它们只能排在后面。
        args = [
            node,
            dsh,
            "--profile",
            "web",
            "--patch",
            self._patch_path("persona.patch.yml"),
            "--patch",
            self._patch_path("model.patch.yml"),
            "--no-open",
            "--port",
            port,
        ]
        log_path = os.path.join(RUNTIME_DIR, "dsh-web.log")
        log = open(log_path, "ab", buffering=0)  # noqa: SIM115
        decky.logger.info("starting dsh web: %s", " ".join(args))
        self.server_proc = await asyncio.create_subprocess_exec(
            *args,
            cwd=DSH_WORKSPACE,
            env=self._env(),
            stdout=log,
            stderr=log,
        )
        self.busy = "启动 DSH 服务…"
        await self._emit_state()
        ok = await self._wait_http(port, 90)
        self.busy = None
        if not ok:
            self.last_error = f"服务 90 秒内没有起来，日志：{log_path}"
        else:
            self.web_token = self._read_token_from_log(log_path)
            await self._log(f"DSH 服务已就绪：http://127.0.0.1:{port}")
            await self._start_pet_events()
        await self._emit_state()
        return self._status()

    async def stop_server(self) -> Dict[str, Any]:
        await self._stop_process("server")
        await self._emit_state()
        return self._status()

    async def restart_server(self) -> Dict[str, Any]:
        await self._stop_process("server")
        return await self.start_server()

    async def _stop_process(self, which: str) -> None:
        proc = self.server_proc if which == "server" else self.overlay_proc
        if proc and proc.returncode is None:
            try:
                proc.terminate()
                await asyncio.wait_for(proc.wait(), timeout=10)
            except Exception:  # noqa: BLE001
                try:
                    proc.kill()
                except Exception:  # noqa: BLE001
                    pass
        if which == "server":
            self.server_proc = None
            if self.pet_task and not self.pet_task.done():
                self.pet_task.cancel()
                self.pet_task = None
        else:
            self.overlay_proc = None

    async def _wait_http(self, port: str, seconds: int) -> bool:
        url = f"http://127.0.0.1:{port}/"
        deadline = time.time() + seconds
        while time.time() < deadline:
            if self.server_proc and self.server_proc.returncode is not None:
                return False
            try:
                await asyncio.to_thread(self._http_status, url)
                return True
            except Exception:  # noqa: BLE001
                await asyncio.sleep(1.5)
        return False

    @staticmethod
    def _http_status(url: str) -> int:
        req = urllib.request.Request(url, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status
        except urllib.error.HTTPError as exc:
            return exc.code

    @staticmethod
    def _read_token_from_log(path: str) -> Optional[str]:
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()[-20000:]
        except Exception:  # noqa: BLE001
            return None
        marker = "?token="
        idx = text.rfind(marker)
        if idx < 0:
            return None
        token = text[idx + len(marker) :].split()[0].strip()
        return token or None

    def _pet_url(self) -> Optional[str]:
        if not (self.server_proc and self.server_proc.returncode is None):
            return None
        port = int(self.settings.get("port") or 3080)
        query = f"?token={self.web_token}" if self.web_token else ""
        return f"http://127.0.0.1:{port}/dsh-pet/standalone{query}"

    async def _autostart(self) -> None:
        await asyncio.sleep(5)
        try:
            if self._runtime_bin("dsh") and self._pet_plugin_installed():
                await self.start_server()
        except Exception as exc:  # noqa: BLE001
            decky.logger.warning("autostart failed: %s", exc)

    # ── RPC：截图 ─────────────────────────────────────────────────────────────

    async def screenshot_and_ask(self, question: str = "") -> str:
        path = await self._capture_screenshot()
        if not path:
            hint = "截图失败：Desktop Mode 可装 grim/spectacle；Game Mode 请按 Steam + R1 截图后重试，我会自动抓最新一张。"
            await self._push_answer("截图", hint)
            return hint
        await self._log(f"截图：{path}")
        return await self._ask_with_image(path, question)

    async def _capture_screenshot(self) -> Optional[str]:
        os.makedirs(self.screenshots_dir, exist_ok=True)
        target = os.path.join(self.screenshots_dir, f"shot-{uuid.uuid4().hex[:8]}.png")
        before = self._newest_steam_shot()
        strategies = [
            ["grim", target],
            ["grim", "-o", "eDP-1", target],
            ["spectacle", "-b", "-n", "-o", target],
            ["gnome-screenshot", "-f", target],
            ["import", "-window", "root", target],
        ]
        for cmd in strategies:
            if not shutil.which(cmd[0]):
                continue
            try:
                res = await self._shell(cmd, timeout=20)
                if res["code"] == 0 and os.path.exists(target) and os.path.getsize(target) > 1024:
                    return target
            except Exception as exc:  # noqa: BLE001
                decky.logger.debug("screenshot via %s failed: %s", cmd[0], exc)
        # 桌面门户（Desktop Mode 多半可用）
        try:
            portal_out = await self._shell(
                [
                    "gdbus",
                    "call",
                    "--session",
                    "--dest",
                    "org.freedesktop.portal.Desktop",
                    "--object-path",
                    "/org/freedesktop/portal/desktop",
                    "--method",
                    "org.freedesktop.portal.Screenshot.Screenshot",
                    "",
                    "{}",
                ],
                timeout=25,
            )
            uri = ""
            if "file://" in portal_out["out"]:
                uri = portal_out["out"].split("file://")[1].split('"')[0]
            src = urllib.request.url2pathname("/" + uri) if uri else ""
            if src and os.path.exists(src):
                shutil.copyfile(src, target)
                return target
        except Exception as exc:  # noqa: BLE001
            decky.logger.debug("portal screenshot failed: %s", exc)
        # 兜底：Steam 自己的截图目录（用户按了 Steam + R1）
        newest = self._newest_steam_shot()
        if newest and newest != before:
            shutil.copyfile(newest, target)
            return target
        return None

    def _newest_steam_shot(self) -> Optional[str]:
        pattern = os.path.join(
            USER_HOME, ".steam", "steam", "userdata", "*", "760", "screenshots", "**", "*.jpg"
        )
        files = glob.glob(pattern, recursive=True) + glob.glob(pattern.replace(".jpg", ".png"), recursive=True)
        if not files:
            pattern2 = os.path.join(USER_HOME, ".local", "share", "Steam", "userdata", "*", "760", "screenshots", "**", "*")
            files = [f for f in glob.glob(pattern2, recursive=True) if f.lower().endswith((".jpg", ".png"))]
        if not files:
            return None
        return max(files, key=os.path.getmtime)

    # ── RPC：语音 ─────────────────────────────────────────────────────────────

    async def start_recording(self) -> None:
        if self.rec_proc and self.rec_proc.returncode is None:
            return
        orig = self.rec_path
        self.rec_path = os.path.join(self.voice_dir, f"voice-{uuid.uuid4().hex[:8]}.wav")
        for tool, args in (
            ("pw-record", ["--rate", "16000", "--channels", "1", self.rec_path]),
            ("parecord", ["--rate=16000", "--channels=1", "--file-format=wav", self.rec_path]),
            ("arecord", ["-f", "S16_LE", "-r", "16000", "-c", "1", self.rec_path]),
        ):
            if shutil.which(tool):
                self.rec_proc = await asyncio.create_subprocess_exec(
                    tool, *args, env=self._env(), stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL
                )
                await self._log(f"🎙 录音中（{tool}）…")
                await self._emit_state()
                return
        self.last_error = "没找到 pw-record / parecord / arecord，装一个 PipeWire 录音工具"
        await self._emit_state()

    async def stop_recording_and_ask(self, question: str = "") -> str:
        if not (self.rec_proc and self.rec_proc.returncode is None):
            return "还没有在录音"
        # SIGINT 让录音工具把 WAV 头写完整
        try:
            self.rec_proc.send_signal(signal.SIGINT)
        except Exception:  # noqa: BLE001
            self.rec_proc.terminate()
        try:
            await asyncio.wait_for(self.rec_proc.wait(), timeout=10)
        except Exception:  # noqa: BLE001
            self.rec_proc.kill()
        self.rec_proc = None
        await self._emit_state()
        path = self.rec_path
        if not path or not os.path.exists(path) or os.path.getsize(path) < 2048:
            return "没录到声音"
        text = await self._transcribe(path)
        if not text:
            return "语音转写没结果（检查 ASR 设置里的 Base / Key）"
        await self._push_answer("你说", text)
        return await self._ask_with_text(text if not question else f"{question}\n{text}", kind="语音")

    async def _transcribe(self, path: str) -> Optional[str]:
        provider = str(self.settings.get("asr_provider") or "")
        if provider != "openai-compatible":
            await self._log(f"ASR provider={provider} 未在本插件内实现，请在设置里选 OpenAI 兼容接口")
            return None
        base = str(self.settings.get("asr_base") or "").rstrip("/")
        key = str(self.settings.get("asr_key") or "")
        if not base:
            return None
        url = f"{base}/audio/transcriptions"
        model = str(self.settings.get("asr_model") or "whisper-1")
        boundary = "----dshdeckpet" + uuid.uuid4().hex
        with open(path, "rb") as fh:
            audio = fh.read()

        def part(name: str, value: str) -> bytes:
            return (
                f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode("utf-8")
            )

        body = b"".join(
            [
                part("model", model),
                part("language", str(self.settings.get("asr_language") or "zh")),
                (
                    f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"voice.wav\"\r\n"
                    "Content-Type: audio/wav\r\n\r\n"
                ).encode("utf-8"),
                audio,
                f"\r\n--{boundary}--\r\n".encode("utf-8"),
            ]
        )
        req = urllib.request.Request(url, data=body, method="POST")
        req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
        if key:
            req.add_header("Authorization", f"Bearer {key}")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            return (data.get("text") or "").strip() or None
        except Exception as exc:  # noqa: BLE001
            self.last_error = f"转写失败：{exc}"
            decky.logger.error("transcribe failed: %s", exc)
            return None

    # ── RPC：问 agent（截图 / 文字） ──────────────────────────────────────────

    async def ask(self, question: str) -> str:
        return await self._ask_with_text(question, kind="提问")

    async def _ask_with_text(self, question: str, kind: str) -> str:
        prompt = question.strip() or "主人戳了你一下，跟他说句话"
        via_pet = await self._ask_via_pet(prompt, kind)
        if via_pet is not None:
            return via_pet
        return await self._run_agent_headless(prompt, kind)

    async def _ask_with_image(self, image_path: str, question: str) -> str:
        q = question.strip() or "看看这张游戏截图，人家卡在哪一步了？给下一步该做什么。"
        # 用相对于她会话工作区的路径（她的 cwd 就是那个目录），比绝对路径更好认
        rel = image_path
        try:
            rel = os.path.relpath(image_path, DSH_WORKSPACE).replace("\\", "/")
        except Exception:  # noqa: BLE001
            pass
        mode = str(self.settings.get("auto_search") or "strong")
        if mode == "strong":
            guides = (
                "按这个顺序做，不要跳步：\n"
                "1) 先看图，说出你看到的游戏/界面/关卡/BOSS/道具/数值；\n"
                "2) 判断主人卡在哪一步；\n"
                "3) 用 web_search 至少搜一轮「游戏名 + 关卡/BOSS + 攻略」（当前版本优先），"
                "必要时再搜一轮补细节；\n"
                "4) 最后只给最关键的 2-3 步做法，并用一句话说这条建议是从哪来的。"
            )
        elif mode == "normal":
            guides = "如果截图里有游戏名/关卡/BOSS/道具/任务名，用 web_search 搜一下当前版本的攻略再回答。"
        else:
            guides = "这次不用联网，就按截图说。"
        prompt = (
            f"[主人发来一张游戏截图：{rel}]\n"
            f"先用文件读取工具看一眼这张图（图片能直接看；看不到就用 OCR，例如 tesseract）。\n"
            f"然后用你的语气回答：{q}\n{guides}"
        )
        via_pet = await self._ask_via_pet(prompt, "截图问答")
        if via_pet is not None:
            return via_pet
        return await self._run_agent_headless(prompt, "截图问答")

    # ── 她自己的通道：/dsh-pet/say + /dsh-pet/events ──────────────────────────
    #
    # 上游插件（dsh-whale-girl-live2d）自己暴露了这两个路由：
    #   POST /dsh-pet/say     {text}  → 内部调官方 sessionController.prompt，进当前会话
    #   GET  /dsh-pet/events         → SSE：delta / assistant / tool-call / turn-end …
    # 走这条路的三个好处：有会话上下文、她自己的窗口里会同步说话和做表情、不用逆向 DSH 内部 API。
    # ⚠️ /say 不带 sessionId 时会用「主会话」，在 Deck 上那就是她自己的会话（正确行为）；
    #    如果哪天要指定会话，把它填进 body 即可。

    def _pet_token(self) -> Optional[str]:
        try:
            with open(os.path.join(DSH_HOME, "dsh-live2d-pet-desktop.json"), "r", encoding="utf-8") as fh:
                token = (json.load(fh) or {}).get("token")
            return token if isinstance(token, str) and len(token) >= 16 else None
        except Exception:  # noqa: BLE001
            return None

    def _pet_headers(self, json_body: bool = False) -> Dict[str, str]:
        headers = {"Accept": "application/json"}
        if json_body:
            headers["Content-Type"] = "application/json"
        token = self._pet_token()
        if token:
            headers["Cookie"] = f"dsh_pet_desk={token}"
        return headers

    def _pet_base(self) -> str:
        return f"http://127.0.0.1:{int(self.settings.get('port') or 3080)}"

    async def _pet_say(self, text: str) -> bool:
        """把话交给她（她会在自己的窗口里回答）。"""
        if not (self.server_proc and self.server_proc.returncode is None):
            return False

        def post() -> int:
            req = urllib.request.Request(
                f"{self._pet_base()}/dsh-pet/say",
                data=json.dumps({"text": text}).encode("utf-8"),
                method="POST",
            )
            for key, value in self._pet_headers(json_body=True).items():
                req.add_header(key, value)
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status

        try:
            status = await asyncio.to_thread(post)
        except urllib.error.HTTPError as exc:
            await self._log(f"她那边回了个 HTTP {exc.code}（插件没装或通行证不对）")
            return False
        except Exception as exc:  # noqa: BLE001
            await self._log(f"连不上她：{exc}")
            return False
        return status == 200

    async def _ask_via_pet(self, prompt: str, kind: str) -> Optional[str]:
        """走她的通道问一句，等她的 assistant 事件。返回 None 表示这条路不通，交给兜底。"""
        if str(self.settings.get("ask_channel") or "pet") != "pet":
            return None
        if not (self.server_proc and self.server_proc.returncode is None):
            return None
        self.stream_buf = []
        self.pending_reply = asyncio.get_event_loop().create_future()
        self.busy = "她正在想…"
        await self._emit_state()
        try:
            if not await self._pet_say(prompt):
                return None
            timeout = int(self.settings.get("reply_timeout") or 180)
            text = await asyncio.wait_for(self.pending_reply, timeout=timeout)
            return text
        except asyncio.TimeoutError:
            return "（她半天没吭声…… 看看模型 API 设好没，或者服务日志）"
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            decky.logger.warning("pet channel failed: %s", exc)
            return None
        finally:
            self.pending_reply = None
            self.busy = None
            await self._emit_state()

    async def _start_pet_events(self) -> None:
        if self.pet_task and not self.pet_task.done():
            return
        self.pet_task = asyncio.get_event_loop().create_task(self._pet_events_loop())

    async def _pet_events_loop(self) -> None:
        """订阅她的事件流：她在窗口里说的话，QAM 里也同步能看到。断了自动重连。"""
        while True:
            if not (self.server_proc and self.server_proc.returncode is None):
                await asyncio.sleep(3)
                continue
            try:
                await self._consume_pet_events()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                decky.logger.debug("pet event stream ended: %s", exc)
            await asyncio.sleep(3)

    async def _consume_pet_events(self) -> None:
        queue: asyncio.Queue = asyncio.Queue()
        loop = asyncio.get_event_loop()
        stop = threading.Event()
        url = f"{self._pet_base()}/dsh-pet/events"

        def reader() -> None:
            req = urllib.request.Request(url, method="GET")
            req.add_header("Accept", "text/event-stream")
            for key, value in self._pet_headers().items():
                if key != "Accept":
                    req.add_header(key, value)
            try:
                with urllib.request.urlopen(req, timeout=3600) as resp:
                    while not stop.is_set():
                        raw = resp.readline()
                        if not raw:
                            break
                        loop.call_soon_threadsafe(queue.put_nowait, raw.decode("utf-8", "replace").strip())
            except Exception as exc:  # noqa: BLE001
                loop.call_soon_threadsafe(queue.put_nowait, f"__err__{exc}")
            finally:
                loop.call_soon_threadsafe(queue.put_nowait, "__eof__")

        threading.Thread(target=reader, daemon=True, name="pet-events").start()
        try:
            while True:
                line = await queue.get()
                if line == "__eof__" or line.startswith("__err__"):
                    if line.startswith("__err__"):
                        decky.logger.debug("pet events: %s", line)
                    return
                if not line.startswith("data:"):
                    continue
                try:
                    await self._handle_pet_event(json.loads(line[5:].strip()))
                except Exception as exc:  # noqa: BLE001
                    decky.logger.debug("bad pet event %r: %s", line[:200], exc)
        finally:
            stop.set()

    async def _handle_pet_event(self, ev: Dict[str, Any]) -> None:
        kind = str(ev.get("t") or "")
        if kind == "delta":
            if ev.get("kind") == "text" and ev.get("text"):
                self.stream_buf.append(str(ev["text"]))
                now = time.time()
                if now - self.stream_emit_at > 0.4:
                    self.stream_emit_at = now
                    await self._emit_soft("dsh_deck_pet/stream", "".join(self.stream_buf)[-1500:])
        elif kind == "assistant":
            text = str(ev.get("text") or "".join(self.stream_buf)).strip()
            self.stream_buf = []
            await self._emit_soft("dsh_deck_pet/stream", "")
            await self._emit_soft("dsh_deck_pet/activity", "")
            if text:
                await self._push_answer("她说", text)
                if self.pending_reply and not self.pending_reply.done():
                    self.pending_reply.set_result(text)
        elif kind == "turn-start":
            self.pet_busy = True
            self.stream_buf = []
            self.stream_emit_at = 0.0
            await self._emit_state()
        elif kind == "turn-end":
            self.pet_busy = False
            self.stream_buf = []
            await self._emit_soft("dsh_deck_pet/stream", "")
            await self._emit_soft("dsh_deck_pet/activity", "")
            await self._emit_state()
        elif kind == "tool-call":
            name = str(ev.get("name") or "工具")
            label = TOOL_LABELS.get(name, f"在用 {name}")
            await self._emit_soft("dsh_deck_pet/activity", label)
            await self._log(f"她{label}…")
        elif kind == "tool-result":
            await self._emit_soft("dsh_deck_pet/activity", "")

    async def _emit_soft(self, event: str, payload: Any) -> None:
        """推一个前端事件；前端没挂/旧版本时不能把主流程带崩。"""
        try:
            await decky.emit(event, payload)
        except Exception as exc:  # noqa: BLE001
            decky.logger.debug("emit %s failed: %s", event, exc)

    async def _run_agent_headless(self, prompt: str, kind: str) -> str:
        node, dsh = self._runtime_bin("node"), self._runtime_bin("dsh")
        if not node or not dsh:
            return "运行时还没装好"
        if not (self.server_proc and self.server_proc.returncode is None):
            return "DSH 服务没在跑，先启动服务"
        self.busy = "她正在想…"
        await self._emit_state()
        try:
            # 一次性问答走 headless profile（跑完就退出）；同样先给 launcher 旗标，
            # 提示词放在最后，避免被当成内部参数。
            res = await self._shell(
                [
                    node,
                    dsh,
                    "--profile",
                    str(self.settings.get("ask_profile") or "headless"),
                    "--patch",
                    self._patch_path("persona.patch.yml"),
                    "--patch",
                    self._patch_path("model.patch.yml"),
                    prompt,
                ],
                timeout=600,
            )
            text = (res["out"] or "").strip()
            # headless 会把推理过程也打到 stdout（形如 "dsh: reasoning:" 的段落），
            # 桌宠面板只留最终回答，不然满屏都是她的内心戏
            if "dsh: reasoning:" in text:
                kept, skipping = [], False
                for line in text.splitlines():
                    if line.startswith("dsh: reasoning:"):
                        skipping = True
                        continue
                    if skipping and (line.startswith("dsh: ") or not line.strip()):
                        continue
                    skipping = False
                    kept.append(line)
                text = "\n".join(kept).strip()
            if res["code"] != 0 and not text:
                text = f"（她没答上来，退出码 {res['code']}）"
            text = text[-4000:]
        except Exception as exc:  # noqa: BLE001
            text = f"出错了：{exc}"
        finally:
            self.busy = None
        await self._push_answer(kind, text)
        await self._emit_state()
        return text

    # ── RPC：悬浮桌宠 ─────────────────────────────────────────────────────────

    async def start_overlay(self) -> Dict[str, Any]:
        if self.overlay_proc and self.overlay_proc.returncode is None:
            return self._status()
        url = self._pet_url()
        if not url:
            self.last_error = "先在 QAM 里启动 DSH 服务，再开悬浮窗"
            await self._emit_state()
            return self._status()
        electron = await self._ensure_electron()
        if not electron:
            self.last_error = "Electron 没装成功，悬浮窗起不来（看插件日志）"
            await self._emit_state()
            return self._status()
        log = open(os.path.join(RUNTIME_DIR, "overlay.log"), "ab", buffering=0)  # noqa: SIM115
        self.overlay_proc = await asyncio.create_subprocess_exec(
            electron,
            os.path.join(PLUGIN_DIR, "overlay"),
            "--url",
            url,
            "--scale",
            str(self.settings.get("overlay_scale") or 0.7),
            env=self._env(),
            cwd=os.path.join(PLUGIN_DIR, "overlay"),
            stdout=log,
            stderr=log,
        )
        await self._log("悬浮桌宠已启动（游戏里也应该能看到她）")
        await self._emit_state()
        return self._status()

    async def stop_overlay(self) -> Dict[str, Any]:
        await self._stop_process("overlay")
        await self._emit_state()
        return self._status()

    async def _ensure_electron(self) -> Optional[str]:
        bin_path = os.path.join(RUNTIME_DIR, "electron-tree", "node_modules", ".bin", "electron")
        if os.path.exists(bin_path):
            return bin_path
        node = self._runtime_bin("node")
        if not node:
            return None
        npm = os.path.join(os.path.dirname(node), "npm")
        prefix = os.path.join(RUNTIME_DIR, "electron-tree")
        await self._log("第一次开悬浮窗：下载 Electron（约 100 MB，之后不再下）…")
        res = await self._shell(
            [npm, "install", "--prefix", prefix, "electron@33"], cwd=RUNTIME_DIR, timeout=1800
        )
        if res["code"] != 0:
            self.last_error = f"Electron 安装失败：{res['out'][-400:]}"
            return None
        return bin_path if os.path.exists(bin_path) else None

    # ── 调试用 ───────────────────────────────────────────────────────────────

    async def tail_log(self, which: str = "dsh-web") -> str:
        path = os.path.join(RUNTIME_DIR, f"{which}.log")
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                return fh.read()[-4000:]
        except Exception as exc:  # noqa: BLE001
            return f"读不到 {path}: {exc}"

    async def open_desktop_url(self) -> str:
        return self._pet_url() or ""
