# QuickTool

> 常驻系统托盘的轻量级脚本启动器。把你写的脚本扔进 `scripts/` 目录，UI 自动出现一个入口，点一下就跑。

完整愿景见 `[VISION.md](./VISION.md)`。

## 快速开始

需要本机已安装 [Node.js](https://nodejs.org/) 18+ 和 npm。

```powershell
# 第一次拉下来
npm install

# 启动（会显示主窗口 + 托盘图标）
npm start
```

启动后：

- **左键单击托盘图标**：在主窗口和隐藏之间切换。
- **双击托盘图标**：始终显示主窗口。
- **右键托盘图标**：显示菜单（打开主窗口 / 打开脚本目录 / 刷新 / 退出）。
- **关闭主窗口**：只是隐藏，应用仍在托盘运行。要彻底退出请用右键菜单的「退出」。

## 添加脚本

1. 打开 `scripts/` 目录（也可以在托盘右键菜单里点「打开脚本目录」）。
2. 把脚本扔进去，支持 `.ps1` / `.bat` / `.cmd` / `.py` / `.exe` / `.js`。
3. UI 会**自动刷新**（无需重启），脚本立刻出现在面板里。

### 元信息（可选）

在脚本同目录下放一个**同名 `.meta.json`** 即可美化显示：

```json
{
  "name": "清理临时文件",
  "description": "删除 %TEMP% 下 7 天前的文件",
  "category": "系统维护",
  "console": "show",
  "hidden": false
}
```

字段说明：


| 字段            | 说明                       |
| ------------- | ------------------------ |
| `name`        | 显示名（缺省用文件名）                                                                                          |
| `description` | 描述文字                                                                                                  |
| `category`    | 分组（缺省用所在子目录名，根目录归为「未分类」）                                                                              |
| `console`     | 控制台模式（默认 `show`）：`show` = 弹窗口、结束自动关（≈双击）；`keep` = 弹窗口、结束保留；`hidden` = 后台静默运行，stdout/stderr 由 QuickTool 捕获 |
| `hidden`      | 是否在 UI 中隐藏（缺省 false）                                                                                  |


> 也可以直接用子目录来分组——`scripts/系统维护/clean.ps1` 会自动归到「系统维护」分组下。

## 设备日志分析（Android & HarmonyOS）

内置一个独立的日志分析窗口，**Android（adb logcat）和 HarmonyOS（hdc hilog）共用同一套 UI**，顶部下拉随时切换平台。打开方式：

- 主窗口顶栏的 **📱** 按钮
- 系统托盘右键菜单的 **「设备日志分析（adb / hdc）」**

**前置条件**（按需准备其一即可）：

| 平台         | 需要的命令行工具                                                                              | 默认查找方式                                                |
| ---------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Android    | [Android Platform Tools](https://developer.android.com/tools/releases/platform-tools) 中的 `adb`              | 系统 `PATH`，或诊断面板里手选 `adb.exe`                  |
| HarmonyOS  | DevEco Studio / OpenHarmony command-line-tools 中的 `hdc`                                | 系统 `PATH`，或诊断面板里手选 `hdc.exe`                   |

切到某个平台时如果工具不在 `PATH`：点窗口顶栏的 **ⓘ 诊断** → **「📁 选择 xxx.exe…」** 手动指定一次，每个平台的路径会**分别记住**，保存在 Electron `userData/settings.json`（键名分别为 `adbPath` / `hdcPath`）。

**支持的能力**（两个平台一致）：

- **设备选择**：自动列出连接设备，多设备可切换
  - Android：`adb devices -l`
  - HarmonyOS：`hdc list targets -v`
- **实时日志**：流式抓取并按级别上色（V/D/I/W/E/F），支持 **暂停 / 继续 / 清屏 / 清设备缓存**
  - Android：`adb -s SERIAL logcat -v threadtime`
  - HarmonyOS：`hdc -t SERIAL shell hilog`（默认输出格式与 threadtime 几乎一致，所以解析 / 高亮 / 摘要全部复用）
- **过滤组合**：Tag（多个用逗号或空格分隔）+ Level 阈值 + PID + 关键字胶囊（回车成片，前缀 `!` 表示排除，可切到正则模式）
- **包名 / Bundle 过滤**：输入包名后点 🎯 即可解析当前 PID 并锁定；点 📦 加载设备全部包名/Bundle 作为下拉候选
  - Android：`pm list packages` + `pidof` / `ps -A` 回退
  - HarmonyOS：`bm dump -a` + `pidof` / `ps -ef` 回退
- **智能高亮**：自动标记 `FATAL` / `AndroidRuntime` 崩溃、`ANR in …`、Java/Native 堆栈帧（`at xxx`、`Caused by:`），命中关键字也会高亮
- **VSCode 风格搜索**：`Ctrl+F` 在当前视图内搜索，支持区分大小写 / 全字 / 正则 / `Enter`、`Shift+Enter` 上下跳
- **保存 / 导入**：把当前过滤后的日志保存为 `.log` 文件；也可以导入已有日志做离线分析（无需连接设备）
- **一键摘要**：📊 按钮展开汇总面板：各级别计数、Top Tag / Top PID、最近 Crash 与 ANR 列表（可点「跳转」回到原行）

切换平台时，当前流会自动停止、视图缓冲会清空，再按新平台拉一遍设备列表，互不干扰。

> 内存策略：日志缓冲最多保留约 50,000 行，DOM 最多渲染 5,000 行，超出自动丢弃最早的，避免长时间抓日志卡死 UI。

## 真机文件浏览器（Android & HarmonyOS）

日志工具同级增加了一个独立的真机文件浏览器，打开方式：

- 主窗口顶栏的 **🗂** 按钮
- 系统托盘右键菜单的 **「真机文件浏览器（adb / hdc）」**

它复用日志工具的 Android / HarmonyOS 平台配置和诊断能力，`adb.exe` / `hdc.exe` 路径仍然保存在同一组 `adbPath` / `hdcPath` 设置里。支持：

- 切换 Android（adb）/ HarmonyOS（hdc）和多设备
- Android：浏览真机目录、输入路径直达、面包屑跳转、上级 / 根目录 / 刷新
- HarmonyOS：选择 / 输入 Bundle Name 后，通过 `hdc shell -b <bundleName>` 浏览应用沙箱，默认路径为 `data/storage/el2/base`
- 双击目录进入，选中文件或目录后拉取到本地

> HarmonyOS 普通真机不允许 `hdc` 像 Android 一样浏览整棵文件系统；应用沙箱浏览依赖 `hdc shell/file -b <bundleName>`，通常只对可调试应用有效。如果选择系统应用或非调试包，设备可能返回 `Invalid bundle name` / `Permission denied`。

## SVN Cherry-pick 可视化

把「`svn merge -c <rev> --ignore-ancestry` 跨分支拣选提交」做成可视化界面，让你能从一个 SVN 目录把某些 revision pick 到另一个 SVN 工作副本。打开方式：

- 主窗口顶栏的 **⇄** 按钮
- 系统托盘右键菜单的 **「SVN Cherry-pick」**

**前置条件**：本机安装命令行 `svn`（TortoiseSVN 勾选 command line client tools，或 SlikSVN）。如果不在系统 `PATH`，点窗口左上角 **ⓘ 诊断** → **「📁 选择 svn 可执行文件…」** 手动指定一次，路径保存在 Electron `userData/settings.json`（键名 `svnPath`）。

**对应的命令行流程**（界面只是把它图形化）：

```powershell
# 1. 更新目标工作副本
svn update "目标目录"

# 2. cherry-pick（--ignore-ancestry 跳过所有 tracking 检查）
svn merge -c <revision号> --ignore-ancestry <来源分支URL> "目标目录"

# 3. 确认无误后提交
svn commit "目标目录" -m "cherry-pick r<revision号> from xxx"
```

**使用步骤**：

1. **来源分支**：填要 pick 提交的来源分支 URL（`svn merge` 的来源）。点「从目标推断」可先填入目标当前分支 URL 再改成来源分支。
2. **目标副本**：点「浏览…」选本地的目标 SVN 工作副本目录；下方会显示它当前的 `r版本 · URL`。
3. 点 **「加载日志」**（`svn log --xml`）列出来源分支最近的提交，可用右上角输入框按 revision / 作者 / 信息关键字过滤。
4. **勾选**要 pick 的一个或多个 revision（多选会合并成 `-c r1,r2,r3`）。
5. 右侧操作区：
   - **① 更新目标** = `svn update`
   - **② 预演合并** = `svn merge --dry-run`（不改动工作副本，先看会动哪些文件 / 有无冲突）
   - **③ 更新并合并** = 先 `svn update` 再 `svn merge -c ... --ignore-ancestry --accept postpone`
   - **查看改动 / 查看 diff** = `svn status` / `svn diff`
   - **撤销改动** = `svn revert -R`（合并后还没提交、想重来时用）
   - **cleanup** = `svn cleanup`
6. 确认无误后，在 **④ 提交** 区检查自动生成的提交信息（`cherry-pick r... from 来源名`，可改），点 **「提交到 SVN」** = `svn commit`。

> 合并若出现冲突（输出里有 `C` 开头的行），界面会提示「存在冲突」。冲突需要你用编辑器 / TortoiseSVN 手动解决后再提交；本工具用 `--accept postpone` 不自动解决冲突，避免误操作。

## 项目结构

```
QuickTool/
├── package.json
├── VISION.md
├── README.md
├── scripts/                  # 你的脚本目录（可随意增删改）
│   ├── 示例-hello.ps1
│   └── 示例-hello.meta.json
└── src/
    ├── main/
    │   ├── index.js          # Electron 主进程入口
    │   ├── tray.js           # 系统托盘
    │   ├── scriptScanner.js  # 扫描 + 监听 scripts 目录
    │   ├── scriptRunner.js   # 执行脚本
    │   ├── settings.js       # 持久化配置（adb / hdc 路径等）
    │   ├── adbWindow.js      # 设备日志窗口（adb + hdc 共用）
    │   ├── deviceFilesWindow.js # 真机文件浏览器窗口（adb + hdc 共用）
    │   ├── svnPick.js        # SVN 命令封装（log / update / merge / commit 等）
    │   ├── svnPickWindow.js  # SVN Cherry-pick 窗口
    │   └── logPlatforms/     # 平台抽象层（共用 UI，分平台命令）
    │       ├── base.js       # execFile / spawn / 二进制查找等共用工具
    │       ├── android.js    # adb logcat 实现
    │       ├── harmony.js    # hdc hilog 实现
    │       └── index.js      # 平台注册 / 路由
    ├── preload/
    │   └── index.js          # 渲染进程的桥接 API（quickTool.log.*）
    └── renderer/
        ├── index.html        # 主窗口
        ├── style.css
        ├── app.js
        ├── adb-log.html      # 设备日志窗口（adb + hdc 共用）
        ├── adb-log.css
        ├── adb-log.js
        ├── device-files.html # 真机文件浏览器
        ├── device-files.css
        ├── device-files.js
        ├── svn-pick.html     # SVN Cherry-pick 可视化
        ├── svn-pick.css
        └── svn-pick.js
```

## 路线图

见 `[VISION.md](./VISION.md)` 第九章「里程碑」。当前进度：**M1 骨架跑通**（托盘 + 主窗口 + 列出脚本 + 点击运行 + 自动刷新）。