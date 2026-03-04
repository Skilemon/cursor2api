# Cursor2API v2

将 Cursor 文档页免费 AI 对话接口代理转换为 **Anthropic Messages API**，可直接对接 **Claude Code**。

## 原理

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│ Claude Code  │────▶│  cursor2api  │────▶│  Cursor API  │
│ (Anthropic   │     │  (代理+转换)  │     │  /api/chat   │
│  Messages)   │◀────│              │◀────│              │
└─────────────┘     └──────────────┘     └──────────────┘
```

1. Claude Code 发送标准 Anthropic Messages API 请求（带工具定义）
2. cursor2api 将工具定义**注入为系统提示词**（XML 格式，Claude 模型原生理解）
3. 将消息转换为 Cursor `/api/chat` 格式，带 Chrome TLS 指纹模拟
4. Cursor 背后的 Claude Sonnet 4.6 按照提示词输出工具调用
5. cursor2api 解析 XML 工具调用 → 转换为 Anthropic `tool_use` 格式返回
6. Claude Code 执行工具 → 发送 `tool_result` → 循环

## 核心特性

- **Anthropic Messages API 完整兼容** - `/v1/messages` 流式/非流式
- **提示词注入工具能力** - 让 Claude Code 的 Bash、Read、Write 等工具全部可用
- **Node.js/TypeScript** - 无需外部进程生成 x-is-human token
- **Chrome TLS 指纹** - 模拟真实浏览器请求头
- **SSE 流式传输** - 实时响应

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 获取必要文件

```bash
# 下载浏览器环境模拟脚本
curl -o jscode/env.js https://raw.githubusercontent.com/jhhgiyv/cursorweb2api/master/jscode/env.js
curl -o jscode/main.js https://raw.githubusercontent.com/jhhgiyv/cursorweb2api/master/jscode/main.js
```

### 3. 配置

编辑 `config.yaml`：
- `script_url` - 从 Cursor 文档页 DevTools 网络面板获取 `c.js` 请求 URL
- `fingerprint` - 浏览器指纹信息

### 4. 启动

```bash
npm run dev
```

### 5. 配合 Claude Code

```bash
export ANTHROPIC_BASE_URL=http://localhost:3010
claude
```

## 项目结构

```
cursor2api/
├── src/
│   ├── index.ts          # 入口 + Express 服务
│   ├── config.ts         # 配置管理
│   ├── types.ts          # 类型定义
│   ├── cursor-client.ts  # Cursor API 客户端 + Token 生成
│   ├── converter.ts      # 协议转换 + 工具提示词注入
│   └── handler.ts        # Anthropic API 处理器
├── jscode/               # x-is-human token 生成脚本
├── config.yaml           # 配置文件
├── package.json
└── tsconfig.json
```

## 技术架构

### 提示词注入工具能力

Claude Code 发送工具定义 → 我们将其转换为 XML 格式系统提示：

```xml
<antml_tool_call>
<tool_name>Bash</tool_name>
<tool_input>
{"command": "ls -la"}
</tool_input>
</antml_tool_call>
```

AI 按此格式输出 → 我们解析并转换为标准的 Anthropic `tool_use` content block。

### x-is-human Token

Cursor 使用 `x-is-human` 请求头进行人机验证。Token 由前端 JS 生成，有效期 25 分钟。
在 Node.js 中直接执行验证脚本，无需外部进程。

## 免责声明

本项目仅供学习和研究目的使用。使用本项目可能违反 Cursor 的服务条款，请自行承担风险。

## License

MIT
