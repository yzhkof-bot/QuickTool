const { app, BrowserWindow, ipcMain, shell, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const scanner = require('./scriptScanner');
const runner = require('./scriptRunner');
const { createTray } = require('./tray');
const logPlatforms = require('./logPlatforms');
const { createAdbWindow, getAdbWindow } = require('./adbWindow');
const { createDeviceFilesWindow, getDeviceFilesWindow } = require('./deviceFilesWindow');
const { QuickCaptureTool } = require('./captureTool');
const aiLogChat = require('./aiLogChat');

const SCRIPTS_DIR = path.join(app.getAppPath(), 'scripts');
const APP_ICON_PATH = path.join(app.getAppPath(), 'assets', 'tray-icon.png');

function loadAppIcon() {
  if (!fs.existsSync(APP_ICON_PATH)) return undefined;
  const img = nativeImage.createFromPath(APP_ICON_PATH);
  if (img.isEmpty()) return undefined;
  const size = img.getSize();
  if (size.width !== size.height) {
    const side = Math.min(size.width, size.height);
    return img.crop({
      x: Math.floor((size.width - side) / 2),
      y: Math.floor((size.height - side) / 2),
      width: side,
      height: side,
    });
  }
  return img;
}

let mainWindow = null;
let tray = null;
let watcher = null;
let isQuiting = false;
let captureTool = null;

function createMainWindow() {
  const appIcon = loadAppIcon();
  const windowOptions = {
    width: 760,
    height: 600,
    minWidth: 520,
    minHeight: 420,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#1e1f24',
    title: 'QuickTool',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  };
  if (appIcon) windowOptions.icon = appIcon;
  mainWindow = new BrowserWindow(windowOptions);

  Menu.setApplicationMenu(null);

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow() {
  if (!mainWindow) {
    createMainWindow();
    return;
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
  } else {
    showMainWindow();
  }
}

function broadcastScriptsChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('scripts:changed');
  }
}

function openLogWindow() {
  createAdbWindow({
    icon: loadAppIcon(),
    onClosed: () => {
      // 关窗时停掉所有平台的流，防止子进程在后台一直跑
      try { logPlatforms.stopAllStreams(); } catch (_) { /* ignore */ }
      lineQueue = [];
      lineQueuePlatform = '';
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      // 顺手把 AI 会话也关掉，避免 CLI 子进程在后台漂着
      try { aiLogChat.closeActive(); } catch (_) { /* ignore */ }
    },
  });
}

function sendAiEvent(payload) {
  const win = getAdbWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('ai:event', payload);
  }
}

function openDeviceFilesWindow() {
  createDeviceFilesWindow({
    icon: loadAppIcon(),
  });
}

function broadcastCaptureStatus() {
  const status = { gifRecording: captureTool ? captureTool.isGifRecording() : false };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('capture:status', status);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startScreenshotCapture() {
  if (!captureTool) return { ok: false, error: '截图工具尚未初始化' };
  const shouldRestoreMainWindow = mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  try {
    if (shouldRestoreMainWindow) {
      mainWindow.hide();
      await wait(60);
    }
    await captureTool.startScreenshot();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (shouldRestoreMainWindow) {
      showMainWindow();
    }
  }
}

async function toggleGifCapture() {
  if (!captureTool) return { ok: false, error: '截图工具尚未初始化' };
  try {
    const result = captureTool.isGifRecording()
      ? await captureTool.stopGif()
      : await captureTool.startGif();
    broadcastCaptureStatus();
    return result;
  } catch (e) {
    broadcastCaptureStatus();
    return { ok: false, error: e.message };
  }
}

async function convertVideoToGif() {
  if (!captureTool) return { ok: false, error: '截图工具尚未初始化' };
  try {
    const result = await captureTool.convertVideoToGif();
    broadcastCaptureStatus();
    return result;
  } catch (e) {
    broadcastCaptureStatus();
    return { ok: false, error: e.message };
  }
}

// 把流式日志按 batch 推到日志窗口，避免 IPC 风暴。
// 同一时刻只会有一个平台在流式输出，所以一个共享队列就够。
let lineQueue = [];
let lineQueuePlatform = '';
let flushTimer = null;

function sendToLogWindow(channel, payload) {
  const win = getAdbWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function flushLines() {
  if (lineQueue.length === 0) return;
  const win = getAdbWindow();
  if (!win || win.isDestroyed()) {
    lineQueue = [];
    return;
  }
  const batch = lineQueue;
  const platformId = lineQueuePlatform;
  lineQueue = [];
  win.webContents.send('log:stream:lines', { platformId, lines: batch });
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushLines();
  }, 80);
}

// 把渲染端传来的 platformId 解析成对应的平台模块
function pf(platformId) {
  return logPlatforms.get(platformId);
}

function remoteBaseName(remotePath) {
  const clean = String(remotePath || '').replace(/\/+$/, '');
  if (!clean || clean === '/') return 'device-root';
  return clean.split('/').filter(Boolean).pop() || 'device-file';
}

function safeLocalName(name) {
  return String(name || 'device-file').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_') || 'device-file';
}

function registerIpc() {
  ipcMain.handle('scripts:list', () => scanner.scan(SCRIPTS_DIR));

  ipcMain.handle('scripts:run', (_event, id) => {
    const items = scanner.scan(SCRIPTS_DIR);
    const target = items.find((s) => s.id === id);
    if (!target) return { ok: false, error: '脚本不存在或已被删除' };
    return runner.run(target);
  });

  ipcMain.handle('scripts:openDir', () => shell.openPath(SCRIPTS_DIR));

  ipcMain.handle('scripts:reveal', (_event, id) => {
    const items = scanner.scan(SCRIPTS_DIR);
    const target = items.find((s) => s.id === id);
    if (!target) return { ok: false };
    shell.showItemInFolder(target.path);
    return { ok: true };
  });

  ipcMain.handle('scripts:scriptsDir', () => SCRIPTS_DIR);

  ipcMain.handle('runs:history', () => runner.getHistory());

  runner.addRunListener((event) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('runs:event', event);
    }
  });

  // ===== 设备日志（adb / hdc 共用） =====
  ipcMain.handle('log:open', () => {
    openLogWindow();
    return { ok: true };
  });

  // ===== 截图 / GIF 捕获 =====
  ipcMain.handle('capture:screenshot', () => startScreenshotCapture());
  ipcMain.handle('capture:gifToggle', () => toggleGifCapture());
  ipcMain.handle('capture:convertVideo', () => convertVideoToGif());
  ipcMain.handle('capture:status', () => ({
    gifRecording: captureTool ? captureTool.isGifRecording() : false,
  }));

  ipcMain.handle('log:platforms', () => logPlatforms.listMeta());

  ipcMain.handle('log:check', (_e, platformId) => pf(platformId).check());
  ipcMain.handle('log:devices', (_e, platformId) => pf(platformId).listDevices());
  ipcMain.handle('log:diag', (_e, platformId) => pf(platformId).diagnose());

  ipcMain.handle('log:getBinaryPath', (_e, platformId) => ({ path: pf(platformId).getBinaryPath() }));
  ipcMain.handle('log:setBinaryPath', (_e, platformId, p) => pf(platformId).setBinaryPath(p));
  ipcMain.handle('log:pickBinaryPath', async (_e, platformId) => {
    const p = pf(platformId);
    const win = getAdbWindow() || mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: `选择 ${p.meta.binaryDisplay}`,
      properties: ['openFile'],
      filters: p.meta.pickFilters,
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    return p.setBinaryPath(result.filePaths[0]);
  });

  ipcMain.handle('log:packages', (_e, platformId, serial) => pf(platformId).listPackages(serial));
  ipcMain.handle('log:pid', (_e, platformId, serial, pkg) => pf(platformId).getPidForPackage(serial, pkg));
  ipcMain.handle('log:clear', (_e, platformId, serial) => pf(platformId).clearBuffer(serial));
  ipcMain.handle('log:isRunning', (_e, platformId) => ({ running: pf(platformId).isStreaming() }));

  ipcMain.handle('log:start', (_e, platformId, serial, options) => {
    const opts = options || {};
    // 切换平台时若另一个平台还在流，先停掉，避免两路日志混进同一队列
    for (const meta of logPlatforms.listMeta()) {
      if (meta.id !== platformId && pf(meta.id).isStreaming()) {
        try { pf(meta.id).stopStream(); } catch (_) { /* ignore */ }
      }
    }
    lineQueue = [];
    lineQueuePlatform = platformId;

    return pf(platformId).startStream({
      serial,
      mode: opts.mode || 'realtime',
      bundleName: opts.bundleName || '',
      onLines: (lines) => {
        // 平台切换或停止后到来的尾行直接丢弃，避免污染
        if (lineQueuePlatform !== platformId) return;
        lineQueue.push(...lines);
        if (lineQueue.length >= 500) flushLines();
        else scheduleFlush();
      },
      onStderr: (text) => {
        if (lineQueuePlatform !== platformId) return;
        sendToLogWindow('log:stream:stderr', { platformId, text });
      },
      onExit: ({ code, signal, error }) => {
        flushLines();
        sendToLogWindow('log:stream:exit', { platformId, code, signal, error });
      },
    });
  });

  ipcMain.handle('log:stop', (_e, platformId) => pf(platformId).stopStream());

  ipcMain.handle('log:save', async (_e, platformId, content, defaultName) => {
    const p = pf(platformId);
    const win = getAdbWindow() || mainWindow;
    const fallback = `${p.meta.defaultLogFilePrefix}-${Date.now()}.log`;
    const result = await dialog.showSaveDialog(win, {
      title: '保存日志',
      defaultPath: defaultName || fallback,
      filters: [
        { name: '日志文件', extensions: ['log', 'txt'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    try {
      await fs.promises.writeFile(result.filePath, content, 'utf8');
      return { ok: true, path: result.filePath };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('log:import', async () => {
    const win = getAdbWindow() || mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: '导入日志文件',
      properties: ['openFile'],
      filters: [
        { name: '日志文件', extensions: ['log', 'txt'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const filePath = result.filePaths[0];
    try {
      const content = await fs.promises.readFile(filePath, 'utf8');
      return { ok: true, path: filePath, content };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ===== 真机文件浏览器（复用 logPlatforms 的 adb / hdc 路径设置） =====
  ipcMain.handle('deviceFiles:open', () => {
    openDeviceFilesWindow();
    return { ok: true };
  });

  ipcMain.handle('deviceFiles:platforms', () => logPlatforms.listMeta());
  ipcMain.handle('deviceFiles:check', (_e, platformId) => pf(platformId).check());
  ipcMain.handle('deviceFiles:devices', (_e, platformId) => pf(platformId).listDevices());
  ipcMain.handle('deviceFiles:diag', (_e, platformId) => pf(platformId).diagnose());
  ipcMain.handle('deviceFiles:packages', (_e, platformId, serial) => pf(platformId).listPackages(serial));
  ipcMain.handle('deviceFiles:pickBinaryPath', async (_e, platformId) => {
    const p = pf(platformId);
    const win = getDeviceFilesWindow() || mainWindow;
    const result = await dialog.showOpenDialog(win, {
      title: `选择 ${p.meta.binaryDisplay}`,
      properties: ['openFile'],
      filters: p.meta.pickFilters,
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    return p.setBinaryPath(result.filePaths[0]);
  });
  ipcMain.handle('deviceFiles:setBinaryPath', (_e, platformId, p) => pf(platformId).setBinaryPath(p));

  ipcMain.handle('deviceFiles:list', (_e, platformId, serial, remotePath, options) =>
    pf(platformId).listFiles(serial, remotePath || '/', options || {}));

  ipcMain.handle('deviceFiles:pull', async (_e, platformId, serial, item, options) => {
    const target = item || {};
    const remotePath = target.path;
    if (!remotePath) return { ok: false, error: '未选择远端路径' };

    const win = getDeviceFilesWindow() || mainWindow;
    const defaultName = remoteBaseName(remotePath);
    let localPath = '';
    if (target.type === 'dir') {
      const result = await dialog.showOpenDialog(win, {
        title: `选择保存 ${defaultName} 的本地目录`,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      localPath = result.filePaths[0];
    } else {
      const result = await dialog.showSaveDialog(win, {
        title: `保存 ${defaultName}`,
        defaultPath: defaultName,
        filters: [{ name: '全部文件', extensions: ['*'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      localPath = result.filePath;
    }
    return pf(platformId).pullFile(serial, remotePath, localPath, options || {});
  });

  ipcMain.handle('deviceFiles:upload', async (_e, platformId, serial, remoteDir, localPaths, options) => {
    if (!remoteDir) return { ok: false, error: '未选择远端目录' };
    let files = Array.isArray(localPaths) ? localPaths.filter(Boolean) : [];
    if (!files.length) {
      const win = getDeviceFilesWindow() || mainWindow;
      const result = await dialog.showOpenDialog(win, {
        title: `上传文件到 ${remoteDir}`,
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '全部文件', extensions: ['*'] }],
      });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      files = result.filePaths;
    }
    return pf(platformId).uploadFiles(serial, files, remoteDir, options || {});
  });

  ipcMain.handle('deviceFiles:delete', (_e, platformId, serial, item, options) => {
    const target = item || {};
    if (!target.path) return { ok: false, error: '未选择远端路径' };
    return pf(platformId).deleteFile(serial, target.path, options || {});
  });

  ipcMain.handle('deviceFiles:openItem', async (_e, platformId, serial, item, options) => {
    const target = item || {};
    const remotePath = target.path;
    if (!remotePath) return { ok: false, error: '未选择远端路径' };

    const defaultName = safeLocalName(remoteBaseName(remotePath));
    const tempRoot = path.join(
      app.getPath('temp'),
      'QuickTool-device-files',
      `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    try {
      await fs.promises.mkdir(tempRoot, { recursive: true });
    } catch (e) {
      return { ok: false, error: e.message };
    }

    const localPath = target.type === 'dir'
      ? tempRoot
      : path.join(tempRoot, defaultName);
    const pulled = await pf(platformId).pullFile(serial, remotePath, localPath, options || {});
    if (!pulled.ok) return pulled;

    const preferredPath = target.type === 'dir'
      ? path.join(tempRoot, defaultName)
      : localPath;
    const pathToOpen = fs.existsSync(preferredPath) ? preferredPath : localPath;
    const error = await shell.openPath(pathToOpen);
    if (error) return { ok: false, error, localPath: pathToOpen };
    return { ok: true, localPath: pathToOpen };
  });

  ipcMain.handle('deviceFiles:properties', (_e, platformId, serial, item, options) => {
    const target = item || {};
    if (!target.path) return { ok: false, error: '未选择远端路径' };
    return pf(platformId).collectFileProperties(serial, target.path, options || {});
  });

  // ===== AI 日志分析（codebuddy agent SDK） =====
  ipcMain.handle('ai:health', () => aiLogChat.health());

  ipcMain.handle('ai:create', async (_e, payload) => {
    const data = payload || {};
    try {
      const info = await aiLogChat.create({
        initialLog: String(data.initialLog || ''),
        context: data.context || {},
        model: data.model || '',
        onEvent: (ev) => sendAiEvent(ev),
        log: (text) => { try { process.stderr.write(text); } catch (_) { /* ignore */ } },
      });
      return { ok: true, info };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('ai:appendLog', async (_e, chunk) => {
    try {
      await aiLogChat.appendLog(String(chunk || ''));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('ai:send', async (_e, text) => {
    try {
      // 这里不 await，避免占住 IPC channel；事件会通过 ai:event 推回去
      aiLogChat.send(String(text || ''))
        .catch((err) => sendAiEvent({
          type: 'error',
          message: err && err.message ? err.message : String(err),
        }));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('ai:interrupt', async () => {
    try {
      await aiLogChat.interrupt();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('ai:setModel', async (_e, model) => {
    try {
      await aiLogChat.setModel(String(model || ''));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('ai:listModels', async (_e, opts) => {
    try {
      const force = !!(opts && opts.force);
      const res = await aiLogChat.listModels(force);
      return { ok: true, models: res.models, fromSdk: res.fromSdk };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });

  ipcMain.handle('ai:close', () => {
    try { aiLogChat.closeActive(); } catch (_) { /* ignore */ }
    return { ok: true };
  });

  ipcMain.handle('ai:info', () => {
    return { ok: true, info: aiLogChat.getActiveInfo() };
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });

  app.whenReady().then(() => {
    scanner.ensureScriptsDir(SCRIPTS_DIR);
    captureTool = new QuickCaptureTool({ onStatusChanged: broadcastCaptureStatus });

    createMainWindow();

    tray = createTray({
      scriptsDir: SCRIPTS_DIR,
      onToggleWindow: toggleMainWindow,
      onShowWindow: showMainWindow,
      onRefresh: broadcastScriptsChanged,
      onOpenLog: openLogWindow,
      onOpenDeviceFiles: openDeviceFilesWindow,
      onScreenshot: startScreenshotCapture,
      onGifToggle: toggleGifCapture,
      onConvertVideo: convertVideoToGif,
      onQuit: () => {
        isQuiting = true;
        app.quit();
      },
    });

    watcher = scanner.startWatcher(SCRIPTS_DIR, broadcastScriptsChanged);

    registerIpc();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
      else showMainWindow();
    });
  });

  app.on('window-all-closed', (e) => {
    e.preventDefault();
  });

  app.on('before-quit', () => {
    isQuiting = true;
    if (watcher) {
      watcher.close().catch(() => {});
    }
    try {
      logPlatforms.stopAllStreams();
    } catch (_) {
      // ignore
    }
    try {
      if (captureTool) captureTool.cleanup();
    } catch (_) {
      // ignore
    }
    try {
      aiLogChat.closeActive();
    } catch (_) {
      // ignore
    }
  });
}
