// DSH 鲸鱼娘桌宠 · Linux/SteamOS 悬浮外壳
// ─────────────────────────────────────────────────────────────
// 和 Windows 版同一个思路：她本身还是 DSH 插件里的那一页，这里只是一扇
// 透明、无边框、永远置顶、鼠标不在她身上时点击穿透的窗户。
//
// Steam Deck 上要注意的四件事（都写在 docs/架构与限制.md 里了）：
//   ① Electron 在 SteamOS 上通常需要 --no-sandbox（chrome-sandbox 权限）
//   ② 透明要合成的支持：Desktop Mode(KDE/Wayland→XWayland) 没问题；
//      Game Mode 由 gamescope 合成，和 OverLaid 那类插件一个路子
//   ③ setIgnoreMouseEvents(true, {forward:true}) 只有 Win/macOS 有 forward，
//      Linux 上我们用「定时问页面：鼠标下面是不是她」来决定穿不穿透
//   ④ 想要键盘输入（打字聊天）就在 QAM 里打开完整界面；这个悬浮窗主要用来看和点
const { app, BrowserWindow, ipcMain, screen, session, shell } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const PET_URL = arg('url', 'http://127.0.0.1:3080/dsh-pet/standalone')
const SCALE = Number(arg('scale', '0.7')) || 0.7
const BASE = 520
const W = Math.round(BASE * SCALE)
const H = Math.round(BASE * SCALE)

// SteamOS 上 chrome-sandbox 几乎一定没配好，直接关掉免得起不来
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-dev-shm-usage')
app.commandLine.appendSwitch('enable-transparent-visuals')
app.commandLine.appendSwitch('ozone-platform-hint', 'auto')

let win = null
let pollTimer = null
let dragTimer = null
let dragFrom = null
let lastInside = false

/** 鼠标下面是什么：她本体 / 她的面板 / 空白 */
const hitJS = (x, y) => `(function(){try{
  var el=document.elementFromPoint(${x},${y});
  var ui=!!(el&&el.closest&&el.closest('.dshp-panel,.dshp-menu,.dshp-hud,.dshp-bubble,.dshp-composer,.dshp-dock,.dshp-tab'));
  if(ui) return 'panel';
  if(window.DSHPet&&DSHPet.hitTest&&DSHPet.hitTest(${x},${y})) return 'model';
  return 'none';
}catch(e){return 'none'}})()`

function setIgnore(on) {
  if (!win || win.isDestroyed()) return
  try {
    win.setIgnoreMouseEvents(on)
  } catch (e) {
    /* 某些合成器上不支持，忽略 */
  }
}

async function poll() {
  if (!win || win.isDestroyed() || !win.isVisible()) return
  if (dragTimer) return
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  const inside = p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height
  if (!inside) {
    if (lastInside !== false) {
      lastInside = false
      setIgnore(true)
    }
    return
  }
  try {
    const kind = await win.webContents.executeJavaScript(hitJS(Math.round(p.x - b.x), Math.round(p.y - b.y)))
    const solid = kind !== 'none'
    if (solid !== lastInside) {
      lastInside = solid
      setIgnore(!solid)
    }
  } catch (e) {
    setIgnore(true)
  }
}

function readPos() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'pos.json'), 'utf8'))
    if (Array.isArray(j) && j.length === 2 && Number.isFinite(j[0])) return j
  } catch (e) {}
  return null
}

function savePos() {
  if (!win || win.isDestroyed()) return
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(path.join(app.getPath('userData'), 'pos.json'), JSON.stringify(win.getPosition()))
  } catch (e) {}
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea
  const saved = readPos()
  win = new BrowserWindow({
    width: W,
    height: H,
    x: saved ? saved[0] : wa.x + wa.width - W - 24,
    y: saved ? saved[1] : wa.y + wa.height - H - 24,
    frame: false,
    transparent: true,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    title: 'DS 鲸鱼娘桌宠',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false,
    },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true)
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('did-finish-load', () => {
    win.webContents
      .executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)')
      .catch(() => {})
  })
  win.on('moved', savePos)

  // 拖动：页面里按下她 → 主进程搬窗口（拖动期间 16ms 快轮询，跟手）
  ipcMain.on('drag-start', async (_e, at) => {
    if (!win) return
    dragFrom = { mouse: at, win: win.getPosition() }
    clearInterval(dragTimer)
    dragTimer = setInterval(() => {
      if (!dragFrom || !win) return
      const p = screen.getCursorScreenPoint()
      win.setPosition(dragFrom.win[0] + (p.x - dragFrom.mouse.x), dragFrom.win[1] + (p.y - dragFrom.mouse.y))
    }, 16)
  })
  ipcMain.on('drag-end', () => {
    clearInterval(dragTimer)
    dragTimer = null
    dragFrom = null
    savePos()
  })
  ipcMain.on('quit', () => app.quit())

  win.loadURL(PET_URL)
  win.once('ready-to-show', () => {
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  })
  pollTimer = setInterval(poll, 120)
}

app.whenReady().then(() => {
  // 让插件那一页认得桌面壳（和 Windows/macOS 版同一套协议）
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture')
  })
  createWindow()
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  clearInterval(pollTimer)
  clearInterval(dragTimer)
})
