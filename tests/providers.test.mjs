import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaudeArgs, reduceClaude, finishClaude, initialClaudeState } from '../src/providers/claude.mjs';
import { buildCodexArgs, reduceCodex, finishCodex, initialCodexState } from '../src/providers/codex.mjs';
import { humanizeError, isStaleSessionError } from '../src/providers/errors.mjs';
import { createProvider } from '../src/providers/index.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// provider 会往 tmpDir 写 schema / 语言设置文件，别写进项目目录
const TMP = join(tmpdir(), 'dual-chat-provider-test');
import { parseVersion, compareVersions, locateCli, createCliCache } from '../src/cli/locate.mjs';

const feed = (reduce, initial, lines) =>
  lines.reduce(
    (acc, line) => {
      const r = reduce(acc.state, line);
      return { state: r.state, events: [...acc.events, ...r.events] };
    },
    { state: initial, events: [] }
  );

// ---- Claude：取自 2026-10-11 实测的 stream-json 输出（删减字段） ----
const CLAUDE_LINES = [
  { type: 'system', subtype: 'init', session_id: 'sess-1', tools: [] },
  { type: 'stream_event', event: { type: 'message_start', message: {} } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来搜一下。' } } },
  { type: 'assistant', message: { content: [{ type: 'server_tool_use', name: 'web_search', input: { query: 'Node LTS' } }] } },
  { type: 'stream_event', event: { type: 'message_start', message: {} } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '最新 LTS 是 v24。' } } },
  { type: 'result', subtype: 'success', is_error: false, result: '最新 LTS 是 v24。', session_id: 'sess-1' }
];

test('claude：流式增量、工具状态、最终取 result', () => {
  const { state, events } = feed(reduceClaude, initialClaudeState, CLAUDE_LINES);
  assert.deepEqual(events.map((e) => e.type), ['session', 'delta', 'status', 'delta']);
  assert.equal(events[2].text, '🔍 Node LTS');
  assert.equal(state.text, '我来搜一下。\n\n最新 LTS 是 v24。', '两段消息之间加空行');
  const out = finishClaude(state, { code: 0, stderr: '' });
  assert.equal(out.text, '最新 LTS 是 v24。');
  assert.equal(out.sessionId, 'sess-1');
});

test('claude：结构化输出', () => {
  const { state } = feed(reduceClaude, initialClaudeState, [
    { type: 'result', subtype: 'success', is_error: false, result: '{"a":1}', structured_output: { a: 1 }, session_id: 's' }
  ]);
  assert.deepEqual(finishClaude(state, { code: 0, stderr: '' }).structured, { a: 1 });
});

test('claude：is_error 结果变成错误', () => {
  const { state } = feed(reduceClaude, initialClaudeState, [{ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }]);
  assert.match(finishClaude(state, { code: 1, stderr: '' }).error, /Not logged in/);
});

test('claude：没有 result 行就退出，用 stderr 报错', () => {
  assert.match(finishClaude(initialClaudeState, { code: 1, stderr: 'No conversation found with session ID: x' }).error, /No conversation found/);
});

test('claude 参数：联网工具、续接、系统提示、一次性会话、schema', () => {
  const args = buildClaudeArgs({ sessionId: 's1', web: true, model: 'sonnet', effort: 'low', systemPrompt: '用中文', ephemeral: true, schema: { type: 'object' } });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes('--safe-mode'));
  assert.equal(at('--tools'), 'WebSearch,WebFetch');
  assert.equal(at('--allowedTools'), 'WebSearch,WebFetch');
  assert.equal(at('--resume'), 's1');
  assert.equal(at('--model'), 'sonnet');
  assert.equal(at('--effort'), 'low');
  assert.equal(at('--append-system-prompt'), '用中文');
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(at('--json-schema'), '{"type":"object"}');
});

test('claude 参数：不联网时不给任何工具', () => {
  const args = buildClaudeArgs({ web: false });
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(!args.includes('--allowedTools'));
  assert.ok(!args.includes('--resume'));
});

// ---- Codex：取自 2026-10-11 实测的 exec --json 输出 ----
const CODEX_LINES = [
  { type: 'thread.started', thread_id: 'th-1' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Skill descriptions were shortened' } },
  { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '我会查询官方信息。' } },
  { type: 'item.started', item: { id: 'item_2', type: 'web_search', query: '', action: { type: 'other' } } },
  { type: 'item.completed', item: { id: 'item_2', type: 'web_search', query: 'nodejs latest LTS' } },
  { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: '最新 LTS 是 **v24.21.0**。' } },
  { type: 'turn.completed', usage: { input_tokens: 1 } }
];

test('codex：会话 ID、搜索状态、最终答案只取工具之后的消息', () => {
  const { state, events } = feed(reduceCodex, initialCodexState, CODEX_LINES);
  assert.deepEqual(events.map((e) => e.type), ['session', 'delta', 'status', 'status', 'delta']);
  assert.equal(events[3].text, '🔍 nodejs latest LTS');
  const out = finishCodex(state, { code: 0, stderr: '' });
  assert.equal(out.text, '最新 LTS 是 **v24.21.0**。');
  assert.equal(out.sessionId, 'th-1');
  assert.equal(state.warnings.length, 1, '提示类 error item 不算失败');
});

test('codex：模型不支持的 400 错误', () => {
  const { state } = feed(reduceCodex, initialCodexState, [
    { type: 'thread.started', thread_id: 'x' },
    { type: 'error', message: '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}' },
    { type: 'turn.failed', error: { message: '{"type":"error","status":400,"error":{"message":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}}' } }
  ]);
  const out = finishCodex(state, { code: 1, stderr: '' });
  assert.match(out.error, /not supported when using Codex/);
  assert.match(humanizeError('codex', out.error, { model: 'gpt-6.1-sol' }), /订阅账号用不了模型「gpt-6.1-sol」/);
});

test('codex：结构化 JSON 结果被解析', () => {
  const { state } = feed(reduceCodex, initialCodexState, [
    { type: 'item.completed', item: { type: 'agent_message', text: '{"title":"标题","topic":"编程"}' } },
    { type: 'turn.completed' }
  ]);
  assert.deepEqual(finishCodex(state, { code: 0, stderr: '' }).structured, { title: '标题', topic: '编程' });
});

test('codex 参数：新会话 vs 续接', () => {
  const fresh = buildCodexArgs({ web: true, model: 'gpt-6.1-sol', effort: 'medium', cwd: 'D:\\ws' });
  assert.deepEqual(fresh.slice(0, 2), ['exec', '--json']);
  assert.ok(fresh.includes('--ignore-user-config'));
  assert.equal(fresh[fresh.indexOf('-C') + 1], 'D:\\ws');
  assert.ok(fresh.includes('web_search=live'));
  assert.ok(fresh.includes('sandbox_mode=read-only'));
  assert.ok(fresh.includes('model_reasoning_effort=medium'));
  assert.equal(fresh.at(-1), '-');

  const resumed = buildCodexArgs({ sessionId: 'th-1', web: false, cwd: 'D:\\ws' });
  assert.deepEqual(resumed.slice(0, 2), ['exec', 'resume']);
  assert.ok(!resumed.includes('-C'), 'resume 不支持 -C');
  assert.ok(resumed.includes('web_search=disabled'));
  assert.deepEqual(resumed.slice(-2), ['th-1', '-']);
});

test('错误提示翻译', () => {
  assert.match(humanizeError('claude', 'Not logged in'), /claude，然后输入 \/login/);
  assert.match(humanizeError('codex', 'You have hit your usage limit'), /额度/);
  assert.match(humanizeError('codex', ''), /没有返回/);
  assert.ok(isStaleSessionError('No conversation found with session ID: abc'));
  assert.ok(!isStaleSessionError('random failure'));
});

test('provider：成功路径透传事件，失败路径带 stale 标记', async () => {
  const fakeRun = (lines, code = 0, stderr = '') => async ({ onLine }) => {
    lines.forEach(onLine);
    return { code, stderr };
  };
  const events = [];
  const ok = createProvider('claude', { getCli: () => ({ file: 'claude.exe', isCmd: false }), cwd: '.', tmpDir: TMP, run: fakeRun(CLAUDE_LINES) });
  const out = await ok.run({ prompt: 'x', onEvent: (e) => events.push(e) });
  assert.equal(out.text, '最新 LTS 是 v24。');
  assert.equal(events.length, 4);

  const stale = createProvider('claude', { getCli: () => ({ file: 'claude.exe', isCmd: false }), cwd: '.', tmpDir: TMP, run: fakeRun([], 1, 'No conversation found with session ID: old') });
  await assert.rejects(stale.run({ prompt: 'x', sessionId: 'old' }), (err) => err.stale === true);

  const missing = createProvider('codex', { getCli: () => null, cwd: '.', tmpDir: TMP });
  await assert.rejects(missing.run({ prompt: 'x' }), /找不到 codex/);
});

test('版本比较：正式版 > 预发布版，0.162 > 0.147', () => {
  assert.ok(compareVersions(parseVersion('codex-cli 0.162.0-alpha.2'), parseVersion('codex-cli 0.147.0')) > 0);
  assert.ok(compareVersions(parseVersion('1.2.3'), parseVersion('1.2.3-beta')) > 0);
  assert.equal(parseVersion('no version'), null);
});

test('定位 codex：桌面版和 npm 版都在时取版本新的', () => {
  const env = { LOCALAPPDATA: 'L', APPDATA: 'A', USERPROFILE: 'U', PATH: 'P' };
  const files = new Set([`L\\OpenAI\\Codex\\bin\\h1\\codex.exe`, `P\\codex.exe`].map((f) => f.replace(/\\/g, process.platform === 'win32' ? '\\' : '/')));
  const fsApi = { readdirSync: () => ['h1', 'h2'] };
  const exists = (f) => files.has(f);
  const versionOf = (f) => parseVersion(f.includes('Codex') ? '0.162.0-alpha.2' : '0.147.0');
  const found = locateCli('codex', { env, exists, versionOf, fsApi });
  assert.match(found.file, /Codex/);
  assert.equal(found.version, '0.162.0-alpha.2');
});

test('定位：手填路径不存在时返回 null', () => {
  assert.equal(locateCli('claude', { override: 'Z:\\nope\\claude.exe', exists: () => false }), null);
});

test('CLI 缓存：文件还在就不重新找；Codex 桌面版更新删掉旧目录后自动换到新路径', () => {
  const files = new Set(['old/codex.exe']);
  const calls = [];
  const locate = (name, { override }) => {
    calls.push({ name, override });
    const file = [...files].at(-1);
    return file ? { file, version: '', isCmd: false } : null;
  };
  const cache = createCliCache('codex', { getOverride: () => '', locate, exists: (f) => files.has(f) });
  assert.equal(cache.get().file, 'old/codex.exe');
  assert.equal(cache.get().file, 'old/codex.exe');
  assert.equal(calls.length, 1, '文件还在时只找一次');

  files.delete('old/codex.exe');
  files.add('new/codex.exe');
  assert.equal(cache.get().file, 'new/codex.exe');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], { name: 'codex', override: '' });
});

test('CLI 缓存：没找到时下次再找（装好后不用重启）；refresh 按新设置重找', () => {
  let installed = false;
  let override = '';
  const locate = (_name, opts) => (installed ? { file: opts.override || 'auto/claude.exe', version: '', isCmd: false } : null);
  const cache = createCliCache('claude', { getOverride: () => override, locate, exists: () => true });
  assert.equal(cache.get(), null);
  installed = true;
  assert.equal(cache.get().file, 'auto/claude.exe');
  override = 'X:/my/claude.exe';
  assert.equal(cache.get().file, 'auto/claude.exe', '没 refresh 前沿用缓存');
  assert.equal(cache.refresh().file, 'X:/my/claude.exe');
});
