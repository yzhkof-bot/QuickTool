const { BrowserWindow } = require('electron');
const path = require('path');

let adbWindow = null;

function createAdbWindow({ icon, onClosed } = {}) {
  if (adbWindow && !adbWindow.isDestroyed()) {
    if (adbWindow.isMinimized()) adbWindow.restore();
    adbWindow.show();
    adbWindow.focus();
    return adbWindow;
  }

  const opts = {
    width: 1180,
    height: 760,
    minWidth: 760,
    minHeight: 480,
    title: 'QuickTool · 设备日志分析（adb / hdc）',
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

  adbWindow = new BrowserWindow(opts);
  adbWindow.setMenu(null);
  adbWindow.loadFile(path.join(__dirname, '..', 'renderer', 'adb-log.html'));

  adbWindow.on('closed', () => {
    adbWindow = null;
    if (typeof onClosed === 'function') {
      try { onClosed(); } catch (_) { /* ignore */ }
    }
  });

  return adbWindow;
}

function getAdbWindow() {
  return adbWindow;
}

module.exports = { createAdbWindow, getAdbWindow };
