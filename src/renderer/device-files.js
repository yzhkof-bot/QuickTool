/* global window, document */
(() => {
  const api = window.quickTool && window.quickTool.deviceFiles;
  if (!api) {
    document.body.innerHTML =
      '<div style="padding:20px;color:#f88">preload 未加载，无法连接主进程。</div>';
    return;
  }

  const $ = (id) => document.getElementById(id);
  const els = {
    platformSelect: $('platformSelect'),
    deviceSelect: $('deviceSelect'),
    btnRefreshDevices: $('btnRefreshDevices'),
    btnDiag: $('btnDiag'),
    status: $('status'),
    sandboxRow: $('sandboxRow'),
    bundleInput: $('bundleInput'),
    bundleList: $('bundleList'),
    btnLoadBundles: $('btnLoadBundles'),
    btnUp: $('btnUp'),
    btnRoot: $('btnRoot'),
    pathInput: $('pathInput'),
    btnGo: $('btnGo'),
    btnRefresh: $('btnRefresh'),
    btnPull: $('btnPull'),
    diagPanel: $('diagPanel'),
    crumbs: $('crumbs'),
    fileTableWrap: $('fileTableWrap'),
    fileRows: $('fileRows'),
    empty: $('empty'),
    footerText: $('footerText'),
    itemCount: $('itemCount'),
    toast: $('toast'),
    contextMenu: $('contextMenu'),
    propertiesModal: $('propertiesModal'),
    propertiesSubtitle: $('propertiesSubtitle'),
    propertiesBody: $('propertiesBody'),
    btnCloseProperties: $('btnCloseProperties'),
  };

  let platforms = [];
  let currentPlatform = 'android';
  let currentSerial = '';
  let currentPath = '/';
  let currentBundle = '';
  let entries = [];
  let rootNodes = [];
  let treeNodes = new Map();
  let selectedPath = '';
  let toastTimer = null;
  const LAST_HARMONY_BUNDLE_KEY = 'quickTool.deviceFiles.lastHarmonyBundle';
  const LAST_PLATFORM_KEY = 'quickTool.deviceFiles.lastPlatform';

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function showToast(message, kind = 'info', duration = 2400) {
    els.toast.textContent = message;
    els.toast.className = 'toast show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), duration);
  }

  function setStatus(kind, text) {
    els.status.className = 'df-status ' + (kind || '');
    els.status.textContent = text || '';
    els.footerText.textContent = text || '就绪';
  }

  function curMeta() {
    return platforms.find((p) => p.id === currentPlatform)
      || { id: currentPlatform, label: currentPlatform, binaryDisplay: currentPlatform };
  }

  function getSavedHarmonyBundle() {
    try {
      return window.localStorage.getItem(LAST_HARMONY_BUNDLE_KEY) || '';
    } catch (_) {
      return '';
    }
  }

  function saveHarmonyBundle(bundleName) {
    const value = String(bundleName || '').trim();
    if (!value) return;
    try {
      window.localStorage.setItem(LAST_HARMONY_BUNDLE_KEY, value);
    } catch (_) {
      // ignore
    }
  }

  function getSavedPlatform() {
    try {
      return window.localStorage.getItem(LAST_PLATFORM_KEY) || '';
    } catch (_) {
      return '';
    }
  }

  function savePlatform(platformId) {
    const value = String(platformId || '').trim();
    if (!value) return;
    try {
      window.localStorage.setItem(LAST_PLATFORM_KEY, value);
    } catch (_) {
      // ignore
    }
  }

  function restoreHarmonyBundle() {
    if (!isSandboxMode()) return;
    currentBundle = getSavedHarmonyBundle();
    els.bundleInput.value = currentBundle;
  }

  function isSandboxMode() {
    return curMeta().fileBrowserMode === 'sandbox';
  }

  function defaultPathForCurrentPlatform() {
    return normalizePath(curMeta().defaultFilePath || '/');
  }

  function normalizePath(p) {
    let value = String(p || '/').trim();
    if (!value) value = '/';
    value = value.replace(/\\/g, '/');
    if (isSandboxMode()) {
      value = value.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/+$/, '');
      return value || String(curMeta().defaultFilePath || 'data/storage/el2/base');
    }
    if (!value.startsWith('/')) value = '/' + value;
    value = value.replace(/\/+/g, '/');
    if (value.length > 1) value = value.replace(/\/+$/, '');
    return value || '/';
  }

  function parentPath(p) {
    const path = normalizePath(p);
    if (isSandboxMode()) {
      const root = defaultPathForCurrentPlatform();
      if (path === root) return root;
      const parts = path.split('/').filter(Boolean);
      parts.pop();
      const next = parts.length ? parts.join('/') : root;
      return next.startsWith(root) ? next : root;
    }
    if (path === '/') return '/';
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    return parts.length ? '/' + parts.join('/') : '/';
  }

  function formatSize(bytes, type) {
    if (type === 'dir') return '';
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  }

  function typeLabel(type) {
    if (type === 'dir') return '目录';
    if (type === 'link') return '链接';
    return '文件';
  }

  function iconFor(type) {
    if (type === 'dir') return '📁';
    if (type === 'link') return '↪';
    return '📄';
  }

  function makeTreeNode(item, level) {
    return {
      item,
      level,
      expanded: false,
      loaded: false,
      loading: false,
      children: [],
    };
  }

  function setRootEntries(items) {
    entries = items || [];
    treeNodes = new Map();
    rootNodes = entries.map((item) => {
      const node = makeTreeNode(item, 0);
      treeNodes.set(item.path, node);
      return node;
    });
  }

  function flattenVisibleNodes(nodes = rootNodes, out = []) {
    for (const node of nodes) {
      out.push(node);
      if (node.expanded) flattenVisibleNodes(node.children, out);
    }
    return out;
  }

  function removeChildNodesFromMap(node) {
    for (const child of node.children) {
      removeChildNodesFromMap(child);
      treeNodes.delete(child.item.path);
    }
  }

  function rebuildTreeNodesMap() {
    treeNodes = new Map();
    const walk = (nodes) => {
      for (const node of nodes) {
        treeNodes.set(node.item.path, node);
        if (node.children && node.children.length) walk(node.children);
      }
    };
    walk(rootNodes);
  }

  async function mergeNodeChildren(node) {
    if (!node) return false;
    const item = node.item;
    if (!(item.type === 'dir' || item.type === 'link')) return false;
    node.loading = true;
    renderRows();
    const res = await api.list(currentPlatform, currentSerial, item.path, fileOptions());
    node.loading = false;
    if (!res.ok) {
      showToast(`刷新 ${item.path} 失败：${res.error || ''}`, 'error', 3800);
      renderRows();
      return false;
    }
    const nextEntries = res.entries || [];
    const prevByPath = new Map();
    for (const child of node.children || []) prevByPath.set(child.item.path, child);
    const nextPaths = new Set(nextEntries.map((e) => e.path));
    for (const child of node.children || []) {
      if (!nextPaths.has(child.item.path)) {
        removeChildNodesFromMap(child);
        treeNodes.delete(child.item.path);
      }
    }
    node.children = nextEntries.map((child) => {
      const old = prevByPath.get(child.path);
      if (old) {
        old.item = child;
        old.level = node.level + 1;
        return old;
      }
      return makeTreeNode(child, node.level + 1);
    });
    node.loaded = true;
    rebuildTreeNodesMap();
    for (const child of node.children) {
      if (child.loaded && child.expanded) {
        await mergeNodeChildren(child);
      }
    }
    return true;
  }

  async function refreshRootPreserve() {
    setStatus('busy', `刷新 ${currentPath}…`);
    const res = await api.list(currentPlatform, currentSerial, currentPath, fileOptions());
    if (!res.ok) {
      setStatus('error', res.error || '刷新失败');
      showToast('刷新失败：' + (res.error || ''), 'error', 3800);
      return;
    }
    const nextEntries = res.entries || [];
    entries = nextEntries;
    const prevByPath = new Map();
    for (const node of rootNodes) prevByPath.set(node.item.path, node);
    const nextPaths = new Set(nextEntries.map((e) => e.path));
    for (const node of rootNodes) {
      if (!nextPaths.has(node.item.path)) {
        removeChildNodesFromMap(node);
        treeNodes.delete(node.item.path);
      }
    }
    rootNodes = nextEntries.map((item) => {
      const old = prevByPath.get(item.path);
      if (old) {
        old.item = item;
        old.level = 0;
        return old;
      }
      return makeTreeNode(item, 0);
    });
    rebuildTreeNodesMap();
    for (const node of rootNodes) {
      if (node.loaded && node.expanded) {
        await mergeNodeChildren(node);
      }
    }
    if (selectedPath && !treeNodes.has(selectedPath)) selectedPath = '';
    renderRows();
    setStatus('ok', `${currentPath} · ${rootNodes.length} 项`);
  }

  function renderCrumbs() {
    if (isSandboxMode()) {
      const root = defaultPathForCurrentPlatform();
      const rootParts = root.split('/').filter(Boolean);
      const parts = currentPath.split('/').filter(Boolean);
      const chunks = [{ name: '沙箱', path: root }];
      let acc = '';
      for (let i = 0; i < parts.length; i++) {
        acc += (acc ? '/' : '') + parts[i];
        if (i < rootParts.length) continue;
        chunks.push({ name: parts[i], path: acc });
      }
      els.crumbs.innerHTML = chunks.map((c, idx) =>
        `<button class="crumb" data-path="${escapeHtml(c.path)}">${escapeHtml(c.name)}</button>` +
        (idx < chunks.length - 1 ? '<span class="crumb-sep">/</span>' : '')
      ).join('');
      return;
    }
    const parts = currentPath.split('/').filter(Boolean);
    const chunks = [{ name: '/', path: '/' }];
    let acc = '';
    for (const part of parts) {
      acc += '/' + part;
      chunks.push({ name: part, path: acc });
    }
    els.crumbs.innerHTML = chunks.map((c, idx) =>
      `<button class="crumb" data-path="${escapeHtml(c.path)}">${escapeHtml(c.name)}</button>` +
      (idx < chunks.length - 1 ? '<span class="crumb-sep">/</span>' : '')
    ).join('');
  }

  function renderRows() {
    const visibleNodes = flattenVisibleNodes();
    els.fileRows.innerHTML = visibleNodes.map((node) => {
      const item = node.item;
      const selected = item.path === selectedPath ? ' selected' : '';
      const name = item.linkTarget ? `${item.name} -> ${item.linkTarget}` : item.name;
      const canExpand = item.type === 'dir' || item.type === 'link';
      const toggle = canExpand
        ? `<button class="tree-toggle" data-tree-toggle="true" title="${node.expanded ? '收起' : '展开'}">${node.loading ? '…' : (node.expanded ? '▾' : '▸')}</button>`
        : '<span class="tree-toggle placeholder"></span>';
      const indent = Math.max(0, node.level) * 18;
      return `
        <tr class="${selected}" data-path="${escapeHtml(item.path)}">
          <td class="name-col">
            <span class="file-name tree-name" style="padding-left:${indent}px">
              ${toggle}
              <span class="file-icon">${node.expanded && item.type === 'dir' ? '📂' : iconFor(item.type)}</span>
              <span class="file-title">${escapeHtml(name)}</span>
            </span>
          </td>
          <td class="muted">${escapeHtml(typeLabel(item.type))}</td>
          <td class="size">${escapeHtml(formatSize(item.size, item.type))}</td>
          <td class="muted">${escapeHtml(item.modified || '')}</td>
          <td class="muted">${escapeHtml(item.mode || '')}</td>
          <td class="muted">${escapeHtml([item.owner, item.group].filter(Boolean).join(':'))}</td>
        </tr>
      `;
    }).join('');
    els.empty.classList.toggle('hidden', rootNodes.length > 0);
    els.itemCount.textContent = rootNodes.length
      ? `${currentPath} · ${rootNodes.length} 项${visibleNodes.length !== rootNodes.length ? ` · 展开 ${visibleNodes.length} 行` : ''}`
      : '';
    updateSelectionState();
    renderCrumbs();
  }

  function selectedItem() {
    const node = treeNodes.get(selectedPath);
    return node ? node.item : null;
  }

  function updateSelectionState() {
    for (const row of els.fileRows.querySelectorAll('tr[data-path]')) {
      row.classList.toggle('selected', row.getAttribute('data-path') === selectedPath);
    }
    els.btnPull.disabled = !selectedItem();
  }

  async function refreshDevices() {
    setStatus('busy', '查询设备…');
    const res = await api.devices(currentPlatform);
    if (!res.ok) {
      currentSerial = '';
      els.deviceSelect.innerHTML = '<option value="">(无可用设备)</option>';
      setStatus('error', res.error || '查询设备失败');
      showToast('设备查询失败：' + (res.error || ''), 'error');
      await showDiag();
      return;
    }
    const devices = res.devices || [];
    if (!devices.length) {
      currentSerial = '';
      els.deviceSelect.innerHTML = '<option value="">(未检测到设备)</option>';
      setStatus('error', '未检测到设备');
      setRootEntries([]);
      selectedPath = '';
      renderRows();
      await showDiag(res.raw || '');
      return;
    }
    const prev = currentSerial;
    els.deviceSelect.innerHTML = devices.map((d) => {
      const label = `${d.model || d.serial} [${d.serial}] ${d.state}`;
      return `<option value="${escapeHtml(d.serial)}">${escapeHtml(label)}</option>`;
    }).join('');
    if (prev && devices.find((d) => d.serial === prev)) {
      els.deviceSelect.value = prev;
    }
    currentSerial = els.deviceSelect.value;
    setStatus('ok', `已连接 ${devices.length} 个设备`);
    if (isSandboxMode()) {
      await loadBundles(false);
      if (!currentBundle) {
        setStatus('ok', '请选择 Bundle 后浏览应用沙箱');
        return;
      }
    }
    await loadPath(currentPath);
  }

  function fileOptions() {
    return isSandboxMode() ? { bundleName: currentBundle } : {};
  }

  function uploadTargetPath() {
    const item = selectedItem();
    if (item && item.type === 'dir') return item.path;
    return currentPath;
  }

  function refreshTargetPath() {
    const item = selectedItem();
    if (!item) return currentPath;
    if (item.type === 'dir' || item.type === 'link') return item.path;
    return parentPath(item.path);
  }

  async function loadPath(path) {
    if (!currentSerial) {
      showToast('请先选择设备', 'error');
      return;
    }
    if (isSandboxMode()) {
      currentBundle = els.bundleInput.value.trim();
      if (!currentBundle) {
        entries = [];
        setRootEntries([]);
        selectedPath = '';
        renderRows();
        showToast('请先选择或输入 Bundle Name', 'error');
        setStatus('error', '未选择 Bundle');
        return;
      }
      saveHarmonyBundle(currentBundle);
    }
    const nextPath = normalizePath(path);
    currentPath = nextPath;
    els.pathInput.value = nextPath;
    selectedPath = '';
    setStatus('busy', `读取 ${nextPath}…`);
    const res = await api.list(currentPlatform, currentSerial, nextPath, fileOptions());
    if (!res.ok) {
      setRootEntries([]);
      renderRows();
      setStatus('error', res.error || '读取目录失败');
      showToast('读取目录失败：' + (res.error || ''), 'error', 3800);
      return;
    }
    setRootEntries(res.entries || []);
    renderRows();
    setStatus('ok', `${nextPath} · ${entries.length} 项`);
  }

  async function toggleTreeNode(path) {
    const node = treeNodes.get(path);
    if (!node) return;
    const item = node.item;
    if (!(item.type === 'dir' || item.type === 'link')) return;
    if (node.loading) return;
    if (node.loaded) {
      node.expanded = !node.expanded;
      renderRows();
      return;
    }

    const ok = await loadTreeNodeChildren(node);
    if (!ok) return;
    node.expanded = true;
    renderRows();
  }

  async function loadTreeNodeChildren(node) {
    if (!node || node.loading) return false;
    const item = node.item;
    if (node.loaded) return true;
    node.loading = true;
    renderRows();
    const res = await api.list(currentPlatform, currentSerial, item.path, fileOptions());
    node.loading = false;
    if (!res.ok) {
      showToast('展开失败：' + (res.error || ''), 'error', 3800);
      renderRows();
      return false;
    }
    removeChildNodesFromMap(node);
    node.children = (res.entries || []).map((child) => {
      const childNode = makeTreeNode(child, node.level + 1);
      treeNodes.set(child.path, childNode);
      return childNode;
    });
    node.loaded = true;
    node.expanded = true;
    return true;
  }

  async function refreshSelectionInPlace() {
    const item = selectedItem();
    if (!item) {
      await refreshRootPreserve();
      return;
    }

    if (item.type === 'dir' || item.type === 'link') {
      const node = treeNodes.get(item.path);
      if (node) {
        setStatus('busy', `刷新 ${item.path}…`);
        await mergeNodeChildren(node);
        node.expanded = true;
        if (selectedPath && !treeNodes.has(selectedPath)) selectedPath = '';
        renderRows();
        setStatus('ok', `已刷新 ${item.path}`);
        return;
      }
    }

    const target = parentPath(item.path);
    if (target === currentPath) {
      await refreshRootPreserve();
      return;
    }
    const parentNode = treeNodes.get(target);
    if (parentNode) {
      setStatus('busy', `刷新 ${target}…`);
      await mergeNodeChildren(parentNode);
      parentNode.expanded = true;
      if (selectedPath && !treeNodes.has(selectedPath)) selectedPath = '';
      renderRows();
      setStatus('ok', `已刷新 ${target}`);
      return;
    }
    await refreshRootPreserve();
  }

  async function checkCurrentPlatform() {
    setStatus('busy', `检查 ${curMeta().binaryDisplay}…`);
    const chk = await api.check(currentPlatform);
    if (!chk.ok) {
      setStatus('error', chk.error || `未找到 ${curMeta().binaryDisplay}`);
      showToast(`未找到 ${curMeta().binaryDisplay}，请在诊断面板里指定路径`, 'error', 5000);
      await showDiag();
      return false;
    }
    setStatus('ok', chk.version || `${curMeta().binaryDisplay} 已就绪`);
    return true;
  }

  async function switchPlatform(nextId) {
    currentPlatform = nextId;
    savePlatform(currentPlatform);
    currentSerial = '';
    currentPath = defaultPathForCurrentPlatform();
    currentBundle = '';
    selectedPath = '';
    entries = [];
    setRootEntries([]);
    els.pathInput.value = currentPath;
    els.bundleInput.value = '';
    els.bundleList.innerHTML = '';
    els.deviceSelect.innerHTML = '';
    updateSandboxUi();
    restoreHarmonyBundle();
    renderRows();
    if (await checkCurrentPlatform()) await refreshDevices();
  }

  async function pickInitialPlatform() {
    const saved = getSavedPlatform();
    const ids = platforms.map((p) => p.id);
    const ordered = [
      ...(saved && ids.includes(saved) ? [saved] : []),
      ...ids.filter((id) => id !== saved),
    ];
    if (!ordered.length) return 'android';

    let firstUsable = '';
    for (const id of ordered) {
      try {
        const chk = await api.check(id);
        if (!chk || !chk.ok) continue;
        if (!firstUsable) firstUsable = id;
        const res = await api.devices(id);
        if (res && res.ok && res.devices && res.devices.length > 0) {
          return id;
        }
      } catch (_) {
        // Probe silently; the normal init path will show diagnostics if needed.
      }
    }
    return (saved && ids.includes(saved)) ? saved : (firstUsable || ordered[0]);
  }

  async function pullSelected() {
    const item = selectedItem();
    if (!item) return;
    hideContextMenu();
    showToast(`准备拉取 ${item.name}…`);
    const res = await api.pull(currentPlatform, currentSerial, item, fileOptions());
    if (!res.ok) {
      if (!res.canceled) showToast('拉取失败：' + (res.error || ''), 'error', 4200);
      return;
    }
    showToast(`已拉取到 ${res.localPath}`, 'success', 4200);
  }

  async function uploadFiles(localPaths, { confirm = false } = {}) {
    if (!currentSerial) {
      showToast('请先选择设备', 'error');
      return;
    }
    if (isSandboxMode()) {
      currentBundle = els.bundleInput.value.trim();
      if (!currentBundle) {
        showToast('请先选择或输入 Bundle Name', 'error');
        return;
      }
      saveHarmonyBundle(currentBundle);
    }
    const target = uploadTargetPath();
    const files = Array.isArray(localPaths) ? localPaths.filter(Boolean) : [];
    if (confirm) {
      const countText = files.length ? `${files.length} 个文件` : '选择的文件';
      const ok = window.confirm(`确定上传 ${countText} 到 ${target} 吗？`);
      if (!ok) return;
    }
    hideContextMenu();
    showToast(files.length ? `正在上传 ${files.length} 个文件…` : '请选择要上传的文件…');
    const res = await api.upload(currentPlatform, currentSerial, target, files, fileOptions());
    if (!res.ok) {
      if (!res.canceled) showToast('上传失败：' + (res.error || ''), 'error', 4200);
      return;
    }
    const count = res.results ? res.results.length : (files.length || 1);
    showToast(`已上传 ${count} 个文件到 ${target}`, 'success', 3500);
    await loadPath(currentPath);
  }

  async function openSelected() {
    const item = selectedItem();
    if (!item) return;
    hideContextMenu();
    showToast(`正在打开 ${item.name}…`);
    const res = await api.open(currentPlatform, currentSerial, item, fileOptions());
    if (!res.ok) {
      showToast('打开失败：' + (res.error || ''), 'error', 4200);
      return;
    }
    showToast(`已打开 ${res.localPath}`, 'success', 3000);
  }

  function renderProperties(item, res) {
    const row = (k, v) =>
      `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v || '(空)')}</div>`;
    const basics = [
      row('名称', item.name),
      row('路径', item.path),
      row('类型', typeLabel(item.type)),
      row('大小', formatSize(item.size, item.type) || String(item.size || 0)),
      row('修改时间', item.modified || ''),
      row('权限', item.mode || ''),
      row('Owner', [item.owner, item.group].filter(Boolean).join(':')),
      row('链接目标', item.linkTarget || ''),
    ].join('');
    const sections = (res.sections || []).map((sec) => {
      const body = [
        sec.error ? `ERROR: ${sec.error}` : '',
        sec.stdout || '',
        sec.stderr ? `STDERR:\n${sec.stderr}` : '',
      ].filter(Boolean).join('\n').trim() || '(无输出)';
      return `
        <div class="prop-section">
          <div class="prop-section-title">
            <span>${escapeHtml(sec.title)}</span>
            <span class="${sec.ok ? '' : 'fail'}">${sec.ok ? 'OK' : '失败'}</span>
          </div>
          <pre>${escapeHtml(body)}</pre>
        </div>
      `;
    }).join('');
    els.propertiesSubtitle.textContent = item.path;
    els.propertiesBody.innerHTML =
      `<div class="prop-grid">${basics}</div>` +
      (res.bundleName ? `<div class="prop-grid">${row('Bundle', res.bundleName)}</div>` : '') +
      sections;
    els.propertiesModal.classList.remove('hidden');
  }

  async function showSelectedProperties() {
    const item = selectedItem();
    if (!item) return;
    hideContextMenu();
    showToast(`正在获取 ${item.name} 的属性…`);
    const res = await api.properties(currentPlatform, currentSerial, item, fileOptions());
    if (!res.ok) {
      showToast('获取属性失败：' + (res.error || ''), 'error', 4200);
      return;
    }
    renderProperties(item, res);
  }

  async function deleteSelected() {
    const item = selectedItem();
    if (!item) return;
    hideContextMenu();
    const ok = window.confirm(`确定删除 ${item.name} 吗？\n\n${item.path}\n\n此操作不可撤销。`);
    if (!ok) return;
    showToast(`正在删除 ${item.name}…`);
    const res = await api.delete(currentPlatform, currentSerial, item, fileOptions());
    if (!res.ok) {
      showToast('删除失败：' + (res.error || ''), 'error', 4200);
      return;
    }
    selectedPath = '';
    showToast(`已删除 ${item.name}`, 'success', 3000);
    await loadPath(currentPath);
  }

  function closeProperties() {
    els.propertiesModal.classList.add('hidden');
  }

  function hideContextMenu() {
    els.contextMenu.classList.add('hidden');
  }

  function showContextMenu(x, y) {
    els.contextMenu.classList.remove('hidden');
    const hasSelection = !!selectedItem();
    els.contextMenu.querySelectorAll('[data-requires-selection]').forEach((btn) => {
      btn.disabled = !hasSelection;
    });
    const rect = els.contextMenu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    els.contextMenu.style.left = Math.max(8, left) + 'px';
    els.contextMenu.style.top = Math.max(8, top) + 'px';
  }

  async function loadBundles(showDone = true) {
    if (!currentSerial) {
      showToast('请先选择设备', 'error');
      return;
    }
    setStatus('busy', '加载 Bundle 列表…');
    const res = await api.packages(currentPlatform, currentSerial);
    if (!res.ok) {
      setStatus('error', res.error || '加载 Bundle 失败');
      showToast('加载 Bundle 失败：' + (res.error || ''), 'error');
      return;
    }
    const packages = res.packages || [];
    els.bundleList.innerHTML = packages
      .map((p) => `<option value="${escapeHtml(p)}"></option>`)
      .join('');
    if (!currentBundle) {
      restoreHarmonyBundle();
    }
    if (!currentBundle && packages.length === 1) {
      currentBundle = packages[0];
      els.bundleInput.value = currentBundle;
      saveHarmonyBundle(currentBundle);
    }
    setStatus('ok', `已加载 ${packages.length} 个 Bundle`);
    if (showDone) showToast(`已加载 ${packages.length} 个 Bundle`, 'success');
  }

  function updateSandboxUi() {
    const sandbox = isSandboxMode();
    els.sandboxRow.classList.toggle('hidden', !sandbox);
    els.btnRoot.textContent = sandbox ? '沙箱根目录' : '默认目录';
    els.pathInput.placeholder = sandbox ? 'data/storage/el2/base' : '/';
  }

  async function showDiag(prefilledRaw) {
    const meta = curMeta();
    els.diagPanel.classList.remove('hidden');
    els.diagPanel.innerHTML = `<h3>${escapeHtml(meta.label)} 诊断</h3><div class="muted">正在收集环境信息…</div>`;
    const d = await api.diag(currentPlatform);
    const pre = (txt) => `<pre>${escapeHtml(txt || '(空)')}</pre>`;
    const value = (txt) => `<div class="value">${escapeHtml(txt || '(空)')}</div>`;
    const card = (title, body) => `<div class="diag-card"><div class="title">${escapeHtml(title)}</div>${body}</div>`;
    const rawDevices = (d.devicesRaw || prefilledRaw || '').trim();
    const binDisplay = d.binaryDisplay || meta.binaryDisplay;
    const binName = d.binaryName || binDisplay;

    els.diagPanel.innerHTML =
      `<h3>${escapeHtml(meta.label)} 诊断</h3>` +
      card(`${escapeHtml(binDisplay)} 路径`,
        `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">` +
        `<button class="btn primary" id="diagPickBin">选择 ${escapeHtml(binDisplay)}…</button>` +
        (d.customPath ? '<button class="btn" id="diagClearBin">清除自定义</button>' : '') +
        '</div>' +
        value(`当前生效: ${d.activePath || '(未找到)'}\n来源: ${d.activeSource}\n自定义: ${d.customPath || '(未设置)'}\nwhere ${binName}: ${d.pathFromWhere || '(无)'}`)) +
      card(`${escapeHtml(binName)} 版本`, pre(d.version || d.versionErr || '(未取到)')) +
      card('设备列表原始输出', pre(rawDevices || d.devicesErr || '(空)')) +
      card('提示', value(d.hint || '如果命令行可用但这里不可用，请直接选择 adb.exe / hdc.exe 的完整路径。'));

    const pickBtn = document.getElementById('diagPickBin');
    if (pickBtn) {
      pickBtn.addEventListener('click', async () => {
        const res = await api.pickBinaryPath(currentPlatform);
        if (res && res.ok) {
          showToast('已设置路径，正在重新检测…', 'success');
          if (await checkCurrentPlatform()) await refreshDevices();
          await showDiag();
        } else if (res && !res.canceled && res.error) {
          showToast('设置失败：' + res.error, 'error');
        }
      });
    }
    const clearBtn = document.getElementById('diagClearBin');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        await api.setBinaryPath(currentPlatform, '');
        showToast('已清除自定义路径', 'success');
        if (await checkCurrentPlatform()) await refreshDevices();
        await showDiag();
      });
    }
  }

  function bindEvents() {
    els.platformSelect.addEventListener('change', () => switchPlatform(els.platformSelect.value));
    els.deviceSelect.addEventListener('change', () => {
      currentSerial = els.deviceSelect.value;
      loadPath(currentPath);
    });
    els.btnRefreshDevices.addEventListener('click', refreshDevices);
    els.btnLoadBundles.addEventListener('click', () => loadBundles(true));
    els.bundleInput.addEventListener('change', () => {
      currentBundle = els.bundleInput.value.trim();
      saveHarmonyBundle(currentBundle);
      if (currentBundle) loadPath(defaultPathForCurrentPlatform());
    });
    els.bundleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        currentBundle = els.bundleInput.value.trim();
        saveHarmonyBundle(currentBundle);
        loadPath(defaultPathForCurrentPlatform());
      }
    });
    els.btnDiag.addEventListener('click', () => {
      els.diagPanel.classList.toggle('hidden');
      if (!els.diagPanel.classList.contains('hidden')) showDiag();
    });
    els.btnGo.addEventListener('click', () => loadPath(els.pathInput.value));
    els.btnRefresh.addEventListener('click', () => refreshSelectionInPlace());
    els.btnRoot.addEventListener('click', () => loadPath(defaultPathForCurrentPlatform()));
    els.btnUp.addEventListener('click', () => loadPath(parentPath(currentPath)));
    els.btnPull.addEventListener('click', pullSelected);
    els.pathInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadPath(els.pathInput.value);
    });

    els.crumbs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-path]');
      if (btn) loadPath(btn.getAttribute('data-path'));
    });

    els.fileRows.addEventListener('click', (e) => {
      const row = e.target.closest('tr[data-path]');
      if (!row) return;
      hideContextMenu();
      selectedPath = row.getAttribute('data-path');
      updateSelectionState();
      if (e.target.closest('[data-tree-toggle]')) {
        toggleTreeNode(selectedPath);
      }
    });

    els.fileRows.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('tr[data-path]');
      if (!row) return;
      e.preventDefault();
      selectedPath = row.getAttribute('data-path');
      updateSelectionState();
      showContextMenu(e.clientX, e.clientY);
    });

    els.fileTableWrap.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('tr[data-path]');
      if (row) return;
      e.preventDefault();
      selectedPath = '';
      updateSelectionState();
      showContextMenu(e.clientX, e.clientY);
    });

    els.fileRows.addEventListener('dblclick', (e) => {
      const row = e.target.closest('tr[data-path]');
      if (!row) return;
      const node = treeNodes.get(row.getAttribute('data-path'));
      const item = node && node.item;
      if (!item) return;
      if (item.type === 'dir' || item.type === 'link') toggleTreeNode(item.path);
      else {
        selectedPath = item.path;
        updateSelectionState();
        pullSelected();
      }
    });

    els.contextMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const action = btn.getAttribute('data-action');
      if (action === 'upload') uploadFiles();
      else if (action === 'pull') pullSelected();
      else if (action === 'open') openSelected();
      else if (action === 'properties') showSelectedProperties();
      else if (action === 'delete') deleteSelected();
    });

    els.fileTableWrap.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.fileTableWrap.classList.add('drop-active');
    });
    els.fileTableWrap.addEventListener('dragleave', (e) => {
      if (!els.fileTableWrap.contains(e.relatedTarget)) {
        els.fileTableWrap.classList.remove('drop-active');
      }
    });
    els.fileTableWrap.addEventListener('drop', (e) => {
      e.preventDefault();
      els.fileTableWrap.classList.remove('drop-active');
      const files = Array.from(e.dataTransfer.files || []);
      const paths = files.map((f) => {
        try {
          return (api.getPathForFile && api.getPathForFile(f)) || f.path || '';
        } catch (_) {
          return f.path || '';
        }
      }).filter(Boolean);
      if (!paths.length) {
        showToast('无法读取拖入文件的本地路径', 'error');
        return;
      }
      uploadFiles(paths, { confirm: true });
    });

    els.btnCloseProperties.addEventListener('click', closeProperties);
    els.propertiesModal.addEventListener('click', (e) => {
      if (e.target === els.propertiesModal) closeProperties();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('#contextMenu')) hideContextMenu();
    });
    window.addEventListener('blur', hideContextMenu);
    window.addEventListener('resize', hideContextMenu);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        hideContextMenu();
        closeProperties();
      }
    });
  }

  async function init() {
    bindEvents();
    try {
      platforms = await api.listPlatforms();
    } catch (_) {
      platforms = [
        { id: 'android', label: 'Android (adb)', binaryDisplay: 'adb.exe' },
        { id: 'harmony', label: 'HarmonyOS (hdc)', binaryDisplay: 'hdc.exe' },
      ];
    }
    els.platformSelect.innerHTML = platforms
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
      .join('');
    currentPlatform = await pickInitialPlatform();
    els.platformSelect.value = currentPlatform;
    savePlatform(currentPlatform);
    currentPath = defaultPathForCurrentPlatform();
    els.pathInput.value = currentPath;
    updateSandboxUi();
    restoreHarmonyBundle();
    renderRows();
    if (await checkCurrentPlatform()) await refreshDevices();
  }

  init();
})();
