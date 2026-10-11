const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  getWidgetSettings: () => ipcRenderer.invoke('get-widget-settings'),
  updateWidgetSettings: (patch) => ipcRenderer.invoke('update-widget-settings', patch),
  onWidgetSettings: (callback) => ipcRenderer.on('widget-settings', (_event, value) => callback(value)),
  getVisualizerSettings: () => ipcRenderer.invoke('get-visualizer-settings'),
  updateVisualizerSettings: (patch) => ipcRenderer.invoke('update-visualizer-settings', patch),
  onVisualizerSettings: (callback) => ipcRenderer.on('visualizer-settings', (_event, value) => callback(value)),
  close: () => ipcRenderer.send('close-widget'),
  minimize: () => ipcRenderer.send('minimize-widget'),
  openSettings: () => ipcRenderer.send('open-settings'),
  closeSettings: () => ipcRenderer.send('close-settings'),
  getAsciiImage: () => ipcRenderer.invoke('get-ascii-image'),
  chooseAsciiImage: () => ipcRenderer.invoke('choose-ascii-image'),
  clearAsciiImage: () => ipcRenderer.invoke('clear-ascii-image'),
  onAsciiImage: (callback) => ipcRenderer.on('ascii-image', (_event, url) => callback(url)),
  getAsciiSettings: () => ipcRenderer.invoke('get-ascii-settings'),
  updateAsciiSettings: (patch) => ipcRenderer.invoke('update-ascii-settings', patch),
  onAsciiSettings: (callback) => ipcRenderer.on('ascii-settings', (_event, value) => callback(value)),
  onAsciiEditMode: (callback) => ipcRenderer.on('ascii-edit-mode', (_event, enabled) => callback(enabled)),
  mediaControl: (action) => ipcRenderer.send('media-control', action),
  audioOutput: (action) => ipcRenderer.invoke('audio-output', action),
  onToggleCompact: (callback) => ipcRenderer.on('toggle-compact', callback),
  onTrackUpdate: (callback) => ipcRenderer.on('track-update', (_event, track) => callback(track))
});
