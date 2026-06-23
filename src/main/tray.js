const { Tray, Menu, nativeImage, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');

// Windows 托盘的逻辑显示尺寸是 16x16，但用 32x32 的源图缩放后在高 DPI 下更清晰。
const TRAY_ICON_SIZE = 32;

// 把任意比例的源图裁成中心正方形，再缩放到目标尺寸；
// 顺手把"非正方形画布两侧的空白/伪影"裁掉，避免托盘里出现奇怪的小杂点。
function normalizeTrayIcon(img) {
  if (img.isEmpty()) return img;
  const size = img.getSize();
  if (!size || !size.width || !size.height) return img;

  let processed = img;
  if (size.width !== size.height) {
    const side = Math.min(size.width, size.height);
    processed = img.crop({
      x: Math.floor((size.width - side) / 2),
      y: Math.floor((size.height - side) / 2),
      width: side,
      height: side,
    });
  }
  return processed.resize({
    width: TRAY_ICON_SIZE,
    height: TRAY_ICON_SIZE,
    quality: 'best',
  });
}

function loadTrayIcon() {
  const candidates = [
    path.join(__dirname, '..', '..', 'assets', 'tray-icon.ico'),
    path.join(__dirname, '..', '..', 'assets', 'tray-icon.png'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const img = nativeImage.createFromPath(p);
    if (img.isEmpty()) continue;
    // .ico 一般已经是多尺寸优化过的，直接返回；.png 走 normalize。
    if (p.toLowerCase().endsWith('.ico')) return img;
    return normalizeTrayIcon(img);
  }
  // 兜底：使用 Electron 可执行文件自带图标（开发期是 Electron logo，
  // 打包后是应用图标），保证托盘一定能看到东西。
  try {
    const fallback = nativeImage.createFromPath(process.execPath);
    if (!fallback.isEmpty()) return fallback;
  } catch (_) {
    // ignore
  }
  return nativeImage.createEmpty();
}

function createTray({
  scriptsDir,
  onToggleWindow,
  onShowWindow,
  onRefresh,
  onOpenLog,
  onOpenDeviceFiles,
  onOpenSvnPick,
  onScreenshot,
  onGifToggle,
  onConvertVideo,
  onQuit,
}) {
  const tray = new Tray(loadTrayIcon());
  tray.setToolTip('QuickTool');

  const contextMenu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => onShowWindow && onShowWindow() },
    { label: '打开脚本目录', click: () => shell.openPath(scriptsDir) },
    { label: '刷新脚本列表', click: () => onRefresh && onRefresh() },
    { type: 'separator' },
    { label: '截图 / 标注', click: () => onScreenshot && onScreenshot() },
    { label: '开始 / 停止 GIF 录制', click: () => onGifToggle && onGifToggle() },
    { label: '视频转 GIF…', click: () => onConvertVideo && onConvertVideo() },
    { type: 'separator' },
    { label: '设备日志分析（adb / hdc）', click: () => onOpenLog && onOpenLog() },
    { label: '真机文件浏览器（adb / hdc）', click: () => onOpenDeviceFiles && onOpenDeviceFiles() },
    { label: 'SVN Cherry-pick', click: () => onOpenSvnPick && onOpenSvnPick() },
    { type: 'separator' },
    {
      label: `版本 ${app.getVersion()}`,
      enabled: false,
    },
    { type: 'separator' },
    { label: '退出 QuickTool', click: () => onQuit && onQuit() },
  ]);
  tray.setContextMenu(contextMenu);

  tray.on('click', () => onToggleWindow && onToggleWindow());
  tray.on('double-click', () => onShowWindow && onShowWindow());

  return tray;
}

module.exports = { createTray };
