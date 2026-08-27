# ============================================================
# OpenSound 一键下载模型（Windows PowerShell）
# 运行方式（PowerShell 或 CMD）：
#   powershell -ExecutionPolicy Bypass -File E:\Github\opensound\asr-server\download-all-models.ps1
#   自定义目录：powershell -ExecutionPolicy Bypass -File ...download-all-models.ps1 -ModelRoot "D:\mymodels"
#
# 下载目标（默认）：E:\Downloads\opensound-download\models\  （与 App 设置里的模型存放目录一致）
#   分文件夹：
#     models\sensevoice\                 SenseVoice（识别，~228MB）
#     models\tts\kokoro-multi-lang-v1_0\ Kokoro（朗读，已下载则跳过）
#     models\llm\qwen2.5-0.5b-*.gguf     LLM 0.5B（对话兜底，~469MB）
#     models\llm\Qwen3-8B-Q4_K_M.gguf    LLM 8B（对话更强，~4.9GB，可选）
#
# 说明：
#   - Whisper：由首次识别时自动下载（缓存结构特殊，不手动下）。
#   - Qwen3-TTS / SenseVoice原始版 / CosyVoice克隆：需要 python 运行环境，
#     环境就绪后启动服务会自动拉模型（下一步 W2），本脚本不覆盖。
# ============================================================
param(
  [string]$ModelRoot = "E:\Downloads\opensound-download"
)

$ErrorActionPreference = "Stop"
$ServerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$env:OPENSOUND_DATA_DIR = $ModelRoot          # 所有下载脚本都认这个环境变量
$Models = Join-Path $ModelRoot "models"
New-Item -ItemType Directory -Force -Path $Models | Out-Null

function Write-Step($s) { Write-Host "`n==== $s ====" -ForegroundColor Cyan }
function Test-Node { $null = Get-Command node -ErrorAction Stop; Write-Host "node 就绪：$(node -v)" }

function Download-Resume {
  param([string]$Url, [string]$Dest, [long]$ExpectBytes)
  $dir = Split-Path -Parent $Dest
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if (Test-Path $Dest) {
    $sz = (Get-Item $Dest).Length
    if ($sz -eq $ExpectBytes) { Write-Host "  ✓ 已存在且完整，跳过：$(Split-Path $Dest -Leaf)" -ForegroundColor Green; return }
    Write-Host "  * 已存在但不完整（$([math]::Round($sz/1MB,1))MB/$([math]::Round($ExpectBytes/1MB,1))MB），断点续传…"
  }
  & curl.exe -L -C - --fail --retry 3 --retry-delay 5 --connect-timeout 20 -o $Dest $Url
  if ($LASTEXITCODE -ne 0) { Write-Warning "  ✗ 下载失败：$Url（稍后重跑本脚本可续传）"; return }
  $sz = (Get-Item $Dest).Length
  if ($sz -ne $ExpectBytes) { Write-Warning "  ⚠️ 大小不符：$sz ≠ $ExpectBytes，建议删除该文件后重跑" }
  else { Write-Host "  ✓ $([math]::Round($sz/1MB,1)) MB 完成" -ForegroundColor Green }
}

Write-Host "OpenSound 模型下载（目标目录：$ModelRoot）" -ForegroundColor Yellow
Test-Node

# ---------- 1. SenseVoice（识别，中文最优先） ----------
Write-Step "1/4  SenseVoice（ASR 识别，~228MB）"
& node (Join-Path $ServerRoot "asr-server-download.js")

# ---------- 2. Kokoro（朗读，中英混合 53 音色） ----------
Write-Step "2/4  Kokoro（朗读，~383MB，已下载则跳过）"
& node (Join-Path $ServerRoot "download-kokoro.js")

# ---------- 3. LLM 0.5B（对话兜底，~469MB） ----------
Write-Step "3/4  LLM 0.5B（对话兜底，~469MB）"
Download-Resume -Url "https://hf-mirror.com/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf" `
  -Dest (Join-Path $Models "llm\qwen2.5-0.5b-instruct-q4_k_m.gguf") -ExpectBytes 491400032

# ---------- 4. LLM Qwen3-8B（对话更强，~4.9GB，可选） ----------
Write-Step "4/4  LLM Qwen3-8B（对话更强，~4.9GB，可选；不想要可 Ctrl+C 跳过）"
Download-Resume -Url "https://hf-mirror.com/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf" `
  -Dest (Join-Path $Models "llm\Qwen3-8B-Q4_K_M.gguf") -ExpectBytes 5027783488

# ---------- 5-7（可选）Python 系模型文件：先下载好，py 环境就绪后直接取用 ----------
Write-Step "5/7  SenseVoice 原始版（funasr，~936MB，需 py 环境才运行）"
$svFiles = @(
  @{ f = "model.pt";                   sz = 936291369 },
  @{ f = "config.yaml";                sz = 1855 },
  @{ f = "am.mvn";                     sz = 11203 },
  @{ f = "chn_jpn_yue_eng_ko_spectok.bpe.model"; sz = 377341 },
  @{ f = "tokens.json";                sz = 352064 }
)
foreach ($x in $svFiles) {
  Download-Resume -Url "https://modelscope.cn/models/iic/SenseVoiceSmall/resolve/master/$($x.f)" `
    -Dest (Join-Path $Models "sensevoice-original\$($x.f)") -ExpectBytes $x.sz
}

Write-Step "6/7  fsmn-vad（语音活动检测，~1.7MB）"
$vadFiles = @(
  @{ f = "model.pt";         sz = 1721366 },
  @{ f = "config.yaml";      sz = 1215 },
  @{ f = "am.mvn";           sz = 8040 },
  @{ f = "configuration.json"; sz = 365 }
)
foreach ($x in $vadFiles) {
  Download-Resume -Url "https://modelscope.cn/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch/resolve/master/$($x.f)" `
    -Dest (Join-Path $Models "fsmn-vad\$($x.f)") -ExpectBytes $x.sz
}

Write-Step "7/7  标点模型（punc-cn-en，~1.2GB，需 py 环境）"
$puncFiles = @(
  @{ f = "model.pt";           sz = 1125507622 },
  @{ f = "config.yaml";        sz = 812 },
  @{ f = "configuration.json"; sz = 450 },
  @{ f = "tokens.json";        sz = 8280697 },
  @{ f = "jieba.c.dict";       sz = 41536866 },
  @{ f = "jieba_usr_dict";     sz = 11280857 }
)
foreach ($x in $puncFiles) {
  Download-Resume -Url "https://modelscope.cn/models/iic/punc_ct-transformer_cn-en-common-vocab471067-large/resolve/master/$($x.f)" `
    -Dest (Join-Path $Models "punc-cn-en\$($x.f)") -ExpectBytes $x.sz
}

# ---------- 汇总 ----------
Write-Step "下载完成检查"
Write-Host "模型目录：$Models"
Get-ChildItem $Models -Recurse -File -ErrorAction SilentlyContinue | Group-Object { $_.DirectoryName.Replace($Models,'') } |
  ForEach-Object { Write-Host ("  {0,-45} {1,8} MB" -f $_.Name, [math]::Round((($_.Group | Measure-Object Length -Sum).Sum)/1MB,0)) }

Write-Host @"

下一步（Win 上跑通）：
1. 打开 OpenSound App；若模型页显示"缺文件"，点「刷新」组件页。
2. 识别 = SenseVoice（已就绪）；朗读 = Kokoro（已就绪）；对话 = LLM（选已下载的档位）。
3. Qwen3-TTS / SenseVoice原始版 / CosyVoice克隆 需要 python 环境（下一步 W2 自动处理）。
"@ -ForegroundColor Cyan