/**
 * 对话仓库：每段对话一个 JSON 文件（data/conversations/<id>.json）。
 *
 * - 启动时全部读进内存，读接口全走内存；写接口「先换内存快照，再排队落盘」。
 * - 对象按不可变方式更新：update 接收 updater(old) → new，绝不原地改。
 * - 删除 = 挪进 data/trash/，可以手动找回。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { localDate, localStamp } from './dates.mjs';
import { t, i18nError } from './i18n.mjs';

export const ID_RE = /^[a-z][a-z0-9_-]{2,63}$/i;

export const LIMITS = Object.freeze({ title: 60, topic: 20, question: 20000 });

export const newId = (prefix, now = new Date()) => `${prefix}_${localStamp(now)}_${randomBytes(3).toString('hex')}`;

const clip = (text, max) => String(text ?? '').trim().slice(0, max);

/** 列表用的摘要，不带完整回答，省流量。 */
export function summarize(conv) {
  const turns = conv.turns ?? [];
  const last = turns.at(-1);
  return {
    id: conv.id,
    title: conv.title,
    topic: conv.topic,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    turnCount: turns.length,
    days: [...new Set(turns.map((t) => localDate(t.createdAt)))].filter(Boolean),
    modes: [...new Set(turns.map((t) => t.mode))],
    lastQuestion: last ? clip(last.question, 80) : '',
    running: turns.some((t) => t.status === 'running')
  };
}

function snippetAround(text, needle, radius = 36) {
  const at = text.toLowerCase().indexOf(needle);
  if (at < 0) return '';
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + needle.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}

function searchableParts(conv) {
  const parts = [conv.title, conv.topic];
  for (const turn of conv.turns ?? []) {
    parts.push(turn.question);
    for (const answer of Object.values(turn.answers ?? {})) parts.push(answer?.text);
    if (turn.comparison?.data?.verdict) parts.push(turn.comparison.data.verdict);
  }
  return parts.filter(Boolean).map(String);
}

async function writeAtomic(file, content) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, content, 'utf8');
  // Windows 上杀毒软件偶尔会短暂占住目标文件，rename 报 EPERM，重试几次
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) {
        await fs.rm(tmp, { force: true });
        throw err;
      }
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

export function createStore({ dir, log = console }) {
  const convDir = join(dir, 'conversations');
  const trashDir = join(dir, 'trash');
  let items = new Map();
  const writeChains = new Map();

  const fileOf = (id) => join(convDir, `${id}.json`);

  function assertId(id) {
    if (!ID_RE.test(String(id))) throw i18nError(400, 'err.badId', { what: 'ID' });
  }

  function persist(conv) {
    const prev = writeChains.get(conv.id) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => writeAtomic(fileOf(conv.id), JSON.stringify(conv, null, 2)))
      .catch((err) => {
        log.error?.(`[store] 保存对话 ${conv.id} 失败：${err.message}`);
        throw err;
      });
    writeChains.set(conv.id, next);
    return next;
  }

  return {
    async load() {
      await fs.mkdir(convDir, { recursive: true });
      await fs.mkdir(trashDir, { recursive: true });
      const loaded = new Map();
      for (const name of await fs.readdir(convDir)) {
        if (!name.endsWith('.json')) continue;
        try {
          const conv = JSON.parse(await fs.readFile(join(convDir, name), 'utf8'));
          if (conv && ID_RE.test(conv.id)) loaded.set(conv.id, conv);
        } catch (err) {
          log.warn?.(`[store] 跳过损坏的对话文件 ${name}：${err.message}`);
        }
      }
      items = loaded;
      return items.size;
    },

    list() {
      return [...items.values()].map(summarize).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    get(id) {
      assertId(id);
      return items.get(id) ?? null;
    },

    topics() {
      const counts = new Map();
      for (const conv of items.values()) counts.set(conv.topic, (counts.get(conv.topic) ?? 0) + 1);
      return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
    },

    search(query) {
      const needle = String(query ?? '').trim().toLowerCase();
      if (!needle) return [];
      const hits = [];
      for (const conv of items.values()) {
        const part = searchableParts(conv).find((p) => p.toLowerCase().includes(needle));
        if (part) hits.push({ ...summarize(conv), snippet: snippetAround(part, needle) });
      }
      return hits.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async create({ title, topic, lang = 'zh', now = new Date() } = {}) {
      const iso = now.toISOString();
      const conv = {
        id: newId('c', now),
        title: clip(title, LIMITS.title) || t(lang, 'new.title'),
        topic: clip(topic, LIMITS.topic) || t(lang, 'new.topic'),
        titleAuto: true,
        createdAt: iso,
        updatedAt: iso,
        sessions: {},
        turns: []
      };
      items = new Map(items).set(conv.id, conv);
      await persist(conv);
      return conv;
    },

    /** updater 必须返回新对象；返回 null/undefined 表示不改。 */
    async update(id, updater, { touch = true } = {}) {
      assertId(id);
      const current = items.get(id);
      if (!current) throw i18nError(404, 'err.noConv');
      const changed = updater(current);
      if (!changed || changed === current) return current;
      const next = touch ? { ...changed, updatedAt: new Date().toISOString() } : changed;
      items = new Map(items).set(id, next);
      try {
        await persist(next);
      } catch (err) {
        // 落盘失败：内存回到改之前（期间没有更新的改动时），避免内存和文件不一致、轮次卡在 running
        if (items.get(id) === next) items = new Map(items).set(id, current);
        throw err;
      }
      return next;
    },

    async remove(id) {
      assertId(id);
      if (!items.has(id)) throw i18nError(404, 'err.noConv');
      await (writeChains.get(id) ?? Promise.resolve()).catch(() => {});
      const rest = new Map(items);
      rest.delete(id);
      items = rest;
      writeChains.delete(id);
      await fs.rename(fileOf(id), join(trashDir, `${id}.json`)).catch(async (err) => {
        if (err.code !== 'ENOENT') throw err;
      });
    },

    /** 测试用：等所有写盘完成。 */
    async flush() {
      await Promise.allSettled([...writeChains.values()]);
    }
  };
}
