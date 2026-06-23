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
    btnPickDir: $('btnPickDir'),
    logCount: $('logCount'),
    selectAll: $('selectAll'),
    logRows: $('logRows'),
    logEmpty: $('logEmpty'),
    selectedChips: $('selectedChips'),
    output: $('output'),
    commitMsg: $('commitMsg'),
    footerText: $('footerText'),
    busyText: $('busyText'),
    toast: $('toast'),
    btnUpdate: $('btnUpdate'),
    btnDryRun: $('btnDryRun'),
    btnMerge: $('btnMerge'),
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

  async function loadLog() {
    const source = requireSource();
    if (!source) return;
    setBusy(true, '加载日志…');
    setFooter('svn log ' + source);
    try {
      const limit = Number(els.limitInput.value) || 100;
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

    setBusy(true, dryRun ? '预演合并…' : '合并中…');
    try {
      if (!dryRun) {
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

  // ===== 事件绑定 =====
  function bindEvents() {
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
      }
    });

    els.btnPickSourceDir.addEventListener('click', async () => {
      const res = await api.pickDir();
      if (res && res.ok) {
        els.sourceInput.value = res.path;
        if (!commitMsgDirty) updateCommitMsg();
      }
    });
    els.targetInput.addEventListener('change', refreshTargetInfo);

    // 行点击 / 勾选
    els.logRows.addEventListener('click', (e) => {
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
  }

  init();
})();
