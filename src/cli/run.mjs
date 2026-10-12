/**
 * 启动 CLI 子进程，prompt 走 stdin，stdout 按行解析 JSON 回调。
 *
 * - 强制走订阅：删掉 API Key 类环境变量，CLI 看不到就会用本机登录态（不按次计费）。
 * - 用户内容只进 stdin，永远不进命令行（避开长度上限和命令注入）。
 * - 取消/超时会杀掉整棵进程树（Windows 上 child.kill 只杀一层）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { delimiter, dirname } from 'node:path';

const IS_WIN = process.platform === 'win32';
const CMD_META = /[&|<>^"%\r\n]/;

export const SUBSCRIPTION_ENV_REMOVE = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  // 从 Claude Code 会话里启动本服务时，这些变量会让子 claude 以为自己是嵌套调用
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SSE_PORT'
]);

export function childEnv(base = process.env) {
  const env = { ...base };
  for (const key of SUBSCRIPTION_ENV_REMOVE) delete env[key];
  // 用便携版 Node 启动时 node 不在 PATH 里；npm 装的 *.cmd 外壳要靠它，所以把当前 Node 所在目录放到最前面
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const nodeDir = dirname(process.execPath);
  const path = String(env[pathKey] ?? '');
  const withNode = path.toLowerCase().split(delimiter).includes(nodeDir.toLowerCase()) ? path : `${nodeDir}${delimiter}${path}`;
  return { ...env, [pathKey]: withNode, NO_COLOR: '1', PYTHONUTF8: '1' };
}

function spawnTarget(cli, args, options) {
  if (!cli.isCmd) return spawn(cli.file, args, options);
  const bad = [cli.file, ...args].find((a) => CMD_META.test(a));
  if (bad !== undefined) throw new Error(`参数里有 cmd.exe 特殊字符，已拒绝执行：${bad.slice(0, 60)}`);
  const line = `"${[cli.file, ...args].map((a) => `"${a}"`).join(' ')}"`;
  return spawn('cmd.exe', ['/d', '/s', '/c', line], { ...options, windowsVerbatimArguments: true });
}

function killTree(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

/**
 * 跑一次 CLI。返回 { code, stderr }；取消或超时 reject。
 * onLine(obj) 收到每一行合法 JSON；非 JSON 行（日志）忽略。
 */
export function runJsonl({ cli, args, stdin, cwd, signal, timeoutMs = 10 * 60 * 1000, onLine, env }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('已取消'), { cancelled: true }));
      return;
    }

    let child;
    try {
      child = spawnTarget(cli, args, { cwd, env: env ?? childEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }

    let buffer = '';
    let stderr = '';
    let settled = false;

    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const onAbort = () => {
      killTree(child);
      finish(() => reject(Object.assign(new Error('已取消'), { cancelled: true })));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      killTree(child);
      finish(() => reject(Object.assign(new Error(`超过 ${Math.round(timeoutMs / 60000)} 分钟没有完成，已停止`), { timeout: true })));
    }, timeoutMs);

    const emitLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        return;
      }
      try {
        onLine?.(obj);
      } catch (err) {
        // 解析回调出错不该拖垮子进程，记到 stderr 里方便排查
        stderr += `\n[解析回调出错] ${err.message}`;
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        emitLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-8000);
    });

    child.on('error', (err) => finish(() => reject(new Error(`启动 ${cli.file} 失败：${err.message}`))));
    child.on('close', (code) => {
      if (buffer) emitLine(buffer);
      finish(() => resolve({ code, stderr }));
    });

    child.stdin.on('error', () => {});
    child.stdin.end(stdin ?? '', 'utf8');
  });
}
