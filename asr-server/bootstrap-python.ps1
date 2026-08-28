# ============================================================
# bootstrap-python.ps1 — 034 阶段3：uv 自举，解锁 python 系引擎
# ------------------------------------------------------------
# 由【用户自己运行】的脚本（App 只检测 + 提示；一切下载/安装都在本脚本内、
# 由用户执行触发——本文件不自动运行）。
#
# 它做什么（034 阶段3 / 032 W2）：
#   1) 下载 uv 单二进制 → <数据目录>/runtime/uv/
#   2) uv python install 3.11（独立 CPython，不复用/污染系统 python）
#   3) 在 <数据目录>/venvs/ 建三个受管 venv：
#        .venv-qwen3      → qwen-tts + torch + torchaudio
#        .venv-funasr     → funasr + torch + torchaudio
#        .venv-cosyvoice  → requirements-cosyvoice.lock（现存锁文件）
#      （qwen3/funasr 暂无锁定 requirements 文件，先装最小依赖集；
#        后续从真实环境 freeze 出 <引擎>.lock 再钉版）
#   4) 全程可见进度；可重跑（已装步骤自动跳过，幂等）；失败可重试。
#
# 数据目录：默认取 $env:OPENSOUND_DATA_DIR（App 启动注入），
#           未设置（直接双击运行）时回退本脚本所在目录（asr-server/）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File bootstrap-python.ps1
#   powershell -ExecutionPolicy Bypass -File bootstrap-python.ps1 -Check   # 只检测，不装任何东西
#
# 网络说明：uv 本体走 GitHub Releases；pip 依赖默认用**清华 pypi 镜像**（国内可达，
#           否则 pypi.org 直连极慢/挂死——033 同 npm 教训）。可用 $env:UV_INDEX_URL
#           （或 -Index 参数）显式覆盖为官方源 / 阿里云等。
# torch 等依赖较大（每个 venv ~0.5-2GB），属大流量，由本脚本（用户动作）执行。
# ============================================================
param(
  [switch]$Check,      # 只输出检测结果，不执行任何下载/安装
  [string]$Index = ''  # pip 索引覆盖（默认清华镜像；传 'https://pypi.org/simple' 用官方）
)

$ErrorActionPreference = 'Stop'
$IS_WIN = $env:OS -like 'Windows*'
$ScriptDir = $PSScriptRoot
$UVIndex = if ($Index) { $Index } elseif ($env:UV_INDEX_URL) { $env:UV_INDEX_URL } else { 'https://pypi.tuna.tsinghua.edu.cn/simple' }
$env:UV_INDEX_URL = $UVIndex

# ---------- 数据目录 ----------
$DataDir = if ($env:OPENSOUND_DATA_DIR) { $env:OPENSOUND_DATA_DIR } else { $ScriptDir }
$RuntimeDir = Join-Path $DataDir 'runtime'
$UvDir      = Join-Path $RuntimeDir 'uv'
$UvExe      = Join-Path $UvDir 'uv.exe'
$PyHome     = Join-Path $RuntimeDir 'python'   # uv 托管的独立 CPython（UV_PYTHON_INSTALL_DIR）
$VenvsDir   = Join-Path $DataDir 'venvs'

Write-Host ""
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host '  OpenSound · python 引擎自举（uv）' -ForegroundColor Cyan
Write-Host "  数据目录 : $DataDir" -ForegroundColor Gray
Write-Host "  venv 目录: $VenvsDir" -ForegroundColor Gray
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host "  [注意] 本脚本会下载 uv + CPython + 依赖（含 torch，共约 1~3GB，大流量）。" -ForegroundColor Yellow
Write-Host "  由你主动运行 = 你授权执行；App 不自动调它。" -ForegroundColor Yellow
Write-Host ""

# ---------- 0. 检测（-Check 即停） ----------
function Test-Uv { Test-Path $UvExe }
function Test-Py311 {
  $p = Join-Path $PyHome 'python.exe'
  if (Test-Path $p) { return $true }
  # uv 也把托管 python 记为 version 子目录：runtime/python/cpython-3.11.x/…，递归找
  if (Test-Path $PyHome) {
    return [bool](Get-ChildItem $PyHome -Recurse -Filter 'python.exe' -ErrorAction SilentlyContinue | Select-Object -First 1)
  }
  return $false
}
function Test-Venv([string]$name) {
  $py = if ($IS_WIN) { Join-Path (Join-Path $VenvsDir $name) 'Scripts\python.exe' }
        else { Join-Path (Join-Path $VenvsDir $name) 'bin\python3' }
  return (Test-Path $py)
}

$state = @{
  uv     = Test-Uv
  py311  = Test-Py311
  qwen3  = Test-Venv '.venv-qwen3'
  funasr = Test-Venv '.venv-funasr'
  cosy   = Test-Venv '.venv-cosyvoice'
}
Write-Host '----- 当前状态 -----' -ForegroundColor Cyan
Write-Host ("  uv（runtime/uv/uv.exe）      : {0}" -f $(if ($state.uv) { '✅ 就绪' } else { '❌ 未下载' }))
Write-Host ("  CPython 3.11（runtime/python）: {0}" -f $(if ($state.py311) { '✅ 已装' } else { '❌ 未安装' }))
Write-Host ("  .venv-qwen3                   : {0}" -f $(if ($state.qwen3) { '✅ 就绪' } else { '❌ 未创建' }))
Write-Host ("  .venv-funasr                  : {0}" -f $(if ($state.funasr) { '✅ 就绪' } else { '❌ 未创建' }))
Write-Host ("  .venv-cosyvoice               : {0}" -f $(if ($state.cosy) { '✅ 就绪' } else { '❌ 未创建' }))
Write-Host '------------------------' -ForegroundColor Cyan
if ($Check) {
  Write-Host '（-Check 模式：仅检测，未执行任何下载/安装）' -ForegroundColor Green
  exit 0
}

# ---------- 1. 下载 uv ----------
if ($state.uv) {
  Write-Host '[1/5] uv 已存在，跳过下载' -ForegroundColor Green
} else {
  Write-Host '[1/5] 下载 uv（单二进制，GitHub Releases）…' -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $UvDir | Out-Null
  $tmp = Join-Path $env:TEMP 'uv-download'
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'uv.zip'
  $url = if ($IS_WIN) {
    'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip'
  } else {
    if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq 'Arm64') {
      'https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz'
    } else {
      'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz'
    }
  }
  $ok = $false
  foreach ($mirror in @($url, $url -replace 'github.com', 'ghfast.top/https://github.com')) {
    try {
      Write-Host "       $mirror"
      Invoke-WebRequest -Uri $mirror -OutFile $zip -UseBasicParsing -TimeoutSec 300
      $ok = $true; break
    } catch { Write-Host "       失败：$($_.Exception.Message)" -ForegroundColor DarkYellow }
  }
  if (-not $ok) { throw 'uv 下载失败（GitHub 直连 + ghfast.top 镜像均不可达），请手动下载后把 uv.exe 放入: ' + $UvDir }
  if ($IS_WIN) {
    Expand-Archive -Path $zip -DestinationPath $UvDir -Force
    # zip 内是 uv.exe 平铺或带 uv-*/ 前缀目录，归一化到 $UvDir\uv.exe
    if (-not (Test-Path $UvExe)) {
      $inner = Get-ChildItem $UvDir -Recurse -Filter 'uv.exe' | Select-Object -First 1
      if ($inner) { Copy-Item $inner.FullName $UvExe -Force }
    }
  } else {
    tar -xzf $zip -C $UvDir
    $inner = Get-ChildItem $UvDir -Recurse -Filter 'uv' -File | Select-Object -First 1
    if ($inner) { Copy-Item $inner.FullName (Join-Path $UvDir 'uv') -Force }
  }
  if (-not (Test-Path $UvExe)) { throw "uv.exe 未出现在 $UvDir" }
  Write-Host '[1/5] uv 就绪' -ForegroundColor Green
}

# ---------- 2. 受管 CPython 3.11 ----------
if ($state.py311) {
  Write-Host '[2/5] CPython 3.11 已安装，跳过' -ForegroundColor Green
} else {
  Write-Host '[2/5] uv python install 3.11（独立 CPython，不碰系统 python）…' -ForegroundColor Cyan
  $env:UV_PYTHON_INSTALL_DIR = $PyHome
  & $UvExe python install 3.11
  if ($LASTEXITCODE -ne 0) { throw "uv python install 3.11 失败（退出码 $LASTEXITCODE）" }
  Write-Host '[2/5] CPython 3.11 就绪' -ForegroundColor Green
}

# ---------- 3. 建 venv ----------
function New-EngineVenv([string]$name, [string[]]$pkg, [string]$lockRel) {
  # 已存在 → 跳过
  if (Test-Venv $name) {
    Write-Host "[3-4/5] $name 已就绪，跳过" -ForegroundColor Green
    return
  }
  $venvDir = Join-Path $VenvsDir $name
  Write-Host "[3-4/5] $name：创建 venv（uv venv --python 3.11）…" -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $VenvsDir | Out-Null
  & $UvExe venv --python 3.11 $venvDir
  if ($LASTEXITCODE -ne 0) { Write-Host "      ⚠️ $name venv 创建失败（退出码 $LASTEXITCODE），继续下一个" -ForegroundColor Red; return }
  $py = if ($IS_WIN) { Join-Path $venvDir 'Scripts\python.exe' } else { Join-Path $venvDir 'bin\python3' }
  Write-Host "      $name：安装依赖（$(if ($lockRel) { $lockRel } else { $pkg -join ' ' })）…" -ForegroundColor Cyan
  if ($lockRel) {
    & $UvExe pip install --python $py -r (Join-Path $ScriptDir $lockRel)
  } else {
    & $UvExe pip install --python $py @pkg
  }
  if ($LASTEXITCODE -ne 0) {
    Write-Host "      ⚠️ $name 依赖安装失败（退出码 $LASTEXITCODE，看上方日志）" -ForegroundColor Red
  } else {
    Write-Host "      ✅ $name 就绪" -ForegroundColor Green
  }
}

$env:UV_PYTHON_INSTALL_DIR = $PyHome
New-EngineVenv '.venv-qwen3' @('qwen-tts', 'torch', 'torchaudio') $null
New-EngineVenv '.venv-funasr' @('funasr', 'torch', 'torchaudio') $null
New-EngineVenv '.venv-cosyvoice' @() 'requirements-cosyvoice.lock'

# ---------- 4. 汇总 ----------
Write-Host ""
Write-Host '================ 完成 ================' -ForegroundColor Cyan
Write-Host '  现在打开 App：模型页三个 python 引擎应转为「就绪 / 缺文件」。' -ForegroundColor Green
Write-Host '  若服务已开着：设置页 → 重启服务（或重启 App）让引擎被拉起。' -ForegroundColor Green
Write-Host '  说明：qwen3 模型在服务首次启动时自动拉取到 models/hf/；' -ForegroundColor Gray
Write-Host '       sensevoice-original 模型已就位（models/sensevoice-original）；' -ForegroundColor Gray
Write-Host '       cosyvoice 模型未下载时，模型页点「补齐」（约 4.4GB，App 内二次确认）。' -ForegroundColor Gray
Write-Host '  重跑本脚本 = 幂等（已装步骤自动跳过）；-Check 只检测不安装。' -ForegroundColor Gray
Write-Host '======================================' -ForegroundColor Cyan