# 双AI对话台（Dual AI Chat）

**同一个问题同时问 Claude 和 ChatGPT（Codex），并排看两份回答，自动打分对比、生成可视化报告——用的是你已经在付费的订阅。**

[English](README.md) · [日本語](README.ja.md)

![双AI对话台：两份回答并排，下方是自动对比](docs/screenshot-chat.png)

这是一个在 Windows 上运行的本地网页小工具。它调用你电脑上已登录的官方 **Claude Code** 和 **Codex** 命令行工具，所以不需要 API Key、不按次计费，用量算在你的 Claude / ChatGPT 套餐里。对话、附件、报告全部只保存在你自己的电脑上。

## 功能

- **三种提问方式**：只问 Claude、只问 Codex、两个都问 · 对比。Claude 逐字流式输出，两边并行回答。
- **匿名对比**：裁判模型从准确性、完整性、清晰度、实用性、深度五个维度打分，列出共识与分歧、指出错误，并写一份**综合最佳回答**。两份回答会匿名成 A / B 并随机排序，减少裁判偏心自家。
- **可视化 HTML 报告**：在聊天里内嵌显示，也会存成独立文件，可以单独打开或转发。
- **记忆**：同一段对话里两个模型都记得前文（包括只问了另一个模型的那几轮）。所有对话自动保存，可以**按日期（带日历）**、**按话题**回看，支持全文搜索；标题和话题自动生成。
- **附件**：拖入文件或 Ctrl+V 粘贴截图。支持图片、截图、**iPhone 照片（HEIC）**、PDF、Word、Excel、PowerPoint、文本 / CSV / 代码，文字会被提取出来让两个模型都能读。CSV 自动识别 UTF-8 / Shift_JIS（楽天导出的）/ GB18030。
- **三种界面语言**：简体中文、日本語、English。模型按界面语言回答，报告也跟着变。
- **联网搜索**开关，适合需要最新信息的问题。

![对比报告](docs/screenshot-report.png)

## 需要准备

- Windows 10 或 11，能上网
- **Claude** 订阅（Pro 或 Max）
- 能用 **Codex** 的 **ChatGPT** 订阅（Plus、Pro 等）

其他的都由安装器搞定。

## 安装（Windows 一键）

1. 在 [**Releases**](https://github.com/tanktangmold/dual-ai-chat/releases/latest) 页面下载 `dual-ai-chat-v<版本>.zip`，**先解压**到一个固定位置，例如 `D:\dual-ai-chat`。
2. 双击 **`install.bat`**。如果 Windows 提示「Windows 已保护你的电脑」，点「更多信息」→「仍要运行」。
3. 中途会打开两次浏览器：先登录 **Claude**，再选 **Sign in with ChatGPT** 登录 Codex。
4. 可选安装「PDF / Word / Excel 读取」（约 60 MB）和「iPhone HEIC 照片」（约 100 MB）。
5. 完成后桌面会出现 **双AI对话台** 图标。

安装器的做法：

- **不需要管理员权限，不改系统。** 缺什么就下载到工具自己的 `runtime\` 里：便携版 Node.js、Claude Code 和 Codex（npm 安装），以及可选的便携 Python（PyMuPDF、python-docx、openpyxl）和 ffmpeg。电脑上已有能用的就直接用。删掉文件夹就等于卸载。
- **可以重复运行**：只补缺的；登录过期也会重新打开登录页。日志在 `data\install.log`。
- 下载失败会自动换镜像（npmmirror、清华 PyPI）。

详细步骤见 [INSTALL.zh-CN.txt](INSTALL.zh-CN.txt)。

## 从源码运行

需要 Node.js 22+，以及已安装并登录的 `claude` 和 `codex`（`claude auth login`、`codex login`）。零 npm 依赖。

```bash
git clone https://github.com/tanktangmold/dual-ai-chat.git
cd dual-ai-chat
node server.mjs --open
```

服务只监听本机 <http://127.0.0.1:8796>。常用命令：

```bash
node server.mjs --check   # 输出找到的 claude / codex / ffmpeg / Python（JSON）
npm test                  # 单元 + 集成测试（假模型，不花额度）
npm run pack              # 打包 dist/dual-ai-chat-v<版本>.zip 用于分享
```

macOS / Linux：服务本身是纯 Node.js，`claude` 和 `codex` 在 `PATH` 上时 `node server.mjs --open` 应该能跑，但只在 Windows 上测试过，一键安装器也只支持 Windows。

## 工作原理

- **Claude**：`claude -p --safe-mode --output-format stream-json --resume <会话>`。流式输出，靠续接会话实现多轮记忆，不加载你个人的 Claude Code 设置、插件和钩子。
- **Codex**：`codex exec --json --ignore-user-config -c sandbox_mode=read-only`，续接用 `codex exec resume <thread>`。
- **只走订阅**：子进程环境里会删掉 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`，保证 CLI 用订阅登录而不是 API 计费。
- **裁判**：默认用 Claude（低推理强度，约 20 秒）。每一轮都可以「换裁判」再评一次；实测 Codex 当裁判时会略偏向自己的回答。

## 隐私与安全

- 服务只监听 `127.0.0.1`，校验 `Host` 头防 DNS 重绑定，所有写操作都要求自定义请求头且同源。
- 模型输出一律先转义再渲染；报告页使用严格的 CSP，并放在沙箱 iframe 里显示。
- Claude 只能读取本工具上传目录里的文件（`Read(./uploads/**)`），Codex 在只读沙箱里运行。
- 没有任何统计上报。当然，你的问题和附件会发给 Anthropic / OpenAI 来回答。

## 数据在哪

全部在工具文件夹的 `data\` 里：`conversations\`（每段对话一个 JSON）、`reports\`（HTML 报告）、`workspace\uploads\`（附件）、`trash\`（删除的对话）、`settings.json`。

## 声明

这是独立的非官方项目，与 Anthropic、OpenAI 没有任何隶属、认可或赞助关系。「Claude」「Claude Code」是 Anthropic 的商标，「ChatGPT」「Codex」是 OpenAI 的商标。请按你自己订阅的服务条款使用。

## 许可证

[MIT](LICENSE)
