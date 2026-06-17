const settings = require('../settings');
const {
  exec, whichTool, resolveBinary, getBinaryStatus, setBinaryPath, createProcessRunner,
  parseLsLong, getLsError, deviceBaseName,
} = require('./base');

const ID = 'harmony';
const SETTING_KEY = 'hdcPath';
const BIN_NAME = 'hdc';

// 王者（包名含 sgame）等应用把业务日志写在沙箱里的 dcLog 目录，文件名形如
// Normal_20260615_171339_2985.log。这里走 hdc 沙箱（-b bundle），对应真机全局
// 路径 /data/app/el2/100/base/<bundle>/haps/entry/files/dcLog。
const NORMAL_LOG_DIR = 'data/storage/el2/base/haps/entry/files/dcLog';

const META = Object.freeze({
  id: ID,
  label: 'HarmonyOS (hdc)',
  binaryName: 'hdc',
  binaryDisplay: 'hdc.exe',
  settingKey: SETTING_KEY,
  pickFilters: process.platform === 'win32'
    ? [{ name: 'hdc.exe', extensions: ['exe'] }, { name: '全部文件', extensions: ['*'] }]
    : [{ name: '全部文件', extensions: ['*'] }],
  defaultLogFilePrefix: 'hilog',
  defaultFilePath: 'data/storage/el2/base',
  fileBrowserMode: 'sandbox',
  diagEnvKeys: ['OHOS_BASE_HOME', 'OHOS_HOME', 'HDC_SERVER_PORT', 'HOS_SDK_HOME'],
  hint: '常见位置：DevEco Studio 的 sdk\\hmscore\\<ver>\\toolchains\\hdc.exe，或独立 command-line-tools 的 toolchains 目录。',
});

const hilogRunner = createProcessRunner(() => resolveBinary(SETTING_KEY, BIN_NAME));

function getBin() { return resolveBinary(SETTING_KEY, BIN_NAME); }

// ===== 王者（含 sgame）日志：列出沙箱 dcLog 目录下的日志文件，供选择载入 =====
// 这些日志（Normal_/Network_/AppManager_… 等）都写在应用沙箱里：
//   全局路径 /data/app/el2/100/base/<bundle>/haps/entry/files/dcLog
//   沙箱内（hdc -b bundle）对应 data/storage/el2/base/haps/entry/files/dcLog
// 列目录用 `ls -la`，拉文件复用 pullFile（file recv），由主进程拉到临时文件后读入查看器。
async function listSgameLogs(serial, bundleName) {
  if (!serial) return { ok: false, error: '未选择设备', files: [] };
  const bn = String(bundleName || '').trim();
  if (!bn) return { ok: false, error: '请先填写王者包名（含 sgame）', files: [] };
  try {
    const { stdout, stderr } = await exec(getBin(),
      ['-t', serial, 'shell', '-b', bn, 'ls', '-la', NORMAL_LOG_DIR], { timeout: 15000 });
    const files = parseLsLong(stdout, NORMAL_LOG_DIR)
      .filter((e) => e.type === 'file' && /\.log$/i.test(e.name))
      .map((e) => ({ name: e.name, size: e.size, modified: e.modified }))
      // 文件名内嵌时间戳，倒序 → 最新在前
      .sort((a, b) => b.name.localeCompare(a.name));
    if (!files.length) {
      const lsErr = getLsError(stdout, stderr);
      return { ok: false, error: lsErr || `${NORMAL_LOG_DIR} 下没有日志文件`, files: [] };
    }
    return { ok: true, dir: NORMAL_LOG_DIR, files };
  } catch (e) {
    return { ok: false, error: e.message, files: [], raw: e.stdout || '', stderr: e.stderr || '' };
  }
}

// 校验文件名（防止越权/路径穿越），返回沙箱内可被 sandboxPath 处理的完整相对路径
function sgameLogRemotePath(fileName) {
  const name = String(fileName || '').trim();
  if (!name || !/^[\w.-]+\.log$/i.test(name)) return '';
  return `${NORMAL_LOG_DIR}/${name}`;
}

async function check() {
  try {
    // hdc 老版本是 `hdc -v`，新版本支持 `hdc version`，先后尝试
    let stdout = '';
    try {
      stdout = (await exec(getBin(), ['version'])).stdout;
    } catch (_) {
      stdout = (await exec(getBin(), ['-v'])).stdout;
    }
    const firstLine = stdout.split(/\r?\n/)[0] || '';
    const fromPath = await whichTool(BIN_NAME);
    const cur = getBinaryStatus(SETTING_KEY, BIN_NAME);
    return {
      ok: true,
      version: firstLine.trim(),
      path: cur.source === 'custom' ? cur.path : (fromPath || BIN_NAME),
      source: cur.source,
    };
  } catch (e) {
    return {
      ok: false,
      error: e.message || '未找到 hdc，请确认 DevEco Studio 已安装并把 toolchains 加入 PATH，或在诊断面板中手动指定 hdc.exe。',
    };
  }
}

// hdc list targets:
//   - 无设备时输出 [Empty]
//   - 有设备时每行一个 serial
//   - hdc list targets -v 还会带 state/connection type
async function listDevices() {
  try {
    const { stdout, stderr } = await exec(getBin(), ['list', 'targets', '-v']);
    const devices = [];
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^\[Empty\]/i.test(line)) continue;
      if (/^\[Fail\]/i.test(line)) continue;
      // 兼容两种格式：单列 serial / 多列 "SERIAL  TYPE  STATE  ..."
      const cols = line.split(/\s+/);
      const serial = cols[0];
      if (!serial) continue;
      // -v 第二列一般是连接类型(USB/TCP)，第三列是状态(Connected/...)
      const conn = cols[1] || '';
      const stateRaw = (cols[2] || cols[1] || '').toLowerCase();
      const state = /connect/.test(stateRaw) ? 'device'
        : (stateRaw || 'device');
      devices.push({ serial, state, model: '', product: conn });
    }
    return { ok: true, devices, raw: stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.message, devices: [], raw: e.stdout || '', stderr: e.stderr || '' };
  }
}

// 鸿蒙的"安装包列表"用 bm dump -a，输出形如：
//   ID: 100
//           com.example.bundle1
//           com.example.bundle2
async function listPackages(serial) {
  if (!serial) return { ok: false, error: '未选择设备', packages: [] };
  try {
    const { stdout } = await exec(getBin(), ['-t', serial, 'shell', 'bm', 'dump', '-a']);
    const packages = [];
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^ID\s*:/i.test(line)) continue;
      // 鸿蒙 bundle name 格式与 Android 包名类似
      if (/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/.test(line)) {
        packages.push(line);
      }
    }
    packages.sort();
    return { ok: true, packages: Array.from(new Set(packages)) };
  } catch (e) {
    return { ok: false, error: e.message, packages: [] };
  }
}

async function getPidForPackage(serial, pkg) {
  if (!serial || !pkg) return { ok: false, error: '参数缺失', pids: [] };
  try {
    const { stdout } = await exec(getBin(), ['-t', serial, 'shell', 'pidof', pkg]);
    const pids = stdout.trim().split(/\s+/).filter(Boolean);
    if (pids.length) return { ok: true, pids };
  } catch (_) {
    // 部分 hdc 镜像没有 pidof，回退到 ps -ef
  }
  try {
    const { stdout } = await exec(getBin(), ['-t', serial, 'shell', 'ps', '-ef']);
    const pids = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(pkg)) continue;
      const cols = line.trim().split(/\s+/);
      // ps -ef: UID PID PPID C STIME TTY TIME CMD
      if (cols.length >= 8) {
        const cmd = cols.slice(7).join(' ');
        if (cmd === pkg || cmd.endsWith('/' + pkg) || cmd.includes(pkg)) {
          pids.push(cols[1]);
        }
      }
    }
    return { ok: true, pids };
  } catch (e) {
    return { ok: false, error: e.message, pids: [] };
  }
}

async function clearBuffer(serial) {
  if (!serial) return { ok: false, error: '未选择设备' };
  try {
    await exec(getBin(), ['-t', serial, 'shell', 'hilog', '-r'], { timeout: 4000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function isStreaming() { return hilogRunner.isRunning(); }

function startStream({ serial, onLines, onStderr, onExit }) {
  if (!serial) return { ok: false, error: '未选择设备' };
  // hilog 默认就是流式输出；不指定 -L 默认输出全部级别
  return hilogRunner.start({
    args: ['-t', serial, 'shell', 'hilog'],
    onLines, onStderr, onExit,
  });
}

function stopStream() { return hilogRunner.stop(); }

async function diagnose() {
  const fromPath = await whichTool(BIN_NAME);
  const cur = getBinaryStatus(SETTING_KEY, BIN_NAME);

  let version = '';
  let versionErr = '';
  try {
    let r;
    try { r = await exec(getBin(), ['version']); }
    catch (_) { r = await exec(getBin(), ['-v']); }
    version = (r.stdout || '').trim();
  } catch (e) {
    versionErr = e.message;
  }

  let devicesRaw = '';
  let devicesErr = '';
  try {
    const { stdout } = await exec(getBin(), ['list', 'targets', '-v']);
    devicesRaw = stdout;
  } catch (e) {
    devicesErr = e.message;
  }

  const extraEnv = {};
  for (const k of META.diagEnvKeys) extraEnv[k] = process.env[k] || '';

  return {
    platformId: ID,
    platformLabel: META.label,
    binaryName: BIN_NAME,
    binaryDisplay: META.binaryDisplay,
    customPath: settings.get(SETTING_KEY, ''),
    customExists: cur.source === 'custom' ? cur.exists : null,
    activeSource: cur.source,
    activePath: cur.source === 'custom' ? cur.path : (fromPath || ''),
    pathFromWhere: fromPath,
    version,
    versionErr,
    devicesRaw,
    devicesErr,
    devicesCmd: 'hdc list targets -v',
    envPath: process.env.PATH || process.env.Path || '',
    extraEnv,
    hint: META.hint,
  };
}

function getBinaryPath() { return settings.get(SETTING_KEY, ''); }
function setBinaryPathFn(p) { return setBinaryPath(SETTING_KEY, p); }

function sandboxPath(remotePath) {
  const raw = String(remotePath || META.defaultFilePath).trim();
  return raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '') || META.defaultFilePath;
}

async function listFiles(serial, remotePath = META.defaultFilePath, options = {}) {
  if (!serial) return { ok: false, error: '未选择设备', entries: [] };
  const bundleName = (options.bundleName || '').trim();
  if (!bundleName) {
    return { ok: false, error: '请先选择或输入 Bundle Name，再浏览应用沙箱', entries: [] };
  }
  const target = sandboxPath(remotePath);
  try {
    const { stdout, stderr } = await exec(getBin(),
      ['-t', serial, 'shell', '-b', bundleName, 'ls', '-la', target]);
    const entries = parseLsLong(stdout, target);
    const lsError = getLsError(stdout, stderr);
    if (lsError && entries.length === 0) {
      return { ok: false, error: lsError, entries, raw: stdout, stderr };
    }
    return { ok: true, path: target, entries, raw: stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.message, entries: [], raw: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function pullFile(serial, remotePath, localPath, options = {}) {
  if (!serial) return { ok: false, error: '未选择设备' };
  if (!remotePath) return { ok: false, error: '未选择远端路径' };
  if (!localPath) return { ok: false, error: '未选择保存路径' };
  const bundleName = (options.bundleName || '').trim();
  if (!bundleName) return { ok: false, error: '请先选择或输入 Bundle Name' };
  try {
    const { stdout, stderr } = await exec(getBin(),
      ['-t', serial, 'file', 'recv', '-b', bundleName, sandboxPath(remotePath), localPath], { timeout: 120000 });
    return { ok: true, stdout, stderr, localPath, defaultName: deviceBaseName(remotePath) };
  } catch (e) {
    return { ok: false, error: e.message, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function uploadFiles(serial, localPaths, remoteDir, options = {}) {
  if (!serial) return { ok: false, error: '未选择设备' };
  if (!remoteDir) return { ok: false, error: '未选择远端目录' };
  const bundleName = (options.bundleName || '').trim();
  if (!bundleName) return { ok: false, error: '请先选择或输入 Bundle Name' };
  const files = Array.isArray(localPaths) ? localPaths.filter(Boolean) : [];
  if (!files.length) return { ok: false, error: '未选择本地文件' };

  const target = sandboxPath(remoteDir);
  const results = [];
  for (const localPath of files) {
    try {
      const { stdout, stderr } = await exec(getBin(),
        ['-t', serial, 'file', 'send', '-b', bundleName, localPath, target], { timeout: 120000 });
      results.push({ ok: true, localPath, remoteDir: target, stdout, stderr });
    } catch (e) {
      results.push({ ok: false, localPath, remoteDir: target, error: e.message, stdout: e.stdout || '', stderr: e.stderr || '' });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    return { ok: false, error: failed[0].error || '部分文件上传失败', results };
  }
  return { ok: true, results };
}

async function deleteFile(serial, remotePath, options = {}) {
  if (!serial) return { ok: false, error: '未选择设备' };
  if (!remotePath) return { ok: false, error: '未选择远端路径' };
  const bundleName = (options.bundleName || '').trim();
  if (!bundleName) return { ok: false, error: '请先选择或输入 Bundle Name' };
  try {
    const { stdout, stderr } = await exec(getBin(),
      ['-t', serial, 'shell', '-b', bundleName, 'rm', '-rf', sandboxPath(remotePath)], { timeout: 30000 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.message, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function collectFileProperties(serial, remotePath, options = {}) {
  if (!serial) return { ok: false, error: '未选择设备' };
  if (!remotePath) return { ok: false, error: '未选择远端路径' };
  const bundleName = (options.bundleName || '').trim();
  if (!bundleName) return { ok: false, error: '请先选择或输入 Bundle Name' };

  const target = sandboxPath(remotePath);
  const commands = [
    { title: 'stat', args: ['-t', serial, 'shell', '-b', bundleName, 'stat', target] },
    { title: 'ls -ld', args: ['-t', serial, 'shell', '-b', bundleName, 'ls', '-ld', target] },
    { title: 'du -sh', args: ['-t', serial, 'shell', '-b', bundleName, 'du', '-sh', target] },
  ];
  const sections = [];
  for (const cmd of commands) {
    try {
      const { stdout, stderr } = await exec(getBin(), cmd.args, { timeout: 10000 });
      sections.push({ title: cmd.title, ok: true, stdout, stderr });
    } catch (e) {
      sections.push({ title: cmd.title, ok: false, error: e.message, stdout: e.stdout || '', stderr: e.stderr || '' });
    }
  }
  return { ok: true, path: target, bundleName, sections };
}

module.exports = {
  meta: META,
  check, listDevices, listPackages, getPidForPackage,
  clearBuffer, startStream, stopStream, isStreaming,
  diagnose, getBinaryPath, setBinaryPath: setBinaryPathFn,
  listFiles, pullFile, uploadFiles, deleteFile, collectFileProperties,
  listSgameLogs, sgameLogRemotePath,
};
