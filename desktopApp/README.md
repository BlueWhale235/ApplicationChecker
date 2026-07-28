# Application Checker Desktop

职迹的 Windows 便携桌面版，使用 .NET 10 WPF 和 Microsoft Edge WebView2。

桌面外壳负责启动内置 API 与 Runner，并在 WebView2 中加载 Vue 前端。API 和 Runner 使用 ncc 编译为独立 JavaScript bundle，发布包不包含业务 `node_modules`。

## 系统要求

### 使用便携版

- Windows 10 或 Windows 11 x64
- Microsoft Edge
- Microsoft Edge WebView2 Runtime
- Microsoft .NET 10 Desktop Runtime x64

便携版不携带 .NET/WPF Runtime，但自带固定版本的 Node.js，无需安装 Docker、WSL 或系统 Node.js。

缺少 .NET 10 Desktop Runtime 时，`ApplicationChecker.exe` 的 AppHost 会显示缺失框架信息和官方下载链接。也可以使用 WinGet 安装：

```powershell
winget install Microsoft.DotNet.DesktopRuntime.10
```

官方页面：<https://dotnet.microsoft.com/download/dotnet/10.0>

### 从源码构建

- Node.js `v24.18.0` LTS
- pnpm `11.2.2`
- .NET 10 SDK
- PowerShell（Windows PowerShell 或 Linux 上的 PowerShell 7）

Node.js 版本必须与 `build-portable.ps1` 中的固定版本一致，否则 `better-sqlite3` 原生模块可能出现 ABI 不兼容。

## 构建

在仓库根目录执行：

```powershell
pnpm install
pnpm desktop:build
```

默认版本从仓库根目录的 `app-version.json` 读取。发布新版本时手动更新该文件；也可以通过参数临时覆盖：

```powershell
./desktopApp/build-portable.ps1 -BuildVersion v0.1.0
```

Linux 构建会交叉发布 WPF Windows x64 程序，并将原生 Node 模块重建为 Windows x64 二进制。

构建命令会执行：

1. TypeScript 类型检查和单元测试
2. Web、API 和 Runner 构建
3. API 与 Runner 的压缩 ncc bundle
4. .NET 10 WPF framework-dependent 发布
5. Node.js 运行时整理
6. 非必要 .NET 语言资源裁剪
7. Windows x64 便携 ZIP 打包

输出文件：

```text
desktopApp/artifacts/ApplicationChecker-portable-win-x64.zip
```

跳过类型检查和测试、只验证打包流程：

```powershell
powershell -ExecutionPolicy Bypass -File desktopApp/build-portable.ps1 -SkipChecks
```

### 只构建 internal

日常修改 Vue 前端、API、Runner 或本地识别器时，可以只重新生成桌面版的 `internal` 运行内容：

```powershell
pnpm desktop:build:internal
```

该命令会执行依赖恢复、类型检查、测试和工作区构建，然后只更新：

```text
desktopApp/.stage/ApplicationChecker/internal/
├─ api/
├─ runner/
└─ web/
```

它不会重新发布 .NET 桌面外壳、处理 Node.js 运行时或生成便携 ZIP，已有的 `internal/node` 也不会被删除。

依赖已经安装并且只是快速验证本次修改时，可以跳过依赖恢复、类型检查和测试：

```powershell
pnpm desktop:build:internal -- -SkipInstall -SkipChecks
```

指定其他 `internal` 输出目录：

```powershell
pnpm desktop:build:internal -- `
  -OutputPath "D:\ApplicationChecker\internal" `
  -SkipInstall `
  -SkipChecks
```

直接覆盖已解压应用的 `internal` 前，应先完全退出 Application Checker，避免 API、Runner 或原生 SQLite 模块仍被占用。完整发布和 GitHub Release 仍应使用 `pnpm desktop:build`。

## 使用

1. 解压 `ApplicationChecker-portable-win-x64.zip`。
2. 将应用放在具有写入权限的普通目录。
3. 双击 `ApplicationChecker.exe`。

不要直接在 ZIP 中运行，也不要放入需要管理员权限才能写入的 `Program Files`。

桌面版只允许一个实例运行。招聘网站需要人工登录时，Runner 会弹出独立的 Microsoft Edge 窗口。

岗位详情中的“查询链接”和“岗位链接”会使用 Windows 默认浏览器打开，不会在应用内的 WebView2 中加载。

## 数据目录

所有应用专属可变数据都保存在 EXE 同级的 `data`，不会写入应用专属的 `%LOCALAPPDATA%` 目录：

```text
data/
├─ application-checker.sqlite
├─ screenshots/
├─ runtime-settings.json
├─ desktop-settings.json
├─ webview2/
├─ browser/
├─ logs/
└─ tmp/
```

移动或备份整个应用目录即可同时迁移应用与数据。

不要让 Docker 版和桌面版同时读写同一个数据库。桌面版不会自动导入仓库根目录的 Docker 数据。

## 运行结构

```text
ApplicationChecker.exe
internal/
├─ api/       API bundle 与 SQLite 原生模块
├─ runner/    Puppeteer Runner bundle
├─ node/      精简 Node.js 运行时
└─ web/       Vue 静态资源
data/         本地业务数据与运行日志
runtimes/     WebView2 Windows 运行组件
zh-Hans/      简体中文卫星资源
```

## 图标

- 透明源图：`assets/app-icon.png`
- Windows 多尺寸图标：`assets/app-icon.ico`

ICO 包含 16、20、24、32、40、48、64、128 和 256 像素版本，并用于 EXE、任务栏和窗口标题栏。

## 故障排查

日志位置：

- `data/logs/desktop.log`
- `data/logs/api.log`
- `data/logs/runner.log`

如果提示本地服务启动失败，错误窗口会显示日志绝对路径及末尾错误内容。

需要临时查看 WebView2 控制台时，先完全退出应用，然后在应用目录打开 PowerShell 并执行：

```powershell
.\ApplicationChecker.exe --devtools
```

页面加载后按 `F12` 或 `Ctrl+Shift+I` 打开开发者工具。只有使用 `--devtools` 参数启动时调试快捷键才会启用；普通双击启动仍会禁用开发者工具。

常见检查项：

- 确认应用目录可写
- 确认 Edge 和 WebView2 Runtime 可用
- 确认已安装 .NET 10 Desktop Runtime x64
- 确认没有另一个 Application Checker 实例
- 确认 ZIP 已完整解压
- 从源码构建时确认 Node.js 为 `v24.18.0` LTS

## 发布边界

- 当前仅构建 Windows x64 便携版
- 不包含安装程序或自动更新
- 不内置 .NET/WPF Runtime，依赖系统 .NET 10 Desktop Runtime x64
- 不内置 Chromium，自动检查复用系统 Edge
- 英文为 .NET 主程序集的默认资源，额外仅保留 `zh-Hans`

## GitHub Release

仓库工作流 `.github/workflows/release-windows-portable.yml` 使用 Ubuntu 构建服务器，只接受手动触发，不会在 push、Pull Request 或创建 tag 时自动发布。输入的 Release 标签会作为构建版本编译进设置页；本地构建未传版本参数时使用 `app-version.json` 中的版本。

在 GitHub 仓库中打开 **Actions → Release Windows portable → Run workflow**：

1. 输入语义化版本标签，例如 `v0.1.0`
2. 按需填写 Release 标题
3. 选择是否为预发布或草稿
4. 勾选发布确认
5. 点击运行

工作流会执行完整测试与构建、上传短期 Actions Artifact，并将 `ApplicationChecker-portable-win-x64.zip` 添加到对应的 GitHub Release。
