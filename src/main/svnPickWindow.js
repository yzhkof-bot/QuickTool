const { BrowserWindow } = require('electron');
const path = require('path');

let svnPickWindow = null;

function createSvnPickWindow({ icon } = {}) {
  if (svnPickWindow && !svnPickWindow.isDestroyed()) {
    if (svnPickWindow.isMinimized()) svnPickWindow.restore();
    svnPickWindow.show();
    svnPickWindow.focus();
    return svnPickWindow;
  }

  const opts = {
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    title: 'QuickTool · SVN Cherry-pick',
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

  svnPickWindow = new BrowserWindow(opts);
  svnPickWindow.setMenu(null);
  svnPickWindow.loadFile(path.join(__dirname, '..', 'renderer', 'svn-pick.html'));

  svnPickWindow.on('closed', () => {
    svnPickWindow = null;
  });

  return svnPickWindow;
}

function getSvnPickWindow() {
  return svnPickWindow;
}

module.exports = { createSvnPickWindow, getSvnPickWindow };
