# Application Checker Desktop

求职进度的 Windows 便携桌面版，使用 .NET 10 WPF 和 Microsoft Edge WebView2。

桌面外壳负责启动内置 API 与 Runner，并在 WebView2 中加载 Vue 前端。API 和 Runner 使用 ncc 编译为独立 JavaScript bundle，发布包不包含业务 `node_modules`。

## 系统要求

### 使用便携版

- Windows 10 或 Windows 11 x64
- Microsoft Edge
- Microsoft Edge WebView2 Runtime

便携版已自包含 .NET 10 Runtime 和固定版本的 Node.js，无需安装 Docker、WSL、系统 Node.js 或系统 .NET Runtime。

### 从源码构建

- Windows 10/11 x64
- Node.js `v24.18.0` LTS
- pnpm `11.2.2`
- .NET 10 SDK
- Microsoft Edge / WebView2 Runtime

Node.js 版本必须与 `build-portable.ps1` 中的固定版本一致，否则 `better-sqlite3` 原生模块可能出现 ABI 不兼容。

## 构建

在仓库根目录执行：

```powershell
pnpm install
pnpm desktop:build
```

构建命令会执行：

1. TypeScript 类型检查和单元测试
2. Web、API 和 Runner 构建
3. API 与 Runner 的 ncc bundle
4. .NET 10 WPF 自包含发布
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

## 使用

1. 解压 `ApplicationChecker-portable-win-x64.zip`。
2. 将应用放在具有写入权限的普通目录。
3. 双击 `ApplicationChecker.exe`。

不要直接在 ZIP 中运行，也不要放入需要管理员权限才能写入的 `Program Files`。

桌面版只允许一个实例运行。招聘网站需要人工登录时，Runner 会弹出独立的 Microsoft Edge 窗口。

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
runtimes/     .NET/WebView2 Windows 运行组件
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

常见检查项：

- 确认应用目录可写
- 确认 Edge 和 WebView2 Runtime 可用
- 确认没有另一个 Application Checker 实例
- 确认 ZIP 已完整解压
- 从源码构建时确认 Node.js 为 `v24.18.0` LTS

## 发布边界

- 当前仅构建 Windows x64 便携版
- 不包含安装程序或自动更新
- 不内置 Chromium，自动检查复用系统 Edge
- 英文为 .NET 主程序集的默认资源，额外仅保留 `zh-Hans`

## GitHub Release

仓库工作流 `.github/workflows/release-windows-portable.yml` 只接受手动触发，不会在 push、Pull Request 或创建 tag 时自动发布。

在 GitHub 仓库中打开 **Actions → Release Windows portable → Run workflow**：

1. 输入语义化版本标签，例如 `v0.1.0`
2. 按需填写 Release 标题
3. 选择是否为预发布或草稿
4. 勾选发布确认
5. 点击运行

工作流会执行完整测试与构建、上传短期 Actions Artifact，并将 `ApplicationChecker-portable-win-x64.zip` 添加到对应的 GitHub Release。
