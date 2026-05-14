const settings = require('../settings');
const {
  exec, whichTool, resolveBinary, getBinaryStatus, setBinaryPath, createProcessRunner,
  parseLsLong, getLsError, deviceBaseName,
} = require('./base');

const ID = 'android';
const SETTING_KEY = 'adbPath';
const BIN_NAME = 'adb';

const META = Object.freeze({
  id: ID,
  label: 'Android (adb)',
  binaryName: 'adb',
  binaryDisplay: 'adb.exe',
  settingKey: SETTING_KEY,
  pickFilters: process.platform === 'win32'
    ? [{ name: 'adb.exe', extensions: ['exe'] }, { name: '全部文件', extensions: ['*'] }]
    : [{ name: '全部文件', extensions: ['*'] }],
  defaultLogFilePrefix: 'logcat',
  defaultFilePath: '/',
  // 在诊断面板中显示的环境变量列表
  diagEnvKeys: ['ANDROID_HOME', 'ANDROID_SDK_ROOT'],
  // 常见路径提示（用于诊断面板的可读建议）
  hint: '常见位置：%LOCALAPPDATA%\\Android\\Sdk\\platform-tools\\adb.exe',
});

const runner = createProcessRunner(() => resolveBinary(SETTING_KEY, BIN_NAME));

async function check() {
  try {
    const { stdout } = await exec(resolveBinary(SETTING_KEY, BIN_NAME), ['version']);
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
      error: e.message || '未找到 adb，请确认已加入系统 PATH 或在诊断面板中手动指定 adb.exe。',
    };
  }
}

async function listDevices() {
  try {
    const { stdout, stderr } = await exec(resolveBinary(SETTING_KEY, BIN_NAME), ['devices', '-l']);
    const devices = [];
    for (const raw of stdout.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^List of devices/i.test(line)) continue;
      if (line.startsWith('*')) continue;
      const m = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
      if (!m) continue;
      const serial = m[1];
      const state = m[2];
      if (!/^(device|offline|unauthorized|bootloader|recovery|sideload|no permissions|host|authorizing)$/i.test(state)) {
        continue;
      }
      const extra = m[3] || '';
      let model = '';
      const mm = extra.match(/model:(\S+)/);
      if (mm) model = mm[1].replace(/_/g, ' ');
      let product = '';
      const pm = extra.match(/product:(\S+)/);
      if (pm) product = pm[1];
      devices.push({ serial, state, model, product });
    }
    return { ok: true, devices, raw: stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.message, devices: [], raw: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function listPackages(serial) {
  if (!serial) return { ok: false, error: '未选择设备', packages: [] };
  try {
    const { stdout } = await exec(resolveBinary(SETTING_KEY, BIN_NAME),
      ['-s', serial, 'shell', 'pm', 'list', 'packages']);
    const packages = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('package:'))
      .map((l) => l.slice('package:'.length))
      .filter(Boolean)
      .sort();
    return { ok: true, packages };
  } catch (e) {
    return { ok: false, error: e.message, packages: [] };
  }
}

async function getPidForPackage(serial, pkg) {
  if (!serial || !pkg) return { ok: false, error: '参数缺失', pids: [] };
  try {
    const { stdout } = await exec(resolveBinary(SETTING_KEY, BIN_NAME),
      ['-s', serial, 'shell', 'pidof', pkg]);
    const pids = stdout.trim().split(/\s+/).filter(Boolean);
    if (pids.length) return { ok: true, pids };
  } catch (_) {
    // pidof 在部分系统上不存在，回退
  }
  try {
    const { stdout } = await exec(resolveBinary(SETTING_KEY, BIN_NAME),
      ['-s', serial, 'shell', 'ps', '-A']);
    const pids = [];
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.includes(pkg)) continue;
      const cols = line.trim().split(/\s+/);
      if (cols.length >= 2 && cols[cols.length - 1] === pkg) {
        pids.push(cols[1]);
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
    await exec(resolveBinary(SETTING_KEY, BIN_NAME),
      ['-s', serial, 'logcat', '-c'], { timeout: 4000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function isStreaming() { return runner.isRunning(); }

function startStream({ serial, onLines, onStderr, onExit }) {
  if (!serial) return { ok: false, error: '未选择设备' };
  return runner.start({
    args: ['-s', serial, 'logcat', '-v', 'threadtime'],
    onLines, onStderr, onExit,
  });
}

function stopStream() { return runner.stop(); }

async function diagnose() {
  const fromPath = await whichTool(BIN_NAME);
  const cur = getBinaryStatus(SETTING_KEY, BIN_NAME);

  let version = '';
  let versionErr = '';
  try {
    const { stdout } = await exec(resolveBinary(SETTING_KEY, BIN_NAME), ['version']);
    version = stdout.trim();
  } catch (e) {
    versionErr = e.message;
  }

  let devicesRaw = '';
  let devicesErr = '';
  try {
    const { stdout } = await exec(resolveBinary(SETTING_KEY, BIN_NAME), ['devices', '-l']);
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
    devicesCmd: 'adb devices -l',
    envPath: process.env.PATH || process.env.Path || '',
    extraEnv,
    hint: META.hint,
  };
}

function getBinaryPath() { return settings.get(SETTING_KEY, ''); }
function setBinaryPathFn(p) { return setBinaryPath(SETTING_KEY, p); }

async function listFiles(serial, remotePath = '/') {
  if (!serial) return { ok: false, error: '未选择设备', entries: [] };
  const target = remotePath || '/';
  try {
    const { stdout, stderr } = await exec(resolveBinary(SETTING_KEY, BIN_NAME),
      ['-s', serial, 'shell', 'ls', '-la', target]);
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

async function pullFile(serial, remotePath, localPath) {
  if (!serial) return { ok: false, error: '未选择设备' };
  if (!remotePath) return { ok: false, error: '未选择远端路径' };
  if (!localPath) return { ok: false, error: '未选择保存路径' };
  try {
    const { stdout, stderr } = await exec(resolveBinary(SETTING_KEY, BIN_NAME),
      ['-s', serial, 'pull', remotePath, localPath], { timeout: 120000 });
    return { ok: true, stdout, stderr, localPath, defaultName: deviceBaseName(remotePath) };
  } catch (e) {
    return { ok: false, error: e.message, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function uploadFiles(serial, localPaths, remoteDir) {
  if (!serial) return { ok: false, error: '未选择设备' };
  if (!remoteDir) return { ok: false, error: '未选择远端目录' };
  const files = Array.isArray(localPaths) ? localPaths.filter(Boolean) : [];
  if (!files.length) return { ok: false, error: '未选择本地文件' };

  const results = [];
  for (const localPath of files) {
    try {
      const { stdout, stderr } = await exec(resolveBinary(SETTING_KEY, BIN_NAME),
        ['-s', serial, 'push', localPath, remoteDir], { timeout: 120000 });
      results.push({ ok: true, localPath, remoteDir, stdout, stderr });
    } catch (e) {
      results.push({ ok: false, localPath, remoteDir, error: e.message, stdout: e.stdout || '', stderr: e.stderr || '' });
    }
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    return { ok: false, error: failed[0].error || '部分文件上传失败', results };
  }
  return { ok: true, results };
}

async function deleteFile(serial, remotePath) {
  if (!serial) return { ok: false, error: '未选择设备' };
  if (!remotePath) return { ok: false, error: '未选择远端路径' };
  try {
    const { stdout, stderr } = await exec(resolveBinary(SETTING_KEY, BIN_NAME),
      ['-s', serial, 'shell', 'rm', '-rf', remotePath], { timeout: 30000 });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, error: e.message, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

async function collectFileProperties(serial, remotePath) {
  if (!serial) return { ok: false, error: '未选择设备' };
  if (!remotePath) return { ok: false, error: '未选择远端路径' };

  const commands = [
    { title: 'stat', args: ['-s', serial, 'shell', 'stat', remotePath] },
    { title: 'ls -ld', args: ['-s', serial, 'shell', 'ls', '-ld', remotePath] },
    { title: 'du -sh', args: ['-s', serial, 'shell', 'du', '-sh', remotePath] },
  ];
  const sections = [];
  for (const cmd of commands) {
    try {
      const { stdout, stderr } = await exec(resolveBinary(SETTING_KEY, BIN_NAME), cmd.args, { timeout: 10000 });
      sections.push({ title: cmd.title, ok: true, stdout, stderr });
    } catch (e) {
      sections.push({ title: cmd.title, ok: false, error: e.message, stdout: e.stdout || '', stderr: e.stderr || '' });
    }
  }
  return { ok: true, path: remotePath, sections };
}

module.exports = {
  meta: META,
  check, listDevices, listPackages, getPidForPackage,
  clearBuffer, startStream, stopStream, isStreaming,
  diagnose, getBinaryPath, setBinaryPath: setBinaryPathFn,
  listFiles, pullFile, uploadFiles, deleteFile, collectFileProperties,
};
