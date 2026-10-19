# 从零安装（含 DeepSeek Harness 本体）

这份指南带你在一台**全新的电脑**上装好 DeepSeek Harness（dsh）和本插件（论文伴读 + 精读），按顺序复制命令即可。全程大约 10~15 分钟，主要花在下载上。

本 fork 的改动都在 `feat/close-reading` 分支：精读面板（子代理并行生成逐段翻译、分节点评、高中生版讲解、重点句）、扫描书支持（含 JBIG2 黑白扫描图显示）、阅读器排版瘦身、对话收进面板。

> **已验证的组合**：macOS（Apple Silicon）+ Node.js 26 + dsh `0.2.0-rc.2`。dsh 还在开发者预览期、版本间常有不兼容，**请照本文锁定版本**，不要直接装 `latest`。

---

## 目录

1. [准备：Node.js、git](#1-准备nodejsgit)
2. [安装 dsh 本体](#2-安装-dsh-本体)
3. [配置模型（DeepSeek / GitHub Copilot）](#3-配置模型)
4. [安装本插件](#4-安装本插件)
5. [启动与验证](#5-启动与验证)
6. [（可选）从旧电脑迁移文献库](#6-可选从旧电脑迁移文献库)
7. [（可选）增强功能](#7-可选增强功能)
8. [更新与卸载](#8-更新与卸载)
9. [常见问题](#9-常见问题)

---

## 1. 准备：Node.js、git

需要 **Node.js ≥ 22.19**（或 24 及以上）和 **git**。

**macOS**（用 [Homebrew](https://brew.sh)）：

```bash
brew install node git
```

**Windows**：从 [nodejs.org](https://nodejs.org) 装 LTS 版（≥ 22.19），从 [git-scm.com](https://git-scm.com) 装 git。下文命令在 PowerShell 里运行即可。

**Linux**：用发行版包管理器或 [nvm](https://github.com/nvm-sh/nvm) 装 Node 22.19+ / 24+。

检查版本：

```bash
node -v
```

```bash
git --version
```

## 2. 安装 dsh 本体

有两种用法，**插件对两者都适用**。不确定就选 A。

| | A. 命令行 + 浏览器（推荐） | B. DSH Desktop App |
|---|---|---|
| 怎么开 | 终端里运行 `dsh web`，浏览器自动打开 | 双击 App |
| 适合 | 想和本指南完全一致、少踩坑 | 想要 Dock 图标、不想开终端 |
| 本插件安装方式 | 直接 `dsh plugin add` | 仍需 A 的命令行来装插件（见第 4 步） |

### A. 命令行 + 浏览器

```bash
npm install -g @deepseek-ai/dsh@0.2.0-rc.2 --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs
```

> `--allow-scripts` 是给 npm 11 及以上用的：新版 npm 默认拦截依赖的安装脚本，而 dsh 的终端（node-pty）和子进程能力需要它们。npm 10 及以下不认识这个参数也没关系，那些版本默认就会执行安装脚本。

dsh 的插件管理器用 pnpm 装插件，再装一个 pnpm：

```bash
npm install -g pnpm
```

检查：

```bash
dsh --version
```

应输出 `0.2.0-rc.2`。

### B. DSH Desktop App（社区版，Dataelem 出品）

1. 到 [DSH Desktop Releases](https://github.com/dataelement/dsh-desktop/releases) 下载 **v0.12.0**（内置 dsh `0.2.0-rc.2`，与本插件一致）：Apple Silicon 选 `dsh-desktop-mac-arm64.dmg`，Intel 选 `dsh-desktop-mac-x64.dmg`，Windows 选 x64 安装包。macOS 版有苹果签名与公证，双击即可。
2. 装好后**打开一次再退出**，让它初始化数据目录。
3. **仍然要按 A 装一遍命令行版**（用来往 App 里装本地插件）——两者共存没问题。

> 如果这台电脑之前在 `~/.dsh` 用过命令行版，DSH Desktop 首次启动会自动迁移配置，但可能只迁移了清单、没装全插件，表现为启动进入 Safe Mode。处理方法见[常见问题](#desktop-进入-safe-mode报-failed-to-read-overlay--cordispatchyml-enoent)。

## 3. 配置模型

精读和伴读对话都要一个模型。两种常见选择：

### DeepSeek 官方 API

运行 `dsh web`（App 用户直接打开 App），在 **设置 → Models** 里填 DeepSeek API Key，选模型。

### GitHub Copilot 订阅

装社区插件 [@inventec/dsh-copilot-auth](https://github.com/iasiv5/dsh-copilot-auth)（**锁定 1.2.20**，npm 上没有更高的版本）：

```bash
dsh plugin --profile web add @inventec/dsh-copilot-auth@1.2.20
```

（App 用户：先退出 App，并把命令换成第 4 步 B 里带 `DSH_HOME` 的写法。）

重启 dsh 后：**设置 → GHC 设置 → 授权登录**，在 `https://github.com/login/device` 输入设备码（公司 SSO 账号要对组织点 **Authorize**）；回到 **Models** 页选 `GitHub Copilot` 路由和模型，并设为默认。

> 在第三方工具里使用 Copilot 订阅是否符合 GitHub 条款、是否符合公司政策，请自行确认。

## 4. 安装本插件

本插件的构建产物 `dist/` 不入库，所以要**克隆 + 构建**后按本地路径安装（**不要**用 `github:` 地址安装，profile 会起不来）。

```bash
git clone -b feat/close-reading https://github.com/patina27/dsh-paper-reader.git ~/dsh-paper-reader
```

```bash
cd ~/dsh-paper-reader && pnpm install && pnpm run build
```

> 如果之前装过 npm 版的原插件（`@ggboy123/dsh-paper-reader`），先移除，避免同名冲突：
>
> ```bash
> dsh plugin --profile web remove @ggboy123/dsh-paper-reader
> ```

### A. 命令行版

先停掉正在运行的 `dsh web`（在它的终端里按 Ctrl-C），然后：

```bash
dsh plugin --profile web add ~/dsh-paper-reader
```

### B. DSH Desktop App

**先完全退出 App**（macOS：菜单 → Quit，或 Cmd+Q），然后让命令行装进 App 的数据目录：

macOS：

```bash
DSH_HOME="$HOME/Library/Application Support/dsh-desktop/harness" dsh plugin --profile web add ~/dsh-paper-reader
```

Windows（PowerShell；App 数据目录通常在 `%APPDATA%\dsh-desktop`，以实际为准）：

```powershell
$env:DSH_HOME="$env:APPDATA\dsh-desktop\harness"; dsh plugin --profile web add "$HOME\dsh-paper-reader"
```

装完再打开 App。

> 插件是以 `link:` 方式装的：之后改代码或 `git pull`，只需重新 `pnpm run build` 并重启 dsh，不用重装。

## 5. 启动与验证

命令行版：

```bash
dsh web
```

它会打开浏览器（`http://127.0.0.1:3080/?token=…`）。**终端窗口不要关**，关了服务就停了。终端里应该能看到：

```
[dsh-paper-reader] registered tools: list_papers, transcribe_pdf, search_paper, study_progress, study_update
[dsh-paper-reader] routes registered under /paper-reader
```

验证清单：

1. 侧栏底部点 **📚 Paper Reading / 论文伴读**，侧栏变成文献库树。
2. 文献库里 **＋ 新建专题 → ⬆ 上传 PDF**，点开文献，PDF 出现在中间（扫描书的底图也应该正常显示）。
3. 阅读器顶栏点 **精读**，右侧出现一列，点 **生成精读**。几分钟内「译文 / 概括·点评 / 高中生版 / 重点」逐步出现，左侧原文上会有青绿色的重点句标记。
4. 精读面板的 **对话** 标签里提问，回答流式出现；回答里的页码可以点，点了在原文跳转。
5. 顶栏的对话按钮可以在「对话收进面板」和「右侧原生对话栏」之间切换。

## 6. （可选）从旧电脑迁移文献库

文献、转录缓存和已生成的精读结果都在插件自己的目录里（与 dsh 版本、App 还是命令行无关）：

- macOS / Linux：`~/.dsh-paper-reader/data/`
- Windows：`%USERPROFILE%\.dsh-paper-reader\data\`

把旧电脑的整个 `data` 目录拷到新电脑同一位置即可，精读结果（`<文献>.digest.json`）会直接显示，不用重新生成。

不会迁移的：伴读**对话记录**（存在 dsh 自己的会话库里）、模型登录凭据（需在新电脑重新登录）。

## 7. （可选）增强功能

- **纯图片扫描件**（PDF 里完全没有文字层）：需要 MinerU 做 OCR 后才能生成精读——**设置 → 论文伴读 → MinerU 解析后端**，选云端（[mineru.net](https://mineru.net) 的 token）或本地自建。带隐形 OCR 层的扫描书（多数图书馆/扫描仪导出的 PDF）不需要。
- **整篇 PDF 中文版 / 中英对照 / 划词翻译**：阅读器「⋯」菜单 → 翻译设置，填一个 OpenAI 兼容端点（DeepSeek / GLM / Kimi 的 key 都行）。这与精读的逐段翻译是两套东西，精读用的是 dsh 的默认模型。

功能细节与已知限制见 [docs/features.md](docs/features.md)。

## 8. 更新与卸载

更新到分支最新：

```bash
cd ~/dsh-paper-reader && git pull && pnpm install && pnpm run build
```

然后重启 dsh（命令行版 Ctrl-C 后重新 `dsh web`；App 退出重开）。

卸载插件（App 用户同样要先退出 App，并在命令前加 `DSH_HOME=…`）：

```bash
dsh plugin --profile web remove @ggboy123/dsh-paper-reader
```

文献库目录 `~/.dsh-paper-reader/` 不会被删除，需要的话手动删。

## 9. 常见问题

### `pnpm was not found`

```bash
npm install -g pnpm
```

### 安装 dsh 时出现一堆 `npm warn allow-scripts`，之后终端功能不能用

装 dsh 时漏了 `--allow-scripts`，按第 2 步 A 的完整命令重装一次即可。

### 页面提示 "Changes are saved and require restarting …"

改了设置或装了插件后，需要重启 dsh 本身（不是刷新浏览器）：命令行版在终端 Ctrl-C 再 `dsh web`；App 退出重开。重启后 token 会变，旧的浏览器标签要换成新打开的那个。

### 生成精读报 `Unknown agent preset: paper-digest`

插件没有作为 bundle 加载。检查：

```bash
dsh plugin --profile web list
```

应包含 `@ggboy123/dsh-paper-reader`；再确认 profile 目录（命令行版 `~/.dsh/profiles/web/package.json`）里 `dsh.profile.bundles` 包含它，然后重启 dsh。

### 生成精读失败：「子代理未返回结构化结果」

当前默认模型不支持工具调用（子代理要靠 `structured_output` 工具回传结果）。在 Models 页换一个支持工具调用的模型（如 DeepSeek 官方模型、Copilot 上的 Claude / GPT）后点「生成剩余全部」。

### 扫描书只显示文字或批注，底图一片空白

说明装的不是本分支（原插件缺 pdf.js 的 JBIG2 解码器）。确认克隆时带了 `-b feat/close-reading`，并且 `pnpm run build` 后重启了 dsh；浏览器强制刷新（Cmd+Shift+R）。

### 端口 3080 被占用

```bash
dsh web --port 3090
```

### Desktop 进入 Safe Mode，报 `failed to read overlay …/cordis.patch.yml: ENOENT`

DSH Desktop 从 `~/.dsh` 自动迁移时只复制了插件清单、没装全插件文件。修复：

1. 退出 App；
2. 用第 4 步 B 的 `DSH_HOME=…` 写法，把报错的插件重新装一遍（例如 Copilot 插件：`… dsh plugin --profile web add @inventec/dsh-copilot-auth@1.2.20`；本插件：`… add ~/dsh-paper-reader`）；
3. 重新打开 App。

**不要**点 Safe Mode 里推荐的「升级到 v1.2.21」：npm 上没有这个版本，会失败。

### 在 App 里，论文对话变成了「考官式」（只出题、不主动讲解）

原插件自带的「论文伴读」preset 在 DSH Desktop 里会被转成正式配置而生效（命令行版的 0.2 里它不生效，论文会话用的是 standard preset）。它会直接回答具体问题，但不会主动替你总结没读的内容，说「带我读」时会出题考你。目前没有界面开关可以切换；若更想要有问必答的风格，用命令行版即可。

### 两套 dsh（命令行版和 App）能同时开吗？

能。它们各有自己的数据目录、会话记录和端口；文献库（`~/.dsh-paper-reader/data`）是共用的。同一篇文献不要在两边同时点「生成精读」。
