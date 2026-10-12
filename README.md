# Dual AI Chat

**Ask Claude and ChatGPT (Codex) the same question, see both answers side by side, and get a scored, visual comparison — using the subscriptions you already pay for.**

[简体中文](README.zh-CN.md) · [日本語](README.ja.md)

**[▶ Try the live demo](https://tanktangmold.github.io/dual-ai-chat/)** — real recorded answers replayed in your browser, no install needed.

![Dual AI Chat — both answers side by side with an automatic comparison](docs/screenshot-chat.png)

Dual AI Chat is a small local web app for Windows. It drives the official **Claude Code** and **Codex** command-line tools that are signed in on your PC, so there is no API key and no per-use billing — usage counts toward your Claude and ChatGPT plans. Everything (chats, attachments, reports) stays on your machine.

## Features

- **Three ways to ask** — *Claude only*, *Codex only*, or *Both · compare*. Claude streams word by word; both run in parallel.
- **Blind comparison** — a judge model scores both answers on accuracy, completeness, clarity, practicality and depth, lists where they agree and differ, flags errors, and writes a **combined best answer**. Answers are anonymized as A/B in random order to reduce self-preference.
- **Visual HTML report** — shown inline in the chat and saved as a standalone file you can open or share.
- **Memory** — both models remember earlier turns of the same chat, even turns answered only by the other model. Every chat is saved and can be browsed **by date (with a calendar)** or **by topic**, with full-text search. Titles and topics are generated automatically.
- **Attachments** — drag in files or paste a screenshot (Ctrl+V): images, screenshots, **iPhone photos (HEIC)**, PDF, Word, Excel, PowerPoint, text / CSV / code. Text is extracted so both models can read it.
- **Three interface languages** — English, 简体中文, 日本語. The models answer in the interface language and the report follows it.
- **Web search** toggle for questions that need fresh information.

![Comparison report](docs/screenshot-report.png)

## Requirements

- Windows 10 or 11 with an internet connection
- A **Claude** subscription (Pro or Max)
- A **ChatGPT** subscription that includes **Codex** (Plus, Pro, …)

The installer takes care of everything else.

## Install (Windows, one click)

1. Download `dual-ai-chat-v<version>.zip` from the [**Releases**](https://github.com/tanktangmold/dual-ai-chat/releases/latest) page and **extract it** to a permanent folder, e.g. `D:\dual-ai-chat`.
2. Double-click **`install.bat`**. If Windows shows “Windows protected your PC”, click *More info* → *Run anyway*.
3. A browser opens twice: sign in to **Claude**, then choose **Sign in with ChatGPT** for Codex.
4. Optionally add PDF/Word/Excel reading (~60 MB) and iPhone HEIC support (~100 MB).
5. Done — a **Dual AI Chat** icon appears on your desktop.

What the installer does:

- **No admin rights, no system changes.** Missing pieces are downloaded into the app's own `runtime\` folder: a portable Node.js, Claude Code and Codex (via npm), and optionally a portable Python (PyMuPDF, python-docx, openpyxl) and ffmpeg. Tools already on your PC are reused. Deleting the folder uninstalls everything.
- **Safe to re-run** — it only adds what is missing, and re-opens sign-in if a login expired. Log: `data\install.log`.
- Falls back to mirrors if a download source is unreachable.

See [INSTALL.txt](INSTALL.txt) for the step-by-step guide.

## Run from source

Requires Node.js 22+ and the `claude` and `codex` CLIs installed and signed in (`claude auth login`, `codex login`). No npm dependencies.

```bash
git clone https://github.com/tanktangmold/dual-ai-chat.git
cd dual-ai-chat
node server.mjs --open
```

The app listens on <http://127.0.0.1:8796> (local only). Useful commands:

```bash
node server.mjs --check   # print which claude / codex / ffmpeg / Python were found (JSON)
npm test                  # unit + integration tests with fake models (no quota used)
npm run pack              # build dist/dual-ai-chat-v<version>.zip for sharing
```

macOS and Linux: the server is plain Node.js and should work with `node server.mjs --open` when `claude` and `codex` are on your `PATH`, but only Windows is tested and the one-click installer is Windows-only.

## Live demo (GitHub Pages)

The [live demo](https://tanktangmold.github.io/dual-ai-chat/) is the real UI with a small in-browser backend (`demo/backend.mjs`) that replays conversations recorded from real runs (`demo/data.json`, reports and attachments in `demo/`). No AI is called.

```bash
npm run pages:serve    # preview at http://127.0.0.1:8798/dual-ai-chat/
npm run pages:deploy   # build and push to the gh-pages branch
```

To refresh the recordings, run a separate instance with its own data folder (never your real `data/`), ask the sample questions, then export:

```bash
DUAL_CHAT_PORT=8797 DUAL_CHAT_DATA=/tmp/demo-data node server.mjs
node scripts/export-demo.mjs /tmp/demo-data
```

## How it works

```
Browser UI  ⇄  local Node server (127.0.0.1:8796)  ⇄  claude -p --output-format stream-json
                         │                         ⇄  codex exec --json
                         └─ data/  (chats, uploads, reports — never leaves your PC)
```

- **Claude**: `claude -p --safe-mode --output-format stream-json --resume <session>` — streamed output, multi-turn memory via session resume, your personal Claude Code settings/plugins are not loaded.
- **Codex**: `codex exec --json --ignore-user-config -c sandbox_mode=read-only` and `codex exec resume <thread>`.
- **Subscription only**: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are removed from the child processes so the CLIs use your subscription login instead of API billing.
- **Judge**: Claude by default (low reasoning effort ≈ 20 s). You can swap the judge per turn; in our tests Codex leans slightly toward its own answers when judging.

## Privacy & security

- The server binds to `127.0.0.1` only, checks the `Host` header (DNS-rebinding protection) and requires a custom header plus same origin for every write request.
- Model output is escaped before rendering; reports are served with a strict Content-Security-Policy and shown in a sandboxed iframe.
- Claude may only read files inside the app's upload folder (`Read(./uploads/**)`); Codex runs in a read-only sandbox.
- No telemetry. Your questions and attachments are, of course, sent to Anthropic / OpenAI to be answered.

## Data

Everything lives in `data\` inside the app folder: `conversations\` (one JSON per chat), `reports\` (HTML reports), `workspace\uploads\` (attachments), `trash\` (deleted chats), `settings.json`.

## Disclaimer

This is an independent, unofficial project. It is not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. “Claude” and “Claude Code” are trademarks of Anthropic; “ChatGPT” and “Codex” are trademarks of OpenAI. Use it in accordance with the terms of your own subscriptions.

## License

[MIT](LICENSE)
