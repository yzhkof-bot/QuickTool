const { spawn, execFile } = require('child_process');
const fs = require('fs');
const settings = require('../settings');

// 通用 execFile 包装：返回 Promise，stderr 文本会作为错误信息
function exec(binary, args, { timeout = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr && stderr.trim()) || err.message || `执行 ${binary} 失败`;
          const e = new Error(msg);
          e.code = err.code;
          e.stdout = stdout || '';
          e.stderr = stderr || '';
          reject(e);
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

// 在系统 PATH 里查找命令的绝对路径
function whichTool(name) {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, [name], { windowsHide: true, encoding: 'utf8' }, (err, stdout) => {
      if (err) return resolve('');
      const lines = (stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      resolve(lines[0] || '');
    });
  });
}

// 优先返回用户配置的可执行文件路径，其次回退到 PATH 中的命令名
function resolveBinary(settingKey, defaultName) {
  const custom = settings.get(settingKey, '');
  if (custom && fs.existsSync(custom)) return custom;
  return defaultName;
}

function getBinaryStatus(settingKey, defaultName) {
  const custom = settings.get(settingKey, '');
  if (custom) return { source: 'custom', path: custom, exists: fs.existsSync(custom) };
  return { source: 'PATH', path: defaultName, exists: null };
}

function setBinaryPath(settingKey, p) {
  if (!p) {
    settings.set(settingKey, '');
    return { ok: true, cleared: true };
  }
  if (!fs.existsSync(p)) return { ok: false, error: '路径不存在: ' + p };
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return { ok: false, error: '请选择可执行文件，而不是目录' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
  settings.set(settingKey, p);
  return { ok: true, path: p };
}

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function joinDevicePath(parent, name) {
  const base = parent || '/';
  if (!name || name === '/') return '/';
  if (base === '/') return '/' + name;
  return base.replace(/\/+$/, '') + '/' + name;
}

function deviceBaseName(p) {
  const clean = String(p || '').replace(/\/+$/, '');
  if (!clean || clean === '/') return 'device-root';
  return clean.split('/').filter(Boolean).pop() || 'device-root';
}

function modeToType(mode) {
  return mode[0] === 'd' ? 'dir'
    : mode[0] === 'l' ? 'link'
    : 'file';
}

function findDateIndex(parts) {
  const months = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/i;
  for (let i = 1; i < parts.length; i++) {
    if (/^\d{4}-\d{2}-\d{2}/.test(parts[i])) return { index: i, count: 2 };
    if (months.test(parts[i]) && i + 2 < parts.length) return { index: i, count: 3 };
  }
  return null;
}

function normalizeLsName(name) {
  let value = String(name || '').trim();
  let typeHint = '';
  if (value.endsWith('/')) {
    typeHint = 'dir';
    value = value.slice(0, -1);
  } else if (value.endsWith('@')) {
    typeHint = 'link';
    value = value.slice(0, -1);
  } else if (value.endsWith('*')) {
    value = value.slice(0, -1);
  }
  return { name: value, typeHint };
}

function getLsError(stdout, stderr) {
  const text = [stdout, stderr].filter(Boolean).join('\n');
  const line = text.split(/\r?\n/).find((item) => /^ls:\s+/i.test(item.trim()));
  return line ? line.trim() : '';
}

function parseLsLong(stdout, parentPath) {
  const entries = [];
  for (const raw of String(stdout || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^total\s+/i.test(line)) continue;
    if (/^ls:/i.test(line)) continue;

    const parts = line.split(/\s+/);
    const mode = parts[0] || '';
    if (!/^[bcdlps-]/.test(mode) || parts.length < 2) {
      const simple = normalizeLsName(line);
      if (!simple.name || simple.name === '.' || simple.name === '..') continue;
      entries.push({
        name: simple.name,
        path: joinDevicePath(parentPath, simple.name),
        type: simple.typeHint || 'file',
        mode: '',
        owner: '',
        group: '',
        size: 0,
        modified: '',
        linkTarget: '',
      });
      continue;
    }

    const dateInfo = findDateIndex(parts);
    let nameStart = -1;
    let dateParts = [];
    let sizeIndex = -1;
    if (dateInfo) {
      nameStart = dateInfo.index + dateInfo.count;
      dateParts = parts.slice(dateInfo.index, nameStart);
      for (let i = dateInfo.index - 1; i >= 1; i--) {
        if (/^\d+$/.test(parts[i])) {
          sizeIndex = i;
          break;
        }
      }
    } else {
      sizeIndex = parts.findIndex((part, idx) => idx >= 3 && /^\d+$/.test(part));
      if (sizeIndex >= 0 && sizeIndex + 1 < parts.length) {
        const rest = parts.slice(sizeIndex + 1);
        let datePartCount = 3;
        if (/^\d{4}-\d{2}-\d{2}/.test(rest[0] || '')) datePartCount = 2;
        else if (rest.length <= 3) datePartCount = Math.max(1, rest.length - 1);
        dateParts = rest.slice(0, datePartCount);
        nameStart = sizeIndex + 1 + datePartCount;
      }
    }
    if (nameStart < 0 || nameStart >= parts.length) continue;
    let name = parts.slice(nameStart).join(' ');
    let linkTarget = '';
    if (mode[0] === 'l' && name.includes(' -> ')) {
      const pair = name.split(' -> ');
      name = pair.shift();
      linkTarget = pair.join(' -> ');
    }
    const normalized = normalizeLsName(name);
    name = normalized.name;
    if (!name || name === '.' || name === '..') continue;

    const hasLinkCount = /^\d+$/.test(parts[1] || '');
    const ownerIndex = hasLinkCount ? 2 : 1;
    entries.push({
      name,
      path: joinDevicePath(parentPath, name),
      type: modeToType(mode) || normalized.typeHint || 'file',
      mode,
      owner: parts[ownerIndex] || '',
      group: parts[ownerIndex + 1] || '',
      size: sizeIndex >= 0 ? (Number(parts[sizeIndex]) || 0) : 0,
      modified: dateParts.join(' '),
      linkTarget,
    });
  }
  entries.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  return entries;
}

// 把日志流式子进程的生命周期 + stdout 行切分逻辑封装成一个 runner，
// 各平台只关心 args 和回调。
function createProcessRunner(getBinary) {
  let proc = null;
  let lineBuffer = '';

  function isRunning() {
    return !!proc;
  }

  function start({ args, onLines, onStderr, onExit }) {
    if (proc) return { ok: false, error: '已在运行，请先停止' };
    let p;
    try {
      p = spawn(getBinary(), args, { windowsHide: true });
    } catch (e) {
      return { ok: false, error: e.message };
    }

    proc = p;
    lineBuffer = '';

    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      const text = lineBuffer + chunk;
      const parts = text.split(/\r?\n/);
      lineBuffer = parts.pop() || '';
      const lines = parts.filter((l) => l.length > 0);
      if (lines.length && onLines) onLines(lines);
    });

    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (chunk) => {
      if (onStderr) onStderr(String(chunk));
    });

    p.on('error', (err) => {
      if (proc === p) proc = null;
      if (onExit) onExit({ code: -1, error: err.message });
    });

    p.on('exit', (code, signal) => {
      if (lineBuffer && onLines) {
        onLines([lineBuffer]);
        lineBuffer = '';
      }
      if (proc === p) proc = null;
      if (onExit) onExit({ code, signal });
    });

    return { ok: true };
  }

  function stop() {
    if (!proc) return { ok: true, alreadyStopped: true };
    try {
      proc.kill();
    } catch (_) {
      // ignore
    }
    proc = null;
    return { ok: true };
  }

  return { isRunning, start, stop };
}

module.exports = {
  exec,
  whichTool,
  resolveBinary,
  getBinaryStatus,
  setBinaryPath,
  shellQuote,
  joinDevicePath,
  deviceBaseName,
  parseLsLong,
  getLsError,
  createProcessRunner,
};
