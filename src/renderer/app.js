/* global window, document */
(() => {
  const api = window.quickTool;
  if (!api) {
    document.body.innerHTML = '<div style="padding:20px;color:#f88">preload 未加载，无法连接主进程。</div>';
    return;
  }

  const $ = (id) => document.getElementById(id);
  const els = {
    search: $('searchInput'),
    btnRefresh: $('btnRefresh'),
    btnOpenDir: $('btnOpenDir'),
    btnScreenshot: $('btnScreenshot'),
    btnGifCapture: $('btnGifCapture'),
    btnVideoToGif: $('btnVideoToGif'),
    btnAdbLog: $('btnAdbLog'),
    btnDeviceFiles: $('btnDeviceFiles'),
    btnSvnPick: $('btnSvnPick'),
    btnOpenDirEmpty: $('btnOpenDirEmpty'),
    groups: $('groups'),
    empty: $('empty'),
    scriptsPathLabel: $('scriptsPathLabel'),
    statusText: $('statusText'),
    scriptCount: $('scriptCount'),
    toast: $('toast'),
  };

  let allScripts = [];
  // 状态：scriptId -> { status, runId, exitCode, endedAt }
  const runState = new Map();
  let toastTimer = null;

  function showToast(message, kind = 'info', duration = 2200) {
    els.toast.textContent = message;
    els.toast.className = 'toast show' + (kind ? ' ' + kind : '');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove('show');
    }, duration);
  }

  function setStatus(text) {
    els.statusText.textContent = text;
  }

  function updateCaptureStatus(status) {
    const recording = !!(status && status.gifRecording);
    if (els.btnGifCapture) {
      els.btnGifCapture.classList.toggle('recording', recording);
      els.btnGifCapture.title = recording ? '停止 GIF 录制' : '开始 GIF 录制';
    }
    if (recording) setStatus('GIF 正在录制，再次点击 GIF 按钮停止');
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function extLabel(ext) {
    return ext.replace('.', '');
  }

  function iconText(name) {
    const ch = (name || '?').trim().charAt(0).toUpperCase();
    return ch || '?';
  }

  function filterScripts(query) {
    const q = query.trim().toLowerCase();
    if (!q) return allScripts;
    return allScripts.filter((s) =>
      s.name.toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q) ||
      (s.category || '').toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q),
    );
  }

  function groupBy(items) {
    const map = new Map();
    for (const item of items) {
      const key = item.category || '未分类';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(item);
    }
    // 「未分类」永远排到最后
    return [...map.entries()].sort(([a], [b]) => {
      if (a === '未分类') return 1;
      if (b === '未分类') return -1;
      return a.localeCompare(b, 'zh');
    });
  }

  function statusOf(scriptId) {
    const s = runState.get(scriptId);
    return s ? s.status : 'idle';
  }

  function statusLabel(scriptId) {
    const s = runState.get(scriptId);
    if (!s) return '未运行';
    switch (s.status) {
      case 'running': return '运行中…';
      case 'success': return `成功 · 退出码 ${s.exitCode ?? 0}`;
      case 'failed': return `失败 · 退出码 ${s.exitCode}`;
      case 'error': return '启动失败';
      default: return '未运行';
    }
  }

  function render() {
    const filtered = filterScripts(els.search.value);
    els.scriptCount.textContent = `共 ${allScripts.length} 个脚本${filtered.length !== allScripts.length ? ` · 显示 ${filtered.length}` : ''}`;

    if (allScripts.length === 0) {
      els.empty.classList.remove('hidden');
      els.groups.innerHTML = '';
      return;
    }
    els.empty.classList.add('hidden');

    const groups = groupBy(filtered);
    if (groups.length === 0) {
      els.groups.innerHTML = `<div class="empty"><div class="empty-tip">没有匹配 "<b>${escapeHtml(els.search.value)}</b>" 的脚本</div></div>`;
      return;
    }

    const html = groups.map(([category, items]) => {
      const cards = items.map((s) => {
        const status = statusOf(s.id);
        return `
          <div class="card" data-id="${escapeHtml(s.id)}" title="${escapeHtml(s.path)}">
            <div class="card-header">
              <div class="card-icon">${escapeHtml(iconText(s.name))}</div>
              <div class="card-name">${escapeHtml(s.name)}</div>
              <div class="card-ext">${escapeHtml(extLabel(s.ext))}</div>
            </div>
            <div class="card-desc">${escapeHtml(s.description || ' ')}</div>
            <div class="card-footer">
              <span class="card-status">
                <span class="status-dot ${status}"></span>
                <span class="status-text">${escapeHtml(statusLabel(s.id))}</span>
              </span>
              <button class="card-action" data-action="reveal" data-id="${escapeHtml(s.id)}" title="在文件管理器中打开">📍</button>
            </div>
          </div>
        `;
      }).join('');
      return `
        <div class="group">
          <div class="group-title">${escapeHtml(category)} · ${items.length}</div>
          <div class="cards">${cards}</div>
        </div>
      `;
    }).join('');

    els.groups.innerHTML = html;
  }

  async function loadScripts() {
    setStatus('正在扫描脚本…');
    try {
      allScripts = await api.listScripts();
      setStatus(`已加载 ${allScripts.length} 个脚本`);
      render();
    } catch (e) {
      console.error(e);
      setStatus('扫描脚本失败：' + e.message);
    }
  }

  async function runScript(id) {
    const target = allScripts.find((s) => s.id === id);
    if (!target) return;

    runState.set(id, { status: 'running', runId: null });
    render();
    setStatus(`启动: ${target.name}`);
    try {
      const result = await api.runScript(id);
      if (!result || !result.ok) {
        runState.set(id, { status: 'error', error: result && result.error });
        showToast(`启动失败: ${target.name}${result && result.error ? '\n' + result.error : ''}`, 'error');
        render();
        return;
      }
      runState.set(id, { status: 'running', runId: result.runId });
      showToast(`已启动: ${target.name}`, 'success');
      render();
    } catch (e) {
      runState.set(id, { status: 'error', error: e.message });
      showToast(`启动出错: ${e.message}`, 'error');
      render();
    }
  }

  function bindEvents() {
    els.search.addEventListener('input', render);

    els.btnRefresh.addEventListener('click', () => {
      loadScripts();
      showToast('已刷新');
    });

    els.btnOpenDir.addEventListener('click', () => api.openScriptsDir());
    els.btnOpenDirEmpty.addEventListener('click', () => api.openScriptsDir());
    if (els.btnScreenshot) {
      els.btnScreenshot.addEventListener('click', async () => {
        setStatus('准备截图选区…');
        const result = await api.captureScreenshot();
        if (!result || !result.ok) {
          showToast(`截图失败: ${result && result.error ? result.error : '未知错误'}`, 'error', 3500);
        }
      });
    }
    if (els.btnGifCapture) {
      els.btnGifCapture.addEventListener('click', async () => {
        const wasRecording = els.btnGifCapture.classList.contains('recording');
        setStatus(wasRecording ? '正在停止 GIF 录制…' : '准备 GIF 录制选区…');
        const result = await api.toggleGifCapture();
        if (!result || !result.ok) {
          showToast(`GIF 操作失败: ${result && result.error ? result.error : '未知错误'}`, 'error', 3500);
        } else if (wasRecording) {
          setStatus(result.finalizing ? 'GIF 录制已停止，正在生成预览…' : 'GIF 录制已停止');
        }
        try {
          updateCaptureStatus(await api.getCaptureStatus());
        } catch (_) {}
      });
    }
    if (els.btnVideoToGif) {
      els.btnVideoToGif.addEventListener('click', async () => {
        setStatus('选择视频文件…');
        const result = await api.convertVideoToGif();
        if (result && result.cancelled) {
          setStatus('已取消视频转 GIF');
        } else if (!result || !result.ok) {
          showToast(`视频转 GIF 失败: ${result && result.error ? result.error : '未知错误'}`, 'error', 4000);
          setStatus('视频转 GIF 失败');
        } else {
          setStatus('视频转 GIF 完成');
        }
      });
    }
    if (els.btnAdbLog) {
      els.btnAdbLog.addEventListener('click', () => api.openLogWindow());
    }
    if (els.btnDeviceFiles) {
      els.btnDeviceFiles.addEventListener('click', () => api.openDeviceFilesWindow());
    }
    if (els.btnSvnPick) {
      els.btnSvnPick.addEventListener('click', () => api.openSvnPickWindow());
    }

    els.groups.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        const id = actionBtn.getAttribute('data-id');
        if (actionBtn.getAttribute('data-action') === 'reveal') {
          api.revealScript(id);
        }
        return;
      }
      const card = e.target.closest('.card');
      if (card) {
        const id = card.getAttribute('data-id');
        runScript(id);
      }
    });

    api.onScriptsChanged(() => {
      loadScripts();
    });

    api.onRunEvent((event) => {
      if (!event) return;
      if (event.type === 'start') {
        const r = event.record;
        runState.set(r.scriptId, { status: 'running', runId: r.runId });
        render();
      } else if (event.type === 'end') {
        const r = event.record;
        const status = r.status; // success / failed / error
        runState.set(r.scriptId, { status, runId: r.runId, exitCode: r.exitCode, endedAt: r.endedAt });
        const item = allScripts.find((s) => s.id === r.scriptId);
        const name = item ? item.name : r.scriptId;
        if (status === 'success') {
          showToast(`完成: ${name}`, 'success');
        } else if (status === 'failed') {
          showToast(`失败: ${name} (退出码 ${r.exitCode})`, 'error', 3500);
        } else {
          showToast(`错误: ${name} - ${r.error || '未知错误'}`, 'error', 3500);
        }
        render();
      }
    });

    if (api.onCaptureStatus) {
      api.onCaptureStatus(updateCaptureStatus);
    }
  }

  async function init() {
    bindEvents();
    try {
      const dir = await api.getScriptsDir();
      els.scriptsPathLabel.textContent = dir;
    } catch (_) {}
    try {
      updateCaptureStatus(await api.getCaptureStatus());
    } catch (_) {}
    await loadScripts();
  }

  init();
})();
