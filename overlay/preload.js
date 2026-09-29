// 预加载：给插件那一页补上桌面壳的协议（和 Windows 版 preload 一一对应）
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__DSHPET_SHELL__', true)
contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {
    dshpetshell: {
      postMessage: (msg) => ipcRenderer.send('shell-msg', String(msg)),
    },
  },
})
contextBridge.exposeInMainWorld('dshpetBridge', {
  install: () => ipcRenderer.send('install-plugin'),
  reload: () => ipcRenderer.send('reload'),
})

ipcRenderer.on('noop', () => {})

window.addEventListener(
  'mousedown',
  (e) => {
    if (e.button === 0) ipcRenderer.send('drag-start', { x: e.screenX, y: e.screenY })
  },
  true,
)
window.addEventListener('mouseup', () => ipcRenderer.send('drag-end'), true)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ipcRenderer.send('quit')
})
