/**
 * 发布在线体验版到 GitHub Pages：npm run pages:deploy
 * 构建 dist/pages/ → 作为 gh-pages 分支强推到 origin（只含网站文件，不影响 main）。
 * 第一次发布后在仓库 Settings → Pages 里选 gh-pages 分支（或用 gh api 开启）。
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, OUT } from './build-pages.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();

const remote = git(['remote', 'get-url', 'origin'], ROOT);
const name = git(['config', 'user.name'], ROOT);
const email = git(['config', 'user.email'], ROOT);
const sha = git(['rev-parse', '--short', 'HEAD'], ROOT);

build();
rmSync(join(OUT, '.git'), { recursive: true, force: true });
git(['init', '-q', '-b', 'gh-pages'], OUT);
git(['-c', 'core.autocrlf=false', 'add', '-A'], OUT);
git(['-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', `deploy: live demo built from ${sha}`], OUT);
git(['push', '-q', '-f', remote, 'gh-pages'], OUT);
console.log(`在线体验版已推送到 ${remote} 的 gh-pages 分支（来自 ${sha}）`);
