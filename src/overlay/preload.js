const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('quickCapture', {
  onScreenshotData: (callback) => {
    ipcRenderer.on('screenshot:data', (_event, data) => callback(data));
  },
  sendSelectionDone: (result) => {
    ipcRenderer.send('selection:done', result);
  },
  sendSelectionCancel: () => {
    ipcRenderer.send('selection:cancel');
  },
});
