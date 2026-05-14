const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');

const SUPPORTED_EXT = ['.ps1', '.bat', '.cmd', '.py', '.exe', '.js'];
const META_EXT = '.meta.json';

function ensureScriptsDir(scriptsDir) {
  if (!fs.existsSync(scriptsDir)) {
    fs.mkdirSync(scriptsDir, { recursive: true });
  }
}

function loadMeta(scriptPath) {
  const ext = path.extname(scriptPath);
  const metaPath = scriptPath.slice(0, -ext.length) + META_EXT;
  if (!fs.existsSync(metaPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  } catch (e) {
    console.warn(`[scriptScanner] meta JSON 解析失败: ${metaPath}`, e.message);
    return {};
  }
}

function scan(scriptsDir) {
  const items = [];
  if (!fs.existsSync(scriptsDir)) return items;

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXT.includes(ext)) continue;

      const relativePath = path.relative(scriptsDir, fullPath);
      const meta = loadMeta(fullPath);
      const subDir = path.dirname(relativePath);
      const defaultCategory = subDir === '.' ? '未分类' : subDir.split(path.sep).join(' / ');

      items.push({
        id: relativePath.split(path.sep).join('/'),
        name: meta.name || path.basename(entry.name, ext),
        description: meta.description || '',
        category: meta.category || defaultCategory,
        path: fullPath,
        ext,
        hidden: !!meta.hidden,
        console: meta.console || 'show',
      });
    }
  };
  walk(scriptsDir);

  return items
    .filter((i) => !i.hidden)
    .sort((a, b) => {
      const c = a.category.localeCompare(b.category, 'zh');
      return c !== 0 ? c : a.name.localeCompare(b.name, 'zh');
    });
}

function startWatcher(scriptsDir, onChange) {
  const watcher = chokidar.watch(scriptsDir, {
    ignored: /(^|[\\/])\../,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
  });

  let timer = null;
  const debounced = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        onChange();
      } catch (e) {
        console.error('[scriptScanner] onChange 失败:', e);
      }
    }, 150);
  };

  watcher
    .on('add', debounced)
    .on('unlink', debounced)
    .on('change', debounced)
    .on('addDir', debounced)
    .on('unlinkDir', debounced)
    .on('error', (err) => console.error('[scriptScanner] watcher error:', err));

  return watcher;
}

module.exports = {
  SUPPORTED_EXT,
  ensureScriptsDir,
  scan,
  startWatcher,
};
