// 2026-10-12 代码审查发现的问题的回归测试
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reduceCodex, finishCodex, initialCodexState } from '../src/providers/codex.mjs';
import { renderMarkdown, renderInline } from '../src/markdown.mjs';
import { parseVersion, compareVersions, locateCli } from '../src/cli/locate.mjs';
import { loadSettings, saveSettings, DEFAULT_SETTINGS } from '../src/settings.mjs';
import { createStore } from '../src/store.mjs';

const feed = (lines) => lines.reduce((s, l) => reduceCodex(s, l).state, initialCodexState);

test('#1 codex 中途的可恢复 error（Reconnecting）不算失败', () => {
  const state = feed([
    { type: 'thread.started', thread_id: 'th' },
    { type: 'error', message: 'Reconnecting... 1/5 (stream disconnected)' },
    { type: 'item.completed', item: { type: 'agent_message', text: '最终答案' } },
    { type: 'turn.completed' }
  ]);
  assert.deepEqual(finishCodex(state, { code: 0, stderr: '' }).text, '最终答案');
});

test('#1 codex 只有 error 没有完成时用它报错', () => {
  const state = feed([{ type: 'error', message: 'stream disconnected' }]);
  assert.match(finishCodex(state, { code: 1, stderr: '' }).error, /stream disconnected/);
});

test('#5 链接文字里的行内代码正常显示，原文里的 NUL 不会伪造占位符', () => {
  assert.equal(renderInline('[`fetch`](https://developer.mozilla.org)'), '<a href="https://developer.mozilla.org" target="_blank" rel="noopener noreferrer"><code>fetch</code></a>');
  assert.equal(renderInline('a\u00000\u0000b'), 'a0b');
});

test('#6 极深嵌套不栈溢出', () => {
  const quotes = `${'>'.repeat(20000)} 深`;
  assert.doesNotThrow(() => renderMarkdown(quotes));
  const list = Array.from({ length: 3000 }, (_, i) => `${' '.repeat(i * 2)}- 项 ${i}`).join('\n');
  assert.doesNotThrow(() => renderMarkdown(list));
  assert.ok(renderMarkdown(list).includes('项 2999'));
});

test('#4 只有 .cmd 版时标记 isCmd；#8 alpha.10 比 alpha.9 新', () => {
  assert.ok(compareVersions(parseVersion('0.163.0-alpha.10'), parseVersion('0.163.0-alpha.9')) > 0);
  const env = { PATH: process.platform === 'win32' ? 'A;B' : 'A:B' };
  const sep = process.platform === 'win32' ? '\\' : '/';
  const files = new Set([`A${sep}codex.cmd`, `B${sep}codex.cmd`]);
  const found = locateCli('codex', { env, exists: (f) => files.has(f), versionOf: (f) => parseVersion(f.startsWith('B') ? '0.2.0' : '0.1.0'), fsApi: { readdirSync: () => [] } });
  if (process.platform === 'win32') {
    assert.equal(found.isCmd, true);
    assert.match(found.file, /^B/);
  }
});

test('#10 设置里某一项坏了只丢那一项；保存是原子写', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dual-chat-set-'));
  const file = join(dir, 'settings.json');
  await writeFile(file, JSON.stringify({ judge: 'gpt', timeoutMin: 7, codex: { model: 'gpt-6.1-sol', effort: 'medium' } }));
  const warns = [];
  const s = await loadSettings(file, { home: dir, log: { warn: (m) => warns.push(m) } });
  assert.equal(s.judge, DEFAULT_SETTINGS.judge, '坏的那项回到默认');
  assert.equal(s.timeoutMin, 7, '好的项保留');
  assert.equal(s.codex.model, 'gpt-6.1-sol');
  assert.equal(warns.length, 1);
  await saveSettings(file, s);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).timeoutMin, 7);
});

test('#2 写盘失败时内存回滚，不会留下卡住的轮次', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dual-chat-fail-'));
  const store = createStore({ dir, log: { warn() {}, error() {} } });
  await store.load();
  const conv = await store.create();
  await store.flush();
  // 把对话文件所在目录换成一个同名文件，让后续写盘必然失败
  await rm(join(dir, 'conversations'), { recursive: true, force: true });
  await writeFile(join(dir, 'conversations'), 'not a dir');
  await assert.rejects(store.update(conv.id, (c) => ({ ...c, turns: [{ id: 't_x1', status: 'running' }] })));
  assert.equal(store.get(conv.id).turns.length, 0);
  await rm(join(dir, 'conversations'), { force: true });
  await mkdir(join(dir, 'conversations'));
});
