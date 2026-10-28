# ocr.ps1 — 用 Windows 自带的 Windows.Media.Ocr 做本地 OCR（零安装、零依赖）。
#
# 为什么用 PowerShell + WinRT 而不是 Python/pytesseract/easyocr：
#   1. Windows 10/11 自带 OCR 引擎（中文语言包随系统装），不用装任何东西；
#   2. 2026-10-18 实测：本机 node 的「管道捕获输出」式 spawn（execFileSync/管道）
#      间歇被 EBUSY——所以本脚本**不往 stdout 吐结果**，一律写入参指定的
#      输出文件，调用方用 stdio:'ignore' 起进程再读文件，10/10 稳定。
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -ImagePath <图> -OutPath <结果>
#   成功：exit 0，OutPath 写识别文本（可能为空串 = 图里没文字）
#   失败：exit 1，OutPath 写 "##ERR##<原因>"
#
# 维护备注：改输出协议必须先改 vision.mjs 的解析，别单边改。

param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][string]$OutPath
)

$ErrorActionPreference = "Stop"

function Write-Out {
  param([string]$Text)
  # UTF-8 无 BOM，Node 侧按 utf8 读
  [System.IO.File]::WriteAllText($OutPath, $Text, (New-Object System.Text.UTF8Encoding($false)))
}

try {
  if (-not (Test-Path -LiteralPath $ImagePath)) {
    Write-Out "##ERR##图片不存在: $ImagePath"
    exit 1
  }

  Add-Type -AssemblyName System.Runtime.WindowsRuntime

  # PS 5.1 不会自动解析 UWP/WinRT 类型字面量，必须先显式静态加载。
  # 2026-10-18 实测三个坑（都踩过，别再改回去）：
  #   1. & ("[类型, 程序集, ...]") 字符串动态加载**不可用**——PS 把它当命令名报
  #      「无法识别为 cmdlet」，必须静态字面量；
  #   2. Windows.Globalization.Language 的程序集名是 **Windows.Globalization**，
  #      不是 Windows.Foundation（写错就报「找不到类型」且毫无提示）；
  #   3. 文件必须带 UTF-8 BOM，否则 PS 5.1 按 GBK 解析，中文注释会让语法全乱、
  #      脚本入口直接挂（退出码 1、什么都不执行、无任何输出）。
  $typeLoadErrors = @()
  try { $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime] } catch { $typeLoadErrors += "OcrEngine: $($_.Exception.Message)" }
  try { $null = [Windows.Globalization.Language, Windows.Globalization, ContentType=WindowsRuntime] } catch { $typeLoadErrors += "Language: $($_.Exception.Message)" }
  try { $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime] } catch { $typeLoadErrors += "StorageFile: $($_.Exception.Message)" }
  try { $null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime] } catch { $typeLoadErrors += "FileAccessMode: $($_.Exception.Message)" }
  try { $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime] } catch { $typeLoadErrors += "BitmapDecoder: $($_.Exception.Message)" }
  if ($typeLoadErrors.Count -gt 0) {
    Write-Out "##ERR##WinRT 类型加载失败: $($typeLoadErrors -join ' | ')"
    exit 1
  }

  # 依次试中文（简体）、英文引擎；语言包没装的会返回 null
  $engine = $null
  $tried = @()
  foreach ($lang in @("zh-Hans-CN", "en-US")) {
    try {
      $e = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new($lang))
      if ($null -ne $e) { $engine = $e; break }
      $tried += $lang
    } catch {
      $tried += "$lang($($_.Exception.Message))"
    }
  }
  if ($null -eq $engine) {
    Write-Out "##ERR##系统没有可用 OCR 语言包，试过: $($tried -join ', ')"
    exit 1
  }

  # 文件 → StorageFile → 流 → 解码器 → SoftwareBitmap → OCR
  $asTask = [System.Runtime.WindowsRuntime.WindowsRuntimeSystemExtensions]
  $fileOp = [Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)
  $file = $asTask::AsTask($fileOp).GetAwaiter().GetResult()
  $streamOp = $file.OpenAsync([Windows.Storage.FileAccessMode]::Read)
  $stream = $asTask::AsTask($streamOp).GetAwaiter().GetResult()
  $decoderOp = [Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)
  $decoder = $asTask::AsTask($decoderOp).GetAwaiter().GetResult()
  $bitmapOp = $decoder.GetSoftwareBitmapAsync()
  $bitmap = $asTask::AsTask($bitmapOp).GetAwaiter().GetResult()
  $ocrOp = $engine.RecognizeAsync($bitmap)
  $result = $asTask::AsTask($ocrOp).GetAwaiter().GetResult()

  $text = $result.Text
  if ($null -eq $text) { $text = "" }
  Write-Out $text
  exit 0
} catch {
  $msg = $_.Exception.Message -replace "`r?`n", " "
  Write-Out "##ERR##$msg"
  exit 1
}
