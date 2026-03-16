# ttPin

[![Release](https://img.shields.io/github/v/release/aristo7298sub/ttPin?display_name=tag&sort=semver)](https://github.com/aristo7298sub/ttPin/releases)
[![License](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue)](LICENSE)

<p align="center">
	<img src="apps/desktop/src-tauri/icons/128x128.png" width="96" alt="ttPin logo" />
</p>

高质量桌面翻译小组件：Tauri + React 打造的无边框翻译卡片，使用 Azure AI Foundry Translator (LLM)；自带本地生词本。

## 界面预览

![ttPin 主界面](docs/screenshots/main.png?v=1.1.0)

![ttPin 设置页](docs/screenshots/settings.png?v=1.1.0)

## 功能特性

- 🚀 快捷键唤出桌面翻译卡片
- 🎯 基于 Azure AI Foundry Translator (LLM) 的高质量翻译
- 🔊 语音合成（TTS）：支持句子/单词发音（选中优先，否则朗读全文）
- � 多种认证方式：API Key / Azure CLI (`az login`) / Entra ID 服务主体
- �📚 生词本管理（单词+翻译+例句+本地存储）
- 🌐 中英文界面切换
- 🔑 用户自配置 Azure 资源（密钥仅保存在本机，不会进入仓库或 Release）
- 💾 本地数据存储（无需联网同步）

## 技术栈

- **桌面应用**: Tauri + React + TypeScript
- **本地存储**: SQLite（生词本）
- **Azure服务**: Azure AI Foundry Translator (LLM) + Azure Speech TTS

> **注**: 当前发布版本为 MVP（纯客户端）。你可以直接下载可执行程序使用；也可以基于源码二次开发。

## 项目结构

```
ttPin/
├── apps/
│   ├── desktop/      # Tauri桌面应用（MVP主应用）
│   ├── backend/      # 后端API（未来扩展用）
│   └── admin/        # 管理后台（未来扩展用）
├── packages/
│   └── shared/       # 共享类型定义
└── 需求文档.md        # 需求文档
```

> MVP阶段专注开发 `apps/desktop`，backend和admin暂不实现。

## 快速开始

### 路径 A：终端用户（只想使用）

1. 打开 Releases 下载最新版：
	- https://github.com/aristo7298sub/ttPin/releases
2. Windows 推荐下载并安装：
	- `ttPin_*_x64-setup.exe`（NSIS 安装器）或 `ttPin_*_x64_en-US.msi`（MSI 安装器）
3. 启动 ttPin → 打开【设置】→ 填写你的 Azure 翻译配置：
	- 翻译端点（Translate Endpoint）
	- 认证方式：API Key / Azure CLI (`az login`) / Entra ID 服务主体（三选一）
	- 区域（Region）
	- AOAI 部署名称（AOAI Deployment Name，通常为 `gpt-4o` 或 `gpt-4o-mini`）
4. 使用快捷键 `Ctrl+Shift+T` 唤出翻译窗口。

> 配置指南见 [docs/azure-setup-guide.md](docs/azure-setup-guide.md)

### 路径 B：开发者（基于源码二次开发）

#### 环境要求

- Node.js >= 20
- Rust >= 1.70（用于 Tauri）
- Windows 建议安装：Visual Studio Build Tools（C++ 工具链）

#### 安装依赖

```bash
npm install
```

#### 启动开发版（桌面应用）

```bash
npm -w @ttpin/desktop run tauri:dev
```

#### 构建安装程序

```bash
npm -w @ttpin/desktop run tauri:build
```

#### 开发说明

- 当前 MVP 只依赖 `apps/desktop`（纯客户端，不需要启动后端/管理后台）
- 翻译配置通过应用内【设置】保存到本地，不会写入仓库，也不会被编译进 Release

更多架构与说明：

- [MVP_ARCHITECTURE.md](MVP_ARCHITECTURE.md)
- [DEVELOPMENT.md](DEVELOPMENT.md)
- [ARCHITECTURE.md](ARCHITECTURE.md)

## 使用方式

- **用户配置**: 在应用设置中配置自己的Azure资源
- **翻译模型**: 由你在 Azure 侧配置的部署决定（通常为 `gpt-4o` 或 `gpt-4o-mini`）
- **单次限制**: 遵循 Azure API 限制
- **费用**: 用户使用自己的Azure账户，按Azure官方定价计费
- **生词本**: 存储在本地SQLite数据库

## 打包发布（维护者）

发布流程与注意事项见 [docs/maintainers/PUSH_TO_GITHUB.md](docs/maintainers/PUSH_TO_GITHUB.md)。

### 用户安装

1. 访问 [GitHub Releases](https://github.com/aristo7298sub/ttPin/releases)
2. 下载 `ttPin_x.x.x_x64.msi`
3. 双击安装
4. 从开始菜单启动 ttPin
5. 打开【设置】并填写你的 Azure 翻译配置

## 许可证

PolyForm Noncommercial 1.0.0（禁止任何商业用途，含转售/商用服务/商业集成）。

说明：在本次许可证变更之前发布/分发的旧版本可能曾使用 MIT；已获得旧版本副本的第三方，仍可能在旧许可证范围内继续使用。
