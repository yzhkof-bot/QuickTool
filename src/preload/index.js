const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('quickTool', {
  listScripts: () => ipcRenderer.invoke('scripts:list'),
  runScript: (id) => ipcRenderer.invoke('scripts:run', id),
  openScriptsDir: () => ipcRenderer.invoke('scripts:openDir'),
  revealScript: (id) => ipcRenderer.invoke('scripts:reveal', id),
  getScriptsDir: () => ipcRenderer.invoke('scripts:scriptsDir'),
  getRunHistory: () => ipcRenderer.invoke('runs:history'),

  openLogWindow: () => ipcRenderer.invoke('log:open'),
  openDeviceFilesWindow: () => ipcRenderer.invoke('deviceFiles:open'),
  openSvnPickWindow: () => ipcRenderer.invoke('svn:open'),
  captureScreenshot: () => ipcRenderer.invoke('capture:screenshot'),
  toggleGifCapture: () => ipcRenderer.invoke('capture:gifToggle'),
  convertVideoToGif: () => ipcRenderer.invoke('capture:convertVideo'),
  getCaptureStatus: () => ipcRenderer.invoke('capture:status'),

  onScriptsChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('scripts:changed', handler);
    return () => ipcRenderer.removeListener('scripts:changed', handler);
  },
  onRunEvent: (cb) => {
    const handler = (_e, event) => cb(event);
    ipcRenderer.on('runs:event', handler);
    return () => ipcRenderer.removeListener('runs:event', handler);
  },
  onCaptureStatus: (cb) => {
    const handler = (_e, status) => cb(status);
    ipcRenderer.on('capture:status', handler);
    return () => ipcRenderer.removeListener('capture:status', handler);
  },

  // 设备日志（adb / hdc 共用一套 IPC，platformId 由调用端传入）
  log: {
    listPlatforms: () => ipcRenderer.invoke('log:platforms'),

    check: (platformId) => ipcRenderer.invoke('log:check', platformId),
    devices: (platformId) => ipcRenderer.invoke('log:devices', platformId),
    diag: (platformId) => ipcRenderer.invoke('log:diag', platformId),

    getBinaryPath: (platformId) => ipcRenderer.invoke('log:getBinaryPath', platformId),
    setBinaryPath: (platformId, p) => ipcRenderer.invoke('log:setBinaryPath', platformId, p),
    pickBinaryPath: (platformId) => ipcRenderer.invoke('log:pickBinaryPath', platformId),

    packages: (platformId, serial) => ipcRenderer.invoke('log:packages', platformId, serial),
    pidOf: (platformId, serial, pkg) => ipcRenderer.invoke('log:pid', platformId, serial, pkg),
    clear: (platformId, serial) => ipcRenderer.invoke('log:clear', platformId, serial),
    isRunning: (platformId) => ipcRenderer.invoke('log:isRunning', platformId),
    start: (platformId, serial) => ipcRenderer.invoke('log:start', platformId, serial),
    stop: (platformId) => ipcRenderer.invoke('log:stop', platformId),

    save: (platformId, content, defaultName) => ipcRenderer.invoke('log:save', platformId, content, defaultName),
    importFile: () => ipcRenderer.invoke('log:import'),

    // 王者（含 sgame）日志：列目录 / 拉取选中文件内容
    sgameLogs: (platformId, serial, bundleName) =>
      ipcRenderer.invoke('log:sgameLogs', platformId, serial, bundleName),
    sgameLogContent: (platformId, serial, bundleName, fileName) =>
      ipcRenderer.invoke('log:sgameLogContent', platformId, serial, bundleName, fileName),

    onLines: (cb) => {
      const handler = (_e, payload) => cb(payload); // { platformId, lines }
      ipcRenderer.on('log:stream:lines', handler);
      return () => ipcRenderer.removeListener('log:stream:lines', handler);
    },
    onStderr: (cb) => {
      const handler = (_e, payload) => cb(payload); // { platformId, text }
      ipcRenderer.on('log:stream:stderr', handler);
      return () => ipcRenderer.removeListener('log:stream:stderr', handler);
    },
    onExit: (cb) => {
      const handler = (_e, payload) => cb(payload); // { platformId, code, signal, error }
      ipcRenderer.on('log:stream:exit', handler);
      return () => ipcRenderer.removeListener('log:stream:exit', handler);
    },
  },

  // AI 日志分析（codebuddy agent SDK）
  ai: {
    health: () => ipcRenderer.invoke('ai:health'),
    create: (payload) => ipcRenderer.invoke('ai:create', payload),
    appendLog: (chunk) => ipcRenderer.invoke('ai:appendLog', chunk),
    send: (text) => ipcRenderer.invoke('ai:send', text),
    interrupt: () => ipcRenderer.invoke('ai:interrupt'),
    setModel: (model) => ipcRenderer.invoke('ai:setModel', model),
    listModels: (opts) => ipcRenderer.invoke('ai:listModels', opts || {}),
    close: () => ipcRenderer.invoke('ai:close'),
    info: () => ipcRenderer.invoke('ai:info'),
    onEvent: (cb) => {
      const handler = (_e, ev) => cb(ev);
      ipcRenderer.on('ai:event', handler);
      return () => ipcRenderer.removeListener('ai:event', handler);
    },
  },

  // SVN Cherry-pick 可视化
  svn: {
    check: () => ipcRenderer.invoke('svn:check'),
    diag: () => ipcRenderer.invoke('svn:diag'),
    getBinaryPath: () => ipcRenderer.invoke('svn:getBinaryPath'),
    setBinaryPath: (p) => ipcRenderer.invoke('svn:setBinaryPath', p),
    pickBinaryPath: () => ipcRenderer.invoke('svn:pickBinaryPath'),
    pickDir: () => ipcRenderer.invoke('svn:pickDir'),
    info: (target) => ipcRenderer.invoke('svn:info', target),
    log: (source, options) => ipcRenderer.invoke('svn:log', source, options),
    update: (target) => ipcRenderer.invoke('svn:update', target),
    merge: (payload) => ipcRenderer.invoke('svn:merge', payload),
    status: (target) => ipcRenderer.invoke('svn:status', target),
    diff: (target) => ipcRenderer.invoke('svn:diff', target),
    commit: (target, message) => ipcRenderer.invoke('svn:commit', target, message),
    revert: (target) => ipcRenderer.invoke('svn:revert', target),
    cleanup: (target) => ipcRenderer.invoke('svn:cleanup', target),
    sourceName: (source) => ipcRenderer.invoke('svn:sourceName', source),
    getHistory: () => ipcRenderer.invoke('svn:getHistory'),
    recordSource: (value) => ipcRenderer.invoke('svn:recordSource', value),
    recordTarget: (value) => ipcRenderer.invoke('svn:recordTarget', value),
    removeHistory: (kind, value) => ipcRenderer.invoke('svn:removeHistory', kind, value),
  },

  // 真机文件浏览器（adb / hdc 路径设置复用日志工具）
  deviceFiles: {
    listPlatforms: () => ipcRenderer.invoke('deviceFiles:platforms'),
    check: (platformId) => ipcRenderer.invoke('deviceFiles:check', platformId),
    devices: (platformId) => ipcRenderer.invoke('deviceFiles:devices', platformId),
    diag: (platformId) => ipcRenderer.invoke('deviceFiles:diag', platformId),
    packages: (platformId, serial) => ipcRenderer.invoke('deviceFiles:packages', platformId, serial),
    pickBinaryPath: (platformId) => ipcRenderer.invoke('deviceFiles:pickBinaryPath', platformId),
    setBinaryPath: (platformId, p) => ipcRenderer.invoke('deviceFiles:setBinaryPath', platformId, p),
    list: (platformId, serial, remotePath, options) =>
      ipcRenderer.invoke('deviceFiles:list', platformId, serial, remotePath, options),
    pull: (platformId, serial, item, options) =>
      ipcRenderer.invoke('deviceFiles:pull', platformId, serial, item, options),
    upload: (platformId, serial, remoteDir, localPaths, options) =>
      ipcRenderer.invoke('deviceFiles:upload', platformId, serial, remoteDir, localPaths, options),
    delete: (platformId, serial, item, options) =>
      ipcRenderer.invoke('deviceFiles:delete', platformId, serial, item, options),
    getPathForFile: (file) => webUtils.getPathForFile(file),
    open: (platformId, serial, item, options) =>
      ipcRenderer.invoke('deviceFiles:openItem', platformId, serial, item, options),
    properties: (platformId, serial, item, options) =>
      ipcRenderer.invoke('deviceFiles:properties', platformId, serial, item, options),
  },
});
