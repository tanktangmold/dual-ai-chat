/**
 * Codex CLI（ChatGPT 订阅）适配：拼参数 + 把 exec --json 的 JSONL 事件归约成统一事件。
 *
 * 关键参数（2026-10 实测 codex 0.162）：
 * - --ignore-user-config：不加载你的 config.toml（MCP 插件等），启动从 12s 降到 7s；
 *   代价是模型/推理强度要自己用 -m / -c 传。
 * - -c sandbox_mode=read-only：只读沙箱，问答用不着写文件。
 * - -c web_search=live：开联网搜索（exec 下没有 --search 参数）。
 * - exec resume <thread_id>：多轮续接。
 * - 不是逐字流式：每段 agent_message 完成后整段到达。
 */

export function buildCodexArgs({ sessionId, web, model, effort, cwd, schemaFile, ephemeral, images = [] }) {
  const head = sessionId ? ['exec', 'resume'] : ['exec'];
  // --image 收多个值，紧跟一个 --flag 才不会把后面的会话 ID 或 `-` 吞进去（实测）
  const imageArgs = images.flatMap((file) => ['--image', file]);
  const args = [...head, ...imageArgs, '--json', '--skip-git-repo-check', '--ignore-user-config'];
  if (!sessionId && cwd) args.push('-C', cwd);
  args.push('-c', 'sandbox_mode=read-only', '-c', `web_search=${web ? 'live' : 'disabled'}`);
  if (model) args.push('-m', model);
  if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
  if (ephemeral) args.push('--ephemeral');
  if (schemaFile) args.push('--output-schema', schemaFile);
  if (sessionId) args.push(sessionId);
  args.push('-');
  return args;
}

export const initialCodexState = Object.freeze({
  text: '', sessionId: '', messages: [], afterTool: [], error: '', lastError: '', done: false, warnings: []
});

const TOOL_ITEMS = new Set(['web_search', 'command_execution', 'mcp_tool_call', 'file_change', 'tool_call']);

function statusForItem(item, phase) {
  if (item.type === 'web_search') {
    const q = item.query || item.action?.query;
    return q ? `🔍 ${q}` : '🔍 …';
  }
  if (item.type === 'command_execution') return `⌨ ${String(item.command ?? '').slice(0, 80)}`;
  if (item.type === 'mcp_tool_call') return `🛠 ${item.tool ?? item.server ?? ''}`;
  if (item.type === 'reasoning' && phase === 'started') return '💭 …';
  return '';
}

function parseErrorMessage(raw) {
  const text = String(raw ?? '');
  try {
    const inner = JSON.parse(text);
    return inner?.error?.message || inner?.message || text;
  } catch {
    return text;
  }
}

export function reduceCodex(state, obj) {
  const events = [];
  let next = state;

  if (obj.type === 'thread.started' && obj.thread_id) {
    next = { ...next, sessionId: obj.thread_id };
    events.push({ type: 'session', id: obj.thread_id });
  } else if (obj.type === 'item.started' || obj.type === 'item.completed') {
    const item = obj.item ?? {};
    const phase = obj.type === 'item.started' ? 'started' : 'completed';
    if (item.type === 'agent_message' && phase === 'completed' && item.text) {
      const chunk = `${next.text ? '\n\n' : ''}${item.text}`;
      next = { ...next, text: next.text + chunk, messages: [...next.messages, item.text], afterTool: [...next.afterTool, item.text] };
      events.push({ type: 'delta', text: chunk });
    } else if (item.type === 'error') {
      next = { ...next, warnings: [...next.warnings, String(item.message ?? '')] };
    } else {
      if (TOOL_ITEMS.has(item.type)) next = { ...next, afterTool: [] };
      const status = statusForItem(item, phase);
      if (status) events.push({ type: 'status', text: status });
    }
  } else if (obj.type === 'error') {
    // 顶层 error 可能只是可恢复的中间状态（比如 "Reconnecting... 1/5"），先记下，等 turn.failed 或没完成才算数
    next = { ...next, lastError: parseErrorMessage(obj.message) };
  } else if (obj.type === 'turn.failed') {
    next = { ...next, error: parseErrorMessage(obj.error?.message) || next.lastError || 'turn failed', done: true };
  } else if (obj.type === 'turn.completed') {
    next = { ...next, done: true, error: '', lastError: '' };
  }

  return { state: next, events };
}

export function finishCodex(state, { code, stderr }) {
  if (state.error) return { error: state.error };
  if (!state.done) {
    return { error: state.lastError || stderr.trim().split('\n').slice(-6).join('\n') || `codex exited with code ${code}` };
  }
  const final = state.afterTool.length ? state.afterTool.join('\n\n') : (state.messages.at(-1) ?? '');
  let structured = null;
  try {
    structured = JSON.parse(final);
  } catch {
    structured = null;
  }
  return { text: final, sessionId: state.sessionId, structured };
}

export const codexAdapter = Object.freeze({
  buildArgs: buildCodexArgs,
  initial: () => initialCodexState,
  reduce: reduceCodex,
  finish: finishCodex,
  supportsSystemPrompt: false
});
