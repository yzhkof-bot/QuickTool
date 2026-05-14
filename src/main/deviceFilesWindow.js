const { BrowserWindow } = require('electron');
const path = require('path');

let deviceFilesWindow = null;

function createDeviceFilesWindow({ icon } = {}) {
  if (deviceFilesWindow && !deviceFilesWindow.isDestroyed()) {
    if (deviceFilesWindow.isMinimized()) deviceFilesWindow.restore();
    deviceFilesWindow.show();
    deviceFilesWindow.focus();
    return deviceFilesWindow;
  }

  const opts = {
    width: 1080,
    height: 720,
    minWidth: 720,
    minHeight: 460,
    title: 'QuickTool · 真机文件浏览器（adb / hdc）',
    backgroundColor: '#1e1f24',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  if (icon) opts.icon = icon;

  deviceFilesWindow = new BrowserWindow(opts);
  deviceFilesWindow.setMenu(null);
  deviceFilesWindow.loadFile(path.join(__dirname, '..', 'renderer', 'device-files.html'));

  deviceFilesWindow.on('closed', () => {
    deviceFilesWindow = null;
  });

  return deviceFilesWindow;
}

function getDeviceFilesWindow() {
  return deviceFilesWindow;
}

module.exports = { createDeviceFilesWindow, getDeviceFilesWindow };
