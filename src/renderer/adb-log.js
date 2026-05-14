/* global window, document */
(() => {
  const api = window.quickTool && window.quickTool.log;
  if (!api) {
    document.body.innerHTML =
      '<div style="padding:20px;color:#f88">preload 未加载，无法连接主进程。</div>';
    return;
  }

  // ===== DOM =====
  const $ = (id) => document.getElementById(id);
  const els = {
    platformSelect: $('platformSelect'),
    deviceSelect: $('deviceSelect'),
    btnRefreshDevices: $('btnRefreshDevices'),
    btnDiag: $('btnDiag'),
    adbStatus: $('adbStatus'),

    packageInput: $('packageInput'),
    packageList: $('packageList'),
    btnLoadPackages: $('btnLoadPackages'),
    btnLockPid: $('btnLockPid'),
    pidLabel: $('pidLabel'),

    tagFilter: $('tagFilter'),
    levelFilter: $('levelFilter'),
    pidFilter: $('pidFilter'),
    kwChips: $('kwChips'),
    kwInput: $('kwInput'),
    regexToggle: $('regexToggle'),
    highlightToggle: $('highlightToggle'),
    autoScrollToggle: $('autoScrollToggle'),

    btnStart: $('btnStart'),
    btnStop: $('btnStop'),
    btnPause: $('btnPause'),
    btnClearView: $('btnClearView'),
    btnClearDevice: $('btnClearDevice'),
    btnSave: $('btnSave'),
    btnImport: $('btnImport'),
    btnSummary: $('btnSummary'),

    lineCount: $('lineCount'),
    summaryPanel: $('summaryPanel'),
    logArea: $('logArea'),
    toast: $('toast'),

    searchBar: $('searchBar'),
    sbInput: $('sbInput'),
    sbCase: $('sbCase'),
    sbWord: $('sbWord'),
    sbRegex: $('sbRegex'),
    sbCount: $('sbCount'),
    sbPrev: $('sbPrev'),
    sbNext: $('sbNext'),
    sbClose: $('sbClose'),
  };

  // ===== 状态 =====
  const MAX_BUFFER = 50000;     // 内存最多保留的解析行
  const MAX_DOM = 5000;         // DOM 最多渲染的可见行
  const LEVEL_RANK = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5, A: 5, S: -1 };

  /** @type {Array<LogLine>} 全部解析后的日志行 */
  const buffer = [];
  let visibleCount = 0;          // 当前 DOM 中渲染的行数
  let renderedFromIdx = 0;       // 流式追加时，buffer 中已被处理过的下标

  let isRunning = false;
  let isPaused = false;
  let pendingDuringPause = [];   // 暂停期间累积的原始字符串行
  let currentSerial = '';
  let currentPid = '';           // 锁定 PID（来自包名解析）

  // 平台元信息（adb / hdc 共用 UI，仅命令层不同）
  /** @type {Array<{id:string,label:string,binaryDisplay:string,defaultLogFilePrefix:string}>} */
  let platforms = [];
  let currentPlatform = 'android';
  function curMeta() {
    return platforms.find((p) => p.id === currentPlatform)
      || { id: currentPlatform, label: currentPlatform, binaryDisplay: currentPlatform, defaultLogFilePrefix: 'log' };
  }

  // 关键字胶囊：每项是字符串，! 前缀表示排除
  const keywords = [];

  let toastTimer = null;

  // ===== 搜索状态（VSCode 风格的浮窗搜索） =====
  const searchState = {
    open: false,
    query: '',
    caseSensitive: false,
    wholeWord: false,
    regex: false,
    matches: [],          // <mark.sm> 节点数组
    current: -1,          // matches 中的当前下标
  };

  // ===== 工具 =====
  function showToast(message, kind = 'info', duration = 2200) {
    els.toast.textContent = message;
    els.toast.className = 'toast show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), duration);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function setStatus(state, text) {
    els.adbStatus.className = 'adb-status ' + state;
    els.adbStatus.innerHTML = `<span class="dot"></span><span>${escapeHtml(text)}</span>`;
  }

  function setRunButtons() {
    els.btnStart.disabled = isRunning;
    els.btnStop.disabled = !isRunning;
    els.btnPause.disabled = !isRunning;
    els.btnPause.textContent = isPaused ? '▶ 继续' : '⏸ 暂停';
  }

  function updateLineCount() {
    const total = buffer.length;
    const filtered = visibleCount;
    els.lineCount.textContent = total === filtered
      ? `${total.toLocaleString()} 行`
      : `${filtered.toLocaleString()} / ${total.toLocaleString()} 行`;
  }

  // ===== 日志解析 =====
  // threadtime: MM-DD HH:MM:SS.mmm  PID  TID L Tag: msg
  // 兼容情况：
  //   1) 标准  "... W HttpTask: hello"
  //   2) 空消息 "... W HttpTask:"
  //   3) 缺冒号 "... W HttpTask"          （罕见，但出现过）
  //   4) tag 中含空格或对齐空格 "Foo Bar  : msg"
  const RE_THREADTIME = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFAS])\s+(\S(?:.*?\S)?)\s*(?::\s?(.*))?$/;

  /**
   * @typedef {Object} LogLine
   * @property {string} raw
   * @property {'log'|'system'|'unparsed'|'stderr'} kind
   * @property {string} time
   * @property {string} pid
   * @property {string} tid
   * @property {string} level   // V/D/I/W/E/F/S
   * @property {string} tag
   * @property {string} msg
   */

  function parseLine(raw) {
    if (!raw) return null;
    if (raw.startsWith('---------')) {
      return { raw, kind: 'system', time: '', pid: '', tid: '', level: 'S', tag: '', msg: raw };
    }
    const m = raw.match(RE_THREADTIME);
    if (!m) {
      return { raw, kind: 'unparsed', time: '', pid: '', tid: '', level: 'S', tag: '', msg: raw };
    }
    return {
      raw,
      kind: 'log',
      time: m[1],
      pid: m[2],
      tid: m[3],
      level: m[4],
      tag: (m[5] || '').trim(),
      msg: m[6] == null ? '' : m[6],
    };
  }

  // ===== 过滤 =====
  let filterCache = null;
  function buildFilter() {
    const minLvl = LEVEL_RANK[els.levelFilter.value] ?? 0;

    const tagsRaw = els.tagFilter.value.trim();
    const tags = tagsRaw
      ? tagsRaw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean)
      : [];

    const pidStr = els.pidFilter.value.trim();
    // PID 框留空时，若已锁定包名 PID 则使用之
    const pid = pidStr || currentPid || '';

    const useRegex = els.regexToggle.checked;

    const kwIncludes = [];
    const kwExcludes = [];
    const regexIncludes = [];
    const regexExcludes = [];
    const invalidChips = new Set();

    for (const k of keywords) {
      const isExclude = k.startsWith('!') && k.length > 1;
      const body = isExclude ? k.slice(1) : k;
      if (!body) continue;
      if (useRegex) {
        try {
          const re = new RegExp(body, 'i');
          if (isExclude) regexExcludes.push(re);
          else regexIncludes.push(re);
        } catch (_) {
          invalidChips.add(k);
        }
      } else {
        if (isExclude) kwExcludes.push(body.toLowerCase());
        else kwIncludes.push(body.toLowerCase());
      }
    }

    // 把无效正则的 chip 在 UI 上标红
    if (els.kwChips) {
      els.kwChips.querySelectorAll('.chip').forEach((c) => {
        const v = c.getAttribute('data-kw') || '';
        c.classList.toggle('invalid', invalidChips.has(v));
      });
    }

    return { minLvl, tags, pid, useRegex, kwIncludes, kwExcludes, regexIncludes, regexExcludes };
  }

  function lineMatches(line, f) {
    // adb 自身的 stderr 永远可见（"device offline" 之类的关键提示，不要被静默掉）
    if (line.kind === 'stderr') return true;

    // tag / pid / level 仅对解析成功的标准 log 行生效
    if (line.kind === 'log') {
      const rank = LEVEL_RANK[line.level] ?? 0;
      if (rank < f.minLvl) return false;

      if (f.tags.length) {
        const tagLower = line.tag.toLowerCase();
        const hit = f.tags.some((t) => tagLower.includes(t.toLowerCase()));
        if (!hit) return false;
      }

      if (f.pid && line.pid !== f.pid) return false;
    }

    // 关键字 / 正则：作用于所有行（用 raw 文本匹配），避免「未解析」行漏过过滤
    const hasKeyword = f.useRegex
      ? (f.regexIncludes.length > 0 || f.regexExcludes.length > 0)
      : (f.kwIncludes.length > 0 || f.kwExcludes.length > 0);

    if (hasKeyword) {
      const target = line.kind === 'log' ? (line.tag + ' ' + line.msg) : line.raw;
      if (f.useRegex) {
        if (f.regexIncludes.length && !f.regexIncludes.every((re) => re.test(target))) return false;
        if (f.regexExcludes.length && f.regexExcludes.some((re) => re.test(target))) return false;
      } else {
        const lower = target.toLowerCase();
        if (f.kwIncludes.length && !f.kwIncludes.every((k) => lower.includes(k))) return false;
        if (f.kwExcludes.length && f.kwExcludes.some((k) => lower.includes(k))) return false;
      }
    }

    return true;
  }

  // ===== 智能高亮 =====
  function detectHighlight(line) {
    if (line.kind !== 'log') return '';
    const tag = line.tag;
    const msg = line.msg;
    if (line.level === 'F') return 'hl-crash';
    if (tag === 'AndroidRuntime' && /FATAL EXCEPTION|fatal/i.test(msg)) return 'hl-crash';
    if (/^ANR in /.test(msg) || (tag === 'ActivityManager' && /ANR/i.test(msg))) return 'hl-anr';
    if (/^\s*at [\w$.]+\(/.test(msg) || /^\s*Caused by: /.test(msg)) return 'hl-stack';
    return '';
  }

  // ===== 渲染 =====
  function renderLineHtml(line, f) {
    const hl = els.highlightToggle.checked ? detectHighlight(line) : '';
    let cls = 'log-line';
    if (line.kind === 'system') cls += ' system';
    else if (line.kind === 'unparsed') cls += ' unparsed';
    else if (line.kind === 'stderr') cls += ' stderr';
    else cls += ' lvl-' + line.level;
    if (hl) cls += ' ' + hl;

    if (line.kind !== 'log') {
      return `<div class="${cls}">${escapeHtml(line.raw)}</div>`;
    }

    let msgHtml = escapeHtml(line.msg);
    // 关键字高亮（仅非正则、且开启 highlight 时）
    if (f && !f.useRegex && f.kwIncludes.length && els.highlightToggle.checked) {
      for (const k of f.kwIncludes) {
        if (!k) continue;
        const re = new RegExp('(' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        msgHtml = msgHtml.replace(re, '<mark>$1</mark>');
      }
      if (f.kwIncludes.length) cls += ' hl-keyword';
    }

    return (
      `<div class="${cls}">` +
      `<span class="log-time">${escapeHtml(line.time)}</span> ` +
      `<span class="log-pid">${escapeHtml(line.pid.padStart(5))} ${escapeHtml(line.tid.padStart(5))}</span>` +
      `<span class="lvl ${line.level}">${line.level}</span> ` +
      `<span class="log-tag">${escapeHtml(line.tag)}</span>: ` +
      `<span class="log-msg">${msgHtml}</span>` +
      `</div>`
    );
  }

  function isAtBottom() {
    const a = els.logArea;
    return a.scrollHeight - a.scrollTop - a.clientHeight < 30;
  }

  function scrollToBottom() {
    els.logArea.scrollTop = els.logArea.scrollHeight;
  }

  function trimDom() {
    let trimmedAny = false;
    while (visibleCount > MAX_DOM) {
      const first = els.logArea.firstElementChild;
      if (!first) break;
      els.logArea.removeChild(first);
      visibleCount--;
      trimmedAny = true;
    }
    if (trimmedAny && searchState.matches.length) {
      // 被裁掉的行里如果有 <mark.sm>，需要从匹配列表里清理
      const stillIn = searchState.matches.filter((m) => els.logArea.contains(m));
      if (stillIn.length !== searchState.matches.length) {
        const removedBefore = searchState.matches
          .slice(0, Math.max(searchState.current, 0))
          .filter((m) => !els.logArea.contains(m)).length;
        searchState.matches = stillIn;
        if (searchState.current >= 0) {
          searchState.current = Math.max(-1, searchState.current - removedBefore);
          if (searchState.current >= searchState.matches.length) {
            searchState.current = searchState.matches.length - 1;
          }
        }
        updateSearchCount();
      }
    }
  }

  /** 增量追加 buffer 中尚未渲染的行 */
  function appendNew() {
    if (renderedFromIdx >= buffer.length) return;
    const f = filterCache || (filterCache = buildFilter());
    const wasAtBottom = isAtBottom();
    const chunks = [];
    let added = 0;
    for (let i = renderedFromIdx; i < buffer.length; i++) {
      const line = buffer[i];
      if (!lineMatches(line, f)) continue;
      chunks.push(renderLineHtml(line, f));
      added++;
    }
    renderedFromIdx = buffer.length;
    if (added) {
      els.logArea.insertAdjacentHTML('beforeend', chunks.join(''));
      visibleCount += added;
      trimDom();
      if (searchState.open && searchState.query) {
        applySearchOnLastN(added);
      }
      if (els.autoScrollToggle.checked && wasAtBottom) scrollToBottom();
    }
    updateLineCount();
  }

  /** 全量重渲染（过滤变化、清屏、导入） */
  function rerenderAll() {
    filterCache = buildFilter();
    els.logArea.innerHTML = '';
    visibleCount = 0;
    const f = filterCache;
    // 只渲染最近的命中行，避免一次构建过多 DOM
    const chunks = [];
    let count = 0;
    for (let i = buffer.length - 1; i >= 0; i--) {
      const line = buffer[i];
      if (!lineMatches(line, f)) continue;
      chunks.push(renderLineHtml(line, f));
      count++;
      if (count >= MAX_DOM) break;
    }
    chunks.reverse();
    if (chunks.length) {
      els.logArea.insertAdjacentHTML('beforeend', chunks.join(''));
      visibleCount = chunks.length;
    }
    renderedFromIdx = buffer.length;
    if (els.autoScrollToggle.checked) scrollToBottom();
    if (searchState.open && searchState.query) {
      applySearch({ keepCurrent: true });
    }
    updateLineCount();
  }

  // ===== 搜索（VSCode 风格） =====
  function buildSearchRegex() {
    const q = searchState.query;
    if (!q) return null;
    const flags = 'g' + (searchState.caseSensitive ? '' : 'i');
    if (searchState.regex) {
      try { return new RegExp(q, flags); } catch (_) { return null; }
    }
    let pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (searchState.wholeWord) pattern = '\\b' + pattern + '\\b';
    try { return new RegExp(pattern, flags); } catch (_) { return null; }
  }

  function clearSearchHighlights() {
    const marks = els.logArea.querySelectorAll('mark.sm');
    for (const m of marks) {
      const parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent), m);
    }
    // 合并相邻文本节点，便于下次搜索整段匹配
    const lines = els.logArea.querySelectorAll('.log-line');
    for (const l of lines) l.normalize();
    searchState.matches = [];
    searchState.current = -1;
  }

  function highlightInElement(root, re) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (p && p.tagName === 'MARK' && p.classList.contains('sm')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const textNodes = [];
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);

    for (const tn of textNodes) {
      const text = tn.nodeValue;
      re.lastIndex = 0;
      const ranges = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        ranges.push([m.index, m.index + m[0].length]);
        if (m[0].length === 0) re.lastIndex++;
      }
      if (ranges.length === 0) continue;

      const parent = tn.parentNode;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const [s, e] of ranges) {
        if (s > last) frag.appendChild(document.createTextNode(text.slice(last, s)));
        const mark = document.createElement('mark');
        mark.className = 'sm';
        mark.textContent = text.slice(s, e);
        frag.appendChild(mark);
        searchState.matches.push(mark);
        last = e;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      parent.replaceChild(frag, tn);
    }
  }

  function applySearch({ keepCurrent } = {}) {
    const prevCurrent = keepCurrent && searchState.current >= 0
      ? searchState.matches[searchState.current]
      : null;

    clearSearchHighlights();

    if (!searchState.query) {
      els.searchBar.classList.remove('invalid');
      updateSearchCount();
      return;
    }

    const re = buildSearchRegex();
    if (!re) {
      els.searchBar.classList.add('invalid');
      updateSearchCount('正则错误');
      return;
    }
    els.searchBar.classList.remove('invalid');

    const lines = els.logArea.querySelectorAll('.log-line');
    for (const line of lines) highlightInElement(line, re);

    if (searchState.matches.length === 0) {
      updateSearchCount();
      return;
    }

    // 尽量保留之前选中的位置（按文本接近度回退到第一个）
    let nextIdx = 0;
    if (prevCurrent) {
      const text = prevCurrent.textContent;
      const found = searchState.matches.findIndex((m) => m.textContent === text);
      if (found >= 0) nextIdx = found;
    }
    setCurrentMatch(nextIdx, { scroll: !keepCurrent });
  }

  // 流式追加新行后，仅对最后 count 行做高亮，保留 current
  function applySearchOnLastN(count) {
    const re = buildSearchRegex();
    if (!re) return;
    const lines = els.logArea.querySelectorAll('.log-line');
    for (let i = Math.max(0, lines.length - count); i < lines.length; i++) {
      highlightInElement(lines[i], re);
    }
    updateSearchCount();
  }

  function setCurrentMatch(idx, { scroll = true } = {}) {
    if (searchState.current >= 0 && searchState.matches[searchState.current]) {
      searchState.matches[searchState.current].classList.remove('current');
    }
    if (idx < 0 || idx >= searchState.matches.length) {
      searchState.current = -1;
      updateSearchCount();
      return;
    }
    searchState.current = idx;
    const cur = searchState.matches[idx];
    cur.classList.add('current');
    if (scroll) cur.scrollIntoView({ block: 'center', inline: 'nearest' });
    updateSearchCount();
  }

  function updateSearchCount(extra) {
    if (extra) {
      els.sbCount.textContent = extra;
      return;
    }
    const total = searchState.matches.length;
    if (!searchState.query) els.sbCount.textContent = '';
    else if (total === 0) els.sbCount.textContent = '无结果';
    else els.sbCount.textContent = `${searchState.current + 1} / ${total}`;
  }

  function nextMatch() {
    if (!searchState.matches.length) return;
    setCurrentMatch((searchState.current + 1) % searchState.matches.length);
  }

  function prevMatch() {
    if (!searchState.matches.length) return;
    const n = searchState.matches.length;
    setCurrentMatch((searchState.current - 1 + n) % n);
  }

  function openSearch() {
    searchState.open = true;
    els.searchBar.classList.remove('hidden');
    // 选中 = 用户的"我想再搜下这个"行为
    const sel = String(window.getSelection ? window.getSelection().toString() : '').trim();
    if (sel && sel.length < 200) {
      els.sbInput.value = sel;
      searchState.query = sel;
    }
    els.sbInput.focus();
    els.sbInput.select();
    if (searchState.query) applySearch();
  }

  function closeSearch() {
    searchState.open = false;
    els.searchBar.classList.add('hidden');
    clearSearchHighlights();
    updateSearchCount();
    els.logArea.focus({ preventScroll: true });
  }

  function toggleSearchMode(which) {
    searchState[which] = !searchState[which];
    const map = { caseSensitive: els.sbCase, wholeWord: els.sbWord, regex: els.sbRegex };
    map[which].classList.toggle('active', searchState[which]);
    if (searchState.open) applySearch();
  }

  // ===== 数据接收 =====
  function pushRawLines(rawLines) {
    if (isPaused) {
      pendingDuringPause.push(...rawLines);
      // 暂停时也避免无限增长
      if (pendingDuringPause.length > MAX_BUFFER) {
        pendingDuringPause.splice(0, pendingDuringPause.length - MAX_BUFFER);
      }
      return;
    }
    for (const raw of rawLines) {
      const line = parseLine(raw);
      if (line) buffer.push(line);
    }
    if (buffer.length > MAX_BUFFER) {
      const drop = buffer.length - MAX_BUFFER;
      buffer.splice(0, drop);
      renderedFromIdx = Math.max(0, renderedFromIdx - drop);
    }
    appendNew();
  }

  function pushStderr(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (const l of lines) {
      buffer.push({ raw: l, kind: 'stderr', time: '', pid: '', tid: '', level: 'S', tag: '', msg: l });
    }
    appendNew();
  }

  // ===== 设备 / 包名 =====
  async function refreshDevices() {
    setStatus('idle', '查询设备…');
    const res = await api.devices(currentPlatform);
    if (!res.ok) {
      setStatus('error', res.error || '查询失败');
      els.deviceSelect.innerHTML = '<option value="">(无可用设备)</option>';
      showToast('设备查询失败：' + (res.error || ''), 'error');
      showDiag(); // 自动弹出诊断面板
      return;
    }
    const devices = res.devices || [];
    if (!devices.length) {
      els.deviceSelect.innerHTML = '<option value="">(未检测到设备)</option>';
      setStatus('idle', '未检测到设备 · 点 ⓘ 看诊断');
      showToast('未检测到设备 - 已展开诊断面板', 'error', 3500);
      showDiag(res.raw || '');
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
    setStatus('idle', `已就绪 · ${devices.length} 个设备`);
  }

  // ===== 诊断面板（同时适用 adb 和 hdc） =====
  async function showDiag(prefilledRaw) {
    const meta = curMeta();
    els.summaryPanel.classList.remove('hidden');
    els.summaryPanel.innerHTML =
      `<h3>🔍 ${escapeHtml(meta.label)} 诊断</h3><div class="muted">正在收集环境信息…</div>`;
    const d = await api.diag(currentPlatform);

    const card = (title, body) =>
      `<div class="summary-card"><div class="title">${escapeHtml(title)}</div>${body}</div>`;
    const pre = (txt) =>
      `<pre style="white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--text-dim);margin:0;max-height:160px;overflow:auto;">${escapeHtml(txt || '(空)')}</pre>`;

    const binDisplay = d.binaryDisplay || meta.binaryDisplay;
    const binName = d.binaryName || meta.binaryDisplay;
    const devicesCmd = d.devicesCmd || `${binName} devices`;
    const tipsArr = [];
    const rawDevices = (d.devicesRaw || prefilledRaw || '').trim();
    const enoent = /ENOENT/i.test(d.versionErr || '') || /ENOENT/i.test(d.devicesErr || '');

    if (enoent && !d.customPath) {
      tipsArr.push(`<b>当前 Electron 进程的 PATH 里没有 ${escapeHtml(binName)}</b>（在 PowerShell 里能跑也没用）。<br>` +
        `最快解决：点上方 <b>「选择 ${escapeHtml(binDisplay)}…」</b> 直接指定路径，会被记住。<br>` +
        (d.hint ? escapeHtml(d.hint) : ''));
    } else if (!d.activePath && !d.pathFromWhere) {
      tipsArr.push(`在 PATH 里没有找到 <b>${escapeHtml(binName)}</b>。建议直接指定 ${escapeHtml(binDisplay)} 路径。`);
    }
    if (rawDevices && !/\bdevice\b|\boffline\b|\bunauthorized\b|\bconnect/i.test(rawDevices)) {
      tipsArr.push(`<b>${escapeHtml(devicesCmd)}</b> 列表里没有任何设备。可能原因：<br>` +
        `&nbsp;• 这个 ${escapeHtml(binName)}（上方"当前生效"）和你命令行里的不是同一个二进制；<br>` +
        '&nbsp;• 应用启动 <b>之后</b> 才连上设备/模拟器，点 ↻ 刷新一下；<br>' +
        (currentPlatform === 'android'
          ? '&nbsp;• 模拟器没有走标准 adb 协议（如 BlueStacks/雷电/MuMu），需要先 <code>adb connect 127.0.0.1:5555</code>（端口随模拟器而定）。'
          : '&nbsp;• 鸿蒙真机请确认已开启「USB 调试 / HDC 调试」，并在弹窗里允许调试授权。'));
    }
    if (d.customPath && d.customExists === false) {
      tipsArr.push('已配置的自定义路径不存在：<code>' + escapeHtml(d.customPath) + '</code>，请重新选择。');
    }

    const tipsHtml = tipsArr.length
      ? '<div class="summary-card" style="grid-column:1/-1;border-color:var(--warn)">' +
        '<div class="title" style="color:var(--warn)">可能的原因 / 解决方案</div>' +
        '<div style="font-size:12px;line-height:1.6;color:var(--text)">' +
        tipsArr.map((t) => '• ' + t).join('<br>') + '</div></div>'
      : '';

    const pathCard =
      '<div class="summary-card" style="grid-column:1/-1">' +
      `<div class="title">${escapeHtml(binDisplay)} 可执行文件路径</div>` +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
      `<button class="btn primary" id="diagPickBin">📁 选择 ${escapeHtml(binDisplay)}…</button>` +
      (d.customPath ? '<button class="btn" id="diagClearBin">清除自定义（回到 PATH）</button>' : '') +
      '<span class="muted">' +
      `当前生效：<b style="color:${d.activePath ? 'var(--accent)' : 'var(--danger)'}">${escapeHtml(d.activePath || '(未找到)')}</b>` +
      ` · 来源：${escapeHtml(d.activeSource)}` +
      '</span>' +
      '</div>' +
      '<div class="row-line"><span class="k">自定义路径（持久化）</span><span class="v">' + escapeHtml(d.customPath || '(未设置)') + '</span></div>' +
      `<div class="row-line"><span class="k">系统 where ${escapeHtml(binName)}</span><span class="v">` + escapeHtml(d.pathFromWhere || '(无)') + '</span></div>' +
      '</div>';

    const envEntries = Object.entries(d.extraEnv || {});
    const envCard = envEntries.length
      ? card('相关环境变量', envEntries.map(([k, v]) =>
          `<div class="row-line"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(v || '(未设置)')}</span></div>`
        ).join(''))
      : '';

    els.summaryPanel.innerHTML =
      `<h3>🔍 ${escapeHtml(meta.label)} 诊断（看不到设备时的排查信息）</h3>` +
      '<div class="summary-grid">' +
      pathCard +
      card(`${binName} 版本`, pre(d.version || d.versionErr || '(未取到)')) +
      card(`${devicesCmd} 原始输出`, pre(rawDevices || d.devicesErr || '(空)')) +
      envCard +
      card('当前 Electron 进程 PATH', pre(d.envPath)) +
      tipsHtml +
      '</div>';

    const pickBtn = document.getElementById('diagPickBin');
    if (pickBtn) {
      pickBtn.addEventListener('click', async () => {
        const res = await api.pickBinaryPath(currentPlatform);
        if (res && res.ok) {
          showToast('已设置路径，正在重新检测…', 'success');
          await afterBinaryPathChanged();
        } else if (res && !res.canceled && res.error) {
          showToast('设置失败：' + res.error, 'error');
        }
      });
    }
    const clearBtn = document.getElementById('diagClearBin');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        await api.setBinaryPath(currentPlatform, '');
        showToast(`已清除自定义 ${binName} 路径`, 'success');
        await afterBinaryPathChanged();
      });
    }
  }

  async function afterBinaryPathChanged() {
    const chk = await api.check(currentPlatform);
    if (!chk.ok) {
      setStatus('error', chk.error || `未找到 ${curMeta().binaryDisplay}`);
    } else {
      setStatus('idle', chk.version || `${curMeta().binaryDisplay} 已就绪`);
    }
    await refreshDevices();
    await showDiag();
  }

  async function loadPackages() {
    if (!currentSerial) {
      showToast('请先选择设备', 'error');
      return;
    }
    showToast('正在加载包列表…');
    const res = await api.packages(currentPlatform, currentSerial);
    if (!res.ok) {
      showToast('加载失败：' + (res.error || ''), 'error');
      return;
    }
    els.packageList.innerHTML = (res.packages || [])
      .map((p) => `<option value="${escapeHtml(p)}"></option>`)
      .join('');
    showToast(`已加载 ${res.packages.length} 个包`, 'success');
  }

  async function lockPid() {
    const pkg = els.packageInput.value.trim();
    if (!pkg) {
      currentPid = '';
      els.pidLabel.textContent = '';
      filterCache = null;
      rerenderAll();
      showToast('已清除 PID 锁定');
      return;
    }
    if (!currentSerial) {
      showToast('请先选择设备', 'error');
      return;
    }
    showToast('正在解析 PID…');
    const res = await api.pidOf(currentPlatform, currentSerial, pkg);
    if (!res.ok) {
      showToast('解析失败：' + (res.error || ''), 'error');
      return;
    }
    if (!res.pids || res.pids.length === 0) {
      currentPid = '';
      els.pidLabel.textContent = `(${pkg} 未运行)`;
      showToast(`${pkg} 当前未在设备上运行`, 'error');
      return;
    }
    currentPid = res.pids[0];
    els.pidLabel.textContent = `PID=${currentPid}` + (res.pids.length > 1 ? ` (+${res.pids.length - 1})` : '');
    filterCache = null;
    rerenderAll();
    showToast(`已锁定 PID ${currentPid}`, 'success');
  }

  // ===== 控制按钮 =====
  async function startLogcat() {
    if (isRunning) return;
    currentSerial = els.deviceSelect.value;
    if (!currentSerial) {
      showToast('请先选择设备', 'error');
      return;
    }
    setStatus('running', '启动中…');
    const res = await api.start(currentPlatform, currentSerial);
    if (!res.ok) {
      setStatus('error', res.error || '启动失败');
      showToast('启动失败：' + (res.error || ''), 'error');
      return;
    }
    isRunning = true;
    isPaused = false;
    setRunButtons();
    setStatus('running', `streaming · ${currentSerial}`);
    showToast(`${curMeta().label} 日志已启动`, 'success');
  }

  async function stopLogcat() {
    if (!isRunning) return;
    await api.stop(currentPlatform);
    isRunning = false;
    isPaused = false;
    setRunButtons();
    setStatus('idle', '已停止');
  }

  function pauseLogcat() {
    if (!isRunning) return;
    isPaused = !isPaused;
    setRunButtons();
    if (isPaused) {
      setStatus('paused', '已暂停（仍在后台缓冲）');
    } else {
      // 恢复时把暂停期间的行刷出
      const pending = pendingDuringPause;
      pendingDuringPause = [];
      for (const raw of pending) {
        const line = parseLine(raw);
        if (line) buffer.push(line);
      }
      if (buffer.length > MAX_BUFFER) {
        const drop = buffer.length - MAX_BUFFER;
        buffer.splice(0, drop);
        renderedFromIdx = Math.max(0, renderedFromIdx - drop);
      }
      appendNew();
      setStatus('running', `streaming · ${currentSerial}`);
    }
  }

  function clearView() {
    buffer.length = 0;
    renderedFromIdx = 0;
    visibleCount = 0;
    els.logArea.innerHTML = '';
    if (searchState.open) {
      searchState.matches = [];
      searchState.current = -1;
      updateSearchCount();
    }
    updateLineCount();
    showToast('已清空当前视图');
  }

  async function clearDevice() {
    if (!currentSerial) {
      showToast('请先选择设备', 'error');
      return;
    }
    const res = await api.clear(currentPlatform, currentSerial);
    if (res.ok) showToast('设备日志缓冲区已清空', 'success');
    else showToast('清空失败：' + (res.error || ''), 'error');
  }

  async function saveLogs() {
    if (buffer.length === 0) {
      showToast('当前没有日志可保存', 'error');
      return;
    }
    const f = filterCache || buildFilter();
    const filtered = buffer.filter((l) => lineMatches(l, f));
    const content = filtered.map((l) => l.raw).join('\n') + '\n';
    const ts = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const prefix = curMeta().defaultLogFilePrefix || 'log';
    const name = `${prefix}-${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}-${pad(ts.getHours())}${pad(ts.getMinutes())}${pad(ts.getSeconds())}.log`;
    const res = await api.save(currentPlatform, content, name);
    if (res.ok) showToast(`已保存到 ${res.path}`, 'success', 3500);
    else if (!res.canceled) showToast('保存失败：' + (res.error || ''), 'error');
  }

  async function importFile() {
    const res = await api.importFile();
    if (!res.ok) {
      if (!res.canceled) showToast('导入失败：' + (res.error || ''), 'error');
      return;
    }
    if (isRunning) await stopLogcat();
    buffer.length = 0;
    renderedFromIdx = 0;
    const lines = res.content.split(/\r?\n/);
    for (const raw of lines) {
      if (!raw) continue;
      const line = parseLine(raw);
      if (line) buffer.push(line);
    }
    if (buffer.length > MAX_BUFFER) {
      buffer.splice(0, buffer.length - MAX_BUFFER);
    }
    rerenderAll();
    setStatus('idle', `已导入 ${res.path.split(/[\\/]/).pop()} · ${buffer.length} 行`);
    showToast(`已导入 ${buffer.length} 行`, 'success');
  }

  // ===== 摘要 =====
  function buildSummary() {
    const total = buffer.length;
    const counts = { V: 0, D: 0, I: 0, W: 0, E: 0, F: 0, S: 0 };
    const tagCount = new Map();
    const pidCount = new Map();
    const crashes = [];
    const anrs = [];

    for (let i = 0; i < buffer.length; i++) {
      const l = buffer[i];
      if (l.kind !== 'log') continue;
      counts[l.level] = (counts[l.level] || 0) + 1;
      tagCount.set(l.tag, (tagCount.get(l.tag) || 0) + 1);
      if (l.pid) pidCount.set(l.pid, (pidCount.get(l.pid) || 0) + 1);

      if (l.level === 'F' || (l.tag === 'AndroidRuntime' && /FATAL EXCEPTION/.test(l.msg))) {
        crashes.push({ idx: i, time: l.time, tag: l.tag, msg: l.msg });
      }
      if (/^ANR in /.test(l.msg) || (l.tag === 'ActivityManager' && /\bANR\b/.test(l.msg))) {
        anrs.push({ idx: i, time: l.time, msg: l.msg });
      }
    }

    const topTags = [...tagCount.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 10);
    const topPids = [...pidCount.entries()]
      .sort((a, b) => b[1] - a[1]).slice(0, 8);

    return { total, counts, topTags, topPids, crashes, anrs };
  }

  function renderSummary() {
    const s = buildSummary();
    const card = (title, body) =>
      `<div class="summary-card"><div class="title">${escapeHtml(title)}</div>${body}</div>`;

    const overview = `
      <div class="big">${s.total.toLocaleString()}</div>
      <div class="row-line"><span class="k">FATAL</span><span class="v">${s.counts.F}</span></div>
      <div class="row-line err"><span class="k">ERROR</span><span class="v">${s.counts.E}</span></div>
      <div class="row-line warn"><span class="k">WARN</span><span class="v">${s.counts.W}</span></div>
      <div class="row-line"><span class="k">INFO</span><span class="v">${s.counts.I}</span></div>
      <div class="row-line"><span class="k">DEBUG</span><span class="v">${s.counts.D}</span></div>
      <div class="row-line"><span class="k">VERBOSE</span><span class="v">${s.counts.V}</span></div>
    `;

    const topTags = s.topTags.length
      ? s.topTags.map(([t, c]) => `<div class="row-line"><span class="k">${escapeHtml(t)}</span><span class="v">${c}</span></div>`).join('')
      : '<div class="row-line"><span class="v">(无)</span></div>';

    const topPids = s.topPids.length
      ? s.topPids.map(([p, c]) => `<div class="row-line"><span class="k">${escapeHtml(p)}</span><span class="v">${c}</span></div>`).join('')
      : '<div class="row-line"><span class="v">(无)</span></div>';

    const crashList = s.crashes.length
      ? s.crashes.slice(-5).map((c) =>
          `<div class="row-line err"><span class="k">${escapeHtml(c.time)} · ${escapeHtml(c.tag)}</span>` +
          `<button class="summary-jump" data-jump="${c.idx}">跳转</button></div>` +
          `<div class="row-line"><span class="v">${escapeHtml(c.msg.slice(0, 120))}</span></div>`
        ).join('')
      : '<div class="row-line"><span class="v">未检测到 Crash / FATAL</span></div>';

    const anrList = s.anrs.length
      ? s.anrs.slice(-5).map((a) =>
          `<div class="row-line warn"><span class="k">${escapeHtml(a.time)}</span>` +
          `<button class="summary-jump" data-jump="${a.idx}">跳转</button></div>` +
          `<div class="row-line"><span class="v">${escapeHtml(a.msg.slice(0, 120))}</span></div>`
        ).join('')
      : '<div class="row-line"><span class="v">未检测到 ANR</span></div>';

    els.summaryPanel.innerHTML =
      '<h3>📊 日志摘要（基于当前缓冲区，与过滤无关）</h3>' +
      '<div class="summary-grid">' +
      card('概览 · 各级别数量', overview) +
      card('Top Tags', topTags) +
      card('Top PID', topPids) +
      card('最近 Crash / FATAL', crashList) +
      card('最近 ANR', anrList) +
      '</div>';
  }

  function toggleSummary() {
    const hidden = els.summaryPanel.classList.toggle('hidden');
    if (!hidden) renderSummary();
  }

  function jumpToBufferIdx(idx) {
    // 简化：先重新渲染（最近 MAX_DOM 条），然后用 raw 文本去匹配滚动
    rerenderAll();
    const target = buffer[idx];
    if (!target) return;
    const lines = els.logArea.querySelectorAll('.log-line');
    for (const node of lines) {
      if (node.textContent.includes(target.raw.slice(0, 60))) {
        node.scrollIntoView({ block: 'center' });
        node.style.outline = '2px solid var(--accent)';
        setTimeout(() => { node.style.outline = ''; }, 2000);
        break;
      }
    }
  }

  // ===== 事件 =====
  function bindEvents() {
    els.platformSelect.addEventListener('change', () => {
      const next = els.platformSelect.value;
      if (next === currentPlatform) return;
      switchPlatform(next);
    });
    els.btnRefreshDevices.addEventListener('click', refreshDevices);
    els.btnDiag.addEventListener('click', () => showDiag());
    els.deviceSelect.addEventListener('change', () => {
      currentSerial = els.deviceSelect.value;
    });

    els.btnLoadPackages.addEventListener('click', loadPackages);
    els.btnLockPid.addEventListener('click', lockPid);
    els.packageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') lockPid();
    });

    const onFilterChange = () => {
      filterCache = null;
      rerenderAll();
    };
    els.tagFilter.addEventListener('input', debounce(onFilterChange, 200));
    els.levelFilter.addEventListener('change', onFilterChange);
    els.pidFilter.addEventListener('input', debounce(onFilterChange, 200));
    els.regexToggle.addEventListener('change', onFilterChange);
    els.highlightToggle.addEventListener('change', onFilterChange);

    // 关键字胶囊
    els.kwChips.addEventListener('click', (e) => {
      const x = e.target.closest('.chip-x');
      if (x) {
        const chip = x.closest('.chip');
        if (!chip) return;
        const idx = parseInt(chip.getAttribute('data-idx'), 10);
        if (!Number.isNaN(idx)) removeKeyword(idx);
        return;
      }
      // 点击容器空白区域聚焦输入
      if (e.target === els.kwChips) els.kwInput.focus();
    });

    els.kwInput.addEventListener('keydown', (e) => {
      // 回车 / 逗号 / Tab 提交当前输入为 chip
      if (e.key === 'Enter' || e.key === ',' || (e.key === 'Tab' && els.kwInput.value.trim())) {
        e.preventDefault();
        addKeyword(els.kwInput.value);
      } else if (e.key === 'Backspace' && els.kwInput.value === '' && keywords.length > 0) {
        e.preventDefault();
        removeKeyword(keywords.length - 1);
      } else if (e.key === 'Escape' && els.kwInput.value !== '') {
        e.preventDefault();
        els.kwInput.value = '';
      }
    });

    // 失焦时把未提交的文本也变成 chip，避免用户「以为已应用其实没」
    els.kwInput.addEventListener('blur', () => {
      if (els.kwInput.value.trim()) addKeyword(els.kwInput.value);
    });

    // 粘贴一段含逗号 / 空格的字符串，自动拆成多个 chip
    els.kwInput.addEventListener('paste', (e) => {
      const text = (e.clipboardData || window.clipboardData).getData('text');
      if (!text) return;
      if (!/[,\n]/.test(text)) return; // 普通粘贴交给浏览器
      e.preventDefault();
      const tokens = text.split(/[,\n]+/).map((t) => t.trim()).filter(Boolean);
      tokens.forEach((t) => addKeyword(t));
    });

    els.btnStart.addEventListener('click', startLogcat);
    els.btnStop.addEventListener('click', stopLogcat);
    els.btnPause.addEventListener('click', pauseLogcat);
    els.btnClearView.addEventListener('click', clearView);
    els.btnClearDevice.addEventListener('click', clearDevice);
    els.btnSave.addEventListener('click', saveLogs);
    els.btnImport.addEventListener('click', importFile);
    els.btnSummary.addEventListener('click', toggleSummary);

    els.summaryPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-jump]');
      if (btn) {
        const idx = parseInt(btn.getAttribute('data-jump'), 10);
        if (!Number.isNaN(idx)) jumpToBufferIdx(idx);
      }
    });

    // ===== 搜索浮窗 =====
    const debouncedApply = debounce(() => applySearch(), 120);
    els.sbInput.addEventListener('input', () => {
      searchState.query = els.sbInput.value;
      debouncedApply();
    });
    els.sbInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) prevMatch(); else nextMatch();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeSearch();
      } else if (e.altKey) {
        if (e.key.toLowerCase() === 'c') { e.preventDefault(); toggleSearchMode('caseSensitive'); }
        else if (e.key.toLowerCase() === 'w') { e.preventDefault(); toggleSearchMode('wholeWord'); }
        else if (e.key.toLowerCase() === 'r') { e.preventDefault(); toggleSearchMode('regex'); }
      }
    });
    els.sbCase.addEventListener('click', () => toggleSearchMode('caseSensitive'));
    els.sbWord.addEventListener('click', () => toggleSearchMode('wholeWord'));
    els.sbRegex.addEventListener('click', () => toggleSearchMode('regex'));
    els.sbPrev.addEventListener('click', prevMatch);
    els.sbNext.addEventListener('click', nextMatch);
    els.sbClose.addEventListener('click', closeSearch);

    window.addEventListener('keydown', (e) => {
      const isCtrl = e.ctrlKey || e.metaKey;
      if (isCtrl && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        openSearch();
        return;
      }
      if (e.key === 'F3') {
        if (!searchState.open) return;
        e.preventDefault();
        if (e.shiftKey) prevMatch(); else nextMatch();
        return;
      }
      if (e.key === 'Escape' && searchState.open) {
        // 在其它输入框里按 Esc 不应关闭搜索
        const t = e.target;
        const isOtherInput =
          t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && t !== els.sbInput;
        if (isOtherInput) return;
        e.preventDefault();
        closeSearch();
      }
    });

    api.onLines(({ platformId, lines }) => {
      // 切换平台后到来的旧批次直接丢弃
      if (platformId && platformId !== currentPlatform) return;
      pushRawLines(lines);
    });
    api.onStderr(({ platformId, text }) => {
      if (platformId && platformId !== currentPlatform) return;
      pushStderr(text);
    });
    api.onExit(({ platformId, code, error }) => {
      if (platformId && platformId !== currentPlatform) return;
      isRunning = false;
      isPaused = false;
      setRunButtons();
      if (error) {
        setStatus('error', `已退出：${error}`);
        showToast('日志流异常退出：' + error, 'error', 3500);
      } else {
        setStatus('idle', `已停止（退出码 ${code}）`);
      }
    });
  }

  // 切换平台时：停掉当前流、清空视图缓冲，按新平台重新初始化设备列表与状态
  async function switchPlatform(nextId) {
    if (isRunning) {
      try { await api.stop(currentPlatform); } catch (_) { /* ignore */ }
      isRunning = false;
      isPaused = false;
      setRunButtons();
    }
    currentPlatform = nextId;
    currentSerial = '';
    currentPid = '';
    els.pidLabel.textContent = '';
    els.packageInput.value = '';
    els.packageList.innerHTML = '';
    els.deviceSelect.innerHTML = '';
    buffer.length = 0;
    renderedFromIdx = 0;
    visibleCount = 0;
    els.logArea.innerHTML = '';
    // 旧平台残留的诊断 / 摘要面板属于上一个平台，先收起清空，避免出现
    // “选到鸿蒙却还显示 Android 诊断提示”这种串台情况。
    els.summaryPanel.classList.add('hidden');
    els.summaryPanel.innerHTML = '';
    if (searchState.open) {
      searchState.matches = [];
      searchState.current = -1;
      updateSearchCount();
    }
    updateLineCount();

    setStatus('idle', `检查 ${curMeta().binaryDisplay}…`);
    const chk = await api.check(currentPlatform);
    if (!chk.ok) {
      setStatus('error', chk.error || `未找到 ${curMeta().binaryDisplay}`);
      showToast(`${curMeta().label}：未找到 ${curMeta().binaryDisplay}`, 'error', 5000);
      // 自动展开诊断面板，方便用户立即指定路径
      await showDiag();
      return;
    }
    setStatus('idle', chk.version || `${curMeta().binaryDisplay} 已就绪`);
    await refreshDevices();
  }

  function debounce(fn, ms) {
    let t = null;
    return (...args) => {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  // ===== 关键字胶囊管理 =====
  function addKeyword(text) {
    const v = (text || '').trim();
    if (!v) return false;
    if (keywords.includes(v)) {
      // 闪一下已存在的同名 chip 提示用户
      const existing = els.kwChips.querySelector(`.chip[data-kw="${cssEscape(v)}"]`);
      if (existing) {
        existing.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }],
          { duration: 220 },
        );
      }
      return false;
    }
    keywords.push(v);
    renderChips();
    els.kwInput.value = '';
    filterCache = null;
    rerenderAll();
    return true;
  }

  function removeKeyword(idx) {
    if (idx < 0 || idx >= keywords.length) return;
    keywords.splice(idx, 1);
    renderChips();
    filterCache = null;
    rerenderAll();
  }

  function clearKeywords() {
    if (keywords.length === 0) return;
    keywords.length = 0;
    renderChips();
    filterCache = null;
    rerenderAll();
  }

  function cssEscape(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function renderChips() {
    // 清掉除 input 之外的所有 chip 节点
    const old = els.kwChips.querySelectorAll('.chip');
    old.forEach((n) => n.remove());

    const frag = document.createDocumentFragment();
    keywords.forEach((kw, idx) => {
      const isExclude = kw.startsWith('!') && kw.length > 1;
      const chip = document.createElement('span');
      chip.className = 'chip' + (isExclude ? ' exclude' : '');
      chip.setAttribute('data-idx', String(idx));
      chip.setAttribute('data-kw', kw);
      chip.title = isExclude ? `排除：${kw.slice(1)}` : `包含：${kw}`;

      const text = document.createElement('span');
      text.className = 'chip-text';
      text.textContent = kw;
      chip.appendChild(text);

      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'chip-x';
      x.textContent = '×';
      x.setAttribute('aria-label', '移除');
      x.title = '移除';
      chip.appendChild(x);

      frag.appendChild(chip);
    });
    els.kwChips.insertBefore(frag, els.kwInput);

    els.kwInput.placeholder = keywords.length
      ? ''
      : '回车添加；以 ! 开头表示排除';
  }

  // ===== 启动 =====
  async function init() {
    renderChips();
    bindEvents();
    setRunButtons();

    // 先拉平台列表填下拉，再按当前选中的平台执行后续检查
    try {
      platforms = await api.listPlatforms();
    } catch (_) {
      platforms = [
        { id: 'android', label: 'Android (adb)', binaryDisplay: 'adb', defaultLogFilePrefix: 'logcat' },
        { id: 'harmony', label: 'HarmonyOS (hdc)', binaryDisplay: 'hdc', defaultLogFilePrefix: 'hilog' },
      ];
    }
    els.platformSelect.innerHTML = platforms
      .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)
      .join('');
    if (!platforms.find((p) => p.id === currentPlatform)) {
      currentPlatform = platforms[0] ? platforms[0].id : 'android';
    }
    els.platformSelect.value = currentPlatform;

    setStatus('idle', `检查 ${curMeta().binaryDisplay}…`);
    const chk = await api.check(currentPlatform);
    if (!chk.ok) {
      setStatus('error', chk.error || `未找到 ${curMeta().binaryDisplay}`);
      showToast(`未找到 ${curMeta().binaryDisplay}，请确认已加入系统 PATH 或在诊断面板里手动指定`, 'error', 5000);
      return;
    }
    setStatus('idle', chk.version || `${curMeta().binaryDisplay} 已就绪`);
    await refreshDevices();
  }

  init();
})();
