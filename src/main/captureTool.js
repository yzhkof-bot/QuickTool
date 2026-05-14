const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execSync, spawn } = require('child_process');
const { app, BrowserWindow, clipboard, desktopCapturer, dialog, ipcMain, nativeImage, Notification, screen } = require('electron');

// ffmpeg 在 Windows + gdigrab 下对 stdin 的 'q' 不总是及时响应（小区域 / 极快编码尤其明显）。
// 我们改用碎片化 MP4 + flush_packets，让强杀也能得到一个可读文件，所以这里超时给得很短。
const FFMPEG_GRACEFUL_STOP_TIMEOUT_MS = 3000;

function getFfmpegPath() {
  try {
    const bundledPath = require('ffmpeg-static');
    if (bundledPath && fs.existsSync(bundledPath)) return bundledPath;
  } catch (_) {
    // Fall back to a system ffmpeg on PATH.
  }
  return 'ffmpeg';
}

function forceKillProcess(childProcess) {
  if (!childProcess || childProcess.killed) return;
  if (process.platform === 'win32' && childProcess.pid) {
    execFile('taskkill.exe', ['/PID', String(childProcess.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    childProcess.kill('SIGKILL');
  } catch (_) {
    // ignore
  }
}

const IPC = {
  SELECTION_DONE: 'selection:done',
  SELECTION_CANCEL: 'selection:cancel',
  SCREENSHOT_DATA: 'screenshot:data',
  GIF_PREVIEW_DATA: 'gif-preview:data',
  GIF_PREVIEW_SAVE: 'gif-preview:save',
  GIF_PREVIEW_SAVE_VIDEO: 'gif-preview:save-video',
  GIF_PREVIEW_CANCEL: 'gif-preview:cancel',
  GIF_PREVIEW_QUALITY: 'gif-preview:quality',
  GIF_PREVIEW_QUALITY_RESULT: 'gif-preview:quality-result',
  GIF_PREVIEW_SEGMENTS: 'gif-preview:segments',
};

const DEFAULT_CONFIG = {
  output: {
    copyToClipboard: true,
  },
  gif: {
    fps: 10,
    maxDuration: 30,
    quality: 10,
  },
};

function notify(title, body) {
  new Notification({ title, body }).show();
}

function getConfig() {
  const outputDir = process.platform === 'darwin'
    ? path.join(app.getPath('home'), 'Desktop')
    : app.getPath('pictures');

  return {
    ...DEFAULT_CONFIG,
    output: {
      ...DEFAULT_CONFIG.output,
      directory: outputDir,
    },
  };
}

function getTimestamp() {
  return new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
}

function getOutputPath(mode, outputDir) {
  const ext = mode === 'screenshot' ? 'png' : 'gif';
  const filename = `quicktool_capture_${getTimestamp()}.${ext}`;
  fs.mkdirSync(outputDir, { recursive: true });
  return path.join(outputDir, filename);
}

function getTempRecordingDir() {
  return path.join(os.tmpdir(), 'quicktool-capture-recordings');
}

function getTempRecordingPath(ext) {
  const tempDir = getTempRecordingDir();
  fs.mkdirSync(tempDir, { recursive: true });
  const normalizedExt = ext.startsWith('.') ? ext.slice(1) : ext;
  return path.join(tempDir, `quicktool_capture_${getTimestamp()}.${normalizedExt}`);
}

// 启动时清理上次崩溃 / 强制退出留下的临时录制文件，避免它们长期占用 %TEMP%。
function pruneOrphanCaptureFiles({ keepFiles = new Set() } = {}) {
  // 清理 quicktool-capture-recordings 目录中所有非"当前在用"的录制文件
  const recordingsDir = getTempRecordingDir();
  if (fs.existsSync(recordingsDir)) {
    try {
      for (const entry of fs.readdirSync(recordingsDir)) {
        const full = path.join(recordingsDir, entry);
        if (keepFiles.has(full)) continue;
        try { fs.rmSync(full, { force: true, recursive: true }); } catch (_) {}
      }
    } catch (_) {}
  }
  // 清理预览阶段为 GIF 估算创建的临时目录（quicktool-capture-preview-*）
  const tmpRoot = os.tmpdir();
  try {
    for (const entry of fs.readdirSync(tmpRoot)) {
      if (!entry.startsWith('quicktool-capture-preview-') && !entry.startsWith('quicktool-capture-win-')) continue;
      const full = path.join(tmpRoot, entry);
      try { fs.rmSync(full, { force: true, recursive: true }); } catch (_) {}
    }
  } catch (_) {}
}

function replaceExtension(filePath, ext) {
  const normalizedExt = ext.startsWith('.') ? ext : `.${ext}`;
  return filePath.replace(/\.[^.]+$/, normalizedExt);
}

function getAllMonitors() {
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return displays.map((display) => ({
    id: display.id,
    bounds: {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
    },
    scaleFactor: display.scaleFactor,
    isPrimary: display.id === primary.id,
  }));
}

// 截图主入口：所有平台统一走 desktopCapturer（Chromium 内置，DPI 感知正确、单进程、毫秒级）。
async function captureAllScreens(monitors) {
  return captureViaDesktopCapturer(monitors);
}

// 把每块屏的截图取回来，按 monitor.id 索引。关键点：
// 1. 一次 getSources 拿到全部 source（thumbnailSize 给一个足够大的"上限"，
//    Electron 会按 source 自身物理像素 / 上限 取较小的，保留原始宽高比）。
// 2. 再用多重策略把 source 精准对到 monitor，避免下标错位（这次 bug 的根因）。
// 3. 拿到 thumbnail 后 *不再做主动放大*——overlay 那边会按 DIP 等比绘制，原图越大越清晰。
async function captureViaDesktopCapturer(monitors) {
  const results = new Map();
  if (!monitors || monitors.length === 0) return results;

  // thumbnailSize 上限取所有屏物理尺寸的最大值，再翻一倍留余量。
  // 这样不会把 4K 屏强行裁成另一块屏的比例。
  let maxW = 0;
  let maxH = 0;
  for (const m of monitors) {
    const p = getPhysicalSize(m);
    if (p.width > maxW) maxW = p.width;
    if (p.height > maxH) maxH = p.height;
  }
  const cap = { width: Math.max(1024, maxW * 2), height: Math.max(1024, maxH * 2) };

  const t0 = Date.now();
  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: cap,
      fetchWindowIcons: false,
    });
  } catch (err) {
    console.warn('[QuickCapture] desktopCapturer.getSources failed:', err.message);
    return results;
  }
  const dur = Date.now() - t0;
  console.log(`[QuickCapture] desktopCapturer.getSources took ${dur}ms, returned ${sources.length} source(s)`);

  // 调试用：打印每个 source 的关键信息，便于多屏排查
  sources.forEach((s, i) => {
    const ts = s.thumbnail.getSize();
    console.log(`[QuickCapture]   source[${i}] id=${s.id} display_id=${s.display_id || '(none)'} name=${s.name} thumb=${ts.width}x${ts.height}`);
  });
  monitors.forEach((m, i) => {
    const p = getPhysicalSize(m);
    console.log(`[QuickCapture]   monitor[${i}] id=${m.id} bounds=${m.bounds.x},${m.bounds.y} ${m.bounds.width}x${m.bounds.height}@${m.scaleFactor} physical=${p.width}x${p.height}${m.isPrimary ? ' (primary)' : ''}`);
  });

  // 用一个分配器：每个 source 只能被一个 monitor 占用，避免重复匹配
  const usedSources = new Set();
  const tryPick = (predicate) => {
    for (const s of sources) {
      if (usedSources.has(s)) continue;
      if (predicate(s)) {
        usedSources.add(s);
        return s;
      }
    }
    return null;
  };

  // 两轮匹配：先 display_id 精确匹配，再按物理尺寸最接近匹配。
  const picks = new Map();

  // Round 1: display_id 精确匹配
  for (const monitor of monitors) {
    const idStr = String(monitor.id);
    const picked = tryPick((s) => s.display_id && String(s.display_id) === idStr);
    if (picked) picks.set(monitor.id, picked);
  }

  // Round 2: 还没找到的，按 thumbnail 与物理尺寸的相似度匹配
  for (const monitor of monitors) {
    if (picks.has(monitor.id)) continue;
    const physical = getPhysicalSize(monitor);
    const targetAspect = physical.width / physical.height;
    let best = null;
    let bestScore = Infinity;
    for (const s of sources) {
      if (usedSources.has(s)) continue;
      const ts = s.thumbnail.getSize();
      if (!ts.width || !ts.height) continue;
      const aspect = ts.width / ts.height;
      // 优先看长宽比，其次看分辨率接近度
      const score = Math.abs(aspect - targetAspect) * 1000
        + Math.abs(ts.width - physical.width) / Math.max(physical.width, 1)
        + Math.abs(ts.height - physical.height) / Math.max(physical.height, 1);
      if (score < bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (best) {
      usedSources.add(best);
      picks.set(monitor.id, best);
    }
  }

  // Round 3: 全都没匹配上的，老老实实按下标兜底
  for (let i = 0; i < monitors.length; i++) {
    const monitor = monitors[i];
    if (picks.has(monitor.id)) continue;
    const fallback = sources[Math.min(i, sources.length - 1)];
    if (fallback && !usedSources.has(fallback)) {
      usedSources.add(fallback);
      picks.set(monitor.id, fallback);
    }
  }

  // 把每块屏的 thumbnail 转 PNG。注意 *不再按 physical 强行 resize*，
  // overlay 里会用 drawImage(img, 0, 0, dipW, dipH) 自动等比绘制。
  for (const monitor of monitors) {
    const source = picks.get(monitor.id);
    if (!source || source.thumbnail.isEmpty()) {
      console.warn(`[QuickCapture] no source for monitor id=${monitor.id}`);
      continue;
    }
    const ts = source.thumbnail.getSize();
    const physical = getPhysicalSize(monitor);
    if (ts.width !== physical.width || ts.height !== physical.height) {
      console.log(
        `[QuickCapture]   monitor=${monitor.id} captured=${ts.width}x${ts.height}, physical=${physical.width}x${physical.height} (size mismatch is OK, overlay 会按 DIP 等比缩放)`,
      );
    }
    results.set(monitor.id, source.thumbnail.toPNG());
  }

  return results;
}

function getPhysicalSize(monitor) {
  return {
    width: Math.max(1, Math.round(monitor.bounds.width * monitor.scaleFactor)),
    height: Math.max(1, Math.round(monitor.bounds.height * monitor.scaleFactor)),
  };
}

function createOverlayWindows(monitors, screenshots, mode) {
  return new Promise((resolve) => {
    const windows = [];
    let resolved = false;

    const cleanup = () => {
      ipcMain.removeAllListeners(IPC.SELECTION_DONE);
      ipcMain.removeAllListeners(IPC.SELECTION_CANCEL);
      for (const win of windows) {
        if (!win.isDestroyed()) win.close();
      }
    };

    ipcMain.once(IPC.SELECTION_DONE, (_event, result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    });

    ipcMain.once(IPC.SELECTION_CANCEL, () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(null);
    });

    for (const monitor of monitors) {
      const screenshotBuffer = screenshots.get(monitor.id);
      if (!screenshotBuffer) continue;

      const win = new BrowserWindow({
        x: monitor.bounds.x,
        y: monitor.bounds.y,
        width: monitor.bounds.width,
        height: monitor.bounds.height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        fullscreen: true,
        skipTaskbar: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: true,
        enableLargerThanScreen: true,
        webPreferences: {
          preload: path.join(__dirname, '..', 'overlay', 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });

      win.setBounds(monitor.bounds);
      win.setAlwaysOnTop(true, 'screen-saver', 1);
      win.setVisibleOnAllWorkspaces(true);
      win.setFullScreen(true);

      const dataUrl = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
      win.loadFile(path.join(__dirname, '..', 'overlay', 'renderer', 'index.html'));
      win.webContents.on('did-finish-load', () => {
        win.moveTop();
        win.focus();
        win.webContents.send(IPC.SCREENSHOT_DATA, {
          screenshotDataUrl: dataUrl,
          monitorId: monitor.id,
          scaleFactor: monitor.scaleFactor,
          mode,
        });
      });
      win.webContents.on('before-input-event', (_event, input) => {
        if (input.key === 'Escape' && !resolved) {
          resolved = true;
          cleanup();
          resolve(null);
        }
      });

      windows.push(win);
    }

    if (windows.length === 0 && !resolved) {
      resolved = true;
      cleanup();
      resolve(null);
    }
  });
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildArrowSvg(arrow) {
  const { from, to, color, strokeWidth } = arrow;
  const headLength = 15;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const arrowLeft = {
    x: to.x - headLength * Math.cos(angle - Math.PI / 6),
    y: to.y - headLength * Math.sin(angle - Math.PI / 6),
  };
  const arrowRight = {
    x: to.x - headLength * Math.cos(angle + Math.PI / 6),
    y: to.y - headLength * Math.sin(angle + Math.PI / 6),
  };

  return `
    <line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}"
          stroke="${color}" stroke-width="${strokeWidth}" stroke-linecap="round"/>
    <polygon points="${to.x},${to.y} ${arrowLeft.x},${arrowLeft.y} ${arrowRight.x},${arrowRight.y}"
             fill="${color}"/>
  `;
}

function buildTextSvg(text) {
  const { position, content, color, fontSize } = text;
  return `
    <text x="${position.x}" y="${position.y}" font-size="${fontSize}"
          fill="${color}" font-family="Arial, Helvetica, sans-serif"
          dominant-baseline="hanging">${escapeXml(content)}</text>
  `;
}

async function applyAnnotations(imageBuffer, width, height, annotations) {
  if (!annotations || annotations.length === 0) return imageBuffer;

  const imageDataUrl = `data:image/png;base64,${imageBuffer.toString('base64')}`;
  const html = `<!doctype html>
<html>
<body style="margin:0;overflow:hidden;background:transparent">
<canvas id="canvas" width="${width}" height="${height}"></canvas>
<script>
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const image = new Image();
const annotations = ${JSON.stringify(annotations)};
function drawArrow(annotation) {
  const headLength = 15;
  const from = annotation.from;
  const to = annotation.to;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.strokeStyle = annotation.color;
  ctx.lineWidth = annotation.strokeWidth;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.fillStyle = annotation.color;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - headLength * Math.cos(angle - Math.PI / 6), to.y - headLength * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(to.x - headLength * Math.cos(angle + Math.PI / 6), to.y - headLength * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}
function drawText(annotation) {
  ctx.fillStyle = annotation.color;
  ctx.font = annotation.fontSize + 'px Arial, Helvetica, sans-serif';
  ctx.fillText(annotation.content, annotation.position.x, annotation.position.y + annotation.fontSize);
}
image.onload = () => {
  ctx.drawImage(image, 0, 0, ${width}, ${height});
  for (const annotation of annotations) {
    if (annotation.type === 'arrow') drawArrow(annotation);
    if (annotation.type === 'text') drawText(annotation);
  }
  requestAnimationFrame(() => {
    document.title = 'ready';
  });
};
image.src = ${JSON.stringify(imageDataUrl)};
</script>
</body>
</html>`;

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('标注渲染超时')), 5000);
      win.on('page-title-updated', (_event, title) => {
        if (title === 'ready') {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    const captured = await win.webContents.capturePage();
    return captured.toPNG();
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

// region 的坐标系是"以物理像素为单位"（来自 overlay：DIP × scaleFactor）。
// 如果实际 PNG 尺寸跟显示器物理像素不一致（desktopCapturer 在某些机器上会返回非 1:1 的 thumbnail），
// 这里需要按 png-to-physical 的比例先把 region 缩放到 PNG 坐标系，再裁。
function cropPngBuffer(imageBuffer, region, physicalSize) {
  const image = nativeImage.createFromBuffer(imageBuffer);
  if (image.isEmpty()) throw new Error('截图图像为空，无法裁剪');
  const pngSize = image.getSize();

  let sx = 1;
  let sy = 1;
  if (physicalSize && physicalSize.width > 0 && physicalSize.height > 0) {
    sx = pngSize.width / physicalSize.width;
    sy = pngSize.height / physicalSize.height;
  }

  const x = Math.max(0, Math.min(pngSize.width, Math.round(region.x * sx)));
  const y = Math.max(0, Math.min(pngSize.height, Math.round(region.y * sy)));
  const w = Math.max(1, Math.min(pngSize.width - x, Math.round(region.width * sx)));
  const h = Math.max(1, Math.min(pngSize.height - y, Math.round(region.height * sy)));

  return {
    pngBuffer: image.crop({ x, y, width: w, height: h }).toPNG(),
    croppedSize: { width: w, height: h },
    scale: { sx, sy },
  };
}

function copyImageToClipboard(pngBuffer) {
  const image = nativeImage.createFromBuffer(pngBuffer);
  clipboard.writeImage(image);
}

function copyGifToClipboard(gifPath) {
  const absPath = path.resolve(gifPath);
  if (process.platform === 'darwin') {
    const script = [
      'tell application "Finder"',
      `  activate`,
      `  select (POSIX file "${absPath}" as alias)`,
      '  delay 0.3',
      'end tell',
      'tell application "System Events"',
      '  keystroke "c" using command down',
      'end tell',
      'delay 0.3',
    ].join('\n');
    const tmpScript = path.join(os.tmpdir(), 'quicktool-capture-clipboard.scpt');
    try {
      fs.writeFileSync(tmpScript, script);
      execSync(`osascript "${tmpScript}"`, { timeout: 8000 });
      fs.unlinkSync(tmpScript);
    } catch (_) {
      try { fs.unlinkSync(tmpScript); } catch (_) {}
      clipboard.writeText(absPath);
    }
    return;
  }

  try {
    const escaped = absPath.replace(/'/g, "''");
    const ps = `Add-Type -AssemblyName System.Windows.Forms; $c = New-Object System.Collections.Specialized.StringCollection; $c.Add('${escaped}'); [System.Windows.Forms.Clipboard]::SetFileDropList($c)`;
    execSync(`powershell -command "${ps}"`);
  } catch (_) {
    clipboard.writeText(absPath);
  }
}

class GifRecorder {
  constructor() {
    this.ffmpegProcess = null;
    this.recording = false;
    this.outputPath = '';
    this.forceStopTimer = null;
    this.stopPromise = null;
    this.stderrTail = '';
  }

  get isRecording() {
    return this.recording;
  }

  async startRecording(region, options, monitor, screenIndex = 0) {
    this.recording = true;
    this.outputPath = options.outputPath;
    const ffmpegArgs = await this.buildFfmpegArgs(region, options.fps || 10, monitor, screenIndex);
    console.log('[QuickCapture] ffmpeg start', ffmpegArgs.join(' '));
    this.ffmpegProcess = spawn(getFfmpegPath(), ffmpegArgs, { windowsHide: true });
    this.stderrTail = '';
    this.ffmpegProcess.stderr.on('data', (data) => {
      // Keep ffmpeg stderr drained. ffmpeg writes progress here.
      this.stderrTail = (this.stderrTail + data.toString()).slice(-4000);
    });
    this.ffmpegProcess.stdout.on('data', () => {});
    await new Promise((resolve, reject) => {
      const processRef = this.ffmpegProcess;
      const onError = (err) => {
        this.recording = false;
        this.ffmpegProcess = null;
        const reason = err.code === 'ENOENT'
          ? '未找到 ffmpeg，请重新安装依赖或检查 ffmpeg-static'
          : err.message;
        reject(new Error(`启动 ffmpeg 失败：${reason}`));
      };
      processRef.once('error', onError);
      processRef.once('spawn', () => {
        processRef.removeListener('error', onError);
        resolve();
      });
    });

    if (options.maxDuration > 0) {
      this.forceStopTimer = setTimeout(() => {
        if (this.recording) void this.stopRecording();
      }, options.maxDuration * 1000);
    }
  }

  stopRecording() {
    if (this.stopPromise) return this.stopPromise;

    this.stopPromise = new Promise((resolve) => {
      const finish = () => {
        if (this.forceStopTimer) {
          clearTimeout(this.forceStopTimer);
          this.forceStopTimer = null;
        }
        this.ffmpegProcess = null;
        this.stopPromise = null;
        resolve(this.outputPath);
      };

      if (!this.recording) {
        finish();
        return;
      }

      this.recording = false;
      if (this.forceStopTimer) {
        clearTimeout(this.forceStopTimer);
        this.forceStopTimer = null;
      }

      if (!this.ffmpegProcess) {
        finish();
        return;
      }

      const processRef = this.ffmpegProcess;
      let finished = false;
      const settle = () => {
        if (finished) return;
        finished = true;
        clearTimeout(forceKillTimer);
        console.log('[QuickCapture] ffmpeg stopped', this.outputPath);
        if (this.stderrTail) {
          console.log('[QuickCapture] ffmpeg stderr tail\n' + this.stderrTail);
        }
        finish();
      };
      const forceKillTimer = setTimeout(() => {
        console.warn('[QuickCapture] ffmpeg did not close after q; taskkill');
        forceKillProcess(processRef);
        // taskkill /F 之后 close 事件偶尔不会触发，1 秒后兜底 settle，
        // 反正碎片化 MP4 + flush_packets 写到磁盘的内容是可读的。
        setTimeout(settle, 1000);
      }, FFMPEG_GRACEFUL_STOP_TIMEOUT_MS);

      processRef.once('error', settle);
      processRef.once('close', settle);

      console.log('[QuickCapture] ffmpeg stop requested');
      try {
        processRef.stdin.write('q');
        // 主动关闭 stdin，让 ffmpeg 的输入循环立刻返回。
        try { processRef.stdin.end(); } catch (_) {}
      } catch (_) {
        forceKillProcess(processRef);
        setTimeout(settle, 300);
      }
    });

    return this.stopPromise;
  }

  async buildFfmpegArgs(region, fps, monitor, screenIndex) {
    const keyframeInterval = Math.max(1, Math.round(fps));
    // libx264 + yuv420p 要求宽高都是偶数，否则 ffmpeg 直接报
    // "height not divisible by 2" 并写出 0 字节 MP4。
    const evenWidth = Math.max(2, region.width - (region.width % 2));
    const evenHeight = Math.max(2, region.height - (region.height % 2));

    if (process.platform === 'darwin') {
      const deviceIndex = await this.findMacScreenDevice(screenIndex);
      return [
        '-y',
        '-f', 'avfoundation',
        '-capture_cursor', '1',
        '-i', `${deviceIndex}:none`,
        '-vf', `crop=${evenWidth}:${evenHeight}:${region.x}:${region.y},fps=${fps}`,
        '-an',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '18',
        '-g', String(keyframeInterval),
        '-keyint_min', String(keyframeInterval),
        '-pix_fmt', 'yuv420p',
        '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
        '-flush_packets', '1',
        this.outputPath,
      ];
    }

    const offsetX = Math.round(monitor.bounds.x * monitor.scaleFactor + region.x);
    const offsetY = Math.round(monitor.bounds.y * monitor.scaleFactor + region.y);
    return [
      '-y',
      '-f', 'gdigrab',
      '-framerate', String(fps),
      '-offset_x', String(offsetX),
      '-offset_y', String(offsetY),
      '-video_size', `${evenWidth}x${evenHeight}`,
      '-i', 'desktop',
      '-vf', `fps=${fps}`,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '18',
      '-g', String(keyframeInterval),
      '-keyint_min', String(keyframeInterval),
      '-pix_fmt', 'yuv420p',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-flush_packets', '1',
      this.outputPath,
    ];
  }

  findMacScreenDevice(screenIndex) {
    return new Promise((resolve) => {
      execFile(getFfmpegPath(), ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], (_error, _stdout, stderr) => {
        const screenDevices = [];
        for (const line of String(stderr || '').split('\n')) {
          const match = line.match(/\[(\d+)\]\s+Capture screen \d+/);
          if (match) screenDevices.push(parseInt(match[1], 10));
        }
        if (screenDevices.length > screenIndex) resolve(screenDevices[screenIndex]);
        else if (screenDevices.length > 0) resolve(screenDevices[0]);
        else resolve(screenIndex + 2);
      });
    });
  }
}

function getMaxColors(quality) {
  if (quality <= 5) return 256;
  if (quality <= 10) return 192;
  if (quality <= 20) return 128;
  return 96;
}

// 把片段数组规范化：去掉无效项（NaN / end<=start），按 start 排序，并合并重叠片段。
// 合并是为了避免 trim+concat 时出现连续两段在边界处抖动（同一帧被重复渲染）。
function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return [];
  const cleaned = segments
    .map((s) => ({
      start: Number(s && s.start),
      end: Number(s && s.end),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start && s.start >= 0)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const cur of cleaned) {
    const last = merged[merged.length - 1];
    if (last && cur.start <= last.end + 1e-3) {
      last.end = Math.max(last.end, cur.end);
    } else {
      merged.push({ start: cur.start, end: cur.end });
    }
  }
  return merged;
}

// 给 ffmpeg filter_complex 拼一段「按片段 trim → setpts 重置时间戳 → concat」的前缀。
// 返回 null 表示当前没有有效片段（=保留全片，调用方继续用 [0:v]）。
function buildSegmentsFilterPrefix(segments) {
  const list = normalizeSegments(segments);
  if (list.length === 0) return null;
  const labels = [];
  const parts = [];
  list.forEach((s, i) => {
    const label = `seg${i}`;
    parts.push(`[0:v]trim=start=${s.start.toFixed(3)}:end=${s.end.toFixed(3)},setpts=PTS-STARTPTS[${label}]`);
    labels.push(`[${label}]`);
  });
  if (list.length === 1) {
    // 单片段不需要走 concat，直接复用上面那条 trim 的输出 label，省一道滤镜。
    return {
      chain: parts.join(';'),
      outputLabel: labels[0],
      segmentCount: 1,
      totalDuration: list[0].end - list[0].start,
      segments: list,
    };
  }
  parts.push(`${labels.join('')}concat=n=${list.length}:v=1:a=0[segout]`);
  return {
    chain: parts.join(';'),
    outputLabel: '[segout]',
    segmentCount: list.length,
    totalDuration: list.reduce((sum, s) => sum + (s.end - s.start), 0),
    segments: list,
  };
}

// 把任意视频转成 Chromium 能直接 <video> 播放、且 ffmpeg 抽帧友好的 fragmented mp4。
// 用 libx264 veryfast 重新编码，去掉音轨，输出到临时目录。
// 可选 segments：只保留 [{start, end}, ...] 这些时间区间，按顺序拼接。
function transcodeToPlayableMp4(inputPath, outputPath, options = {}) {
  const { segments = null, onProgress = null } = options || {};
  return new Promise((resolve, reject) => {
    const segPrefix = buildSegmentsFilterPrefix(segments);
    const args = ['-y', '-i', inputPath];
    if (segPrefix) {
      const fc = `${segPrefix.chain};${segPrefix.outputLabel}format=yuv420p[outv]`;
      args.push('-filter_complex', fc, '-map', '[outv]');
    } else {
      args.push('-vf', 'format=yuv420p');
    }
    args.push(
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '20',
      '-an',
      '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
      '-pix_fmt', 'yuv420p',
      outputPath,
    );
    const child = spawn(getFfmpegPath(), args, { windowsHide: true });
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderrTail = (stderrTail + text).slice(-4000);
      if (typeof onProgress === 'function') onProgress(text);
    });
    child.stdout.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 转码失败（exit=${code}）: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

function ffmpegToGif(inputPath, outputPath, fps, scale, quality, segments) {
  return new Promise((resolve, reject) => {
    const segPrefix = buildSegmentsFilterPrefix(segments);
    const sourceLabel = segPrefix ? segPrefix.outputLabel : '[0:v]';
    const filters = [`fps=${fps}`];
    if (scale < 1) filters.push(`scale=iw*${scale}:ih*${scale}:flags=lanczos`);

    const filterParts = [];
    if (segPrefix) filterParts.push(segPrefix.chain);
    filterParts.push(
      `${sourceLabel}${filters.join(',')},split[s0][s1]`,
      `[s0]palettegen=max_colors=${getMaxColors(quality)}:stats_mode=diff[p]`,
      '[s1][p]paletteuse=dither=bayer',
    );
    const filterComplex = filterParts.join(';');

    execFile(getFfmpegPath(), [
      '-y',
      '-i', inputPath,
      '-filter_complex', filterComplex,
      '-an',
      '-loop', '0',
      outputPath,
    ], (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function readGifEstimate(gifPath) {
  const data = fs.readFileSync(gifPath);
  const width = data.readUInt16LE(6);
  const height = data.readUInt16LE(8);
  const packed = data[10];
  const gctSize = ((packed >> 7) & 1) ? 3 * Math.pow(2, (packed & 7) + 1) : 0;
  let pos = 13 + gctSize;
  let frames = 0;

  while (pos < data.length) {
    const b = data[pos];
    if (b === 0x3b) break;
    if (b === 0x2c) {
      frames++;
      pos += 9;
      const lp = data[pos];
      pos++;
      if ((lp >> 7) & 1) pos += 3 * Math.pow(2, (lp & 7) + 1);
      pos++;
      while (pos < data.length) {
        const sz = data[pos];
        pos++;
        if (sz === 0) break;
        pos += sz;
      }
    } else if (b === 0x21) {
      pos += 2;
      while (pos < data.length) {
        const sz = data[pos];
        pos++;
        if (sz === 0) break;
        pos += sz;
      }
    } else {
      pos++;
    }
  }

  return { path: gifPath, fileSize: data.length, frames, width, height };
}

function segmentsCacheKey(segments) {
  const list = normalizeSegments(segments);
  if (list.length === 0) return 'full';
  return list.map((s) => `${s.start.toFixed(3)}-${s.end.toFixed(3)}`).join('|');
}

function makePreviewData(videoPath, exportScale, estimate, estimatingGif, segments) {
  const videoStat = fs.statSync(videoPath);
  const normalized = normalizeSegments(segments);
  const segmentsTotal = normalized.reduce((sum, s) => sum + (s.end - s.start), 0);
  return {
    mediaUrl: require('url').pathToFileURL(videoPath).toString(),
    videoSize: videoStat.size,
    exportScale,
    estimatingGif,
    estimatedGifSize: estimate ? estimate.fileSize : null,
    estimatedGifFrames: estimate ? estimate.frames : null,
    estimatedGifWidth: estimate ? estimate.width : null,
    estimatedGifHeight: estimate ? estimate.height : null,
    segmentsKey: segmentsCacheKey(segments),
    segmentCount: normalized.length,
    segmentsTotalDuration: segmentsTotal,
  };
}

function showGifPreview(videoPath, options) {
  return new Promise((resolve) => {
    let resolved = false;
    let exportScale = 1;
    let currentSegments = []; // [] = 全片
    let estimateRequestId = 0;
    const finalGifPath = options.gifOutputPath;
    const finalMp4Path = replaceExtension(finalGifPath, 'mp4');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quicktool-capture-preview-'));
    const estimateCache = new Map();
    const estimateJobs = new Map();

    const win = new BrowserWindow({
      width: 820,
      height: 720,
      minWidth: 560,
      minHeight: 520,
      title: 'QuickTool · GIF 预览',
      backgroundColor: '#1a1a1a',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preview', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    const cleanupListeners = () => {
      ipcMain.removeAllListeners(IPC.GIF_PREVIEW_SAVE);
      ipcMain.removeAllListeners(IPC.GIF_PREVIEW_SAVE_VIDEO);
      ipcMain.removeAllListeners(IPC.GIF_PREVIEW_CANCEL);
      ipcMain.removeAllListeners(IPC.GIF_PREVIEW_QUALITY);
      ipcMain.removeAllListeners(IPC.GIF_PREVIEW_SEGMENTS);
    };
    const cleanupTmp = () => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    };
    const cleanupSourceVideo = () => {
      try { fs.unlinkSync(videoPath); } catch (_) {}
    };
    const cleanup = () => {
      cleanupListeners();
      if (!win.isDestroyed()) win.close();
    };
    const cacheKey = (scale, segments) => `${scale}__${segmentsCacheKey(segments)}`;
    const sendPreviewUpdate = (channel, scale, estimatingGif, segments, extra = {}) => {
      if (win.isDestroyed()) return;
      win.webContents.send(channel, {
        ...makePreviewData(
          videoPath,
          scale,
          estimateCache.get(cacheKey(scale, segments)) || null,
          estimatingGif,
          segments,
        ),
        ...extra,
      });
    };
    const getOrCreateEstimate = async (scale, segments) => {
      const key = cacheKey(scale, segments);
      const cached = estimateCache.get(key);
      if (cached && fs.existsSync(cached.path)) return cached;
      const running = estimateJobs.get(key);
      if (running) return running;
      // 文件名要保险地脱去非字母数字字符，否则 segments 拼出来的 key 会带 '|' '.' 等等
      const safe = key.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 96);
      const estimatePath = path.join(tmpDir, `estimate_${safe}.gif`);
      const job = (async () => {
        await ffmpegToGif(videoPath, estimatePath, options.fps, scale, options.quality, segments);
        const estimate = readGifEstimate(estimatePath);
        estimateCache.set(key, estimate);
        return estimate;
      })();
      estimateJobs.set(key, job);
      try {
        return await job;
      } finally {
        estimateJobs.delete(key);
      }
    };
    const refreshEstimate = async (scale, segments) => {
      const requestId = ++estimateRequestId;
      sendPreviewUpdate(IPC.GIF_PREVIEW_QUALITY_RESULT, scale, true, segments);
      try {
        await getOrCreateEstimate(scale, segments);
        if (
          resolved
          || win.isDestroyed()
          || requestId !== estimateRequestId
          || scale !== exportScale
          || segmentsCacheKey(segments) !== segmentsCacheKey(currentSegments)
        ) return;
        sendPreviewUpdate(IPC.GIF_PREVIEW_QUALITY_RESULT, scale, false, segments);
      } catch (err) {
        if (
          resolved
          || win.isDestroyed()
          || requestId !== estimateRequestId
          || scale !== exportScale
          || segmentsCacheKey(segments) !== segmentsCacheKey(currentSegments)
        ) return;
        sendPreviewUpdate(IPC.GIF_PREVIEW_QUALITY_RESULT, scale, false, segments, {
          error: `GIF 估算失败：${err.message}`,
          errorTarget: 'gif',
        });
      }
    };

    // 用户可以在预览窗里多次保存 GIF / MP4。已保存的路径会累积在这里，
    // 关窗后才把全部结果一次性返回给上层（用于剪贴板复制等后续动作）。
    const savedResults = [];
    let lastSavedGifPath = null;
    let lastSavedVideoPath = null;

    ipcMain.on(IPC.GIF_PREVIEW_SAVE, async () => {
      if (resolved) return;
      try {
        const estimate = await getOrCreateEstimate(exportScale, currentSegments);
        const saveResult = await dialog.showSaveDialog(win.isDestroyed() ? null : win, {
          title: '保存 GIF',
          defaultPath: lastSavedGifPath || finalGifPath,
          filters: [
            { name: 'GIF 动图', extensions: ['gif'] },
            { name: '全部文件', extensions: ['*'] },
          ],
        });
        if (saveResult.canceled || !saveResult.filePath) {
          // 用户在保存对话框点了取消，解锁按钮回到预览界面
          sendPreviewUpdate(IPC.GIF_PREVIEW_QUALITY_RESULT, exportScale, false, currentSegments, { released: true });
          return;
        }
        fs.copyFileSync(estimate.path, saveResult.filePath);
        lastSavedGifPath = saveResult.filePath;
        savedResults.push({ action: 'save-gif', outputPath: saveResult.filePath });
        notify('QuickTool · GIF 已保存', saveResult.filePath);
        // 不关闭预览窗，解锁按钮，把已保存的路径回传给前端展示
        sendPreviewUpdate(IPC.GIF_PREVIEW_QUALITY_RESULT, exportScale, false, currentSegments, {
          released: true,
          lastSavedGifPath,
          lastSavedVideoPath,
        });
      } catch (err) {
        sendPreviewUpdate(IPC.GIF_PREVIEW_QUALITY_RESULT, exportScale, false, currentSegments, {
          released: true,
          error: `GIF 导出失败：${err.message}`,
          errorTarget: 'gif',
          lastSavedGifPath,
          lastSavedVideoPath,
        });
      }
    });

    ipcMain.on(IPC.GIF_PREVIEW_SAVE_VIDEO, async () => {
      if (resolved) return;
      try {
        const saveResult = await dialog.showSaveDialog(win.isDestroyed() ? null : win, {
          title: '保存 MP4',
          defaultPath: lastSavedVideoPath || finalMp4Path,
          filters: [
            { name: 'MP4 视频', extensions: ['mp4'] },
            { name: '全部文件', extensions: ['*'] },
          ],
        });
        if (saveResult.canceled || !saveResult.filePath) {
          sendPreviewUpdate(IPC.GIF_PREVIEW_QUALITY_RESULT, exportScale, false, currentSegments, { released: true });
          return;
        }
        const segPrefix = buildSegmentsFilterPrefix(currentSegments);
        if (segPrefix) {
          // 有片段：直接 ffmpeg trim+concat 重新编码到目标路径，省掉多余的中转拷贝。
          await transcodeToPlayableMp4(videoPath, saveResult.filePath, { segments: currentSegments });
        } else {
          fs.copyFileSync(videoPath, saveResult.filePath);
        }
        lastSavedVideoPath = saveResult.filePath;
        savedResults.push({ action: 'save-video', outputPath: saveResult.filePath });
        notify('QuickTool · MP4 已保存', saveResult.filePath);
        sendPreviewUpdate(IPC.GIF_PREVIEW_QUALITY_RESULT, exportScale, false, currentSegments, {
          released: true,
          lastSavedGifPath,
          lastSavedVideoPath,
        });
      } catch (err) {
        sendPreviewUpdate(IPC.GIF_PREVIEW_QUALITY_RESULT, exportScale, false, currentSegments, {
          released: true,
          error: `MP4 保存失败：${err.message}`,
          errorTarget: 'video',
          lastSavedGifPath,
          lastSavedVideoPath,
        });
      }
    });

    ipcMain.on(IPC.GIF_PREVIEW_CANCEL, () => {
      if (resolved) return;
      resolved = true;
      cleanup();
      cleanupTmp();
      cleanupSourceVideo();
      resolve({ savedResults });
    });

    ipcMain.on(IPC.GIF_PREVIEW_QUALITY, (_event, scale) => {
      if (resolved || win.isDestroyed()) return;
      exportScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
      void refreshEstimate(exportScale, currentSegments);
    });

    ipcMain.on(IPC.GIF_PREVIEW_SEGMENTS, (_event, payload) => {
      if (resolved || win.isDestroyed()) return;
      const incoming = Array.isArray(payload && payload.segments) ? payload.segments : [];
      currentSegments = normalizeSegments(incoming);
      void refreshEstimate(exportScale, currentSegments);
    });

    win.on('closed', () => {
      if (!resolved) {
        resolved = true;
        cleanupListeners();
        cleanupTmp();
        cleanupSourceVideo();
        resolve({ savedResults });
      }
    });

    win.loadFile(path.join(__dirname, '..', 'preview', 'renderer', 'index.html'));
    win.webContents.on('did-finish-load', () => {
      sendPreviewUpdate(IPC.GIF_PREVIEW_DATA, exportScale, true, currentSegments);
      void refreshEstimate(exportScale, currentSegments);
    });
  });
}

class QuickCaptureTool {
  constructor({ onStatusChanged } = {}) {
    this.config = getConfig();
    this.gifRecorder = new GifRecorder();
    this.capturing = false;
    this.onStatusChanged = onStatusChanged;
    // 启动时清理上次未正常收尾留下的录制临时文件，避免长期堆积
    try { pruneOrphanCaptureFiles(); } catch (_) {}
  }

  isGifRecording() {
    return this.gifRecorder.isRecording;
  }

  emitStatusChanged() {
    if (typeof this.onStatusChanged === 'function') {
      this.onStatusChanged({ gifRecording: this.isGifRecording() });
    }
  }

  async startScreenshot() {
    await this.startCapture('screenshot');
    return { ok: true };
  }

  async startGif() {
    if (this.gifRecorder.isRecording) return this.stopGif();
    if (this.pendingFinalize) {
      return { ok: false, error: '上一次 GIF 还在收尾，请稍后再试' };
    }
    await this.startCapture('gif');
    return { ok: true, recording: this.gifRecorder.isRecording };
  }

  async stopGif() {
    if (!this.gifRecorder.isRecording) return { ok: true, recording: false };
    const stopPromise = this.gifRecorder.stopRecording();
    this.pendingFinalize = true;
    this.emitStatusChanged();

    stopPromise.then((tempVideoPath) => {
      notify('QuickTool · GIF 录制已收尾', '正在打开预览窗口');
      return this.openGifPreview(tempVideoPath);
    }).catch((err) => {
      notify('QuickTool · GIF 录制收尾失败', err.message);
    }).finally(() => {
      this.pendingFinalize = false;
      this.emitStatusChanged();
    });

    return { ok: true, recording: false, finalizing: true };
  }

  async openGifPreview(tempVideoPath) {
    const stat = fs.existsSync(tempVideoPath) ? fs.statSync(tempVideoPath) : null;
    if (!stat || stat.size < 4096) {
      const size = stat ? stat.size : 0;
      // 录制无效，立刻删除避免占空间
      try { if (fs.existsSync(tempVideoPath)) fs.unlinkSync(tempVideoPath); } catch (_) {}
      throw new Error(`录制文件过小（${size} 字节），可能录制时间过短，请尝试录制至少 1-2 秒`);
    }

    const gifOutputPath = getOutputPath('gif', this.config.output.directory);
    const result = await showGifPreview(tempVideoPath, {
      gifOutputPath,
      fps: this.config.gif.fps,
      quality: this.config.gif.quality,
    });

    // 用户可能在预览窗里多次保存（GIF + MP4）。通知已经在 showGifPreview 内部即时弹过，
    // 这里只补一次剪贴板复制（如果配置开启），用最后一次保存的 GIF 路径。
    const savedResults = (result && result.savedResults) || [];
    if (this.config.output.copyToClipboard) {
      const lastGif = [...savedResults].reverse().find((r) => r.action === 'save-gif');
      if (lastGif) copyGifToClipboard(lastGif.outputPath);
    }
  }

  async startCapture(mode) {
    if (this.capturing) return;
    this.capturing = true;
    try {
      const monitors = getAllMonitors();
      const screenshots = await captureAllScreens(monitors);
      const result = await createOverlayWindows(monitors, screenshots, mode);
      if (!result) return;

      if (mode === 'screenshot') {
        await this.processScreenshot(result, screenshots);
      } else {
        await this.startGifRecording(result, monitors);
      }
    } catch (err) {
      notify('QuickTool · 截图失败', err.message);
      throw err;
    } finally {
      this.capturing = false;
    }
  }

  async processScreenshot(result, screenshots) {
    const screenshotBuffer = screenshots.get(result.monitorId);
    if (!screenshotBuffer) throw new Error(`找不到显示器 ${result.monitorId} 的截图`);

    const monitors = getAllMonitors();
    const monitor = monitors.find((m) => m.id === result.monitorId);
    const physicalSize = monitor ? getPhysicalSize(monitor) : null;

    const { pngBuffer, croppedSize, scale } = cropPngBuffer(screenshotBuffer, result.region, physicalSize);

    // 标注坐标也按 PNG 比例同步缩放（overlay 给的坐标也是物理像素体系）
    const scaledAnnotations = (result.annotations || []).map((a) => {
      if (a.type === 'arrow') {
        return {
          ...a,
          from: { x: Math.round(a.from.x * scale.sx), y: Math.round(a.from.y * scale.sy) },
          to: { x: Math.round(a.to.x * scale.sx), y: Math.round(a.to.y * scale.sy) },
        };
      }
      return {
        ...a,
        position: {
          x: Math.round((a.position ? a.position.x : 0) * scale.sx),
          y: Math.round((a.position ? a.position.y : 0) * scale.sy),
        },
        fontSize: Math.max(8, Math.round((a.fontSize || 16) * scale.sy)),
      };
    });

    const annotated = await applyAnnotations(pngBuffer, croppedSize.width, croppedSize.height, scaledAnnotations);
    const outputPath = getOutputPath('screenshot', this.config.output.directory);
    fs.writeFileSync(outputPath, annotated);
    if (this.config.output.copyToClipboard) copyImageToClipboard(annotated);
    notify('QuickTool · 截图已保存', outputPath);
  }

  async startGifRecording(result, monitors) {
    const outputPath = getTempRecordingPath('mp4');
    const monitor = monitors.find((item) => item.id === result.monitorId) || monitors[0];
    const screenIndex = monitors.findIndex((item) => item.id === result.monitorId);
    await this.gifRecorder.startRecording(
      result.region,
      {
        fps: this.config.gif.fps,
        maxDuration: this.config.gif.maxDuration,
        quality: this.config.gif.quality,
        outputPath,
      },
      monitor,
      Math.max(0, screenIndex),
    );
    this.emitStatusChanged();
    notify('QuickTool · GIF 录制中', '再次点击 GIF 按钮或托盘菜单即可停止录制');
  }

  cleanup() {
    if (this.gifRecorder.isRecording) {
      void this.gifRecorder.stopRecording();
    }
    // 退出前再清一次孤儿文件，确保不留残留
    try { pruneOrphanCaptureFiles(); } catch (_) {}
  }

  // 让用户挑一个本地视频文件，转码成可预览的 mp4 后走原有的 GIF 预览/导出流程。
  async convertVideoToGif() {
    if (this.pendingFinalize) {
      return { ok: false, error: '上一次任务还在收尾，请稍后再试' };
    }
    if (this.gifRecorder.isRecording) {
      return { ok: false, error: 'GIF 录制中，请先停止录制' };
    }

    const pick = await dialog.showOpenDialog({
      title: '选择要转换为 GIF 的视频',
      properties: ['openFile'],
      filters: [
        { name: '视频文件', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv', 'ts', 'mpeg', 'mpg'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (pick.canceled || !pick.filePaths || pick.filePaths.length === 0) {
      return { ok: false, cancelled: true };
    }

    const sourceVideo = pick.filePaths[0];
    if (!fs.existsSync(sourceVideo)) {
      return { ok: false, error: `文件不存在：${sourceVideo}` };
    }

    this.pendingFinalize = true;
    this.emitStatusChanged();
    notify('QuickTool · 正在准备视频', '正在转码为可预览的 MP4，请稍候…');

    let tempMp4 = null;
    try {
      tempMp4 = getTempRecordingPath('mp4');
      await transcodeToPlayableMp4(sourceVideo, tempMp4);
      const stat = fs.existsSync(tempMp4) ? fs.statSync(tempMp4) : null;
      if (!stat || stat.size < 4096) {
        try { if (tempMp4 && fs.existsSync(tempMp4)) fs.unlinkSync(tempMp4); } catch (_) {}
        throw new Error('转码失败：输出文件无效');
      }

      // 复用现有 openGifPreview 流程；它会在预览结束后清理 tempMp4，不会动用户的原始文件。
      await this.openGifPreview(tempMp4);
      return { ok: true };
    } catch (err) {
      // 转码 / 预览失败，确保临时文件被清理
      try { if (tempMp4 && fs.existsSync(tempMp4)) fs.unlinkSync(tempMp4); } catch (_) {}
      notify('QuickTool · 视频转 GIF 失败', err.message);
      return { ok: false, error: err.message };
    } finally {
      this.pendingFinalize = false;
      this.emitStatusChanged();
    }
  }
}

module.exports = { QuickCaptureTool };
