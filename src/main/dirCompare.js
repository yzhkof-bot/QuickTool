// 纯本地目录树对比（与 svn 无关）。
// - compareTree(left, right)：递归比较两个本地目录，返回扁平的树节点列表
//   （父目录在前、子节点紧随其后，带 depth），每个节点带状态：
//   same / added（仅右侧有） / removed（仅左侧有） / modified（两侧都有但内容不同）。
// - compareFile(left, right, relPath)：返回单个文件的对比结果，结构与 svn fileDiff
//   保持一致（mode: 'text-js' | 'binary' | 'dir'），便于渲染端直接复用 diff 详情那套 UI。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 默认忽略的目录（版本库元数据等纯噪音，且 .svn 往往体量巨大）
const SKIP_NAMES = new Set(['.svn', '.git', '.hg']);

// 安全上限：超大目录避免一次性遍历卡死 / 内存爆炸
const MAX_ENTRIES = 50000;
// 同样大小的两个文件，超过该体积就用流式分块比较，避免一次性读入内存
const CONTENT_READ_LIMIT = 32 * 1024 * 1024;

function isLocalDir(p) {
  const s = String(p || '').trim();
  if (!s) return false;
  try {
    return fs.statSync(s).isDirectory();
  } catch (_) {
    return false;
  }
}

function safeStat(p) {
  try { return fs.statSync(p); } catch (_) { return null; }
}

// 列出目录下的直接子项：Map<name, { kind:'dir'|'file', size }>
function readDirSafe(dir) {
  const map = new Map();
  let dirents = [];
  try { dirents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return map; }
  for (const d of dirents) {
    if (SKIP_NAMES.has(d.name)) continue;
    let kind = '';
    if (d.isDirectory()) kind = 'dir';
    else if (d.isFile()) kind = 'file';
    else {
      // 符号链接等：解析其真实类型
      const st = safeStat(path.join(dir, d.name));
      if (!st) continue;
      kind = st.isDirectory() ? 'dir' : 'file';
    }
    let size = 0;
    if (kind === 'file') {
      const st = safeStat(path.join(dir, d.name));
      size = st ? st.size : 0;
    }
    map.set(d.name, { kind, size });
  }
  return map;
}

function md5(buf) {
  return buf ? crypto.createHash('md5').update(buf).digest('hex') : '';
}

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

// 大文件分块比较（同样大小才会走到这里）
function filesEqualStreaming(lp, rp) {
  const CHUNK = 1 << 20; // 1MB
  let fa = null;
  let fb = null;
  try {
    fa = fs.openSync(lp, 'r');
    fb = fs.openSync(rp, 'r');
    const ba = Buffer.allocUnsafe(CHUNK);
    const bb = Buffer.allocUnsafe(CHUNK);
    for (;;) {
      const na = fs.readSync(fa, ba, 0, CHUNK, null);
      const nb = fs.readSync(fb, bb, 0, CHUNK, null);
      if (na !== nb) return false;
      if (na === 0) return true;
      if (Buffer.compare(ba.subarray(0, na), bb.subarray(0, nb)) !== 0) return false;
    }
  } catch (_) {
    return false; // 读失败时保守地判为不同
  } finally {
    if (fa !== null) try { fs.closeSync(fa); } catch (_) { /* ignore */ }
    if (fb !== null) try { fs.closeSync(fb); } catch (_) { /* ignore */ }
  }
}

// 比较两个文件内容：'same' | 'modified'
function compareFileStatus(lp, rp, lsize, rsize) {
  if (lsize !== rsize) return 'modified';
  if (lsize === 0) return 'same';
  if (lsize > CONTENT_READ_LIMIT) {
    return filesEqualStreaming(lp, rp) ? 'same' : 'modified';
  }
  try {
    const a = fs.readFileSync(lp);
    const b = fs.readFileSync(rp);
    return a.equals(b) ? 'same' : 'modified';
  } catch (_) {
    return 'modified';
  }
}

function sortNames(names) {
  return names.sort((a, b) => {
    const r = a.toLowerCase().localeCompare(b.toLowerCase());
    return r !== 0 ? r : a.localeCompare(b);
  });
}

// 把"只在一侧存在"的节点（及其整个子树）按统一状态追加进结果
function addSubtreeAsStatus(rel, name, depth, kind, absPath, status, ctx) {
  if (ctx.count >= MAX_ENTRIES) { ctx.truncated = true; return; }
  ctx.count++;
  ctx.entries.push({ path: rel, name, depth, kind, status });
  if (kind === 'file') ctx.counts[status] += 1;
  if (kind === 'dir') {
    const map = readDirSafe(absPath);
    const names = sortNames([...map.keys()]);
    for (const n of names) {
      if (ctx.count >= MAX_ENTRIES) { ctx.truncated = true; break; }
      const child = map.get(n);
      addSubtreeAsStatus(
        rel ? rel + '/' + n : n,
        n, depth + 1, child.kind, path.join(absPath, n), status, ctx,
      );
    }
  }
}

// 递归比较同一层级，返回该层是否存在任何差异（供父目录聚合状态用）
function walkLevel(relBase, leftDir, rightDir, depth, ctx) {
  const lmap = readDirSafe(leftDir);
  const rmap = readDirSafe(rightDir);
  const names = sortNames([...new Set([...lmap.keys(), ...rmap.keys()])]);
  let anyDiff = false;

  for (const name of names) {
    if (ctx.count >= MAX_ENTRIES) { ctx.truncated = true; break; }
    const l = lmap.get(name);
    const r = rmap.get(name);
    const rel = relBase ? relBase + '/' + name : name;
    const lp = l ? path.join(leftDir, name) : '';
    const rp = r ? path.join(rightDir, name) : '';
    const lIsDir = l && l.kind === 'dir';
    const rIsDir = r && r.kind === 'dir';

    if (l && r && lIsDir && rIsDir) {
      const node = { path: rel, name, depth, kind: 'dir', status: 'same' };
      ctx.count++;
      ctx.entries.push(node);
      const childDiff = walkLevel(rel, lp, rp, depth + 1, ctx);
      node.status = childDiff ? 'modified' : 'same';
      if (childDiff) anyDiff = true;
    } else if (l && r && !lIsDir && !rIsDir) {
      const status = compareFileStatus(lp, rp, l.size, r.size);
      ctx.count++;
      ctx.entries.push({ path: rel, name, depth, kind: 'file', status });
      ctx.counts[status] += 1;
      if (status !== 'same') anyDiff = true;
    } else if (l && r) {
      // 一侧是目录、一侧是文件：类型变更，标记为 modified
      ctx.count++;
      ctx.entries.push({ path: rel, name, depth, kind: 'file', status: 'modified', typeChanged: true });
      ctx.counts.modified += 1;
      anyDiff = true;
    } else if (l) {
      addSubtreeAsStatus(rel, name, depth, l.kind, lp, 'removed', ctx);
      anyDiff = true;
    } else {
      addSubtreeAsStatus(rel, name, depth, r.kind, rp, 'added', ctx);
      anyDiff = true;
    }
  }
  return anyDiff;
}

function compareTree(left, right) {
  const l = String(left || '').trim();
  const r = String(right || '').trim();
  if (!isLocalDir(l)) return { ok: false, error: '左侧不是有效的本地目录：' + l };
  if (!isLocalDir(r)) return { ok: false, error: '右侧不是有效的本地目录：' + r };

  const ctx = {
    entries: [],
    count: 0,
    truncated: false,
    counts: { same: 0, added: 0, removed: 0, modified: 0 },
  };
  try {
    walkLevel('', l, r, 0, ctx);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return {
    ok: true,
    left: l,
    right: r,
    entries: ctx.entries,
    truncated: ctx.truncated,
    counts: ctx.counts,
  };
}

// 单个文件对比：结构与 svnPick.fileDiff 对齐，渲染端可复用同一套渲染逻辑
function compareFile(left, right, relPath) {
  const rel = String(relPath || '').replace(/^[\\/]+/, '');
  if (!rel) return { ok: false, error: '缺少文件路径' };
  const segs = rel.split('/');
  const lp = path.join(left, ...segs);
  const rp = path.join(right, ...segs);

  const lStat = safeStat(lp);
  const rStat = safeStat(rp);
  if (!lStat && !rStat) return { ok: false, error: '文件不存在' };

  // 目录节点没有文本 diff
  if ((lStat && lStat.isDirectory()) || (rStat && rStat.isDirectory())) {
    return { ok: true, mode: 'dir' };
  }

  let action = 'M';
  if (lStat && !rStat) action = 'D';
  else if (!lStat && rStat) action = 'A';

  let oldBuf = null;
  let newBuf = null;
  try { if (lStat) oldBuf = fs.readFileSync(lp); } catch (_) { /* ignore */ }
  try { if (rStat) newBuf = fs.readFileSync(rp); } catch (_) { /* ignore */ }

  if (isBinaryBuffer(oldBuf) || isBinaryBuffer(newBuf)) {
    return {
      ok: true,
      mode: 'binary',
      action,
      oldSize: oldBuf ? oldBuf.length : null,
      newSize: newBuf ? newBuf.length : null,
      oldMd5: md5(oldBuf),
      newMd5: md5(newBuf),
      mimeType: '',
    };
  }

  return {
    ok: true,
    mode: 'text-js',
    action,
    oldText: bufToText(oldBuf),
    newText: bufToText(newBuf),
  };
}

module.exports = {
  compareTree,
  compareFile,
};
