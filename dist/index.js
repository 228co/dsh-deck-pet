const manifest = {"name":"DSH 鲸鱼娘桌宠"};
const API_VERSION = 2;
const internalAPIConnection = window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit;
if (!internalAPIConnection) {
    throw new Error('[@decky/api]: Failed to connect to the loader as as the loader API was not initialized. This is likely a bug in Decky Loader.');
}
let api;
try {
    api = internalAPIConnection.connect(API_VERSION, manifest.name);
}
catch {
    api = internalAPIConnection.connect(1, manifest.name);
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version 1. Some features may not work.`);
}
if (api._version != API_VERSION) {
    console.warn(`[@decky/api] Requested API version ${API_VERSION} but the running loader only supports version ${api._version}. Some features may not work.`);
}
const callable = api.callable;
const addEventListener = api.addEventListener;
const removeEventListener = api.removeEventListener;
const toaster = api.toaster;
const definePlugin = (fn) => {
    return (...args) => {
        return fn(...args);
    };
};

/** 插件图标：一条小鲸鱼（不引第三方图标库，少一个依赖少一份风险） */
const WhaleIcon = () => (SP_JSX.jsxs("svg", { viewBox: "0 0 24 24", width: "1em", height: "1em", fill: "currentColor", "aria-hidden": "true", children: [SP_JSX.jsx("path", { d: "M2 15.5c2.6 0 3.6-1.8 5.4-1.8 1.9 0 2.7 1.8 5.4 1.8s3.6-2.7 5.4-2.7c1.2 0 2 .8 2.3 1.9-.6-.3-1.4-.5-2.1-.5-2.6 0-3.6 2.7-5.6 2.7-2.7 0-3.5-1.8-5.4-1.8-1.8 0-2.8 1.8-5.4 1.8v-1.4z" }), SP_JSX.jsx("circle", { cx: "17.5", cy: "8.5", r: "1.2" })] }));
const getState = callable("get_state");
const saveSettings = callable("save_settings");
const installRuntime = callable("install_runtime");
const installPetPlugin = callable("install_pet_plugin");
const startServer = callable("start_server");
const stopServer = callable("stop_server");
const restartServer = callable("restart_server");
const takeScreenshot = callable("screenshot_and_ask");
const startRecording = callable("start_recording");
const stopRecording = callable("stop_recording_and_ask");
const startOverlay = callable("start_overlay");
const stopOverlay = callable("stop_overlay");
const askPet = callable("ask");
// ── helpers ──────────────────────────────────────────────────────────────────
async function guard(fn, label) {
    try {
        return await fn();
    }
    catch (error) {
        toaster.toast({ title: label, body: String(error) });
        return undefined;
    }
}
function StatusLine({ status }) {
    if (!status)
        return SP_JSX.jsx("div", { style: { opacity: 0.7 }, children: "\u6B63\u5728\u8BFB\u53D6\u72B6\u6001\u2026" });
    const rows = [
        ["运行时", status.runtime_ready ? "✅ node + dsh" : "❌ 还没装（点下面安装）"],
        ["桌宠插件", status.plugin_installed ? "✅ 已装进 web profile" : "❌ 未安装"],
        ["DSH 服务", status.server_running ? `✅ 运行中 :${status.server_port}` : "⏸ 未运行"],
        ["悬浮桌宠", status.overlay_running ? "✅ 悬浮中" : "⏸ 未启动"],
        ["语音", status.recording ? "🔴 录音中…" : "待机"],
    ];
    return (SP_JSX.jsxs("div", { style: { fontSize: 12, lineHeight: 1.7 }, children: [rows.map(([k, v]) => (SP_JSX.jsxs("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 }, children: [SP_JSX.jsx("span", { style: { opacity: 0.75 }, children: k }), SP_JSX.jsx("span", { children: v })] }, k))), status.busy ? SP_JSX.jsxs("div", { style: { marginTop: 6, opacity: 0.9 }, children: ["\u23F3 ", status.busy] }) : null, status.last_error ? (SP_JSX.jsxs("div", { style: { marginTop: 6, color: "#ff9a9a", wordBreak: "break-word" }, children: ["\u26A0\uFE0F ", status.last_error] })) : null] }));
}
// ── settings modal ───────────────────────────────────────────────────────────
function SettingsModal({ root, initial }) {
    const [draft, setDraft] = SP_REACT.useState(initial);
    const set = (patch) => setDraft((prev) => ({ ...prev, ...patch }));
    const save = async () => {
        await guard(() => saveSettings(draft), "保存失败");
        toaster.toast({ title: "DSH 桌宠", body: "设置已保存" });
        root?.Close?.();
    };
    return (SP_JSX.jsx(DFL.ModalRoot, { onCancel: root?.Close, onEscKeypress: root?.Close, children: SP_JSX.jsxs("div", { style: { maxHeight: "70vh", overflowY: "auto", paddingRight: 4 }, children: [SP_JSX.jsxs(DFL.PanelSection, { title: "\u5927\u6A21\u578B API\uFF08\u968F\u65F6\u53EF\u6362\uFF09", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.DropdownItem, { label: "Provider", rgOptions: [
                                    { data: "deepseek-official", label: "DeepSeek 官方" },
                                    { data: "deepseek-api-key", label: "DeepSeek（自填 key）" },
                                    { data: "pi-ai", label: "自定义 OpenAI 兼容" },
                                ], selectedOption: draft.model_provider, onChange: (o) => set({ model_provider: String(o.data) }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "\u6A21\u578B\u540D", value: draft.model_name, onChange: (e) => set({ model_name: e.target.value }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "API Base\uFF08\u517C\u5BB9\u63A5\u53E3\u7528\uFF09", value: draft.api_base, onChange: (e) => set({ api_base: e.target.value }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "API Key", value: draft.api_key, bIsPassword: true, onChange: (e) => set({ api_key: e.target.value }) }) })] }), SP_JSX.jsxs(DFL.PanelSection, { title: "\u8BED\u97F3\u8F93\u5165\uFF08\u6309\u4F4F\u8BF4\u8BDD\uFF09", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.DropdownItem, { label: "\u8F6C\u5199\u65B9\u5F0F", rgOptions: [
                                    { data: "openai-compatible", label: "OpenAI 兼容 /audio/transcriptions" },
                                    { data: "dsh", label: "交给 DSH 的语音插件" },
                                    { data: "off", label: "关闭" },
                                ], selectedOption: draft.asr_provider, onChange: (o) => set({ asr_provider: String(o.data) }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "ASR Base", value: draft.asr_base, onChange: (e) => set({ asr_base: e.target.value }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "ASR Key", value: draft.asr_key, bIsPassword: true, onChange: (e) => set({ asr_key: e.target.value }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "\u8BED\u8A00\uFF08zh / en / auto\uFF09", value: draft.asr_language, onChange: (e) => set({ asr_language: e.target.value }) }) })] }), SP_JSX.jsxs(DFL.PanelSection, { title: "\u4EBA\u8BBE\u4E0E\u884C\u4E3A", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "\u4EBA\u8BBE\uFF08system prompt\uFF09", value: draft.persona, 
                                // @ts-ignore Decky's TextField accepts multiline
                                multiline: true, onChange: (e) => set({ persona: e.target.value }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.DropdownItem, { label: "\u6536\u5230\u622A\u56FE\u540E\u8054\u7F51\u641C\u653B\u7565", rgOptions: [
                                    { data: "strong", label: "强：先判断游戏/关卡，至少搜一轮，回答带来源" },
                                    { data: "normal", label: "普通：看情况搜" },
                                    { data: "off", label: "关：只按截图说" },
                                ], selectedOption: draft.auto_search, onChange: (o) => set({ auto_search: String(o.data) }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.DropdownItem, { label: "\u95EE\u7B54\u901A\u9053", rgOptions: [
                                    { data: "pet", label: "她的会话（有记忆，她窗口里也说话）" },
                                    { data: "headless", label: "一次性问答（无记忆，兜底用）" },
                                ], selectedOption: draft.ask_channel, onChange: (o) => set({ ask_channel: String(o.data) }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "DSH \u7248\u672C", value: draft.dsh_version, onChange: (e) => set({ dsh_version: e.target.value }) }) })] }), SP_JSX.jsxs(DFL.PanelSection, { title: "\u60AC\u6D6E\u7A97", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "\u7AEF\u53E3\uFF08\u684C\u5BA0\u5916\u58F3\u8BA4 3080\uFF09", value: String(draft.port), onChange: (e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || 3080 }) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ToggleField, { label: "\u5F00\u673A/\u52A0\u8F7D\u65F6\u81EA\u52A8\u8D77\u670D\u52A1", checked: draft.auto_start, onChange: (v) => set({ auto_start: v }) }) })] }), SP_JSX.jsxs(DFL.PanelSection, { children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: save, children: "\u4FDD\u5B58" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: () => root?.Close?.(), children: "\u53D6\u6D88" }) })] }), SP_JSX.jsxs("div", { style: { fontSize: 11, opacity: 0.6, padding: "0 16px 16px" }, children: ["API Key \u53EA\u5199\u5728\u672C\u673A ", SP_JSX.jsx("code", { children: "~/homebrew/settings/dsh-deck-pet/settings.json" }), "\uFF0C\u4EE5\u53CA DSH \u81EA\u5DF1\u7684", SP_JSX.jsx("code", { children: " ~/.dsh/.credentials.yaml" }), "\uFF0C\u4E0D\u4F1A\u4E0A\u4F20\u3002"] })] }) }));
}
// ── pet view (full screen, embeds the whale girl page served by DSH) ──────────
function PetModal({ root, url }) {
    return (SP_JSX.jsx(DFL.ModalRoot, { onCancel: root?.Close, onEscKeypress: root?.Close, children: SP_JSX.jsx("div", { style: { width: "100%", height: "62vh", background: "rgba(10,14,24,.9)", borderRadius: 8, overflow: "hidden" }, children: url ? (SP_JSX.jsx("iframe", { title: "whale-girl-pet", src: url, style: { width: "100%", height: "100%", border: "0", background: "transparent" }, allow: "microphone; autoplay" })) : (SP_JSX.jsx("div", { style: { padding: 20, fontSize: 13 }, children: "\u684C\u5BA0\u9875\u9762\u8FD8\u6CA1\u51C6\u5907\u597D\uFF1A\u5148\u5728\u4E0A\u9762\u300C\u5B89\u88C5\u8FD0\u884C\u65F6\u300D\u5E76\u300C\u542F\u52A8 DSH \u670D\u52A1\u300D\u3002" })) }) }));
}
// ── main QAM panel ───────────────────────────────────────────────────────────
function Content() {
    const [status, setStatus] = SP_REACT.useState();
    const [settings, setSettings] = SP_REACT.useState();
    const [answers, setAnswers] = SP_REACT.useState([]);
    const [question, setQuestion] = SP_REACT.useState("");
    const [busy, setBusy] = SP_REACT.useState(false);
    const [stream, setStream] = SP_REACT.useState("");
    const [activity, setActivity] = SP_REACT.useState("");
    const refresh = async () => {
        const state = await guard(() => getState(), "读取状态失败");
        if (state) {
            setStatus(state.status);
            setSettings(state.settings);
            setAnswers(state.answers ?? []);
        }
    };
    SP_REACT.useEffect(() => {
        refresh();
        const off = addEventListener("dsh_deck_pet/state", (s) => setStatus(s));
        const offAnswer = addEventListener("dsh_deck_pet/answer", (a) => setAnswers((prev) => [a, ...prev].slice(0, 5)));
        const offStream = addEventListener("dsh_deck_pet/stream", (t) => setStream(t));
        const offActivity = addEventListener("dsh_deck_pet/activity", (t) => setActivity(t));
        const offLog = addEventListener("dsh_deck_pet/log", (line) => toaster.toast({ title: "DSH 桌宠", body: line.slice(0, 180) }));
        return () => {
            removeEventListener("dsh_deck_pet/state", off);
            removeEventListener("dsh_deck_pet/answer", offAnswer);
            removeEventListener("dsh_deck_pet/stream", offStream);
            removeEventListener("dsh_deck_pet/activity", offActivity);
            removeEventListener("dsh_deck_pet/log", offLog);
        };
    }, []);
    const run = async (fn, label) => {
        setBusy(true);
        await guard(fn, label);
        await refresh();
        setBusy(false);
    };
    return (SP_JSX.jsxs(DFL.PanelSection, { title: "DSH \u9CB8\u9C7C\u5A18\u684C\u5BA0", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(StatusLine, { status: status }) }), !status?.runtime_ready ? (SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy, onClick: () => run(installRuntime, "安装运行时失败"), children: "\u2460 \u5B89\u88C5\u8FD0\u884C\u65F6\uFF08node + dsh CLI\uFF0C\u7EA6 60 MB\uFF09" }) })) : null, status?.runtime_ready && !status?.plugin_installed ? (SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy, onClick: () => run(installPetPlugin, "安装桌宠插件失败"), children: "\u2461 \u5B89\u88C5\u9CB8\u9C7C\u5A18\u63D2\u4EF6\u5230 web profile" }) })) : null, SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy || !status?.runtime_ready, onClick: () => run(status?.server_running ? stopServer : startServer, "服务操作失败"), children: status?.server_running ? "停止 DSH 服务" : "③ 启动 DSH 服务" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy || !status?.server_running, onClick: () => run(status?.overlay_running ? stopOverlay : startOverlay, "悬浮窗操作失败"), children: status?.overlay_running ? "收起悬浮桌宠" : "④ 让桌宠悬浮在屏幕上" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", onClick: () => DFL.showModal(SP_JSX.jsx(PetModal, { url: status?.pet_url ?? null })), children: "\u5728 QAM \u91CC\u770B\u5979\uFF08\u5B8C\u6574\u754C\u9762\uFF09" }) }), SP_JSX.jsxs(DFL.PanelSection, { title: "\u622A\u56FE\u95EE\u653B\u7565", children: [SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.TextField, { label: "\u60F3\u95EE\u4EC0\u4E48\uFF08\u53EF\u7559\u7A7A\uFF09", value: question, onChange: (e) => setQuestion(e.target.value) }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy || !status?.server_running, onClick: () => run(() => takeScreenshot(question), "截图失败"), children: "\uD83D\uDCF8 \u622A\u56FE\u5E76\u95EE\u5979" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.Focusable, { style: { fontSize: 11, opacity: 0.65 }, children: "\u622A\u56FE\u65B9\u5F0F\u6309\u987A\u5E8F\u5C1D\u8BD5 grim \u2192 spectacle \u2192 \u684C\u9762\u95E8\u6237\uFF08Desktop Mode \u66F4\u7A33\uFF09\uFF1BGame Mode \u4E0B\u82E5\u90FD\u5931\u8D25\uFF0C\u4F1A\u63D0\u793A\u4F60\u6309 Steam + R1 \u622A\u56FE\uFF0C\u63D2\u4EF6\u81EA\u52A8\u6293\u6700\u65B0\u4E00\u5F20\u3002" }) })] }), SP_JSX.jsx(DFL.PanelSection, { title: "\u8BED\u97F3", children: SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy || !status?.server_running || settings?.asr_provider === "off", onClick: () => run(async () => {
                            if (status?.recording)
                                await stopRecording(question);
                            else
                                await startRecording();
                        }, "语音失败"), children: status?.recording ? "⏹ 停止并发送" : "🎙 按住我说话" }) }) }), activity || stream ? (SP_JSX.jsx(DFL.PanelSection, { title: "\u5979\u6B63\u5728\u8BF4", children: SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsxs("div", { style: { fontSize: 12, lineHeight: 1.6 }, children: [activity ? SP_JSX.jsxs("div", { style: { opacity: 0.7, marginBottom: 4 }, children: ["\uD83D\uDCAD ", activity, "\u2026"] }) : null, SP_JSX.jsx("div", { style: { whiteSpace: "pre-wrap", maxHeight: 160, overflowY: "auto" }, children: stream })] }) }) })) : null, answers.length > 0 ? (SP_JSX.jsx(DFL.PanelSection, { title: "\u5979\u521A\u8BF4", children: SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx("div", { style: { fontSize: 12, lineHeight: 1.6, maxHeight: 200, overflowY: "auto" }, children: answers.map((a) => (SP_JSX.jsxs("div", { style: { marginBottom: 8 }, children: [SP_JSX.jsx("div", { style: { opacity: 0.55, fontSize: 10 }, children: a.kind }), SP_JSX.jsx("div", { style: { whiteSpace: "pre-wrap" }, children: a.text })] }, a.at))) }) }) })) : null, SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy || !status?.server_running, onClick: () => run(() => askPet(question), "提问失败"), children: "\u76F4\u63A5\u95EE\u5979\uFF08\u4E0D\u53D1\u622A\u56FE\uFF09" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: !settings, onClick: () => settings && DFL.showModal(SP_JSX.jsx(SettingsModal, { initial: settings })), children: "\u2699\uFE0F \u8BBE\u7F6E / \u6362\u6A21\u578B API" }) }), SP_JSX.jsx(DFL.PanelSectionRow, { children: SP_JSX.jsx(DFL.ButtonItem, { layout: "below", disabled: busy, onClick: () => run(restartServer, "重启失败"), children: "\u91CD\u542F DSH \u670D\u52A1" }) })] }));
}
var index = definePlugin(() => {
    return {
        name: "DSH 鲸鱼娘桌宠",
        titleView: SP_JSX.jsx("div", { className: DFL.staticClasses.Title, children: "DSH \u9CB8\u9C7C\u5A18\u684C\u5BA0" }),
        content: SP_JSX.jsx(Content, {}),
        icon: SP_JSX.jsx(WhaleIcon, {}),
        onDismount() {
            // 事件监听在 Content 的 useEffect 里注销；这里留给以后的全局补丁清理
        },
    };
});

export { index as default };
//# sourceMappingURL=index.js.map
