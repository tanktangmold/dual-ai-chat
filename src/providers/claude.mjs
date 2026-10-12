/**
 * Claude Code CLI（订阅）适配：拼参数 + 把 stream-json 事件归约成统一事件。
 *
 * 关键参数（2026-10 实测 claude 2.1.285）：
 * - --safe-mode：不加载你的 CLAUDE.md / 插件 / 钩子 / MCP，启动快、上下文干净，但订阅登录照常
 *   （--bare 不行：它只认 API Key）。
 * - --include-partial-messages：逐字流式输出。
 * - --resume <session_id>：多轮续接，记得前文。
 * - --json-schema：结构化输出，结果在 result.structured_output。
 * - 附件：给 Read 工具，但权限只放行 ./uploads/**（工作目录下的上传目录），读不到本机其他文件。
 */

export const CLAUDE_WEB_TOOLS = Object.freeze(['WebSearch', 'WebFetch']);
export const CLAUDE_READ_RULE = 'Read(./uploads/**)';

export function buildClaudeArgs({ sessionId, web, model, effort, systemPrompt, schema, ephemeral, readFiles, settingsFile }) {
  const tools = [...(web ? CLAUDE_WEB_TOOLS : []), ...(readFiles ? ['Read'] : [])];
  const allowed = [...(web ? CLAUDE_WEB_TOOLS : []), ...(readFiles ? [CLAUDE_READ_RULE] : [])];
  const args = [
    '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--safe-mode', '--no-chrome', '--permission-mode', 'dontAsk', '--tools', tools.join(',')
  ];
  if (allowed.length) args.push('--allowedTools', allowed.join(','));
  // 覆盖用户全局 settings.json 里的 language（比如 "chinese"），否则选日语界面时 Claude 仍会说中文
  if (settingsFile) args.push('--settings', settingsFile);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (sessionId) args.push('--resume', sessionId);
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);
  if (ephemeral) args.push('--no-session-persistence');
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  return args;
}

export const initialClaudeState = Object.freeze({
  text: '', sessionId: '', final: null, structured: null, error: '', sepPending: false, thinking: false, done: false
});

function describeTool(block) {
  const input = block.input ?? {};
  if (input.query) return `🔍 ${input.query}`;
  if (input.url) return `🌐 ${input.url}`;
  if (input.file_path) return `📎 ${String(input.file_path).split(/[\\/]/).pop()}`;
  return `🛠 ${block.name}`;
}

/** 纯函数：(state, 一行事件) → { state, events } */
export function reduceClaude(state, obj) {
  const events = [];
  let next = state;

  if (obj.type === 'system' && obj.subtype === 'init' && obj.session_id) {
    next = { ...next, sessionId: obj.session_id };
    events.push({ type: 'session', id: obj.session_id });
  } else if (obj.type === 'stream_event') {
    const ev = obj.event ?? {};
    if (ev.type === 'message_start') {
      next = { ...next, sepPending: next.text.length > 0 };
    } else if (ev.type === 'content_block_start' && ev.content_block?.type === 'thinking' && !next.thinking) {
      next = { ...next, thinking: true };
      events.push({ type: 'status', text: '💭 …' });
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      const chunk = `${next.sepPending ? '\n\n' : ''}${ev.delta.text}`;
      next = { ...next, text: next.text + chunk, sepPending: false };
      events.push({ type: 'delta', text: chunk });
    }
  } else if (obj.type === 'assistant') {
    for (const block of obj.message?.content ?? []) {
      if (block.type === 'tool_use' || block.type === 'server_tool_use') events.push({ type: 'status', text: describeTool(block) });
    }
  } else if (obj.type === 'rate_limit_event' && obj.rate_limit_info?.status === 'rejected') {
    events.push({ type: 'status', text: '⏳ rate limit' });
  } else if (obj.type === 'result') {
    const failed = obj.is_error || (obj.subtype && obj.subtype !== 'success');
    next = {
      ...next,
      done: true,
      sessionId: obj.session_id || next.sessionId,
      final: failed ? null : String(obj.result ?? ''),
      structured: obj.structured_output ?? null,
      error: failed ? String(obj.result || obj.api_error_status || obj.subtype || '未知错误') : ''
    };
  }

  return { state: next, events };
}

/** 收尾：根据最终状态 + 退出码给出结果或错误文本。 */
export function finishClaude(state, { code, stderr }) {
  if (state.error) return { error: state.error };
  if (!state.done) return { error: stderr.trim() || `claude 异常退出（退出码 ${code}）` };
  const text = state.final?.trim() ? state.final : state.text;
  return { text, sessionId: state.sessionId, structured: state.structured };
}

export const claudeAdapter = Object.freeze({
  buildArgs: buildClaudeArgs,
  initial: () => initialClaudeState,
  reduce: reduceClaude,
  finish: finishClaude,
  supportsSystemPrompt: true
});
