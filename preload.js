'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, data) => callback(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  currentState: () => ipcRenderer.invoke('media:state'),
  onState: (callback) => subscribe('media:state', callback),
  command: (payload) => ipcRenderer.invoke('media:command', payload),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  restartProvider: () => ipcRenderer.invoke('provider:restart'),
  openYandex: () => ipcRenderer.invoke('open:yandex'),
  openTrack: (track) => ipcRenderer.invoke('open:track', track),
});
