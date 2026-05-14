const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quickCapturePreview', {
  onPreviewData: (callback) => {
    ipcRenderer.on('gif-preview:data', (_event, data) => callback(data));
  },
  onQualityResult: (callback) => {
    ipcRenderer.on('gif-preview:quality-result', (_event, data) => callback(data));
  },
  save: () => {
    ipcRenderer.send('gif-preview:save');
  },
  saveVideo: () => {
    ipcRenderer.send('gif-preview:save-video');
  },
  cancel: () => {
    ipcRenderer.send('gif-preview:cancel');
  },
  changeQuality: (scale) => {
    ipcRenderer.send('gif-preview:quality', scale);
  },
  updateSegments: (segments) => {
    ipcRenderer.send('gif-preview:segments', { segments });
  },
});
