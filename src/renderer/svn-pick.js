/* global window, document */
(() => {
  const api = window.quickTool && window.quickTool.svn;
  if (!api) {
    document.body.innerHTML = '<div style="padding:20px;color:#f88">preload 未加载，无法连接主进程。</div>';
    return;
  }

  const $ = (id) => document.getElementById(id);
  const els = {
    svnStatus: $('svnStatus'),
    btnDiag: $('btnDiag'),
    diagPanel: $('diagPanel'),
    sourceInput: $('sourceInput'),
    targetInput: $('targetInput'),
    sourceHistory: $('sourceHistory'),
    targetHistory: $('targetHistory'),
    targetInfo: $('targetInfo'),
    limitInput: $('limitInput'),
    searchInput: $('searchInput'),
    authorSelect: $('authorSelect'),
    btnClearFilter: $('btnClearFilter'),
    btnPickSourceDir: $('btnPickSourceDir'),
    btnLoadLog: $('btnLoadLog'),
    btnSwapDirs: $('btnSwapDirs'),
    btnCompareDirs: $('btnCompareDirs'),
    btnPickDir: $('btnPickDir'),
    logCount: $('logCount'),
    selectAll: $('selectAll'),
    logRows: $('logRows'),
    logEmpty: $('logEmpty'),
    selectedChips: $('selectedChips'),
    output: $('output'),
    detailModal: $('detailModal'),
    detailTitle: $('detailTitle'),
    detailSubtitle: $('detailSubtitle'),
    detailBody: $('detailBody'),
    btnCloseDetail: $('btnCloseDetail'),
    dirCompareModal: $('dirCompareModal'),
    dirCompareSubtitle: $('dirCompareSubtitle'),
    dirCompareBody: $('dirCompareBody'),
    btnCloseDirCompare: $('btnCloseDirCompare'),
    commitMsg: $('commitMsg'),
    footerText: $('footerText'),
    busyText: $('busyText'),
    toast: $('toast'),
    fileCtxMenu: $('fileCtxMenu'),
    btnUpdate: $('btnUpdate'),
    btnDryRun: $('btnDryRun'),
    btnMerge: $('btnMerge'),
    chkUpdateBeforeMerge: $('chkUpdateBeforeMerge'),
    btnStatus: $('btnStatus'),
    btnDiff: $('btnDiff'),
    btnRevert: $('btnRevert'),
    btnCleanup: $('btnCleanup'),
    btnCommit: $('btnCommit'),
  };

  let entries = [];
  const selected = new Map(); // revision -> entry
  let busy = false;
  let commitMsgDirty = false;
  let toastTimer = null;

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function showToast(message, kind = 'info', duration = 2400) {
    els.toast.textContent = message;
    els.toast.className = 'toast show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), duration);
  }

  function setFooter(text) {
    els.footerText.textContent = text;
  }

  function setBusy(on, label) {
    busy = on;
    els.busyText.textContent = on ? (label || '执行中…') : '';
    const opButtons = [
      els.btnUpdate, els.btnDryRun, els.btnMerge, els.btnStatus,
      els.btnDiff, els.btnRevert, els.btnCleanup, els.btnCommit, els.btnLoadLog,
    ];
    opButtons.forEach((b) => { if (b) b.disabled = on; });
  }

  function shortDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso.slice(0, 19).replace('T', ' ');
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ===== 输出区 =====
  function classifyLine(line) {
    if (/^(\$|svn )/.test(line)) return 'ln-cmd';
    if (/^(Committed revision|Updated to revision|At revision|完成|成功)/i.test(line)) return 'ln-ok';
    if (/^(svn: |E\d{6}|错误|失败|abort|conflict)/i.test(line) || /^\s*C[\sUGEA]/.test(line)) return 'ln-err';
    if (/^(警告|warning|Skipped)/i.test(line)) return 'ln-warn';
    if (/^@@/.test(line)) return 'ln-hunk';
    if (/^\+(?!\+\+)/.test(line)) return 'ln-add';
    if (/^-(?!--)/.test(line)) return 'ln-del';
    return '';
  }

  function setOutput(text, { append = false } = {}) {
    const lines = String(text || '').split(/\r?\n/);
    const html = lines.map((ln) => {
      const cls = classifyLine(ln);
      return cls ? `<span class="${cls}">${escapeHtml(ln)}</span>` : escapeHtml(ln);
    }).join('\n');
    if (append) {
      els.output.innerHTML += (els.output.innerHTML ? '\n' : '') + html;
    } else {
      els.output.innerHTML = html;
    }
    els.output.scrollTop = els.output.scrollHeight;
  }

  function appendOutput(text) {
    setOutput(text, { append: true });
  }

  // ===== 日志列表 =====
  function visibleEntries() {
    const q = els.searchInput.value.trim().toLowerCase();
    const author = els.authorSelect.value;
    return entries.filter((e) => {
      if (author && e.author !== author) return false;
      if (!q) return true;
      return String(e.revision).includes(q) ||
        (e.msg || '').toLowerCase().includes(q) ||
        (e.author || '').toLowerCase().includes(q);
    });
  }

  function populateAuthors() {
    const prev = els.authorSelect.value;
    const authors = [...new Set(entries.map((e) => e.author).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh'));
    els.authorSelect.innerHTML = '<option value="">全部作者</option>'
      + authors.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)}</option>`).join('');
    // 尽量保留之前的选择
    if (prev && authors.includes(prev)) els.authorSelect.value = prev;
    else els.authorSelect.value = '';
  }

  function renderLog() {
    const list = visibleEntries();
    if (entries.length === 0) {
      els.logRows.innerHTML = '';
      els.logEmpty.textContent = '输入来源分支后点击「加载日志」';
      els.logEmpty.classList.remove('hidden');
      els.logCount.textContent = '未加载日志';
      return;
    }
    if (list.length === 0) {
      els.logRows.innerHTML = '';
      els.logEmpty.textContent = '没有匹配的提交';
      els.logEmpty.classList.remove('hidden');
    } else {
      els.logEmpty.classList.add('hidden');
    }

    els.logCount.textContent = `共 ${entries.length} 条${list.length !== entries.length ? ` · 显示 ${list.length}` : ''} · 已选 ${selected.size}`;

    els.logRows.innerHTML = list.map((e) => {
      const isSel = selected.has(e.revision);
      const firstLine = (e.msg || '').split(/\r?\n/)[0];
      return `
        <tr data-rev="${e.revision}" class="${isSel ? 'selected' : ''}">
          <td class="chk-col"><input type="checkbox" data-rev="${e.revision}" ${isSel ? 'checked' : ''} /></td>
          <td class="rev-cell">r${e.revision}</td>
          <td class="author-cell">${escapeHtml(e.author)}</td>
          <td class="date-cell">${escapeHtml(shortDate(e.date))}</td>
          <td class="msg-cell" title="${escapeHtml(e.msg)}">${escapeHtml(firstLine)}</td>
          <td class="act-col"><button type="button" class="detail-btn" data-detail="${e.revision}" title="查看该提交的详细改动">改动</button></td>
        </tr>`;
    }).join('');

    const vis = list;
    els.selectAll.checked = vis.length > 0 && vis.every((e) => selected.has(e.revision));
  }

  function renderSelected() {
    if (selected.size === 0) {
      els.selectedChips.innerHTML = '<span class="muted">尚未选择</span>';
    } else {
      const revs = [...selected.keys()].sort((a, b) => a - b);
      els.selectedChips.innerHTML = revs.map((r) =>
        `<span class="chip">r${r}<button data-rev="${r}" title="移除">✕</button></span>`,
      ).join('');
    }
    updateCommitMsg();
    renderLog();
  }

  function toggleRev(rev, on) {
    const entry = entries.find((e) => e.revision === rev);
    if (!entry) return;
    if (on === undefined) on = !selected.has(rev);
    if (on) selected.set(rev, entry);
    else selected.delete(rev);
  }

  async function updateCommitMsg() {
    if (commitMsgDirty) return;
    if (selected.size === 0) {
      els.commitMsg.value = '';
      return;
    }
    const revs = [...selected.keys()].sort((a, b) => a - b);
    let name = '';
    try {
      const src = els.sourceInput.value.trim();
      if (src) name = (await api.sourceName(src)).name || '';
    } catch (_) { /* ignore */ }
    const revText = revs.map((r) => 'r' + r).join(', ');
    els.commitMsg.value = `cherry-pick ${revText}${name ? ' from ' + name : ''}`;
  }

  function selectedRevs() {
    return [...selected.keys()].sort((a, b) => a - b);
  }

  // ===== SVN 状态 / 诊断 =====
  async function refreshSvnStatus() {
    els.svnStatus.className = 'sp-status busy';
    els.svnStatus.textContent = '检测中…';
    try {
      const res = await api.check();
      if (res.ok) {
        els.svnStatus.className = 'sp-status ok';
        els.svnStatus.textContent = 'svn ' + (res.version || '可用');
      } else {
        els.svnStatus.className = 'sp-status error';
        els.svnStatus.textContent = 'svn 不可用';
      }
    } catch (e) {
      els.svnStatus.className = 'sp-status error';
      els.svnStatus.textContent = 'svn 检测失败';
    }
  }

  async function renderDiag() {
    const d = await api.diag();
    const bin = d.binary || {};
    els.diagPanel.innerHTML = `
      <h3>SVN 诊断</h3>
      <div class="diag-card">
        <div class="title">当前 svn</div>
        <pre>来源：${escapeHtml(bin.source || '')}
路径：${escapeHtml(bin.path || '')}
存在：${bin.exists === null ? '(PATH 中查找)' : (bin.exists ? '是' : '否')}</pre>
      </div>
      <div class="diag-card">
        <div class="title">PATH 中的 svn</div>
        <pre>${escapeHtml(d.onPath || '(未找到)')}</pre>
      </div>
      <div class="diag-card">
        <div class="title">版本</div>
        <pre>${escapeHtml(d.versionOk ? d.version : (d.error || '执行失败'))}</pre>
      </div>
      <div class="op-actions">
        <button id="btnPickSvn" class="btn primary">📁 选择 svn 可执行文件…</button>
        <button id="btnClearSvn" class="btn">清除自定义路径</button>
      </div>
    `;
    const pick = $('btnPickSvn');
    const clear = $('btnClearSvn');
    if (pick) pick.addEventListener('click', async () => {
      const res = await api.pickBinaryPath();
      if (res && res.ok) {
        showToast('已设置 svn 路径', 'success');
        await refreshSvnStatus();
        await renderDiag();
      } else if (res && !res.canceled) {
        showToast('设置失败：' + (res.error || '未知错误'), 'error');
      }
    });
    if (clear) clear.addEventListener('click', async () => {
      await api.setBinaryPath('');
      showToast('已清除自定义 svn 路径');
      await refreshSvnStatus();
      await renderDiag();
    });
  }

  function toggleDiag() {
    const willShow = els.diagPanel.classList.contains('hidden');
    els.diagPanel.classList.toggle('hidden');
    if (willShow) renderDiag();
  }

  // ===== 历史记录 =====
  function fillDatalist(el, values) {
    el.innerHTML = (values || []).map((v) => `<option value="${escapeHtml(v)}"></option>`).join('');
  }

  async function loadHistory({ applyLast = false } = {}) {
    try {
      const h = await api.getHistory();
      fillDatalist(els.sourceHistory, h.sources);
      fillDatalist(els.targetHistory, h.targets);
      if (applyLast) {
        if (h.lastSource && !els.sourceInput.value) els.sourceInput.value = h.lastSource;
        if (h.lastTarget && !els.targetInput.value) els.targetInput.value = h.lastTarget;
      }
    } catch (_) { /* ignore */ }
  }

  // ===== 目标信息 =====
  async function refreshTargetInfo() {
    const target = els.targetInput.value.trim();
    if (!target) { els.targetInfo.textContent = ''; return; }
    const res = await api.info(target);
    if (res.ok) {
      els.targetInfo.textContent = `r${res.revision} · ${res.url}`;
      els.targetInfo.title = `URL: ${res.url}\n仓库根: ${res.repoRoot}`;
      await api.recordTarget(target);
      loadHistory();
    } else {
      els.targetInfo.textContent = '⚠ 不是有效的工作副本';
      els.targetInfo.title = res.error || '';
    }
  }

  // ===== 操作 =====
  function requireTarget() {
    const target = els.targetInput.value.trim();
    if (!target) {
      showToast('请先指定目标工作副本目录', 'error');
      return null;
    }
    return target;
  }

  function requireSource() {
    const source = els.sourceInput.value.trim();
    if (!source) {
      showToast('请先填写来源分支 URL', 'error');
      return null;
    }
    return source;
  }

  // 与后端 isUrl 保持一致：http(s):// svn:// svn+ssh:// file:// 等都算 URL（非本地目录）
  function isUrlLike(s) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(s || '').trim());
  }

  // 目录对比按钮：仅当来源与目标都是本地路径（非 URL、非空）时可用
  function updateCompareButton() {
    if (!els.btnCompareDirs) return;
    const src = els.sourceInput.value.trim();
    const tgt = els.targetInput.value.trim();
    const ok = !!src && !!tgt && !isUrlLike(src) && !isUrlLike(tgt);
    els.btnCompareDirs.disabled = !ok;
    els.btnCompareDirs.title = ok
      ? '对比「来源 ⟷ 目标」两个本地目录的文件树差异'
      : '来源与目标都为本地目录时可用（当前为空或包含 URL）';
  }

  function doCompareDirs() {
    openDirCompare();
  }

  // 调换来源与目标路径
  function swapDirs() {
    const src = els.sourceInput.value;
    els.sourceInput.value = els.targetInput.value;
    els.targetInput.value = src;
    if (!commitMsgDirty) updateCommitMsg();
    refreshTargetInfo();
    updateCompareButton();
    showToast('已调换来源与目标', 'info', 1500);
  }

  async function loadLog() {
    const source = requireSource();
    if (!source) return;
    const raw = els.limitInput.value.trim();
    const limit = raw === '' ? 0 : Math.max(0, Math.floor(Number(raw) || 0)); // 0 = 全部
    setBusy(true, limit ? '加载日志…' : '加载全部历史…（可能较慢）');
    setFooter('svn log ' + source);
    try {
      const res = await api.log(source, { limit });
      if (!res.ok) {
        showToast('加载日志失败', 'error', 3500);
        setOutput('svn log 失败：\n' + (res.error || '未知错误'));
        setFooter('加载日志失败');
        return;
      }
      entries = res.entries || [];
      populateAuthors();
      renderLog();
      if (res.resolvedUrl) {
        setFooter(`已加载 ${entries.length} 条（来源 URL：${res.resolvedUrl}）`);
      } else {
        setFooter(`已加载 ${entries.length} 条提交`);
      }
      if (entries.length === 0) showToast('该来源没有可显示的提交', 'info');
      await api.recordSource(source);
      loadHistory();
    } finally {
      setBusy(false);
    }
  }

  async function doUpdate() {
    const target = requireTarget();
    if (!target) return;
    setBusy(true, '更新中…');
    setFooter('svn update');
    setOutput('$ svn update ' + target);
    try {
      const res = await api.update(target);
      appendOutput(res.output || (res.ok ? '(无输出)' : res.error));
      setFooter(res.ok ? '更新完成' : '更新失败');
      showToast(res.ok ? '更新完成' : '更新失败', res.ok ? 'success' : 'error');
      refreshTargetInfo();
    } finally {
      setBusy(false);
    }
  }

  async function doMerge(dryRun) {
    const target = requireTarget();
    if (!target) return;
    const source = requireSource();
    if (!source) return;
    const revisions = selectedRevs();
    if (revisions.length === 0) {
      showToast('请先勾选至少一个 revision', 'error');
      return;
    }

    const updateFirst = !!els.chkUpdateBeforeMerge.checked;
    setBusy(true, dryRun ? '预演合并…' : '合并中…');
    try {
      if (!dryRun && updateFirst) {
        setFooter('svn update');
        setOutput('$ svn update ' + target);
        const up = await api.update(target);
        appendOutput(up.output || (up.ok ? '(无输出)' : up.error));
        if (!up.ok) {
          showToast('更新失败，已中止合并', 'error', 3500);
          setFooter('更新失败');
          return;
        }
      } else {
        setOutput('');
        if (!dryRun) appendOutput('（已跳过 svn update）');
      }

      const res = await api.merge({ sourceUrl: source, revisions, target, dryRun });
      if (res.error && !res.command) {
        appendOutput('合并未执行：\n' + res.error);
        setFooter('合并未执行');
        showToast(res.error, 'error', 4000);
        return;
      }
      if (res.sourceWasLocal && res.resolvedSourceUrl) {
        appendOutput('（来源是本地路径，已解析为仓库 URL：' + res.resolvedSourceUrl + '）');
      }
      if (res.warning) appendOutput(res.warning);
      appendOutput('$ ' + res.command);
      appendOutput(res.output || (res.ok ? '(无改动输出)' : res.error));

      if (!res.ok) {
        setFooter(dryRun ? '预演失败' : '合并失败');
        showToast(dryRun ? '预演失败' : '合并失败', 'error', 3500);
        return;
      }
      if (res.conflicts && res.conflicts.length) {
        setFooter('合并完成但存在冲突，请手动解决');
        showToast(`存在 ${res.conflicts.length} 处冲突，请手动解决后再提交`, 'error', 4000);
      } else {
        setFooter(dryRun ? '预演完成（未改动工作副本）' : '合并完成，请检查后提交');
        showToast(dryRun ? '预演完成' : '合并完成', 'success');
      }
      if (!dryRun) updateCommitMsg();
    } finally {
      setBusy(false);
    }
  }

  async function doStatus() {
    const target = requireTarget();
    if (!target) return;
    setBusy(true, '查询状态…');
    try {
      const res = await api.status(target);
      if (!res.ok) {
        setOutput('svn status 失败：\n' + (res.error || ''));
        setFooter('查询状态失败');
        return;
      }
      if (!res.entries.length) {
        setOutput('工作副本干净，没有本地改动。');
        setFooter('无本地改动');
        return;
      }
      const lines = res.entries.map((e) => `${e.item.padEnd(12)} ${e.path}`);
      setOutput(`本地改动（${res.entries.length}）：\n` + lines.join('\n'));
      setFooter(`${res.entries.length} 项本地改动`);
    } finally {
      setBusy(false);
    }
  }

  async function doDiff() {
    const target = requireTarget();
    if (!target) return;
    setBusy(true, '生成 diff…');
    try {
      const res = await api.diff(target);
      if (!res.ok) {
        setOutput('svn diff 失败：\n' + (res.error || ''));
        setFooter('diff 失败');
        return;
      }
      setOutput(res.diff || '(没有差异)');
      setFooter('diff 生成完成');
    } finally {
      setBusy(false);
    }
  }

  async function doRevert() {
    const target = requireTarget();
    if (!target) return;
    if (!window.confirm('确定要 svn revert -R 撤销目标工作副本下所有未提交改动吗？此操作不可恢复。')) return;
    setBusy(true, '撤销中…');
    try {
      const res = await api.revert(target);
      setOutput('$ svn revert -R ' + target + '\n' + (res.output || (res.ok ? '已撤销' : res.error)));
      setFooter(res.ok ? '已撤销所有改动' : '撤销失败');
      showToast(res.ok ? '已撤销所有改动' : '撤销失败', res.ok ? 'success' : 'error');
    } finally {
      setBusy(false);
    }
  }

  async function doCleanup() {
    const target = requireTarget();
    if (!target) return;
    setBusy(true, 'cleanup…');
    try {
      const res = await api.cleanup(target);
      setOutput('$ svn cleanup ' + target + '\n' + (res.output || (res.ok ? '完成' : res.error)));
      setFooter(res.ok ? 'cleanup 完成' : 'cleanup 失败');
    } finally {
      setBusy(false);
    }
  }

  async function doCommit() {
    const target = requireTarget();
    if (!target) return;
    const msg = els.commitMsg.value.trim();
    if (!msg) {
      showToast('请填写提交信息', 'error');
      els.commitMsg.focus();
      return;
    }
    if (!window.confirm(`确定要提交到 SVN 吗？\n\n目标：${target}\n信息：${msg}`)) return;
    setBusy(true, '提交中…');
    try {
      const res = await api.commit(target, msg);
      appendOutput('$ svn commit -m "' + msg + '"');
      appendOutput(res.output || (res.ok ? '(无输出)' : res.error));
      if (res.ok) {
        setFooter(res.committedRevision ? `提交成功 r${res.committedRevision}` : '提交成功');
        showToast(res.committedRevision ? `提交成功，新版本 r${res.committedRevision}` : '提交成功', 'success', 3500);
        selected.clear();
        commitMsgDirty = false;
        renderSelected();
        refreshTargetInfo();
      } else {
        setFooter('提交失败');
        showToast('提交失败', 'error', 3500);
      }
    } finally {
      setBusy(false);
    }
  }

  // ===== 改动详情弹窗 =====
  const detail = {
    source: '', revision: 0, repoRoot: '', paths: [], selectedPath: '',
    token: 0,
    ignoreSpace: false,  // 是否忽略空白量变化（行尾符差异始终忽略，对齐 TortoiseSVN）
    cache: new Map(),    // cacheKey -> fileDiff 结果（已取到）
    inflight: new Map(), // cacheKey -> 正在进行的请求 Promise（去重）
  };

  // 缓存键：同一文件在「忽略空白」开/关下结果不同，需分别缓存
  function diffCacheKey(repoPath) {
    return (detail.ignoreSpace ? 'S1|' : 'S0|') + repoPath;
  }

  // 取单个文件 diff：命中缓存直接返回；在途请求复用；否则发起并缓存
  function getFileDiff(repoPath) {
    const key = diffCacheKey(repoPath);
    if (detail.cache.has(key)) return Promise.resolve(detail.cache.get(key));
    if (detail.inflight.has(key)) return detail.inflight.get(key);
    const entry = detail.paths.find((p) => p.path === repoPath);
    const token = detail.token;
    const promise = api.fileDiff({
      repoRoot: detail.repoRoot,
      repoPath,
      revision: detail.revision,
      action: entry ? entry.action : '',
      ignoreSpace: detail.ignoreSpace,
    }).then((res) => {
      if (detail.token === token) detail.cache.set(key, res);
      detail.inflight.delete(key);
      return res;
    }).catch((err) => {
      detail.inflight.delete(key);
      throw err;
    });
    detail.inflight.set(key, promise);
    return promise;
  }

  // 后台并发预取本次 revision 所有文件的 diff，切换时即可秒开
  async function prefetchAllDiffs() {
    const token = detail.token;
    const files = detail.paths.filter((p) => p.kind !== 'dir');
    let idx = 0;
    const CONCURRENCY = 4;
    const worker = async () => {
      while (idx < files.length) {
        if (detail.token !== token) return; // 弹窗已切换/关闭
        const p = files[idx++];
        const key = diffCacheKey(p.path);
        if (detail.cache.has(key) || detail.inflight.has(key)) continue;
        try { await getFileDiff(p.path); } catch (_) { /* 单个失败不影响其它 */ }
      }
    };
    const n = Math.min(CONCURRENCY, files.length);
    await Promise.all(Array.from({ length: n }, worker));
  }

  // 把文本切成行（去掉末尾空行造成的多余空项）
  function splitLines(t) {
    if (t === '' || t == null) return [];
    const arr = String(t).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    if (arr.length > 1 && arr[arr.length - 1] === '') arr.pop();
    return arr;
  }

  function diffRow(o, n, cls, sign, code) {
    return `<div class="dl ${cls}">`
      + `<span class="dl-no old">${o === '' ? '' : o}</span>`
      + `<span class="dl-no new">${n === '' ? '' : n}</span>`
      + `<span class="dl-sign">${sign}</span>`
      + `<span class="dl-code">${escapeHtml(code)}</span>`
      + `</div>`;
  }

  // 折叠区暂存：foldId -> 该折叠隐藏的所有行 HTML（点击展开时用）
  const foldStore = new Map();
  let foldSeq = 0;
  const DIFF_CONTEXT = 3; // 改动上下保留的上下文行数

  // 纯 LCS（middle 段用，可能 O(n*m)）
  function lcsOps(a, b) {
    const n = a.length;
    const m = b.length;
    const W = m + 1;
    const dp = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * W + j] = a[i] === b[j]
          ? dp[(i + 1) * W + (j + 1)] + 1
          : Math.max(dp[(i + 1) * W + j], dp[i * W + (j + 1)]);
      }
    }
    const ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ t: 'ctx', s: a[i] }); i++; j++; }
      else if (dp[(i + 1) * W + j] >= dp[i * W + (j + 1)]) { ops.push({ t: 'del', s: a[i] }); i++; }
      else { ops.push({ t: 'add', s: b[j] }); j++; }
    }
    while (i < n) ops.push({ t: 'del', s: a[i++] });
    while (j < m) ops.push({ t: 'add', s: b[j++] });
    return ops;
  }

  // 逐行比对：先剥离公共前后缀（典型改动 middle 很小），中段再做 LCS；
  // 不再有总行数上限。只有当“完全不同的中段”超大时才退化成整块替换，避免内存爆炸。
  function diffLinesSmart(a, b) {
    const n = a.length;
    const m = b.length;
    let p = 0;
    while (p < n && p < m && a[p] === b[p]) p++;
    let s = 0;
    while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s++;

    const midA = a.slice(p, n - s);
    const midB = b.slice(p, m - s);
    let midOps;
    if (midA.length === 0 && midB.length === 0) midOps = [];
    else if (midA.length === 0) midOps = midB.map((x) => ({ t: 'add', s: x }));
    else if (midB.length === 0) midOps = midA.map((x) => ({ t: 'del', s: x }));
    else if (midA.length * midB.length > 8000000) {
      midOps = [...midA.map((x) => ({ t: 'del', s: x })), ...midB.map((x) => ({ t: 'add', s: x }))];
    } else {
      midOps = lcsOps(midA, midB);
    }

    const ops = [];
    for (let i = 0; i < p; i++) ops.push({ t: 'ctx', s: a[i] });
    for (const o of midOps) ops.push(o);
    for (let i = n - s; i < n; i++) ops.push({ t: 'ctx', s: a[i] });
    return ops;
  }

  // 把若干行对象渲染成带折叠的 diff（gap=true 的连续行折叠成「展开 N 行」）
  function renderLineList(lines) {
    if (!lines.length) return '<div class="detail-loading">（无差异）</div>';
    const signOf = (cls) => (cls === 'add' ? '+' : cls === 'del' ? '-' : '');
    const rowOf = (l) => diffRow(l.o, l.n, l.cls, signOf(l.cls), l.code);
    let html = '';
    let i = 0;
    while (i < lines.length) {
      if (!lines[i].gap) { html += rowOf(lines[i]); i++; continue; }
      let j = i;
      while (j < lines.length && lines[j].gap) j++;
      const hidden = lines.slice(i, j);
      const id = 'fold' + (foldSeq++);
      foldStore.set(id, hidden.map(rowOf).join(''));
      html += `<div class="diff-fold" data-fold="${id}"><span class="diff-fold-icon">⋯</span> 展开 ${hidden.length} 行未改动</div>`;
      i = j;
    }
    return `<div class="diff-view">${html}</div>`;
  }

  // 用 svn 自己的 unified diff + 新版本全文，重建出整文件视图（hunk 之间未改动段标为可折叠 gap）
  function reconstructFromSvnDiff(diffText, newText) {
    const newLines = splitLines(newText);
    const raw = String(diffText || '').split(/\r?\n/);
    const hunks = [];
    let cur = null;
    for (const ln of raw) {
      if (/^Index: /.test(ln) || /^={3,}$/.test(ln) || /^--- /.test(ln) || /^\+\+\+ /.test(ln)) continue;
      const h = ln.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) { cur = { oldStart: Number(h[1]), newStart: Number(h[2]), body: [] }; hunks.push(cur); continue; }
      if (!cur) continue;
      if (ln.startsWith('\\')) continue; // \ No newline at end of file
      cur.body.push(ln);
    }

    const out = [];
    let newPos = 1;
    let oldPos = 1;
    for (const hunk of hunks) {
      while (newPos < hunk.newStart) {
        out.push({ cls: 'ctx', o: oldPos, n: newPos, code: newLines[newPos - 1] || '', gap: true });
        newPos++; oldPos++;
      }
      for (const bl of hunk.body) {
        const c = bl[0];
        const text = bl.slice(1);
        if (c === '+') { out.push({ cls: 'add', o: '', n: newPos, code: text }); newPos++; }
        else if (c === '-') { out.push({ cls: 'del', o: oldPos, n: '', code: text }); oldPos++; }
        else { out.push({ cls: 'ctx', o: oldPos, n: newPos, code: text }); oldPos++; newPos++; }
      }
    }
    while (newPos <= newLines.length) {
      out.push({ cls: 'ctx', o: oldPos, n: newPos, code: newLines[newPos - 1] || '', gap: true });
      newPos++; oldPos++;
    }
    return out;
  }

  // 渲染 cat 比对结果（兜底）：改动周围保留上下文，长段未改动折叠成「展开 N 行」
  function renderTextDiff(oldText, newText) {
    const a = splitLines(oldText);
    const b = splitLines(newText);
    const ops = diffLinesSmart(a, b);
    if (!ops.length) return '<div class="detail-loading">（两个版本内容相同）</div>';

    // 1) 给每行编号
    const lines = [];
    let oldNo = 1;
    let newNo = 1;
    for (const op of ops) {
      if (op.t === 'add') { lines.push({ cls: 'add', sign: '+', o: '', n: newNo, code: op.s }); newNo++; }
      else if (op.t === 'del') { lines.push({ cls: 'del', sign: '-', o: oldNo, n: '', code: op.s }); oldNo++; }
      else { lines.push({ cls: 'ctx', sign: '', o: oldNo, n: newNo, code: op.s }); oldNo++; newNo++; }
    }

    // 2) 标记需要保留显示的行（改动行 + 其上下 DIFF_CONTEXT 行）
    const hasChange = lines.some((l) => l.cls !== 'ctx');
    const keep = new Array(lines.length).fill(!hasChange); // 整文件无改动则全部显示
    if (hasChange) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].cls !== 'ctx') {
          const from = Math.max(0, i - DIFF_CONTEXT);
          const to = Math.min(lines.length - 1, i + DIFF_CONTEXT);
          for (let k = from; k <= to; k++) keep[k] = true;
        }
      }
    }

    // 3) 输出：保留行直接渲染；连续被折叠的行收进一个可展开的 fold
    const rowOf = (l) => diffRow(l.o, l.n, l.cls, l.sign, l.code);
    let html = '';
    let i = 0;
    while (i < lines.length) {
      if (keep[i]) { html += rowOf(lines[i]); i++; continue; }
      let j = i;
      while (j < lines.length && !keep[j]) j++;
      const hidden = lines.slice(i, j);
      const id = 'fold' + (foldSeq++);
      foldStore.set(id, hidden.map(rowOf).join(''));
      html += `<div class="diff-fold" data-fold="${id}"><span class="diff-fold-icon">⋯</span> 展开 ${hidden.length} 行未改动</div>`;
      i = j;
    }
    return `<div class="diff-view">${html}</div>`;
  }

  function closeDetail() {
    els.detailModal.classList.add('hidden');
    hideFileCtxMenu();
    detail.token += 1; // 让后台预取停止
  }

  function fileBaseName(p) {
    return String(p || '').split('/').filter(Boolean).pop() || p;
  }

  function fmtSize(n) {
    if (n == null) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  // 二进制文件：展示轻量元信息对比
  function renderBinaryInfo(res) {
    const actLabel = { A: '新增', M: '修改', D: '删除', R: '替换' }[res.action] || res.action || '改动';

    let sizeVal;
    if (res.action === 'A') sizeVal = fmtSize(res.newSize);
    else if (res.action === 'D') sizeVal = fmtSize(res.oldSize);
    else {
      const delta = (res.oldSize != null && res.newSize != null) ? res.newSize - res.oldSize : null;
      const deltaStr = delta == null ? '' : ` <span class="${delta >= 0 ? 'up' : 'down'}">(${delta >= 0 ? '+' : '-'}${fmtSize(Math.abs(delta))})</span>`;
      sizeVal = `${fmtSize(res.oldSize)} → ${fmtSize(res.newSize)}${deltaStr}`;
    }

    let md5Val;
    if (res.action === 'A') md5Val = `<code>${escapeHtml(res.newMd5 || '—')}</code>`;
    else if (res.action === 'D') md5Val = `<code>${escapeHtml(res.oldMd5 || '—')}</code>`;
    else {
      const changed = res.oldMd5 && res.newMd5 && res.oldMd5 !== res.newMd5;
      md5Val = `<code>${escapeHtml(res.oldMd5 || '—')}</code><br><code>${escapeHtml(res.newMd5 || '—')}</code>`
        + `<div class="bin-md5-note ${changed ? 'changed' : ''}">${changed ? '内容已变化' : '内容未变化'}</div>`;
    }

    return `
      <div class="bin-info">
        <div class="bin-title">二进制文件，无法逐行对比，仅显示元信息</div>
        <table class="bin-table">
          <tr><th>操作</th><td>${escapeHtml(actLabel)}</td></tr>
          <tr><th>MIME</th><td>${escapeHtml(res.mimeType || '（未设置）')}</td></tr>
          <tr><th>大小</th><td>${sizeVal}</td></tr>
          <tr><th>MD5</th><td>${md5Val}</td></tr>
        </table>
      </div>`;
  }

  function renderDiffResult(pane, res) {
    if (!res || !res.ok) {
      pane.innerHTML = `<div class="detail-loading">获取失败：${escapeHtml((res && res.error) || '未知错误')}</div>`;
      return;
    }
    if (res.mode === 'binary') {
      pane.innerHTML = renderBinaryInfo(res);
      return;
    }
    foldStore.clear();
    if (res.mode === 'text-js') {
      pane.innerHTML = renderTextDiff(res.oldText, res.newText);
    } else if (!res.diff || !res.diff.trim()) {
      pane.innerHTML = '<div class="detail-loading">（svn 未报告文本差异，可能仅属性改动）</div>';
    } else {
      pane.innerHTML = renderLineList(reconstructFromSvnDiff(res.diff, res.newText));
    }
    pane.scrollTop = 0;
  }

  async function selectDetailFile(repoPath) {
    detail.selectedPath = repoPath;
    els.detailBody.querySelectorAll('.path-row').forEach((el) => {
      el.classList.toggle('selected', el.getAttribute('data-path') === repoPath);
    });
    const pane = els.detailBody.querySelector('#detailDiffPane');
    if (!pane) return;

    const entry = detail.paths.find((p) => p.path === repoPath);
    if (entry && entry.kind === 'dir') {
      pane.innerHTML = '<div class="detail-loading">目录改动没有文本 diff</div>';
      return;
    }

    // 命中缓存：直接渲染，不闪 loading
    const key = diffCacheKey(repoPath);
    if (detail.cache.has(key)) {
      renderDiffResult(pane, detail.cache.get(key));
      return;
    }

    pane.innerHTML = '<div class="detail-loading">正在获取该文件的 diff…</div>';
    let res;
    try {
      res = await getFileDiff(repoPath);
    } catch (e) {
      if (detail.selectedPath === repoPath) {
        pane.innerHTML = `<div class="detail-loading">获取失败：${escapeHtml(e.message)}</div>`;
      }
      return;
    }
    if (detail.selectedPath !== repoPath) return; // 期间又点了别的文件
    renderDiffResult(pane, res);
  }

  async function openDetail(revision) {
    const source = els.sourceInput.value.trim();
    if (!source) { showToast('请先填写来源', 'error'); return; }
    const entry = entries.find((e) => e.revision === revision);
    els.detailTitle.textContent = `r${revision} 改动详情`;
    els.detailSubtitle.textContent = entry ? `${entry.author} · ${shortDate(entry.date)}` : '';
    els.detailBody.innerHTML = '<div class="detail-loading">正在获取改动…</div>';
    els.detailModal.classList.remove('hidden');

    let res;
    try {
      res = await api.revisionDetail(source, revision);
    } catch (e) {
      els.detailBody.innerHTML = `<div class="detail-loading">获取失败：${escapeHtml(e.message)}</div>`;
      return;
    }
    if (!res || !res.ok) {
      els.detailBody.innerHTML = `<div class="detail-loading">获取失败：${escapeHtml((res && res.error) || '未知错误')}</div>`;
      return;
    }

    detail.source = source;
    detail.revision = revision;
    detail.repoRoot = res.repoRoot || '';
    detail.paths = res.paths || [];
    detail.selectedPath = '';
    detail.token += 1;       // 使上一次 revision 的在途请求/预取作废
    detail.cache = new Map();
    detail.inflight = new Map();

    const msgHtml = res.msg ? `<div class="detail-msg">${escapeHtml(res.msg)}</div>` : '';
    const fileItems = detail.paths.length
      ? detail.paths.map((p) =>
          `<div class="path-row" data-path="${escapeHtml(p.path)}" title="${escapeHtml(p.path)}">
             <span class="path-action ${escapeHtml(p.action)}">${escapeHtml(p.action)}</span>
             <span class="path-text">${escapeHtml(fileBaseName(p.path))}</span>
           </div>`,
        ).join('')
      : `<div class="detail-loading">${escapeHtml(res.pathsError || '（无改动文件）')}</div>`;

    els.detailBody.innerHTML = `
      ${msgHtml}
      <div class="detail-split">
        <div class="detail-files">
          <div class="detail-section-title">改动文件（${detail.paths.length}）</div>
          <div class="path-list">${fileItems}</div>
        </div>
        <div class="detail-diff-pane">
          <div class="detail-diff-head">
            <span class="detail-section-title">Diff</span>
            <label class="diff-opt" title="始终忽略行尾符(CRLF/LF)差异；勾选则进一步忽略空白量变化（缩进/行尾空格）">
              <input id="chkIgnoreSpace" type="checkbox" ${detail.ignoreSpace ? 'checked' : ''} /> 忽略空白
            </label>
          </div>
          <div id="detailDiffPane" class="diff-pane"><div class="detail-loading">请选择左侧文件查看 diff</div></div>
        </div>
      </div>
    `;

    const chk = els.detailBody.querySelector('#chkIgnoreSpace');
    if (chk) {
      chk.addEventListener('change', () => {
        detail.ignoreSpace = chk.checked;
        if (detail.selectedPath) selectDetailFile(detail.selectedPath);
        prefetchAllDiffs();
      });
    }

    const firstFile = detail.paths.find((p) => p.kind !== 'dir') || detail.paths[0];
    if (firstFile) selectDetailFile(firstFile.path);
    // 后台并发预取其余文件的 diff，之后切换文件即可秒开
    prefetchAllDiffs();
  }

  // ===== 本地目录树对比（与 svn 无关，复用 diff 详情的折叠/着色渲染） =====
  const dirCmp = {
    left: '', right: '',
    entries: [],
    collapsed: new Set(), // 已折叠的目录 path
    onlyDiff: true,
    selectedPath: '',
    token: 0,
    cache: new Map(),     // relPath -> compareFile 结果
  };

  function statusLetter(s) {
    return s === 'added' ? 'A' : s === 'removed' ? 'D' : s === 'modified' ? 'M' : 'S';
  }
  function statusSymbol(s) {
    return s === 'added' ? 'A' : s === 'removed' ? 'D' : s === 'modified' ? 'M' : '·';
  }

  // 某节点是否被某个已折叠的祖先目录隐藏
  function isHiddenByCollapse(p) {
    if (dirCmp.collapsed.size === 0) return false;
    for (const c of dirCmp.collapsed) {
      if (p.startsWith(c + '/')) return true;
    }
    return false;
  }

  function dirCmpVisibleEntries() {
    return dirCmp.entries.filter((e) => {
      if (dirCmp.onlyDiff && e.status === 'same') return false;
      if (isHiddenByCollapse(e.path)) return false;
      return true;
    });
  }

  function renderDirCmpList() {
    const list = els.dirCompareBody.querySelector('#dirCmpList');
    if (!list) return;
    const vis = dirCmpVisibleEntries();
    if (!vis.length) {
      list.innerHTML = '<div class="detail-loading">没有可显示的节点</div>';
      return;
    }
    list.innerHTML = vis.map((e) => {
      const isDir = e.kind === 'dir';
      const collapsed = isDir && dirCmp.collapsed.has(e.path);
      const caret = isDir ? (collapsed ? '▶' : '▼') : '';
      const letter = statusLetter(e.status);
      const sym = statusSymbol(e.status);
      const sel = e.path === dirCmp.selectedPath ? ' selected' : '';
      const pad = 8 + e.depth * 15;
      return `<div class="path-row dircmp-row${sel}" data-path="${escapeHtml(e.path)}" data-kind="${e.kind}" title="${escapeHtml(e.path)}" style="padding-left:${pad}px">
          <span class="dircmp-caret" data-caret="${isDir ? '1' : ''}">${caret}</span>
          <span class="path-action ${letter}">${sym}</span>
          <span class="path-text">${escapeHtml(e.name)}${isDir ? '/' : ''}</span>
        </div>`;
    }).join('');
  }

  function getDirCmpFile(relPath) {
    if (dirCmp.cache.has(relPath)) return Promise.resolve(dirCmp.cache.get(relPath));
    const token = dirCmp.token;
    return api.dirCompareFile(dirCmp.left, dirCmp.right, relPath).then((res) => {
      if (dirCmp.token === token) dirCmp.cache.set(relPath, res);
      return res;
    });
  }

  async function selectDirCmpFile(relPath) {
    dirCmp.selectedPath = relPath;
    els.dirCompareBody.querySelectorAll('.dircmp-row').forEach((el) => {
      el.classList.toggle('selected', el.getAttribute('data-path') === relPath);
    });
    const pane = els.dirCompareBody.querySelector('#dirCmpDiffPane');
    if (!pane) return;

    const entry = dirCmp.entries.find((p) => p.path === relPath);
    if (entry && entry.kind === 'dir') {
      pane.innerHTML = '<div class="detail-loading">目录节点没有文本 diff，请选择文件</div>';
      return;
    }

    if (dirCmp.cache.has(relPath)) {
      renderDiffResult(pane, dirCmp.cache.get(relPath));
      return;
    }
    pane.innerHTML = '<div class="detail-loading">正在比较该文件…</div>';
    let res;
    try {
      res = await getDirCmpFile(relPath);
    } catch (e) {
      if (dirCmp.selectedPath === relPath) {
        pane.innerHTML = `<div class="detail-loading">比较失败：${escapeHtml(e.message)}</div>`;
      }
      return;
    }
    if (dirCmp.selectedPath !== relPath) return;
    if (res && res.mode === 'dir') {
      pane.innerHTML = '<div class="detail-loading">目录节点没有文本 diff</div>';
      return;
    }
    renderDiffResult(pane, res);
  }

  function closeDirCompare() {
    els.dirCompareModal.classList.add('hidden');
    hideFileCtxMenu();
    dirCmp.token += 1;
  }

  async function openDirCompare() {
    const left = els.sourceInput.value.trim();
    const right = els.targetInput.value.trim();
    if (!left || !right) { showToast('请先填写来源与目标本地目录', 'error'); return; }
    if (isUrlLike(left) || isUrlLike(right)) {
      showToast('目录对比仅支持本地目录（来源或目标当前是 URL）', 'error');
      return;
    }
    els.dirCompareSubtitle.textContent = `${left}  ⟷  ${right}`;
    els.dirCompareBody.innerHTML = '<div class="detail-loading">正在扫描两个目录…</div>';
    els.dirCompareModal.classList.remove('hidden');
    dirCmp.token += 1;

    let res;
    try {
      res = await api.dirCompareTree(left, right);
    } catch (e) {
      els.dirCompareBody.innerHTML = `<div class="detail-loading">对比失败：${escapeHtml(e.message)}</div>`;
      return;
    }
    if (!res || !res.ok) {
      els.dirCompareBody.innerHTML = `<div class="detail-loading">对比失败：${escapeHtml((res && res.error) || '未知错误')}</div>`;
      return;
    }

    dirCmp.left = res.left;
    dirCmp.right = res.right;
    dirCmp.entries = res.entries || [];
    dirCmp.collapsed = new Set();
    dirCmp.onlyDiff = true;
    dirCmp.selectedPath = '';
    dirCmp.cache = new Map();

    const c = res.counts || { added: 0, removed: 0, modified: 0, same: 0 };
    const truncatedNote = res.truncated
      ? ` <span class="dircmp-trunc">· 已达上限，仅显示部分</span>` : '';
    const countsHtml = `共 ${dirCmp.entries.length} 项 · `
      + `<span class="dc-add">新增 ${c.added}</span> · `
      + `<span class="dc-del">删除 ${c.removed}</span> · `
      + `<span class="dc-mod">修改 ${c.modified}</span>${truncatedNote}`;

    els.dirCompareBody.innerHTML = `
      <div class="dircmp-bar">
        <span class="dircmp-counts">${countsHtml}</span>
        <label class="dircmp-onlydiff"><input type="checkbox" id="dirCmpOnlyDiff" checked /> 只看差异</label>
      </div>
      <div class="detail-split">
        <div class="detail-files">
          <div class="detail-section-title">文件树（来源 ⟷ 目标）</div>
          <div class="path-list" id="dirCmpList"></div>
        </div>
        <div class="detail-diff-pane">
          <div class="detail-section-title">Diff（左=来源 / 右=目标）</div>
          <div id="dirCmpDiffPane" class="diff-pane"><div class="detail-loading">请选择左侧文件查看差异</div></div>
        </div>
      </div>
    `;
    renderDirCmpList();

    const firstDiff = dirCmp.entries.find((e) => e.kind === 'file' && e.status !== 'same');
    if (firstDiff) selectDirCmpFile(firstDiff.path);
  }

  // ===== 文件列表右键菜单（复制文件路径 / 文件名） =====
  let ctxMenuPath = '';

  function hideFileCtxMenu() {
    els.fileCtxMenu.classList.add('hidden');
  }

  function showFileCtxMenu(x, y, p) {
    ctxMenuPath = p || '';
    els.fileCtxMenu.classList.remove('hidden');
    const rect = els.fileCtxMenu.getBoundingClientRect();
    const left = Math.min(x, window.innerWidth - rect.width - 8);
    const top = Math.min(y, window.innerHeight - rect.height - 8);
    els.fileCtxMenu.style.left = Math.max(8, left) + 'px';
    els.fileCtxMenu.style.top = Math.max(8, top) + 'px';
  }

  function onFileRowContextMenu(e) {
    const row = e.target.closest('.path-row[data-path]');
    if (!row) return;
    e.preventDefault();
    showFileCtxMenu(e.clientX, e.clientY, row.getAttribute('data-path'));
  }

  // ===== 拖拽目录到输入框 =====
  function setupDropZone(input, onPath) {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    input.addEventListener('dragenter', (e) => { stop(e); input.classList.add('drag-over'); });
    input.addEventListener('dragover', (e) => {
      stop(e);
      e.dataTransfer.dropEffect = 'copy';
      input.classList.add('drag-over');
    });
    input.addEventListener('dragleave', (e) => { stop(e); input.classList.remove('drag-over'); });
    input.addEventListener('drop', (e) => {
      stop(e);
      input.classList.remove('drag-over');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      let p = '';
      try {
        p = api.getPathForFile ? api.getPathForFile(file) : (file.path || '');
      } catch (_) {
        p = file.path || '';
      }
      if (!p) { showToast('无法获取拖入路径', 'error'); return; }
      input.value = p;
      onPath(p);
    });
  }

  // ===== 事件绑定 =====
  function bindEvents() {
    els.btnCloseDetail.addEventListener('click', closeDetail);
    els.detailModal.addEventListener('click', (e) => {
      if (e.target === els.detailModal) closeDetail();
    });
    els.detailBody.addEventListener('click', (e) => {
      const fold = e.target.closest('.diff-fold[data-fold]');
      if (fold) {
        const rows = foldStore.get(fold.getAttribute('data-fold'));
        if (rows != null) {
          foldStore.delete(fold.getAttribute('data-fold'));
          fold.outerHTML = rows;
        }
        return;
      }
      const row = e.target.closest('.path-row[data-path]');
      if (row) selectDetailFile(row.getAttribute('data-path'));
    });
    els.detailBody.addEventListener('contextmenu', onFileRowContextMenu);
    els.dirCompareBody.addEventListener('contextmenu', onFileRowContextMenu);

    els.fileCtxMenu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.getAttribute('data-action');
      const p = ctxMenuPath;
      hideFileCtxMenu();
      if (!p) return;
      const text = action === 'copyName' ? fileBaseName(p) : p;
      const ok = api.copyText ? api.copyText(text) : false;
      showToast(ok ? '已复制：' + text : '复制失败', ok ? 'success' : 'error', 1800);
    });
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#fileCtxMenu')) hideFileCtxMenu();
    });
    window.addEventListener('blur', hideFileCtxMenu);
    window.addEventListener('resize', hideFileCtxMenu);
    els.btnCloseDirCompare.addEventListener('click', closeDirCompare);
    els.dirCompareModal.addEventListener('click', (e) => {
      if (e.target === els.dirCompareModal) closeDirCompare();
    });
    els.dirCompareBody.addEventListener('change', (e) => {
      if (e.target && e.target.id === 'dirCmpOnlyDiff') {
        dirCmp.onlyDiff = e.target.checked;
        renderDirCmpList();
      }
    });
    els.dirCompareBody.addEventListener('click', (e) => {
      const fold = e.target.closest('.diff-fold[data-fold]');
      if (fold) {
        const rows = foldStore.get(fold.getAttribute('data-fold'));
        if (rows != null) {
          foldStore.delete(fold.getAttribute('data-fold'));
          fold.outerHTML = rows;
        }
        return;
      }
      const row = e.target.closest('.dircmp-row[data-path]');
      if (!row) return;
      const p = row.getAttribute('data-path');
      if (row.getAttribute('data-kind') === 'dir') {
        if (dirCmp.collapsed.has(p)) dirCmp.collapsed.delete(p);
        else dirCmp.collapsed.add(p);
        renderDirCmpList();
      } else {
        selectDirCmpFile(p);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!els.fileCtxMenu.classList.contains('hidden')) { hideFileCtxMenu(); return; }
      if (!els.dirCompareModal.classList.contains('hidden')) { closeDirCompare(); return; }
      if (!els.detailModal.classList.contains('hidden')) closeDetail();
    });

    els.btnDiag.addEventListener('click', toggleDiag);
    els.btnLoadLog.addEventListener('click', loadLog);
    els.sourceInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadLog(); });
    els.searchInput.addEventListener('input', renderLog);
    els.authorSelect.addEventListener('change', renderLog);
    els.btnClearFilter.addEventListener('click', () => {
      els.searchInput.value = '';
      els.authorSelect.value = '';
      renderLog();
    });

    els.btnPickDir.addEventListener('click', async () => {
      const res = await api.pickDir();
      if (res && res.ok) {
        els.targetInput.value = res.path;
        refreshTargetInfo();
        updateCompareButton();
      }
    });

    els.btnPickSourceDir.addEventListener('click', async () => {
      const res = await api.pickDir();
      if (res && res.ok) {
        els.sourceInput.value = res.path;
        if (!commitMsgDirty) updateCommitMsg();
        updateCompareButton();
      }
    });
    els.targetInput.addEventListener('change', refreshTargetInfo);
    els.sourceInput.addEventListener('input', updateCompareButton);
    els.targetInput.addEventListener('input', updateCompareButton);
    if (els.btnCompareDirs) els.btnCompareDirs.addEventListener('click', doCompareDirs);
    if (els.btnSwapDirs) els.btnSwapDirs.addEventListener('click', swapDirs);

    // 拖拽目录到输入框
    setupDropZone(els.sourceInput, () => { if (!commitMsgDirty) updateCommitMsg(); updateCompareButton(); });
    setupDropZone(els.targetInput, () => { refreshTargetInfo(); updateCompareButton(); });

    // 行点击 / 勾选
    els.logRows.addEventListener('click', (e) => {
      const detailBtn = e.target.closest('button[data-detail]');
      if (detailBtn) {
        e.stopPropagation();
        openDetail(Number(detailBtn.getAttribute('data-detail')));
        return;
      }
      const cb = e.target.closest('input[type="checkbox"]');
      if (cb) {
        toggleRev(Number(cb.getAttribute('data-rev')), cb.checked);
        renderSelected();
        return;
      }
      const tr = e.target.closest('tr[data-rev]');
      if (tr) {
        toggleRev(Number(tr.getAttribute('data-rev')));
        renderSelected();
      }
    });

    els.selectAll.addEventListener('change', () => {
      const vis = visibleEntries();
      const on = els.selectAll.checked;
      vis.forEach((e) => toggleRev(e.revision, on));
      renderSelected();
    });

    els.selectedChips.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-rev]');
      if (btn) {
        toggleRev(Number(btn.getAttribute('data-rev')), false);
        renderSelected();
      }
    });

    els.commitMsg.addEventListener('input', () => { commitMsgDirty = true; });
    els.sourceInput.addEventListener('change', () => { if (!commitMsgDirty) updateCommitMsg(); });

    els.btnUpdate.addEventListener('click', doUpdate);
    els.btnDryRun.addEventListener('click', () => doMerge(true));
    els.btnMerge.addEventListener('click', () => doMerge(false));
    els.btnStatus.addEventListener('click', doStatus);
    els.btnDiff.addEventListener('click', doDiff);
    els.btnRevert.addEventListener('click', doRevert);
    els.btnCleanup.addEventListener('click', doCleanup);
    els.btnCommit.addEventListener('click', doCommit);
  }

  async function init() {
    bindEvents();
    await refreshSvnStatus();
    await loadHistory({ applyLast: true });
    if (els.targetInput.value.trim()) refreshTargetInfo();
    renderLog();
    renderSelected();
    updateCompareButton();
  }

  init();
})();
