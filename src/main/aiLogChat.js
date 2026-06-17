/**
 * 日志 AI 对话：把 codebuddy agent SDK 接进 QuickTool 的设备日志窗口。
 *
 * 核心设计：
 *  - 不把日志一次性塞进对话上下文。把当前可见日志缓冲先 dump 到一个临时文件
 *    (`<tempDir>/current.log`)，再让 SDK Session 把 cwd 锁到这个目录；
 *    agent 用自带的 Read / Grep / Glob 工具按需切片读取。
 *  - 后续流入的日志由渲染端持续推过来，append 到 current.log 末尾，agent 想看
 *    "最新" 时再 Read 文件尾部即可。
 *  - 每个 ADB 日志窗口一次只持有一个 chat 实例；窗口关 / 切平台时 close。
 */

const { unstable_v2_createSession } = require('@tencent-ai/agent-sdk');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const settings = require('./settings');

const DEFAULT_MODEL_PREF = 'opus4.7';

/** 需要透传给 SDK 子进程的 CodeBuddy 环境变量 */
const CODEBUDDY_ENV_KEYS = [
  'CODEBUDDY_API_KEY',
  'CODEBUDDY_AUTH_TOKEN',
  'CODEBUDDY_CODE_PATH',
  'CODEBUDDY_INTERNET_ENVIRONMENT',
];

/**
 * 组装 SDK 子进程环境变量。
 * Electron 从桌面快捷方式启动时通常继承不到终端里的 export，
 * 因此 iOA / 中国版必须在这里显式注入 CODEBUDDY_INTERNET_ENVIRONMENT。
 */
function buildSdkEnv() {
  const env = {};
  for (const k of CODEBUDDY_ENV_KEYS) {
    if (process.env[k]) env[k] = process.env[k];
  }
  if (!env.CODEBUDDY_INTERNET_ENVIRONMENT) {
    // 默认 ioa；可在 userData/settings.json 里用 codebuddyInternetEnvironment 覆盖
    env.CODEBUDDY_INTERNET_ENVIRONMENT = settings.get('codebuddyInternetEnvironment', 'ioa');
  }
  return env;
}

/** Session 公共选项（cwd 由调用方指定） */
function createBaseSdkOpts(cwd) {
  return {
    cwd,
    env: buildSdkEnv(),
    permissionMode: 'bypassPermissions',
    canUseTool: async (_toolName, input) => ({
      behavior: 'allow',
      updatedInput: input,
    }),
  };
}

class AiLogChat {
  /**
   * @param {object} opts
   * @param {string} opts.workDir    工作目录（current.log + meta.json 落在这里）
   * @param {string} [opts.model]    模型 id；空字符串 / undefined 走 CLI 默认
   * @param {(text:string)=>void} [opts.log] 调试日志（接到 main 进程 stderr）
   * @param {(ev:object)=>void} [opts.onEvent] 流事件回调（推给 renderer）
   * @param {object} [opts.context]  会话上下文（platform/device 等）
   */
  constructor(opts) {
    this.workDir = opts.workDir;
    this.model = opts.model || '';
    this.log = opts.log || (() => {});
    this.onEvent = opts.onEvent || (() => {});
    this.context = opts.context || {};
    this.closed = false;
    this.connected = false;
    this.connectPromise = null;
    this.inFlight = false;
    this.streamAbort = false;

    const sdkOpts = {
      ...createBaseSdkOpts(this.workDir),
      systemPrompt: { append: buildSystemPrompt(this.context) },
      includePartialMessages: true,
    };
    if (this.model) sdkOpts.model = this.model;

    this.sdk = unstable_v2_createSession(sdkOpts);
  }

  get sessionId() {
    return this.sdk.sessionId;
  }

  /** 幂等的 connect */
  async _connect() {
    if (this.connected) return;
    if (!this.connectPromise) {
      this.connectPromise = this.sdk.connect().then(
        () => { this.connected = true; },
        (err) => { this.connectPromise = null; throw err; },
      );
    }
    return this.connectPromise;
  }

  /**
   * 发一条用户消息并把流事件通过 onEvent 推出去。
   * 同一时刻只允许一个轮次。
   */
  async send(text) {
    if (this.closed) {
      this.onEvent({ type: 'error', message: '会话已关闭，请新建一个对话' });
      this.onEvent({ type: 'done' });
      return;
    }
    if (this.inFlight) {
      this.onEvent({ type: 'error', message: '上一轮还在进行中，先中断再发送' });
      this.onEvent({ type: 'done' });
      return;
    }
    this.inFlight = true;
    this.streamAbort = false;

    try {
      await this._connect();
    } catch (err) {
      this.inFlight = false;
      this.onEvent({ type: 'error', message: `AI 初始化失败：${describeError(err)}` });
      this.onEvent({ type: 'done' });
      return;
    }

    this.onEvent({ type: 'turn_start' });

    try {
      await this.sdk.send(text);
    } catch (err) {
      this.inFlight = false;
      this.onEvent({ type: 'error', message: `发送失败：${describeError(err)}` });
      this.onEvent({ type: 'done' });
      return;
    }

    try {
      for await (const msg of this.sdk.stream()) {
        if (this.streamAbort) break;
        for (const ev of translateSdkMessage(msg)) {
          this.onEvent(ev);
        }
      }
    } catch (err) {
      this.onEvent({ type: 'error', message: `推理异常：${describeError(err)}` });
    } finally {
      this.inFlight = false;
      this.onEvent({ type: 'done' });
    }
  }

  async interrupt() {
    this.streamAbort = true;
    if (!this.connected) return;
    try { await this.sdk.interrupt(); } catch (_) { /* 状态机问题，吞掉 */ }
  }

  async setModel(model) {
    if (!model || !model.trim()) throw new Error('model 不能为空');
    if (this.closed) throw new Error('会话已关闭');
    await this._connect();
    await this.sdk.setModel(model);
    this.model = model;
  }

  async listModels() {
    if (this.closed) throw new Error('会话已关闭');
    await this._connect();
    return this.sdk.getAvailableModels();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.sdk.close(); } catch (_) { /* ignore */ }
  }
}

/* -------------------------------------------------------------------------- */
/* 系统 Prompt                                                                 */
/* -------------------------------------------------------------------------- */

function buildSystemPrompt(ctx) {
  const lines = [
    '# 设备日志分析助手',
    '',
    '你是一名熟悉 Android（logcat）和 HarmonyOS（hilog）日志的工程师，正在帮用户分析当前抓取到的日志。',
    '',
    '## 重要规则（必须遵守）',
    '- 当前工作目录里有一个 `current.log` 文件，里面是全部待分析的日志。',
    '- **绝对不要一次性 Read 整个 `current.log`**——它可能成千上万行。优先用 `Grep` 按关键字、tag、PID、异常字样定位行号，再用带 `offset` / `limit` 的 `Read` 读对应片段。',
    '- 文件会被实时追加新行，必要时可以再次 Grep / Read 末尾。',
    '- `meta.json` 是会话元信息（平台、设备、当前过滤条件、时间戳），可以先读它了解上下文。',
    '',
    '## 推荐排查流程',
    '1. 先 `Read meta.json` 了解平台 / 设备 / 当前过滤条件。',
    '2. 用 `Grep` 搜 `FATAL`、`AndroidRuntime`、`ANR in`、`Caused by`、`E/`、用户提到的 tag/包名等。',
    '3. 命中后用 `Read current.log --offset N --limit 80` 读上下文。',
    '4. 综合多次检索的片段做归因，给出结论 + 关键行号。',
    '',
    '## 输出风格',
    '- 用简体中文，简洁但抓重点；可以用 Markdown 列表 / 表格 / 代码块。',
    '- 引用日志行时贴关键片段，不要整段倾倒；标出来源（行号或时间戳）。',
    '- 没找到证据就直说"日志里没有相关信息"，不要编造。',
    '',
    '## 当前会话上下文',
    `- 平台：\`${ctx.platform || '未知'}\``,
    `- 设备：\`${ctx.device || '未连接'}\``,
    `- 包名：\`${ctx.packageName || '(未指定)'}\``,
    `- 锁定 PID：\`${ctx.pid || '(未锁定)'}\``,
    `- 时间：\`${ctx.timestamp || new Date().toISOString()}\``,
  ];
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* SDK Message → 渲染端事件 翻译                                              */
/* -------------------------------------------------------------------------- */

function translateSdkMessage(msg) {
  switch (msg.type) {
    case 'assistant':
      return translateAssistant(msg);
    case 'stream_event':
      return translatePartial(msg);
    case 'user':
      return translateUserToolResult(msg);
    case 'result':
      return [translateResult(msg)];
    case 'error':
      return [{ type: 'error', message: msg.error }];
    default:
      return [];
  }
}

function translateAssistant(msg) {
  const out = [];
  for (const block of msg.message.content) {
    if (block.type === 'tool_use') {
      out.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }
  return out;
}

function translatePartial(msg) {
  const ev = msg.event;
  if (!ev || ev.type !== 'content_block_delta') return [];
  const d = ev.delta;
  if (!d) return [];
  if (d.type === 'text_delta') {
    return d.text ? [{ type: 'text_delta', text: d.text }] : [];
  }
  if (d.type === 'thinking_delta') {
    return d.thinking ? [{ type: 'thinking', text: d.thinking }] : [];
  }
  return [];
}

function translateUserToolResult(msg) {
  const out = [];
  const content = msg.message.content;
  if (typeof content === 'string') return out;
  for (const block of content) {
    if (block.type === 'tool_result') {
      out.push({
        type: 'tool_result',
        id: block.tool_use_id,
        content: stringifyToolResultContent(block.content),
        isError: !!block.is_error,
      });
    }
  }
  return out;
}

function translateResult(msg) {
  if (msg.subtype === 'success') {
    return {
      type: 'turn_end',
      success: true,
      durationMs: msg.duration_ms,
      totalCostUsd: msg.total_cost_usd,
      numTurns: msg.num_turns,
    };
  }
  return {
    type: 'turn_end',
    success: false,
    durationMs: msg.duration_ms,
    totalCostUsd: msg.total_cost_usd,
    numTurns: msg.num_turns,
    errors: msg.errors,
  };
}

function stringifyToolResultContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else {
        parts.push(`[${block.type || 'unknown'} block]`);
      }
    }
    return parts.join('\n');
  }
  if (content == null) return '';
  return String(content);
}

function describeError(err) {
  if (err && err.message) return err.message;
  return String(err);
}

/* -------------------------------------------------------------------------- */
/* 全局管理器：单实例，跟 adbWindow 生命周期挂钩                              */
/* -------------------------------------------------------------------------- */

const TEMP_ROOT = path.join(os.tmpdir(), 'QuickTool-ai');
const PROBE_DIR = path.join(TEMP_ROOT, '_probe');
const LOG_FILE_NAME = 'current.log';
const META_FILE_NAME = 'meta.json';
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;

let activeChat = null;
let activeChatId = null;
let activeWorkDir = null;
/** 累计写入 current.log 的字节数，给 renderer 显示用 */
let writtenBytes = 0;
/** 探测得到的模型列表缓存 */
let modelsCache = null; // { models, fromSdk, fetchedAt }
let modelsInFlight = null;

function ensureRoot() {
  if (!fs.existsSync(TEMP_ROOT)) {
    fs.mkdirSync(TEMP_ROOT, { recursive: true });
  }
}

function freshWorkDir() {
  ensureRoot();
  const id = `chat_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(TEMP_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

function getActive() {
  return activeChat;
}

function getActiveInfo() {
  if (!activeChat) return null;
  return {
    id: activeChatId,
    workDir: activeWorkDir,
    logFile: path.join(activeWorkDir, LOG_FILE_NAME),
    bytes: writtenBytes,
  };
}

/**
 * 创建（或重建）一次 AI 会话。
 * 关键步骤：
 *   1. 新建临时目录
 *   2. 写 meta.json
 *   3. 写 current.log = 初始 dump
 *   4. new AiLogChat，cwd 锁住该目录
 */
async function create({ initialLog, context, model, onEvent, log }) {
  closeActive();

  const { id, dir } = freshWorkDir();
  const meta = {
    createdAt: new Date().toISOString(),
    ...context,
  };
  await fsp.writeFile(path.join(dir, META_FILE_NAME), JSON.stringify(meta, null, 2), 'utf8');

  const logFile = path.join(dir, LOG_FILE_NAME);
  const dump = typeof initialLog === 'string' ? initialLog : '';
  await fsp.writeFile(logFile, dump, 'utf8');
  writtenBytes = Buffer.byteLength(dump, 'utf8');

  const chat = new AiLogChat({
    workDir: dir,
    model,
    log,
    onEvent,
    context,
  });
  activeChat = chat;
  activeChatId = id;
  activeWorkDir = dir;
  return getActiveInfo();
}

/** 把渲染端推过来的新增日志追加到 current.log */
async function appendLog(chunk) {
  if (!activeChat || !activeWorkDir) return;
  if (!chunk) return;
  const file = path.join(activeWorkDir, LOG_FILE_NAME);
  try {
    await fsp.appendFile(file, chunk, 'utf8');
    writtenBytes += Buffer.byteLength(chunk, 'utf8');
  } catch (_) {
    // 文件被删 / 权限问题：放弃这一段，避免主进程崩
  }
}

async function send(text) {
  if (!activeChat) throw new Error('AI 会话尚未创建');
  await activeChat.send(text);
}

async function interrupt() {
  if (!activeChat) return;
  await activeChat.interrupt();
}

async function setModel(model) {
  if (!activeChat) throw new Error('AI 会话尚未创建');
  await activeChat.setModel(model);
}

/**
 * 拉一次 SDK 可用模型列表。
 *
 * 策略：临时起一个"探测会话"——cwd 用 PROBE_DIR，connect 后调 getAvailableModels()，
 * 完事立刻 close。结果缓存 1 小时，避免每次开面板都拉起一个 CLI 子进程。
 * 跟用户真正的对话会话完全解耦，所以用户没发消息前也能选模型。
 */
async function listModels(force = false) {
  if (!force && modelsCache) {
    const fresh = Date.now() - modelsCache.fetchedAt < MODELS_CACHE_TTL_MS;
    if (fresh) {
      return { models: modelsCache.models, fromSdk: modelsCache.fromSdk };
    }
  }
  if (modelsInFlight) return modelsInFlight;
  modelsInFlight = (async () => {
    ensureRoot();
    if (!fs.existsSync(PROBE_DIR)) {
      fs.mkdirSync(PROBE_DIR, { recursive: true });
    }
    let probe = null;
    try {
      probe = unstable_v2_createSession(createBaseSdkOpts(PROBE_DIR));
      await probe.connect();
      const raw = await probe.getAvailableModels();
      const list = Array.isArray(raw) ? raw.map((m) => ({
        modelId: m.modelId,
        name: m.name,
        description: m.description,
      })) : [];
      modelsCache = { models: list, fromSdk: true, fetchedAt: Date.now() };
      return { models: list, fromSdk: true };
    } catch (_err) {
      modelsCache = { models: [], fromSdk: false, fetchedAt: Date.now() };
      return { models: [], fromSdk: false };
    } finally {
      if (probe) { try { probe.close(); } catch (_) { /* ignore */ } }
    }
  })().finally(() => { modelsInFlight = null; });
  return modelsInFlight;
}

function closeActive() {
  if (activeChat) {
    try { activeChat.close(); } catch (_) { /* ignore */ }
  }
  // 主动清掉工作目录，避免临时文件堆积
  if (activeWorkDir) {
    try { fs.rmSync(activeWorkDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
  activeChat = null;
  activeChatId = null;
  activeWorkDir = null;
  writtenBytes = 0;
}

/** 健康检查：判定凭据是否就绪 */
function health() {
  const hasEnvCreds =
    !!process.env.CODEBUDDY_API_KEY || !!process.env.CODEBUDDY_AUTH_TOKEN;
  const hasLoginDir = fs.existsSync(path.join(os.homedir(), '.codebuddy'));
  const internetEnv = buildSdkEnv().CODEBUDDY_INTERNET_ENVIRONMENT || 'ioa';
  if (!hasEnvCreds && !hasLoginDir) {
    return {
      available: false,
      provider: 'codebuddy',
      internetEnvironment: internetEnv,
      reason:
        '未检测到 CodeBuddy 登录态：请在终端跑 `codebuddy` 完成登录，或设置 CODEBUDDY_API_KEY 环境变量后重启 QuickTool。',
    };
  }
  return {
    available: true,
    provider: 'codebuddy',
    internetEnvironment: internetEnv,
  };
}

module.exports = {
  DEFAULT_MODEL_PREF,
  health,
  create,
  appendLog,
  send,
  interrupt,
  setModel,
  listModels,
  getActive,
  getActiveInfo,
  closeActive,
};
