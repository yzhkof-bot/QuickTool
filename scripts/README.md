# scripts 目录

这是 QuickTool 默认扫描的脚本目录。

## 玩法

1. 把脚本放进来（支持 `.ps1` `.bat` `.cmd` `.py` `.exe` `.js`），UI 会**自动出现**新的卡片，无需重启应用。
2. 删除/重命名脚本，UI 也会**自动更新**。
3. 子目录会被当作分组，例如 `scripts/系统维护/clean.ps1` 会出现在「系统维护」分组下。

## 元信息（可选）

在脚本旁边放一个**同名 `.meta.json`**，例如 `hello.ps1` 配套 `hello.meta.json`：

```json
{
  "name": "显示名字",
  "description": "描述文字",
  "category": "分组名（覆盖目录分组）",
  "console": "show",
  "hidden": false
}
```

字段都可省略：

- `name`：缺省用文件名（去后缀）。
- `description`：缺省为空。
- `category`：缺省用所在子目录，根目录归为「未分类」。
- `hidden`：true 时不显示在 UI 中。
- `console`：控制台行为，三选一，**缺省为 `show`**：
  - `"show"`：弹出新的控制台窗口，脚本结束自动关闭——和**双击脚本**最接近。
  - `"keep"`：弹出新的控制台窗口，脚本结束**保留窗口**（PowerShell 加 `-NoExit`、bat 用 `cmd /k`），便于看完输出再手动关。
  - `"hidden"`：**后台运行**，不弹窗口；适合静默任务（清理、备份等）。后台模式下 stdout/stderr 由 QuickTool 捕获，但目前 UI 还没有输出查看面板（M4 计划）。

## 示例

本目录下已经放了两个示例：

- `hello.ps1` + `hello.meta.json`：打印一行问候语。
- `open-explorer.bat` + `open-explorer.meta.json`：打开当前目录。

可以删掉，也可以照着写自己的脚本。
