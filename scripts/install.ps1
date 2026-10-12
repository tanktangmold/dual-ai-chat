<#
  Dual AI Chat - one-click installer (Windows 10/11, Windows PowerShell 5.1+)

  - No admin rights and no system changes: Node.js, Claude Code, Codex, ffmpeg and Python go into this app's runtime\ folder.
    Anything already usable on the PC is reused. Deleting the folder uninstalls everything.
  - The only manual steps are two browser sign-ins: your Claude subscription and your ChatGPT account.
  - Safe to run again: it checks first and only adds what is missing.

  Parameters:
    -DryRun    check only; no downloads, installs or sign-ins
    -Yes       install optional parts without asking
    -NoLaunch  do not open the app at the end
    -Lang      zh | ja | en  (default: Windows display language)
#>
param([switch]$DryRun, [switch]$Yes, [switch]$NoLaunch, [string]$Lang = '')

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the PowerShell 5.1 progress bar makes downloads many times slower
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

if (-not $Lang) {
  # Prefer the user's first preferred language (Settings > Language); fall back to the display language
  $ui = ''
  try { $ui = @(Get-WinUserLanguageList)[0].LanguageTag } catch { }
  if (-not $ui) { $ui = (Get-UICulture).Name }
  if ($ui -like 'zh*') { $Lang = 'zh' } elseif ($ui -like 'ja*') { $Lang = 'ja' } else { $Lang = 'en' }
}
if (@('zh', 'ja', 'en') -notcontains $Lang) { $Lang = 'en' }

$Msg = @{
  zh = @{
    title = '双AI对话台 一键安装'; location = '安装位置：{0}'; dryRun = '演练模式：只检查，不下载、不安装、不登录。'
    download = '下载 {0}'; downloadFail = '这个地址下载失败（{0}），换下一个…'; allDownloadsFail = '所有下载地址都失败了，请检查网络后重新运行。'
    extracting = '解压中…'
    step1 = '1/5 Node.js（运行本工具）'; nodeOk = 'Node.js {0}：{1}'; nodeWill = '没有 Node.js 22 以上版本，正式安装时会下载便携版到 runtime\node（约 30 MB）'
    nodeIndexFail = '获取版本列表失败：{0}'; nodeNoIndex = '拿不到 Node.js 版本列表，请检查网络。'; nodeInstalled = '已安装便携版 Node.js {0}'
    nodeFail = 'Node.js 安装失败：{0}'; noNode = '没有 Node.js，后面的步骤无法继续。'; notDone = '安装没有完成。请检查网络后，再双击一次 install.bat。'
    step2 = '2/5 Claude Code 和 Codex（调用你的订阅）'; cliOk = '{0} {1}：{2}'; cliWill = '没有 {0}，正式安装时会用 npm 装到 runtime\npm（{1}）'
    cliInstalling = '安装 {0}（{1}，请稍等）…'; cliInstalled = '{0} 已安装'; cliFail = '{0} 安装失败：{1}'; npmMirror = '换用国内镜像 {0} 重试…'
    step3 = '3/5 登录订阅账号'; claudeOk = 'Claude 已登录：{0}'; claudeWill = 'Claude 还没登录，正式安装时会打开浏览器登录'
    claudeHint = '马上会打开浏览器，请用你的 Claude 订阅账号（Pro / Max）登录，登录完回到这个窗口。'; claudeFail = 'Claude 没有登录成功（可以之后再运行一次 install.bat）'
    noClaude = '没有 Claude Code，跳过登录'; codexOk = 'Codex 已登录（{0}）'; codexWill = 'Codex 还没登录，正式安装时会打开浏览器登录'
    codexHint = '马上会打开浏览器，请选「Sign in with ChatGPT」，用你的 ChatGPT 订阅账号登录，登录完回到这个窗口。'
    codexLoggedIn = 'Codex 已登录'; codexFail = 'Codex 没有登录成功（可以之后再运行一次 install.bat）'; noCodex = '没有 Codex，跳过登录'
    step4 = '4/5 可选功能'; docOk = 'PDF / Word / Excel 读取：{0}（{1}）'; docWill = 'PDF / Word / Excel 读取：缺 Python 或文档库，正式安装时会问是否装便携版 Python（约 60 MB）'
    docAsk = '安装「PDF / Word / Excel 读取」支持？（便携版 Python，约 60 MB，推荐）'; docInstalled = '已安装 PDF / Word / Excel 读取支持'
    docLibFail = '文档库安装失败（不影响聊天和图片，只是 Codex 读不到 PDF / Office 里的文字）'; docFail = 'PDF / Word / Excel 读取支持安装失败：{0}'
    pipMirror = '换用国内镜像 {0} 重试…'; heicOk = 'iPhone 照片（HEIC）转换：{0}'; heicWill = 'iPhone 照片（HEIC）：没有 ffmpeg，正式安装时会问是否下载（约 100 MB）'
    heicAsk = '安装「iPhone 照片（HEIC）」支持？（ffmpeg，约 100 MB）'; heicInstalled = '已安装 iPhone 照片（HEIC）支持'; heicNoExe = '压缩包里没找到 ffmpeg.exe'
    heicFail = 'HEIC 支持安装失败：{0}（不影响其他功能）'; skip = '跳过。以后想装就再运行一次 install.bat。'
    step5 = '5/5 桌面图标'; lnkWill = '正式安装时会创建桌面图标：{0}'; lnkOk = '已创建桌面图标：{0}'; lnkFail = '创建桌面图标失败：{0}（可以直接双击文件夹里的 start.vbs）'
    lnkName = '双AI对话台'; lnkDesc = '同一个问题问 Claude 和 Codex，并排对比'
    results = '检查结果'; rowDoc = 'PDF/Office 读取'; rowHeic = 'HEIC 照片'; none = '没有'; optionalNone = '没有（可选）'; heicAvail = 'ffmpeg 可用'
    problems = '有些步骤没有完成：'; retry = '处理后再双击一次 install.bat 即可，已经装好的部分不会重装。日志在 data\install.log。'
    allDone = '全部完成！以后双击桌面上的「双AI对话台」就能用。'; opening = '正在打开双AI对话台…'
  }
  ja = @{
    title = 'デュアルAIチャット ワンクリックインストール'; location = 'インストール先：{0}'; dryRun = '確認モード：チェックのみ行い、ダウンロード・インストール・ログインはしません。'
    download = 'ダウンロード {0}'; downloadFail = 'このアドレスからのダウンロードに失敗しました（{0}）。次を試します…'; allDownloadsFail = 'すべてのダウンロード先で失敗しました。ネットワークを確認してから再実行してください。'
    extracting = '展開中…'
    step1 = '1/5 Node.js（本ツールの実行環境）'; nodeOk = 'Node.js {0}：{1}'; nodeWill = 'Node.js 22 以上がありません。本番では runtime\node にポータブル版をダウンロードします（約 30 MB）'
    nodeIndexFail = 'バージョン一覧の取得に失敗：{0}'; nodeNoIndex = 'Node.js のバージョン一覧を取得できません。ネットワークを確認してください。'; nodeInstalled = 'ポータブル版 Node.js {0} をインストールしました'
    nodeFail = 'Node.js のインストールに失敗：{0}'; noNode = 'Node.js がないため、これ以降の手順を続けられません。'; notDone = 'インストールは完了していません。ネットワークを確認して、もう一度 install.bat をダブルクリックしてください。'
    step2 = '2/5 Claude Code と Codex（あなたのサブスクを利用）'; cliOk = '{0} {1}：{2}'; cliWill = '{0} がありません。本番では npm で runtime\npm にインストールします（{1}）'
    cliInstalling = '{0} をインストール中（{1}、少々お待ちください）…'; cliInstalled = '{0} をインストールしました'; cliFail = '{0} のインストールに失敗：{1}'; npmMirror = 'ミラー {0} で再試行します…'
    step3 = '3/5 サブスクにログイン'; claudeOk = 'Claude にログイン済み：{0}'; claudeWill = 'Claude は未ログインです。本番ではブラウザを開いてログインします'
    claudeHint = 'まもなくブラウザが開きます。Claude のサブスク（Pro / Max）のアカウントでログインし、終わったらこのウィンドウに戻ってください。'; claudeFail = 'Claude にログインできませんでした（あとで install.bat をもう一度実行できます）'
    noClaude = 'Claude Code がないため、ログインをスキップします'; codexOk = 'Codex にログイン済み（{0}）'; codexWill = 'Codex は未ログインです。本番ではブラウザを開いてログインします'
    codexHint = 'まもなくブラウザが開きます。「Sign in with ChatGPT」を選び、ChatGPT のサブスクのアカウントでログインして、このウィンドウに戻ってください。'
    codexLoggedIn = 'Codex にログインしました'; codexFail = 'Codex にログインできませんでした（あとで install.bat をもう一度実行できます）'; noCodex = 'Codex がないため、ログインをスキップします'
    step4 = '4/5 オプション機能'; docOk = 'PDF / Word / Excel の読み取り：{0}（{1}）'; docWill = 'PDF / Word / Excel の読み取り：Python かライブラリが不足。本番ではポータブル版 Python を入れるか確認します（約 60 MB）'
    docAsk = '「PDF / Word / Excel の読み取り」をインストールしますか？（ポータブル版 Python、約 60 MB、推奨）'; docInstalled = 'PDF / Word / Excel の読み取りをインストールしました'
    docLibFail = 'ライブラリのインストールに失敗しました（チャットや画像には影響なし。Codex が PDF / Office の文字を読めないだけです）'; docFail = 'PDF / Word / Excel の読み取りのインストールに失敗：{0}'
    pipMirror = 'ミラー {0} で再試行します…'; heicOk = 'iPhone の写真（HEIC）の変換：{0}'; heicWill = 'iPhone の写真（HEIC）：ffmpeg がありません。本番ではダウンロードするか確認します（約 100 MB）'
    heicAsk = '「iPhone の写真（HEIC）」対応をインストールしますか？（ffmpeg、約 100 MB）'; heicInstalled = 'iPhone の写真（HEIC）対応をインストールしました'; heicNoExe = 'アーカイブに ffmpeg.exe が見つかりません'
    heicFail = 'HEIC 対応のインストールに失敗：{0}（他の機能には影響しません）'; skip = 'スキップしました。あとで install.bat をもう一度実行すれば入れられます。'
    step5 = '5/5 デスクトップのアイコン'; lnkWill = '本番ではデスクトップにアイコンを作成します：{0}'; lnkOk = 'デスクトップにアイコンを作成しました：{0}'; lnkFail = 'アイコンの作成に失敗：{0}（フォルダ内の start.vbs をダブルクリックしても起動できます）'
    lnkName = 'デュアルAIチャット'; lnkDesc = '同じ質問を Claude と Codex に聞いて並べて比較'
    results = 'チェック結果'; rowDoc = 'PDF/Office 読み取り'; rowHeic = 'HEIC 写真'; none = 'なし'; optionalNone = 'なし（オプション）'; heicAvail = 'ffmpeg あり'
    problems = '完了していない手順があります：'; retry = '対処してから install.bat をもう一度ダブルクリックしてください。入っているものは再インストールしません。ログは data\install.log。'
    allDone = 'すべて完了しました！これからはデスクトップの「デュアルAIチャット」をダブルクリックして使えます。'; opening = 'デュアルAIチャットを開いています…'
  }
  en = @{
    title = 'Dual AI Chat - one-click installer'; location = 'Install location: {0}'; dryRun = 'Dry run: checking only - nothing is downloaded, installed or signed in.'
    download = 'Downloading {0}'; downloadFail = 'Download failed from this address ({0}), trying the next one...'; allDownloadsFail = 'All download addresses failed. Check your network and run again.'
    extracting = 'Extracting...'
    step1 = '1/5 Node.js (runs this app)'; nodeOk = 'Node.js {0}: {1}'; nodeWill = 'No Node.js 22+ found. A real install downloads a portable Node.js into runtime\node (~30 MB)'
    nodeIndexFail = 'Could not get the version list: {0}'; nodeNoIndex = 'Could not get the Node.js version list. Check your network.'; nodeInstalled = 'Installed portable Node.js {0}'
    nodeFail = 'Node.js install failed: {0}'; noNode = 'Node.js is missing, so the remaining steps cannot continue.'; notDone = 'Setup did not finish. Check your network and double-click install.bat again.'
    step2 = '2/5 Claude Code and Codex (use your subscriptions)'; cliOk = '{0} {1}: {2}'; cliWill = '{0} not found. A real install puts it into runtime\npm with npm ({1})'
    cliInstalling = 'Installing {0} ({1}, please wait)...'; cliInstalled = '{0} installed'; cliFail = '{0} install failed: {1}'; npmMirror = 'Retrying with mirror {0}...'
    step3 = '3/5 Sign in to your subscriptions'; claudeOk = 'Claude signed in: {0}'; claudeWill = 'Claude is not signed in. A real install opens the browser to sign in'
    claudeHint = 'A browser window will open. Sign in with your Claude subscription account (Pro / Max), then come back to this window.'; claudeFail = 'Claude sign-in did not complete (you can run install.bat again later)'
    noClaude = 'Claude Code is missing; skipping sign-in'; codexOk = 'Codex signed in ({0})'; codexWill = 'Codex is not signed in. A real install opens the browser to sign in'
    codexHint = 'A browser window will open. Choose "Sign in with ChatGPT", sign in with your ChatGPT subscription account, then come back to this window.'
    codexLoggedIn = 'Codex signed in'; codexFail = 'Codex sign-in did not complete (you can run install.bat again later)'; noCodex = 'Codex is missing; skipping sign-in'
    step4 = '4/5 Optional features'; docOk = 'PDF / Word / Excel reading: {0} ({1})'; docWill = 'PDF / Word / Excel reading: Python or its libraries are missing. A real install asks whether to add a portable Python (~60 MB)'
    docAsk = 'Install "PDF / Word / Excel reading"? (portable Python, ~60 MB, recommended)'; docInstalled = 'PDF / Word / Excel reading installed'
    docLibFail = 'Library install failed (chat and images still work; Codex just cannot read text inside PDF / Office files)'; docFail = 'PDF / Word / Excel reading install failed: {0}'
    pipMirror = 'Retrying with mirror {0}...'; heicOk = 'iPhone photo (HEIC) conversion: {0}'; heicWill = 'iPhone photos (HEIC): no ffmpeg. A real install asks whether to download it (~100 MB)'
    heicAsk = 'Install "iPhone photo (HEIC)" support? (ffmpeg, ~100 MB)'; heicInstalled = 'iPhone photo (HEIC) support installed'; heicNoExe = 'ffmpeg.exe was not found in the archive'
    heicFail = 'HEIC support install failed: {0} (other features are not affected)'; skip = 'Skipped. Run install.bat again any time to add it.'
    step5 = '5/5 Desktop icon'; lnkWill = 'A real install creates a desktop icon: {0}'; lnkOk = 'Desktop icon created: {0}'; lnkFail = 'Could not create the desktop icon: {0} (you can double-click start.vbs in the folder instead)'
    lnkName = 'Dual AI Chat'; lnkDesc = 'Ask Claude and Codex the same question and compare side by side'
    results = 'Results'; rowDoc = 'PDF/Office read'; rowHeic = 'HEIC photos'; none = 'missing'; optionalNone = 'missing (optional)'; heicAvail = 'ffmpeg available'
    problems = 'Some steps did not finish:'; retry = 'Fix them and double-click install.bat again - finished parts are not reinstalled. Log: data\install.log.'
    allDone = 'All done! From now on, double-click "Dual AI Chat" on your desktop.'; opening = 'Opening Dual AI Chat...'
  }
}

function M([string]$Key) {
  $text = $Msg[$Lang][$Key]
  if (-not $text) { $text = $Msg['en'][$Key] }
  return $text
}
function MF([string]$Key, [object[]]$Values) { return ((M $Key) -f $Values) }

$Root = Split-Path -Parent $PSScriptRoot
$Runtime = Join-Path $Root 'runtime'
$Downloads = Join-Path $Runtime 'downloads'
$NpmPrefix = Join-Path $Runtime 'npm'
$Launcher = Join-Path $Root 'start.vbs'
$Arch = 'x64'
if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { $Arch = 'arm64' }
$Problems = New-Object System.Collections.ArrayList

New-Item -ItemType Directory -Force -Path (Join-Path $Root 'data') | Out-Null
try { Start-Transcript -Path (Join-Path $Root 'data\install.log') -Append | Out-Null } catch { }

# Subscription sign-in only: hide API keys from the CLIs (otherwise they bill the API)
foreach ($k in @('ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY')) {
  Remove-Item "Env:$k" -ErrorAction SilentlyContinue
}

function Say([string]$Text) { Write-Host "  $Text" }
function Step([string]$Text) { Write-Host ''; Write-Host "== $Text ==" -ForegroundColor Cyan }
function Ok([string]$Text) { Write-Host "  [OK] $Text" -ForegroundColor Green }
function Warn([string]$Text) { Write-Host "  [!] $Text" -ForegroundColor Yellow }
function Bad([string]$Text) {
  Write-Host "  [X] $Text" -ForegroundColor Red
  [void]$Problems.Add($Text)
}

function Ask([string]$Question) {
  if ($Yes -or $DryRun) { return $true }
  $answer = Read-Host "  $Question [Y/n]"
  return -not ($answer -match '^\s*(n|no)\s*$')
}

# In "stop on error" mode, PowerShell 5.1 treats any stderr line from a native program as an exception
# (codex login status writes to stderr). Relax it while calling native programs.
function Invoke-Quiet([scriptblock]$Block) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { return (& $Block) } finally { $ErrorActionPreference = $old }
}

function Download([string[]]$Urls, [string]$OutFile) {
  New-Item -ItemType Directory -Force -Path (Split-Path $OutFile) | Out-Null
  foreach ($u in $Urls) {
    try {
      Say (MF 'download' @($u))
      Invoke-WebRequest -Uri $u -OutFile $OutFile -UseBasicParsing -TimeoutSec 900
      if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -gt 0) { return }
    } catch {
      Warn (MF 'downloadFail' @($_.Exception.Message))
    }
  }
  throw (M 'allDownloadsFail')
}

# Windows' tar.exe is fast but cannot open zips on some non-ASCII paths; fall back to Expand-Archive
function Extract([string]$Zip, [string]$Dest) {
  New-Item -ItemType Directory -Force -Path $Dest | Out-Null
  $tar = Join-Path $env:WINDIR 'System32\tar.exe'
  if (Test-Path $tar) {
    Invoke-Quiet { & $tar -xf $Zip -C $Dest 2>$null }
    if ($LASTEXITCODE -eq 0) { return }
  }
  Expand-Archive -Path $Zip -DestinationPath $Dest -Force
}

function NodeMajor([string]$Exe) {
  try {
    $v = Invoke-Quiet { & $Exe --version 2>$null }
    if ($v -match '^v(\d+)\.') { return [int]$Matches[1] }
  } catch { }
  return 0
}

function Get-Check {
  $out = Invoke-Quiet { & $script:NodeExe (Join-Path $Root 'server.mjs') --check 2>$null }
  return ($out | Select-Object -Last 1 | ConvertFrom-Json)
}

# ---------------------------------------------------------------- 0. prepare
Write-Host ''
Write-Host (M 'title') -ForegroundColor White
Say (MF 'location' @($Root))
if ($DryRun) { Warn (M 'dryRun') }
if (-not $DryRun) {
  # Files unzipped from a download carry a "from the internet" mark; remove it so .vbs/.bat do not warn every time
  Get-ChildItem -Path $Root -Recurse -File -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------- 1. Node.js
Step (M 'step1')
$script:NodeExe = $null
$portableNode = Join-Path $Runtime 'node\node.exe'
if (Test-Path $portableNode) {
  $script:NodeExe = $portableNode
} else {
  $sys = Get-Command node -ErrorAction SilentlyContinue
  if ($sys -and (NodeMajor $sys.Source) -ge 22) { $script:NodeExe = $sys.Source }
}

if ($script:NodeExe) {
  Ok (MF 'nodeOk' @((Invoke-Quiet { & $script:NodeExe --version }), $script:NodeExe))
} elseif ($DryRun) {
  Warn (M 'nodeWill')
} else {
  try {
    $index = $null
    foreach ($u in @('https://nodejs.org/dist/index.json', 'https://npmmirror.com/mirrors/node/index.json')) {
      try { $index = Invoke-RestMethod -Uri $u -TimeoutSec 60; break } catch { Warn (MF 'nodeIndexFail' @($u)) }
    }
    if (-not $index) { throw (M 'nodeNoIndex') }
    $lts = $index | Where-Object { $_.lts -and ($_.files -contains "win-$Arch-zip") } | Select-Object -First 1
    $v = $lts.version
    $name = "node-$v-win-$Arch"
    $zip = Join-Path $Downloads "$name.zip"
    Download @("https://nodejs.org/dist/$v/$name.zip", "https://npmmirror.com/mirrors/node/$v/$name.zip") $zip
    Say (M 'extracting')
    Extract $zip $Runtime
    if (Test-Path (Join-Path $Runtime 'node')) { Remove-Item -Recurse -Force (Join-Path $Runtime 'node') }
    Rename-Item -Path (Join-Path $Runtime $name) -NewName 'node'
    $script:NodeExe = $portableNode
    Ok (MF 'nodeInstalled' @($v))
  } catch {
    Bad (MF 'nodeFail' @($_.Exception.Message))
  }
}

if (-not $script:NodeExe) {
  Bad (M 'noNode')
  Write-Host ''
  Write-Host (M 'notDone') -ForegroundColor Red
  try { Stop-Transcript | Out-Null } catch { }
  exit 1
}

$check = Get-Check
$npm = Join-Path (Split-Path $script:NodeExe) 'npm.cmd'

function Install-NpmCli([string]$Package) {
  foreach ($registry in @('', 'https://registry.npmmirror.com')) {
    $npmArgs = @('install', '-g', '--prefix', $NpmPrefix, '--no-fund', '--no-audit', '--loglevel', 'error', $Package)
    if ($registry) { $npmArgs += "--registry=$registry"; Warn (MF 'npmMirror' @($registry)) }
    & $npm @npmArgs
    if ($LASTEXITCODE -eq 0) { return }
  }
  throw "npm install $Package failed"
}

# ---------------------------------------------------------------- 2. Claude Code / Codex
Step (M 'step2')
$clis = @(
  @{ Key = 'claude'; Label = 'Claude Code'; Package = '@anthropic-ai/claude-code'; Size = '~250 MB' },
  @{ Key = 'codex'; Label = 'Codex'; Package = '@openai/codex'; Size = '~80 MB' }
)
foreach ($c in $clis) {
  $found = $check.($c.Key)
  if ($found) {
    Ok (MF 'cliOk' @($c.Label, $found.version, $found.file))
  } elseif ($DryRun) {
    Warn (MF 'cliWill' @($c.Label, $c.Size))
  } else {
    try {
      Say (MF 'cliInstalling' @($c.Label, $c.Size))
      Install-NpmCli $c.Package
      Ok (MF 'cliInstalled' @($c.Label))
    } catch {
      Bad (MF 'cliFail' @($c.Label, $_.Exception.Message))
    }
  }
}
$check = Get-Check

# ---------------------------------------------------------------- 3. sign in
Step (M 'step3')
if ($check.claude) {
  $claude = $check.claude.file
  $status = $null
  try { $status = (Invoke-Quiet { & $claude auth status 2>$null } | Out-String) | ConvertFrom-Json } catch { }
  if ($status -and $status.loggedIn) {
    Ok (MF 'claudeOk' @($status.email))
  } elseif ($DryRun) {
    Warn (M 'claudeWill')
  } else {
    Say (M 'claudeHint')
    & $claude auth login --claudeai
    try { $status = (Invoke-Quiet { & $claude auth status 2>$null } | Out-String) | ConvertFrom-Json } catch { }
    if ($status -and $status.loggedIn) { Ok (MF 'claudeOk' @($status.email)) } else { Bad (M 'claudeFail') }
  }
} else {
  Bad (M 'noClaude')
}

if ($check.codex) {
  $codex = $check.codex.file
  $codexStatus = (Invoke-Quiet { & $codex login status 2>&1 } | ForEach-Object { "$_" } | Out-String)
  if ($codexStatus -match 'Logged in') {
    Ok (MF 'codexOk' @($codexStatus.Trim()))
  } elseif ($DryRun) {
    Warn (M 'codexWill')
  } else {
    Say (M 'codexHint')
    & $codex login
    $codexStatus = (Invoke-Quiet { & $codex login status 2>&1 } | ForEach-Object { "$_" } | Out-String)
    if ($codexStatus -match 'Logged in') { Ok (M 'codexLoggedIn') } else { Bad (M 'codexFail') }
  }
} else {
  Bad (M 'noCodex')
}

# ---------------------------------------------------------------- 4. optional: documents / iPhone photos
Step (M 'step4')
$needLibs = @('fitz', 'docx', 'openpyxl')
$hasLibs = $false
if ($check.python) { $hasLibs = @($needLibs | Where-Object { $check.python.libs -contains $_ }).Count -eq $needLibs.Count }
if ($hasLibs) {
  Ok (MF 'docOk' @($check.python.version, $check.python.file))
} elseif ($DryRun) {
  Warn (M 'docWill')
} elseif (Ask (M 'docAsk')) {
  try {
    $pyVer = '3.12.10'
    $pyArch = 'amd64'
    if ($Arch -eq 'arm64') { $pyArch = 'arm64' }
    $pyName = "python-$pyVer-embed-$pyArch.zip"
    $pyZip = Join-Path $Downloads $pyName
    $pyDir = Join-Path $Runtime 'python'
    Download @("https://www.python.org/ftp/python/$pyVer/$pyName", "https://registry.npmmirror.com/-/binary/python/$pyVer/$pyName") $pyZip
    if (Test-Path $pyDir) { Remove-Item -Recurse -Force $pyDir }
    Extract $pyZip $pyDir
    # The embeddable Python ships with site-packages disabled; enable it so pip-installed libraries load
    $pth = Get-ChildItem -Path $pyDir -Filter 'python*._pth' | Select-Object -First 1
    (Get-Content $pth.FullName) -replace '^#\s*import site', 'import site' | Set-Content -Path $pth.FullName -Encoding ASCII
    $getPip = Join-Path $Downloads 'get-pip.py'
    Download @('https://bootstrap.pypa.io/get-pip.py', 'https://bootstrap.pypa.io/pip/get-pip.py') $getPip
    $py = Join-Path $pyDir 'python.exe'
    & $py $getPip --no-warn-script-location
    $libsOk = $false
    foreach ($pipIndex in @('', 'https://pypi.tuna.tsinghua.edu.cn/simple')) {
      $pipArgs = @('-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check', 'pymupdf', 'python-docx', 'openpyxl')
      if ($pipIndex) { $pipArgs += @('-i', $pipIndex); Warn (MF 'pipMirror' @($pipIndex)) }
      & $py @pipArgs
      if ($LASTEXITCODE -eq 0) { $libsOk = $true; break }
    }
    if ($libsOk) { Ok (M 'docInstalled') } else { Bad (M 'docLibFail') }
  } catch {
    Bad (MF 'docFail' @($_.Exception.Message))
  }
} else {
  Warn (M 'skip')
}

if ($check.ffmpeg) {
  Ok (MF 'heicOk' @($check.ffmpeg))
} elseif ($DryRun) {
  Warn (M 'heicWill')
} elseif (Ask (M 'heicAsk')) {
  try {
    $ffZip = Join-Path $Downloads 'ffmpeg.zip'
    $urls = @('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip')
    if ($Arch -eq 'arm64') { $urls = @('https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-winarm64-gpl.zip') }
    Download $urls $ffZip
    $tmp = Join-Path $Downloads 'ffmpeg-extract'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Extract $ffZip $tmp
    $exe = Get-ChildItem -Path $tmp -Recurse -Filter 'ffmpeg.exe' | Select-Object -First 1
    if (-not $exe) { throw (M 'heicNoExe') }
    $ffDir = Join-Path $Runtime 'ffmpeg'
    New-Item -ItemType Directory -Force -Path $ffDir | Out-Null
    Copy-Item -Path $exe.FullName -Destination (Join-Path $ffDir 'ffmpeg.exe') -Force
    Remove-Item -Recurse -Force $tmp
    Ok (M 'heicInstalled')
  } catch {
    Bad (MF 'heicFail' @($_.Exception.Message))
  }
} else {
  Warn (M 'skip')
}

# ---------------------------------------------------------------- 5. desktop icon + launch
Step (M 'step5')
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop ((M 'lnkName') + '.lnk')
if ($DryRun) {
  Warn (MF 'lnkWill' @($lnkPath))
} else {
  try {
    $shell = New-Object -ComObject WScript.Shell
    $lnk = $shell.CreateShortcut($lnkPath)
    $lnk.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $lnk.Arguments = '"' + $Launcher + '"'
    $lnk.WorkingDirectory = $Root
    $lnk.IconLocation = (Join-Path $Root 'public\app.ico') + ',0'
    $lnk.Description = (M 'lnkDesc')
    $lnk.Save()
    Ok (MF 'lnkOk' @($lnkPath))
  } catch {
    Bad (MF 'lnkFail' @($_.Exception.Message))
  }
  if (Test-Path $Downloads) { Remove-Item -Recurse -Force $Downloads -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- results
$final = Get-Check
Write-Host ''
Write-Host ('== ' + (M 'results') + ' ==') -ForegroundColor Cyan
$claudeRow = M 'none'
if ($final.claude) { $claudeRow = $final.claude.version }
$codexRow = M 'none'
if ($final.codex) { $codexRow = $final.codex.version }
$docRow = M 'optionalNone'
if ($final.python) { $docRow = "$($final.python.version) [$($final.python.libs -join ', ')]" }
$heicRow = M 'optionalNone'
if ($final.ffmpeg) { $heicRow = M 'heicAvail' }
$rows = @(@('Node.js', $final.node), @('Claude Code', $claudeRow), @('Codex', $codexRow), @((M 'rowDoc'), $docRow), @((M 'rowHeic'), $heicRow))
foreach ($r in $rows) { Write-Host ('  {0,-18} {1}' -f $r[0], $r[1]) }

Write-Host ''
if ($Problems.Count -gt 0) {
  Write-Host (M 'problems') -ForegroundColor Yellow
  foreach ($p in $Problems) { Write-Host "  - $p" -ForegroundColor Yellow }
  Write-Host (M 'retry') -ForegroundColor Yellow
} else {
  Write-Host (M 'allDone') -ForegroundColor Green
}

if (-not $DryRun -and -not $NoLaunch -and $final.claude -and $final.codex) {
  Start-Process -FilePath (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + $Launcher + '"')
  Say (M 'opening')
}
try { Stop-Transcript | Out-Null } catch { }
