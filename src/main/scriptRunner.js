const path = require('path');
const { spawn } = require('child_process');

// console 模式：
//   'show' (默认): 弹出新的控制台窗口，脚本结束后自动关闭——和双击脚本最接近的体验。
//   'keep'        : 弹出新的控制台窗口，脚本结束后保留窗口（PowerShell -NoExit / cmd /k）。
//   'hidden'      : 后台运行，不弹窗口；stdout/stderr 由 QuickTool 捕获（适合静默任务）。
const HIDDEN_ALIASES = new Set(['hidden', 'none', 'background', 'silent', 'off', 'false']);
const KEEP_ALIASES = new Set(['keep', 'pause', 'noexit', 'stay']);
const SHOW_ALIASES = new Set(['show', 'visible', 'console', 'on', 'true', 'default', '']);

function normalizeMode(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (HIDDEN_ALIASES.has(s)) return 'hidden';
  if (KEEP_ALIASES.has(s)) return 'keep';
  if (SHOW_ALIASES.has(s)) return 'show';
  return 'show';
}

function buildCommand(script, mode) {
  switch (script.ext) {
    case '.ps1': {
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass'];
      if (mode === 'keep') args.push('-NoExit');
      args.push('-File', script.path);
      return { cmd: 'powershell.exe', args };
    }
    case '.bat':
    case '.cmd':
      return {
        cmd: 'cmd.exe',
        args: [mode === 'keep' ? '/k' : '/c', script.path],
      };
    case '.py':
      // keep 模式用 cmd /k 包一层，让脚本结束后窗口仍在
      if (mode === 'keep') {
        return { cmd: 'cmd.exe', args: ['/k', 'python', script.path] };
      }
      return { cmd: 'python', args: [script.path] };
    case '.js':
      if (mode === 'keep') {
        return { cmd: 'cmd.exe', args: ['/k', 'node', script.path] };
      }
      return { cmd: 'node', args: [script.path] };
    case '.exe':
      // .exe 自带窗口控制（GUI 还是 CLI 由它自己决定），mode 只控制是否隐藏
      return { cmd: script.path, args: [] };
    default:
      return null;
  }
}

const history = [];
const MAX_HISTORY = 200;
let nextRunId = 1;
const listeners = new Set();

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (e) {
      console.error('[scriptRunner] listener 抛错:', e);
    }
  }
}

function addRunListener(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getHistory() {
  return history.slice(-MAX_HISTORY);
}

function run(script) {
  const mode = normalizeMode(script.console);
  const built = buildCommand(script, mode);
  if (!built) return { ok: false, error: `unsupported extension: ${script.ext}` };

  const visible = mode !== 'hidden';

  const runId = nextRunId++;
  const startedAt = Date.now();
  const record = {
    runId,
    scriptId: script.id,
    name: script.name,
    startedAt,
    endedAt: null,
    exitCode: null,
    error: null,
    stdout: '',
    stderr: '',
    status: 'running',
    mode,
    visible,
  };
  history.push(record);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);

  // 关键：可见模式下让 Windows 给子进程创建一个新的控制台窗口。
  //   - windowsHide: false  => 不加 CREATE_NO_WINDOW 标志
  //   - stdio: 'ignore'     => 子进程的输入输出走自己的控制台，而不是被父进程捕获
  //   - detached: true      => 让子进程独立成组，便于在新窗口里运行
  // 隐藏模式继续用管道收 stdout/stderr。
  const spawnOpts = {
    cwd: path.dirname(script.path),
    windowsHide: !visible,
    shell: false,
    detached: visible,
    stdio: visible ? 'ignore' : ['ignore', 'pipe', 'pipe'],
  };

  let child;
  try {
    child = spawn(built.cmd, built.args, spawnOpts);
  } catch (e) {
    record.status = 'error';
    record.error = e.message;
    record.endedAt = Date.now();
    emit({ type: 'end', record });
    return { ok: false, error: e.message, runId };
  }

  emit({ type: 'start', record });

  if (!visible) {
    child.stdout?.on('data', (chunk) => {
      record.stdout += chunk.toString();
      if (record.stdout.length > 100_000) {
        record.stdout = record.stdout.slice(-100_000);
      }
      emit({ type: 'stdout', runId, chunk: chunk.toString() });
    });
    child.stderr?.on('data', (chunk) => {
      record.stderr += chunk.toString();
      if (record.stderr.length > 100_000) {
        record.stderr = record.stderr.slice(-100_000);
      }
      emit({ type: 'stderr', runId, chunk: chunk.toString() });
    });
  }
  child.on('error', (err) => {
    record.status = 'error';
    record.error = err.message;
    record.endedAt = Date.now();
    emit({ type: 'end', record });
  });
  child.on('close', (code) => {
    record.exitCode = code;
    record.endedAt = Date.now();
    record.status = code === 0 ? 'success' : 'failed';
    emit({ type: 'end', record });
  });

  return { ok: true, runId, pid: child.pid, mode };
}

module.exports = {
  run,
  getHistory,
  addRunListener,
  normalizeMode,
};
