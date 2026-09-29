import {
  ButtonItem,
  DropdownItem,
  Focusable,
  ModalRoot,
  PanelSection,
  PanelSectionRow,
  TextField,
  ToggleField,
  showModal,
  staticClasses,
} from "@decky/ui";
import { addEventListener, callable, definePlugin, removeEventListener, toaster } from "@decky/api";
import { useEffect, useState } from "react";

/** 插件图标：一条小鲸鱼（不引第三方图标库，少一个依赖少一份风险） */
const WhaleIcon = () => (
  <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d="M2 15.5c2.6 0 3.6-1.8 5.4-1.8 1.9 0 2.7 1.8 5.4 1.8s3.6-2.7 5.4-2.7c1.2 0 2 .8 2.3 1.9-.6-.3-1.4-.5-2.1-.5-2.6 0-3.6 2.7-5.6 2.7-2.7 0-3.5-1.8-5.4-1.8-1.8 0-2.8 1.8-5.4 1.8v-1.4z" />
    <circle cx="17.5" cy="8.5" r="1.2" />
  </svg>
);

// ── RPC surface (mirrors the async methods on the Python `Plugin` class) ──────

type Status = {
  runtime_ready: boolean;
  node: string | null;
  dsh: string | null;
  plugin_installed: boolean;
  server_running: boolean;
  server_port: number;
  pet_url: string | null;
  overlay_running: boolean;
  recording: boolean;
  busy: string | null;
  last_error: string | null;
  pet_busy: boolean;
  pet_token: boolean;
  ask_channel: string;
};

type Settings = {
  model_provider: string;
  model_name: string;
  api_base: string;
  api_key: string;
  asr_provider: string;
  asr_base: string;
  asr_key: string;
  asr_language: string;
  persona: string;
  port: number;
  dsh_version: string;
  auto_start: boolean;
  overlay_scale: number;
  auto_search: string;
  ask_channel: string;
  reply_timeout: number;
};

type Answer = { at: string; kind: string; text: string };

const getState = callable<[], { status: Status; settings: Settings; answers: Answer[] }>("get_state");
const saveSettings = callable<[patch: Partial<Settings>], Settings>("save_settings");
const installRuntime = callable<[], Status>("install_runtime");
const installPetPlugin = callable<[], Status>("install_pet_plugin");
const startServer = callable<[], Status>("start_server");
const stopServer = callable<[], Status>("stop_server");
const restartServer = callable<[], Status>("restart_server");
const takeScreenshot = callable<[question: string], string>("screenshot_and_ask");
const startRecording = callable<[], void>("start_recording");
const stopRecording = callable<[question: string], string>("stop_recording_and_ask");
const startOverlay = callable<[], Status>("start_overlay");
const stopOverlay = callable<[], Status>("stop_overlay");
const askPet = callable<[question: string], string>("ask");

// ── helpers ──────────────────────────────────────────────────────────────────

async function guard<T>(fn: () => Promise<T>, label: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (error) {
    toaster.toast({ title: label, body: String(error) });
    return undefined;
  }
}

function StatusLine({ status }: { status: Status | undefined }) {
  if (!status) return <div style={{ opacity: 0.7 }}>正在读取状态…</div>;
  const rows: [string, string][] = [
    ["运行时", status.runtime_ready ? "✅ node + dsh" : "❌ 还没装（点下面安装）"],
    ["桌宠插件", status.plugin_installed ? "✅ 已装进 web profile" : "❌ 未安装"],
    ["DSH 服务", status.server_running ? `✅ 运行中 :${status.server_port}` : "⏸ 未运行"],
    ["悬浮桌宠", status.overlay_running ? "✅ 悬浮中" : "⏸ 未启动"],
    ["语音", status.recording ? "🔴 录音中…" : "待机"],
  ];
  return (
    <div style={{ fontSize: 12, lineHeight: 1.7 }}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
          <span style={{ opacity: 0.75 }}>{k}</span>
          <span>{v}</span>
        </div>
      ))}
      {status.busy ? <div style={{ marginTop: 6, opacity: 0.9 }}>⏳ {status.busy}</div> : null}
      {status.last_error ? (
        <div style={{ marginTop: 6, color: "#ff9a9a", wordBreak: "break-word" }}>⚠️ {status.last_error}</div>
      ) : null}
    </div>
  );
}

// ── settings modal ───────────────────────────────────────────────────────────

function SettingsModal({ root, initial }: { root?: any; initial: Settings }) {
  const [draft, setDraft] = useState<Settings>(initial);
  const set = (patch: Partial<Settings>) => setDraft((prev) => ({ ...prev, ...patch }));

  const save = async () => {
    await guard(() => saveSettings(draft), "保存失败");
    toaster.toast({ title: "DSH 桌宠", body: "设置已保存" });
    root?.Close?.();
  };

  return (
    <ModalRoot onCancel={root?.Close} onEscKeypress={root?.Close}>
      <div style={{ maxHeight: "70vh", overflowY: "auto", paddingRight: 4 }}>
        <PanelSection title="大模型 API（随时可换）">
          <PanelSectionRow>
            <DropdownItem
              label="Provider"
              rgOptions={[
                { data: "deepseek-official", label: "DeepSeek 官方" },
                { data: "deepseek-api-key", label: "DeepSeek（自填 key）" },
                { data: "pi-ai", label: "自定义 OpenAI 兼容" },
              ]}
              selectedOption={draft.model_provider}
              onChange={(o) => set({ model_provider: String(o.data) })}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField label="模型名" value={draft.model_name} onChange={(e) => set({ model_name: e.target.value })} />
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField
              label="API Base（兼容接口用）"
              value={draft.api_base}
              onChange={(e) => set({ api_base: e.target.value })}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField
              label="API Key"
              value={draft.api_key}
              bIsPassword
              onChange={(e) => set({ api_key: e.target.value })}
            />
          </PanelSectionRow>
        </PanelSection>

        <PanelSection title="语音输入（按住说话）">
          <PanelSectionRow>
            <DropdownItem
              label="转写方式"
              rgOptions={[
                { data: "openai-compatible", label: "OpenAI 兼容 /audio/transcriptions" },
                { data: "dsh", label: "交给 DSH 的语音插件" },
                { data: "off", label: "关闭" },
              ]}
              selectedOption={draft.asr_provider}
              onChange={(o) => set({ asr_provider: String(o.data) })}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField label="ASR Base" value={draft.asr_base} onChange={(e) => set({ asr_base: e.target.value })} />
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField
              label="ASR Key"
              value={draft.asr_key}
              bIsPassword
              onChange={(e) => set({ asr_key: e.target.value })}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField
              label="语言（zh / en / auto）"
              value={draft.asr_language}
              onChange={(e) => set({ asr_language: e.target.value })}
            />
          </PanelSectionRow>
        </PanelSection>

        <PanelSection title="人设与行为">
          <PanelSectionRow>
            <TextField
              label="人设（system prompt）"
              value={draft.persona}
              // @ts-ignore Decky's TextField accepts multiline
              multiline
              onChange={(e) => set({ persona: e.target.value })}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <DropdownItem
              label="收到截图后联网搜攻略"
              rgOptions={[
                { data: "strong", label: "强：先判断游戏/关卡，至少搜一轮，回答带来源" },
                { data: "normal", label: "普通：看情况搜" },
                { data: "off", label: "关：只按截图说" },
              ]}
              selectedOption={draft.auto_search}
              onChange={(o) => set({ auto_search: String(o.data) })}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <DropdownItem
              label="问答通道"
              rgOptions={[
                { data: "pet", label: "她的会话（有记忆，她窗口里也说话）" },
                { data: "headless", label: "一次性问答（无记忆，兜底用）" },
              ]}
              selectedOption={draft.ask_channel}
              onChange={(o) => set({ ask_channel: String(o.data) })}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <TextField
              label="DSH 版本"
              value={draft.dsh_version}
              onChange={(e) => set({ dsh_version: e.target.value })}
            />
          </PanelSectionRow>
        </PanelSection>

        <PanelSection title="悬浮窗">
          <PanelSectionRow>
            <TextField
              label="端口（桌宠外壳认 3080）"
              value={String(draft.port)}
              onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 3080 })}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField label="开机/加载时自动起服务" checked={draft.auto_start} onChange={(v) => set({ auto_start: v })} />
          </PanelSectionRow>
        </PanelSection>

        <PanelSection>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={save}>
              保存
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" onClick={() => root?.Close?.()}>
              取消
            </ButtonItem>
          </PanelSectionRow>
        </PanelSection>
        <div style={{ fontSize: 11, opacity: 0.6, padding: "0 16px 16px" }}>
          API Key 只写在本机 <code>~/homebrew/settings/dsh-deck-pet/settings.json</code>，以及 DSH 自己的
          <code> ~/.dsh/.credentials.yaml</code>，不会上传。
        </div>
      </div>
    </ModalRoot>
  );
}

// ── pet view (full screen, embeds the whale girl page served by DSH) ──────────

function PetModal({ root, url }: { root?: any; url: string | null }) {
  return (
    <ModalRoot onCancel={root?.Close} onEscKeypress={root?.Close}>
      <div style={{ width: "100%", height: "62vh", background: "rgba(10,14,24,.9)", borderRadius: 8, overflow: "hidden" }}>
        {url ? (
          <iframe
            title="whale-girl-pet"
            src={url}
            style={{ width: "100%", height: "100%", border: "0", background: "transparent" }}
            allow="microphone; autoplay"
          />
        ) : (
          <div style={{ padding: 20, fontSize: 13 }}>
            桌宠页面还没准备好：先在上面「安装运行时」并「启动 DSH 服务」。
          </div>
        )}
      </div>
    </ModalRoot>
  );
}

// ── main QAM panel ───────────────────────────────────────────────────────────

function Content() {
  const [status, setStatus] = useState<Status | undefined>();
  const [settings, setSettings] = useState<Settings | undefined>();
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [stream, setStream] = useState("");
  const [activity, setActivity] = useState("");

  const refresh = async () => {
    const state = await guard(() => getState(), "读取状态失败");
    if (state) {
      setStatus(state.status);
      setSettings(state.settings);
      setAnswers(state.answers ?? []);
    }
  };

  useEffect(() => {
    refresh();
    const off = addEventListener<[Status]>("dsh_deck_pet/state", (s) => setStatus(s));
    const offAnswer = addEventListener<[Answer]>("dsh_deck_pet/answer", (a) => setAnswers((prev) => [a, ...prev].slice(0, 5)));
    const offStream = addEventListener<[string]>("dsh_deck_pet/stream", (t) => setStream(t));
    const offActivity = addEventListener<[string]>("dsh_deck_pet/activity", (t) => setActivity(t));
    const offLog = addEventListener<[string]>("dsh_deck_pet/log", (line) =>
      toaster.toast({ title: "DSH 桌宠", body: line.slice(0, 180) }),
    );
    return () => {
      removeEventListener("dsh_deck_pet/state", off);
      removeEventListener("dsh_deck_pet/answer", offAnswer);
      removeEventListener("dsh_deck_pet/stream", offStream);
      removeEventListener("dsh_deck_pet/activity", offActivity);
      removeEventListener("dsh_deck_pet/log", offLog);
    };
  }, []);

  const run = async (fn: () => Promise<unknown>, label: string) => {
    setBusy(true);
    await guard(fn as () => Promise<unknown>, label);
    await refresh();
    setBusy(false);
  };

  return (
    <PanelSection title="DSH 鲸鱼娘桌宠">
      <PanelSectionRow>
        <StatusLine status={status} />
      </PanelSectionRow>

      {!status?.runtime_ready ? (
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={() => run(installRuntime, "安装运行时失败")}>
            ① 安装运行时（node + dsh CLI，约 60 MB）
          </ButtonItem>
        </PanelSectionRow>
      ) : null}

      {status?.runtime_ready && !status?.plugin_installed ? (
        <PanelSectionRow>
          <ButtonItem layout="below" disabled={busy} onClick={() => run(installPetPlugin, "安装桌宠插件失败")}>
            ② 安装鲸鱼娘插件到 web profile
          </ButtonItem>
        </PanelSectionRow>
      ) : null}

      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={busy || !status?.runtime_ready}
          onClick={() => run(status?.server_running ? stopServer : startServer, "服务操作失败")}
        >
          {status?.server_running ? "停止 DSH 服务" : "③ 启动 DSH 服务"}
        </ButtonItem>
      </PanelSectionRow>

      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={busy || !status?.server_running}
          onClick={() => run(status?.overlay_running ? stopOverlay : startOverlay, "悬浮窗操作失败")}
        >
          {status?.overlay_running ? "收起悬浮桌宠" : "④ 让桌宠悬浮在屏幕上"}
        </ButtonItem>
      </PanelSectionRow>

      <PanelSectionRow>
        <ButtonItem layout="below" onClick={() => showModal(<PetModal url={status?.pet_url ?? null} />)}>
          在 QAM 里看她（完整界面）
        </ButtonItem>
      </PanelSectionRow>

      <PanelSection title="截图问攻略">
        <PanelSectionRow>
          <TextField
            label="想问什么（可留空）"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy || !status?.server_running}
            onClick={() => run(() => takeScreenshot(question), "截图失败")}
          >
            📸 截图并问她
          </ButtonItem>
        </PanelSectionRow>
        <PanelSectionRow>
          <Focusable style={{ fontSize: 11, opacity: 0.65 }}>
            截图方式按顺序尝试 grim → spectacle → 桌面门户（Desktop Mode 更稳）；Game Mode 下若都失败，会提示你按
            Steam + R1 截图，插件自动抓最新一张。
          </Focusable>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="语音">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy || !status?.server_running || settings?.asr_provider === "off"}
            onClick={() =>
              run(async () => {
                if (status?.recording) await stopRecording(question);
                else await startRecording();
              }, "语音失败")
            }
          >
            {status?.recording ? "⏹ 停止并发送" : "🎙 按住我说话"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      {activity || stream ? (
        <PanelSection title="她正在说">
          <PanelSectionRow>
            <div style={{ fontSize: 12, lineHeight: 1.6 }}>
              {activity ? <div style={{ opacity: 0.7, marginBottom: 4 }}>💭 {activity}…</div> : null}
              <div style={{ whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto" }}>{stream}</div>
            </div>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      {answers.length > 0 ? (
        <PanelSection title="她刚说">
          <PanelSectionRow>
            <div style={{ fontSize: 12, lineHeight: 1.6, maxHeight: 200, overflowY: "auto" }}>
              {answers.map((a) => (
                <div key={a.at} style={{ marginBottom: 8 }}>
                  <div style={{ opacity: 0.55, fontSize: 10 }}>{a.kind}</div>
                  <div style={{ whiteSpace: "pre-wrap" }}>{a.text}</div>
                </div>
              ))}
            </div>
          </PanelSectionRow>
        </PanelSection>
      ) : null}

      <PanelSectionRow>
        <ButtonItem
          layout="below"
          disabled={busy || !status?.server_running}
          onClick={() => run(() => askPet(question), "提问失败")}
        >
          直接问她（不发截图）
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={!settings} onClick={() => settings && showModal(<SettingsModal initial={settings} />)}>
          ⚙️ 设置 / 换模型 API
        </ButtonItem>
      </PanelSectionRow>
      <PanelSectionRow>
        <ButtonItem layout="below" disabled={busy} onClick={() => run(restartServer, "重启失败")}>
          重启 DSH 服务
        </ButtonItem>
      </PanelSectionRow>
    </PanelSection>
  );
}

export default definePlugin(() => {
  return {
    name: "DSH 鲸鱼娘桌宠",
    titleView: <div className={staticClasses.Title}>DSH 鲸鱼娘桌宠</div>,
    content: <Content />,
    icon: <WhaleIcon />,
    onDismount() {
      // 事件监听在 Content 的 useEffect 里注销；这里留给以后的全局补丁清理
    },
  };
});
