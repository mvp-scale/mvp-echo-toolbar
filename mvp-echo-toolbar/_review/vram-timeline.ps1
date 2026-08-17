<#
  VRAM timeline probe — where does the GPU memory actually go?

  The question: the 3090 shows ~2.5 GB resident while the XPS shows ~1.2 GB, both
  on the fp16 encoder. 1.2 GB is the weight file almost exactly (1,238,960,452
  bytes), so the extra ~1.3 GB on the desktop is NOT weights. This tells you what
  it is by measuring WHEN the memory appears.

  Smoke-test it first (2 seconds, no ceremony):
      pwsh -NoProfile -File .\_review\vram-timeline.ps1 -Check

  Then the real run (four labelled samples):
      pwsh -NoProfile -File .\_review\vram-timeline.ps1

  Windows PowerShell 5.1 works too:
      powershell -ExecutionPolicy Bypass -File .\_review\vram-timeline.ps1

  Nothing is installed and nothing is written outside this console.
#>

[CmdletBinding()]
param(
  # Print the disk listing and a single VRAM sample, then exit. Use this to
  # confirm the script runs before committing to the four-checkpoint sequence.
  [switch]$Check
)

# NOT 'Stop'. A terminating preference turned a recoverable nvidia-smi quirk into
# a dead script with no output, which is the opposite of what a probe is for.
# Failures are handled where they happen and reported in place.
$ErrorActionPreference = 'Continue'

function Get-Smi {
  $cmd = Get-Command nvidia-smi -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  foreach ($p in @(
      "$env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
      "$env:SystemRoot\System32\nvidia-smi.exe")) {
    if (Test-Path $p) { return $p }
  }
  return $null
}

# Per-process accounting is the number we want, but Windows drives consumer cards
# in WDDM mode, where nvidia-smi routinely reports per-process memory as N/A and
# omits graphics processes entirely. So: try per-process, fall back to whole-card
# used memory with the baseline subtracted — and SAY which one it used rather
# than quietly presenting one as the other.
function Read-Vram {
  param([string]$Smi)

  $mine = @()
  $rows = & $Smi --query-compute-apps=pid,used_gpu_memory --format=csv,noheader,nounits 2>$null
  if ($LASTEXITCODE -eq 0 -and $rows) {
    foreach ($row in $rows) {
      # $procId, NOT $pid: $PID is a read-only automatic variable in both 5.1 and
      # 7, and assigning to it throws before this function can return anything.
      if ($row -match '^\s*(\d+)\s*,\s*(\d+)\s*$') {
        $procId = [int]$Matches[1]
        $usedMb = [int]$Matches[2]
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -like '*MVP-Echo*') { $mine += $usedMb }
      }
    }
  }
  if ($mine.Count -gt 0) {
    return @{ mb = ($mine | Measure-Object -Sum).Sum; mode = 'per-process'; procs = $mine.Count }
  }

  $total = & $Smi --query-gpu=memory.used --format=csv,noheader,nounits 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $total) {
    return @{ mb = -1; mode = 'unavailable'; procs = 0 }
  }
  return @{ mb = [int]($total | Select-Object -First 1); mode = 'whole-card'; procs = 0 }
}

# Which encoder is actually on disk. fp16 and fp32 hold the same graph, so the
# byte count IS the dtype proof: 1,238,960,452 vs 2,435,420,160 is exactly half.
function Show-ModelFiles {
  $modelDir = Join-Path $env:LOCALAPPDATA 'mvp-echo-toolbar\models'
  Write-Host "`n=== Model files on disk ===" -ForegroundColor Cyan
  Write-Host "  $modelDir"
  if (-not (Test-Path $modelDir)) {
    Write-Host "  (does not exist — nothing downloaded yet)" -ForegroundColor Yellow
    return
  }
  foreach ($file in (Get-ChildItem $modelDir -File)) {
    # $file is bound OUTSIDE the switch on purpose. Inside a switch action block
    # $_ is the switch's INPUT (here, the file name string), so $_.Length would
    # silently be a character count and every file would read SIZE MISMATCH.
    $tag = switch ($file.Name) {
      'encoder-model.fp16.onnx' {
        if ($file.Length -eq 1238960452) { 'fp16 encoder — exact expected size' }
        else { 'fp16 encoder — SIZE MISMATCH (expected 1,238,960,452)' }
      }
      'encoder-model.onnx.data' { 'fp32 weights present — fp32 is possible here' }
      'encoder-model.int8.onnx' { 'int8 encoder' }
      default { '' }
    }
    '  {0,-32} {1,15:N0} bytes  {2}' -f $file.Name, $file.Length, $tag | Write-Host
  }
}

# ── main ────────────────────────────────────────────────────────────────────
$smi = Get-Smi
if (-not $smi) {
  Write-Host "nvidia-smi not found." -ForegroundColor Red
  Write-Host "It ships with the NVIDIA driver. Looked in PATH and:"
  Write-Host "  $env:ProgramFiles\NVIDIA Corporation\NVSMI\nvidia-smi.exe"
  Write-Host "  $env:SystemRoot\System32\nvidia-smi.exe"
  exit 1
}
Write-Host "nvidia-smi: $smi" -ForegroundColor DarkGray

Show-ModelFiles

if ($Check) {
  Write-Host "`n=== Single sample (-Check) ===" -ForegroundColor Cyan
  $v = Read-Vram -Smi $smi
  if ($v.mb -lt 0) {
    Write-Host "  nvidia-smi ran but returned no usable memory figure." -ForegroundColor Red
    Write-Host "  Paste the output of:  nvidia-smi --query-gpu=memory.used --format=csv"
    exit 1
  }
  '  {0} MB   (mode: {1}{2})' -f $v.mb, $v.mode, $(if ($v.procs) { ", $($v.procs) proc(s)" } else { '' }) | Write-Host -ForegroundColor Green
  Write-Host "`nWorks. Re-run without -Check for the full timeline." -ForegroundColor Green
  exit 0
}

$samples = [ordered]@{}
function Add-Checkpoint {
  param([string]$Label, [string]$Instruction)
  Write-Host "`n>>> $Instruction" -ForegroundColor Yellow
  [void](Read-Host "    press Enter when done")
  $v = Read-Vram -Smi $smi
  $samples[$Label] = $v
  '    {0,-26} {1,6} MB   ({2})' -f $Label, $v.mb, $v.mode | Write-Host -ForegroundColor Green
}

Write-Host "`n=== VRAM timeline ===" -ForegroundColor Cyan
Write-Host "Four samples. Keep DevTools CLOSED throughout — it allocates GPU memory of its own."

Add-Checkpoint 'baseline (app closed)'   'Close MVP-Echo completely (tray -> Quit), then continue.'
Add-Checkpoint 'model loaded'            'Launch the app, select GPU, wait for "Model loaded and ready" in the log.'
Add-Checkpoint 'after 1 transcription'   'Record and transcribe ONE short clip.'
Add-Checkpoint 'after 10 transcriptions' 'Record and transcribe TEN more short clips.'

$base   = $samples['baseline (app closed)'].mb
$loaded = $samples['model loaded'].mb
$ten    = $samples['after 10 transcriptions'].mb
$atLoad = $loaded - $base
$growth = $ten - $loaded

Write-Host "`n=== Result ===" -ForegroundColor Cyan
'  attributable at load     {0,6} MB' -f $atLoad | Write-Host
'  growth over 11 runs      {0,6} MB' -f $growth | Write-Host
'  fp16 weights on disk       1181 MB' | Write-Host

Write-Host "`n=== Reading ===" -ForegroundColor Cyan
if ($atLoad -ge 2000 -and $growth -lt 300) {
  Write-Host "  ~2x the weights at load, then flat." -ForegroundColor Yellow
  Write-Host "  => the weights are resident TWICE, or upcast to fp32 on upload."
  Write-Host "     An upload/staging buffer never destroyed after session creation"
  Write-Host "     gives exactly this shape. That is upstream in ORT, not in this app."
} elseif ($atLoad -lt 1600 -and $growth -ge 500) {
  Write-Host "  Starts near the weight size and climbs with use." -ForegroundColor Yellow
  Write-Host "  => ORT's WebGPU allocator is caching freed activation buffers and"
  Write-Host "     never releasing them. WebGPU hands it no VRAM-pressure signal,"
  Write-Host "     so a 24 GB card never forces reuse and a 4 GB one does."
} elseif ($atLoad -lt 1600 -and $growth -lt 300) {
  Write-Host "  ~1.2 GB at load and stable." -ForegroundColor Green
  Write-Host "  => fp16 is resident exactly once, and nothing is over-allocating."
  Write-Host "     Whatever showed 2.5 GB was counting other things alongside it."
} else {
  Write-Host "  Mixed shape — paste the four numbers and the mode into the chat." -ForegroundColor Yellow
}

if ($samples['model loaded'].mode -eq 'whole-card') {
  Write-Host "`n  NOTE: whole-card mode — WDDM hid per-process accounting, so these" -ForegroundColor DarkYellow
  Write-Host "  numbers include everything else on the GPU. The deltas still hold," -ForegroundColor DarkYellow
  Write-Host "  as long as nothing else started or stopped between samples." -ForegroundColor DarkYellow
}

Write-Host ""
foreach ($kv in $samples.GetEnumerator()) { '{0,-26} {1,6} MB' -f $kv.Key, $kv.Value.mb | Write-Host }
