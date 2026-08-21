const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kinso', {
  getStore: (name) => ipcRenderer.invoke('store:get', name),
  setStore: (name, data) => ipcRenderer.invoke('store:set', name, data),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (partial) => ipcRenderer.invoke('settings:set', partial),
  copy: (text) => ipcRenderer.invoke('clipboard:copy', text),
  quit: () => ipcRenderer.invoke('app:quit'),
  askAI: (message, history) => ipcRenderer.invoke('ai:ask', { message, history }),
  setMode: (mode) => ipcRenderer.send('ui:set-mode', mode),
  onOpenAI: (cb) => ipcRenderer.on('hotkey:open-ai', cb),
  onDockSide: (cb) => ipcRenderer.on('dock:side', (_e, side) => cb(side)),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),
  googleStatus: () => ipcRenderer.invoke('google:status'),
  googleConnect: (creds) => ipcRenderer.invoke('google:connect', creds),
  googleDisconnect: () => ipcRenderer.invoke('google:disconnect'),
  gmailList: (opts) => ipcRenderer.invoke('gmail:list', opts),
  gmailHasUnread: () => ipcRenderer.invoke('gmail:has-unread'),
  gmailGet: (id) => ipcRenderer.invoke('gmail:get', { id }),
  gmailReply: (payload) => ipcRenderer.invoke('gmail:reply', payload),
  gmailMarkRead: (id) => ipcRenderer.invoke('gmail:mark-read', { id }),
  calendarList: (opts) => ipcRenderer.invoke('calendar:list', opts),
  calendarUpdate: (id, patch) => ipcRenderer.invoke('calendar:update', { id, patch }),
  notesList: () => ipcRenderer.invoke('notes:list'),
  notesGet: (id) => ipcRenderer.invoke('notes:get', { id }),
  notesSave: (payload) => ipcRenderer.invoke('notes:save', payload),
  notesOpenExternal: (id) => ipcRenderer.invoke('notes:open-external', { id })
});
