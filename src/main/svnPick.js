const { execFile } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const settings = require('./settings');

const SETTING_KEY = 'svnPath';
const DEFAULT_BINARY = 'svn';

// 通用 execFile 包装：返回 { ok, stdout, stderr, code }，不会 reject，
// 方便渲染端统一处理（svn 的"失败"很多时候要把 stderr 展示给用户）。
function run(args, { timeout = 60000 } = {}) {
  const binary = resolveBinary();
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout },
      (err, stdout, stderr) => {
        if (err) {
          resolve({
            ok: false,
            code: typeof err.code === 'number' ? err.code : -1,
            stdout: stdout || '',
            stderr: (stderr && stderr.trim()) || err.message || `执行 ${binary} 失败`,
            error: (stderr && stderr.trim()) || err.message,
          });
          return;
        }
        resolve({ ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

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

function resolveBinary() {
  const custom = settings.get(SETTING_KEY, '');
  if (custom && fs.existsSync(custom)) return custom;
  return DEFAULT_BINARY;
}

function getBinaryStatus() {
  const custom = settings.get(SETTING_KEY, '');
  if (custom) return { source: 'custom', path: custom, exists: fs.existsSync(custom) };
  return { source: 'PATH', path: DEFAULT_BINARY, exists: null };
}

function getBinaryPath() {
  return settings.get(SETTING_KEY, '');
}

function setBinaryPath(p) {
  if (!p) {
    settings.set(SETTING_KEY, '');
    return { ok: true, cleared: true };
  }
  if (!fs.existsSync(p)) return { ok: false, error: '路径不存在: ' + p };
  try {
    const stat = fs.statSync(p);
    if (!stat.isFile()) return { ok: false, error: '请选择 svn 可执行文件，而不是目录' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
  settings.set(SETTING_KEY, p);
  return { ok: true, path: p };
}

// ===== XML helpers（svn --xml 输出体量可控，用轻量正则解析即可） =====
function decodeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');
}

function pickTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decodeXml(m[1]) : '';
}

// ===== 命令封装 =====

async function check() {
  const status = getBinaryStatus();
  const res = await run(['--version', '--quiet'], { timeout: 15000 });
  if (!res.ok) {
    return { ok: false, binary: status, error: res.stderr };
  }
  return { ok: true, binary: status, version: (res.stdout || '').trim() };
}

async function diagnose() {
  const status = getBinaryStatus();
  const onPath = await whichTool(DEFAULT_BINARY);
  const ver = await run(['--version'], { timeout: 15000 });
  return {
    binary: status,
    onPath,
    versionOk: ver.ok,
    version: ver.ok ? (ver.stdout || '').trim() : '',
    error: ver.ok ? '' : ver.stderr,
  };
}

// svn info --xml；target 可以是工作副本目录或 URL
async function info(target) {
  if (!target) return { ok: false, error: '未指定目标' };
  const res = await run(['info', '--xml', target], { timeout: 30000 });
  if (!res.ok) return { ok: false, error: res.stderr };
  const xml = res.stdout;
  return {
    ok: true,
    url: pickTag(xml, 'url'),
    relativeUrl: pickTag(xml, 'relative-url'),
    repoRoot: pickTag(xml, 'root'),
    revision: (xml.match(/<entry[^>]*\brevision="(\d+)"/) || [])[1] || '',
    kind: (xml.match(/<entry[^>]*\bkind="([^"]+)"/) || [])[1] || '',
    wcPath: pickTag(xml, 'wcroot-abspath'),
  };
}

// svn log --xml；source 可以是 URL 或工作副本路径
// 关键：本地工作副本默认只显示到 BASE（已 update 到的版本），看不到仓库最新提交；
// 所以本地路径会先解析成仓库 URL，再对 URL 查 log（URL 默认查到 HEAD）。
async function log(source, { limit = 100, search = '', revisionRange = '' } = {}) {
  if (!source) return { ok: false, error: '未指定来源分支', entries: [] };

  let target = source;
  let resolvedUrl = '';
  if (!isUrl(source)) {
    const resolved = await resolveSourceUrl(source);
    if (!resolved.ok) return { ok: false, error: resolved.error, entries: [] };
    target = resolved.url;
    resolvedUrl = resolved.url;
  }

  const args = ['log', '--xml'];
  if (revisionRange) {
    args.push('-r', revisionRange);
  } else {
    // 显式从 HEAD 往回取，保证能看到仓库最新提交
    args.push('-r', 'HEAD:1');
    args.push('-l', String(Math.max(1, Math.min(2000, Number(limit) || 100))));
  }
  if (search) args.push('--search', search);
  args.push(target);

  const res = await run(args, { timeout: 60000 });
  if (!res.ok) return { ok: false, error: res.stderr, entries: [], resolvedUrl };

  const entries = [];
  const re = /<logentry[^>]*\brevision="(\d+)"[^>]*>([\s\S]*?)<\/logentry>/g;
  let m;
  while ((m = re.exec(res.stdout)) !== null) {
    const block = m[2];
    entries.push({
      revision: Number(m[1]),
      author: pickTag(block, 'author'),
      date: pickTag(block, 'date'),
      msg: pickTag(block, 'msg').trim(),
    });
  }
  return { ok: true, entries, resolvedUrl };
}

// 查看单个 revision 的改动文件清单（svn log -v）+ 仓库根（用于拼接单文件 URL）
async function revisionDetail(source, revision) {
  if (!source) return { ok: false, error: '未指定来源' };
  const rev = Number(revision);
  if (!Number.isFinite(rev) || rev <= 0) return { ok: false, error: '非法 revision' };

  let target = source;
  if (!isUrl(source)) {
    const resolved = await resolveSourceUrl(source);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    target = resolved.url;
  }

  // 仓库根：用于把 svn log -v 给出的仓库绝对路径拼成可 diff 的 URL
  const inf = await info(target);
  const repoRoot = inf.ok ? inf.repoRoot : '';

  // 变更文件清单
  const logRes = await run(['log', '-v', '--xml', '-r', String(rev), target], { timeout: 60000 });
  const paths = [];
  let author = '';
  let date = '';
  let msg = '';
  if (logRes.ok) {
    const entry = (logRes.stdout.match(/<logentry[\s\S]*?<\/logentry>/) || [''])[0];
    author = pickTag(entry, 'author');
    date = pickTag(entry, 'date');
    msg = pickTag(entry, 'msg').trim();
    const re = /<path\b([^>]*)>([\s\S]*?)<\/path>/g;
    let m;
    while ((m = re.exec(entry)) !== null) {
      const attrs = m[1];
      paths.push({
        action: (attrs.match(/\baction="([^"]*)"/) || [])[1] || '',
        kind: (attrs.match(/\bkind="([^"]*)"/) || [])[1] || '',
        path: decodeXml(m[2]),
      });
    }
    paths.sort((a, b) => a.path.localeCompare(b.path));
  }

  return {
    ok: true,
    revision: rev,
    author,
    date,
    msg,
    repoRoot,
    paths,
    pathsError: logRes.ok ? '' : logRes.stderr,
  };
}

// 以原始字节方式执行 svn（用于 svn cat，避免文本解码破坏二进制判断）
function runBuf(args, { timeout = 180000 } = {}) {
  const binary = resolveBinary();
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { windowsHide: true, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr && stderr.toString('utf8').trim()) || err.message || `执行 ${binary} 失败`;
          resolve({ ok: false, code: err.code, stderr: msg });
          return;
        }
        resolve({ ok: true, buf: stdout || Buffer.alloc(0) });
      },
    );
  });
}

// 二进制判定：参照 git——文件前 8000 字节内出现 NUL 字节即视为二进制
function isBinaryBuffer(buf) {
  if (!buf || !buf.length) return false;
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function bufToText(buf) {
  if (!buf || !buf.length) return '';
  let t = buf.toString('utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); // 去掉 BOM
  return t;
}

// 查看单个文件在某 revision 的 diff。
// - 先用 svn cat 取原始字节做二进制嗅探（NUL 字节），真二进制直接返回 binary；
// - 文本用 svn 自己的 diff（加 --force，即便 svn:mime-type 把 .cs 等误标二进制也能出文本 diff），
//   保证 diff 结果与 svn 一致、准确；
// - 同时返回新版本全文，供渲染端展开被折叠的上下文。
async function fileDiff({ repoRoot, repoPath, revision, action }) {
  const rev = Number(revision);
  if (!Number.isFinite(rev) || rev <= 0) return { ok: false, error: '非法 revision' };
  if (!repoRoot || !repoPath) return { ok: false, error: '缺少文件 URL 信息' };

  const fileUrl = String(repoRoot).replace(/\/+$/, '') + '/' + String(repoPath).replace(/^\/+/, '');
  const N = rev;
  const P = rev - 1;
  const act = String(action || '').toUpperCase();

  // 嗅探用的版本：改动/新增取新版 @N；删除取旧版 @(N-1)
  let sniffBuf = null;
  let newText = '';
  let lastErr = '';
  if (act !== 'D') {
    const n = await runBuf(['cat', `${fileUrl}@${N}`]);
    if (n.ok) { sniffBuf = n.buf; newText = bufToText(n.buf); } else lastErr = n.stderr || lastErr;
  } else {
    const o = await runBuf(['cat', `${fileUrl}@${P}`]);
    if (o.ok) sniffBuf = o.buf; else lastErr = o.stderr || lastErr;
  }

  if (sniffBuf && isBinaryBuffer(sniffBuf)) {
    // 二进制：补齐另一版本，给出轻量元信息对比（大小 / MD5 / mime-type）
    const sniffIsNew = act !== 'D';
    let newBuf = sniffIsNew ? sniffBuf : null;
    let oldBuf = sniffIsNew ? null : sniffBuf;
    if (act !== 'A' && oldBuf === null) {
      let o = await runBuf(['cat', `${fileUrl}@${P}`]);
      if (!o.ok) o = await runBuf(['cat', '-r', String(P), `${fileUrl}@${N}`]);
      if (o.ok) oldBuf = o.buf;
    }
    if (act !== 'D' && newBuf === null) {
      const n = await runBuf(['cat', `${fileUrl}@${N}`]);
      if (n.ok) newBuf = n.buf;
    }
    const md5 = (b) => (b ? crypto.createHash('md5').update(b).digest('hex') : '');
    const mimeRef = act !== 'D' ? `${fileUrl}@${N}` : `${fileUrl}@${P}`;
    const mp = await run(['propget', 'svn:mime-type', mimeRef], { timeout: 30000 });
    return {
      ok: true,
      mode: 'binary',
      action: act,
      oldSize: oldBuf ? oldBuf.length : null,
      newSize: newBuf ? newBuf.length : null,
      oldMd5: md5(oldBuf),
      newMd5: md5(newBuf),
      mimeType: mp.ok ? (mp.stdout || '').trim() : '',
      fileUrl,
    };
  }

  // 用 svn 自己的 diff（--force 跳过 mime-type 二进制限制）
  const d = await run(['diff', '-c', String(N), '--force', fileUrl], { timeout: 180000 });
  if (d.ok) {
    return { ok: true, mode: 'text', action: act, diff: d.stdout, newText, fileUrl };
  }

  // 兜底：svn diff 失败时退回 cat 双版本本地比对
  let oldText = '';
  if (act !== 'A') {
    let o = await runBuf(['cat', `${fileUrl}@${P}`]);
    if (!o.ok) o = await runBuf(['cat', '-r', String(P), `${fileUrl}@${N}`]);
    if (o.ok) oldText = bufToText(o.buf); else lastErr = o.stderr || lastErr;
  }
  if (!newText && !oldText) {
    return { ok: false, error: lastErr || d.stderr || '无法获取文件内容', fileUrl };
  }
  return { ok: true, mode: 'text-js', action: act, oldText, newText, fileUrl };
}

// svn update 工作副本
async function update(target) {
  if (!target) return { ok: false, error: '未指定目标工作副本' };
  const res = await run(['update', '--non-interactive', target], { timeout: 600000 });
  return { ok: res.ok, output: (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim(), error: res.ok ? '' : res.stderr };
}

// 判断一个字符串是不是 URL（http(s):// svn:// svn+ssh:// file:// 等）
function isUrl(s) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(s || ''));
}

// 把来源解析成"仓库 URL"：URL 原样返回；本地工作副本路径用 svn info 取其 url。
async function resolveSourceUrl(source) {
  if (isUrl(source)) return { ok: true, url: source, repoRoot: '', wasLocal: false };
  const i = await info(source);
  if (!i.ok || !i.url) {
    return { ok: false, error: i.error || `无法从本地路径解析仓库 URL：${source}` };
  }
  return { ok: true, url: i.url, repoRoot: i.repoRoot, wasLocal: true };
}

// svn merge -c <revs> --ignore-ancestry <sourceUrl> <target>
// revisions: number[]；dryRun=true 时加 --dry-run
// sourceUrl 可以是 URL 或本地工作副本路径（本地路径会自动解析成对应的仓库 URL）
async function merge({ sourceUrl, revisions, target, dryRun = false }) {
  if (!sourceUrl) return { ok: false, error: '未指定来源分支' };
  if (!target) return { ok: false, error: '未指定目标工作副本' };
  const revs = (Array.isArray(revisions) ? revisions : [revisions])
    .map((r) => Number(r))
    .filter((r) => Number.isFinite(r) && r > 0);
  if (!revs.length) return { ok: false, error: '未选择任何 revision' };

  // 来源是本地路径时解析成仓库 URL，cherry-pick 必须基于 URL 才稳定
  const resolved = await resolveSourceUrl(sourceUrl);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const realSourceUrl = resolved.url;

  // 校验来源 / 目标是否在同一个仓库（跨仓库 revision 号无意义，必然失败）
  let warning = '';
  const targetInfo = await info(target);
  if (targetInfo.ok && resolved.repoRoot && targetInfo.repoRoot
      && resolved.repoRoot !== targetInfo.repoRoot) {
    warning = `⚠ 来源与目标不在同一个仓库（来源 ${resolved.repoRoot} / 目标 ${targetInfo.repoRoot}），cherry-pick 很可能失败。`;
  }

  const args = [
    'merge',
    '-c', revs.join(','),
    '--ignore-ancestry',
    '--non-interactive',
    '--accept', 'postpone',
  ];
  if (dryRun) args.push('--dry-run');
  args.push(realSourceUrl, target);

  const res = await run(args, { timeout: 600000 });
  const output = (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim();
  // 解析冲突标记（以 C 开头的状态行）
  const conflicts = output
    .split(/\r?\n/)
    .filter((line) => /^\s*C[\sUGEA]/.test(line) || /conflict/i.test(line))
    .map((line) => line.trim());
  return {
    ok: res.ok,
    command: 'svn ' + args.join(' '),
    resolvedSourceUrl: realSourceUrl,
    sourceWasLocal: resolved.wasLocal,
    warning,
    output,
    conflicts,
    error: res.ok ? '' : res.stderr,
  };
}

// svn status --xml；返回变更条目列表
async function status(target) {
  if (!target) return { ok: false, error: '未指定目标工作副本', entries: [] };
  const res = await run(['status', '--xml', target], { timeout: 60000 });
  if (!res.ok) return { ok: false, error: res.stderr, entries: [] };

  const entries = [];
  const re = /<entry\s+path="([^"]*)"[\s\S]*?<wc-status[^>]*\bitem="([^"]*)"[^>]*?\/?>/g;
  let m;
  while ((m = re.exec(res.stdout)) !== null) {
    entries.push({ path: decodeXml(m[1]), item: m[2] });
  }
  return { ok: true, entries };
}

// svn diff（文本）
async function diff(target) {
  if (!target) return { ok: false, error: '未指定目标工作副本', diff: '' };
  const res = await run(['diff', target], { timeout: 120000 });
  if (!res.ok) return { ok: false, error: res.stderr, diff: '' };
  return { ok: true, diff: res.stdout };
}

// svn commit
async function commit(target, message) {
  if (!target) return { ok: false, error: '未指定目标工作副本' };
  if (!message || !message.trim()) return { ok: false, error: '提交信息不能为空' };
  const res = await run(['commit', target, '-m', message, '--non-interactive'], { timeout: 600000 });
  const output = (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim();
  const revMatch = output.match(/Committed revision (\d+)/i);
  return {
    ok: res.ok,
    output,
    committedRevision: revMatch ? Number(revMatch[1]) : null,
    error: res.ok ? '' : res.stderr,
  };
}

// svn revert -R（撤销合并后还未提交的本地改动）
async function revert(target) {
  if (!target) return { ok: false, error: '未指定目标工作副本' };
  const res = await run(['revert', '-R', target], { timeout: 120000 });
  return { ok: res.ok, output: (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim(), error: res.ok ? '' : res.stderr };
}

// svn cleanup
async function cleanup(target) {
  if (!target) return { ok: false, error: '未指定目标工作副本' };
  const res = await run(['cleanup', target], { timeout: 120000 });
  return { ok: res.ok, output: (res.stdout + (res.stderr ? '\n' + res.stderr : '')).trim(), error: res.ok ? '' : res.stderr };
}

// ===== 来源 / 目标历史记录 =====
const SOURCE_HISTORY_KEY = 'svnSourceHistory';
const TARGET_HISTORY_KEY = 'svnTargetHistory';
const LAST_SOURCE_KEY = 'svnLastSource';
const LAST_TARGET_KEY = 'svnLastTarget';
const HISTORY_LIMIT = 20;

function getHistory() {
  const sources = settings.get(SOURCE_HISTORY_KEY, []);
  const targets = settings.get(TARGET_HISTORY_KEY, []);
  return {
    sources: Array.isArray(sources) ? sources : [],
    targets: Array.isArray(targets) ? targets : [],
    lastSource: settings.get(LAST_SOURCE_KEY, ''),
    lastTarget: settings.get(LAST_TARGET_KEY, ''),
  };
}

function pushHistory(listKey, lastKey, value) {
  const v = String(value || '').trim();
  if (!v) return { ok: true };
  let list = settings.get(listKey, []);
  if (!Array.isArray(list)) list = [];
  // 去重（不区分大小写），把本次置顶
  list = list.filter((x) => String(x).toLowerCase() !== v.toLowerCase());
  list.unshift(v);
  if (list.length > HISTORY_LIMIT) list = list.slice(0, HISTORY_LIMIT);
  settings.set(listKey, list);
  settings.set(lastKey, v);
  return { ok: true };
}

function recordSource(value) {
  return pushHistory(SOURCE_HISTORY_KEY, LAST_SOURCE_KEY, value);
}

function recordTarget(value) {
  return pushHistory(TARGET_HISTORY_KEY, LAST_TARGET_KEY, value);
}

function removeHistory(kind, value) {
  const listKey = kind === 'target' ? TARGET_HISTORY_KEY : SOURCE_HISTORY_KEY;
  const v = String(value || '').trim();
  let list = settings.get(listKey, []);
  if (!Array.isArray(list)) list = [];
  list = list.filter((x) => String(x).toLowerCase() !== v.toLowerCase());
  settings.set(listKey, list);
  return { ok: true };
}

// 从 URL / 路径里取最后一段作为"来源名"，用于默认提交信息 "from xxx"
function sourceName(source) {
  const clean = String(source || '').replace(/[\\/]+$/, '');
  if (!clean) return '';
  const seg = clean.split(/[\\/]/).filter(Boolean).pop() || '';
  return seg;
}

module.exports = {
  check,
  diagnose,
  getBinaryPath,
  setBinaryPath,
  getBinaryStatus,
  info,
  log,
  revisionDetail,
  fileDiff,
  update,
  merge,
  status,
  diff,
  commit,
  revert,
  cleanup,
  sourceName,
  getHistory,
  recordSource,
  recordTarget,
  removeHistory,
};
