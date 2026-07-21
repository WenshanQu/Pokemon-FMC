<#
.SYNOPSIS
  Crop a card image down to the card face (trims transparent or uniform-color borders).

.DESCRIPTION
  Built for source images that come padded / landscape (e.g. snkrdunk's
  `upload_bg_removed/...webp?size=l`, typically 856x625 with the card small and off-centre).
  - If the image has a transparent background, it trims by alpha (content = alpha > -AlphaThreshold).
  - Otherwise it detects the border colour from the four corners and trims the uniform border.
  Output is always a PNG (preserves transparency). Loads webp / png / jpg via WPF/WIC.

.PARAMETER Source
  Path to the image to crop (required).

.PARAMETER Dest
  Output path. Defaults to "<source-dir>\<source-basename>_c.png".

.PARAMETER Pad
  Pixels of padding to keep around the detected content (default 2).

.PARAMETER AlphaThreshold
  Alpha value above which a pixel counts as content, in transparent mode (default 20).

.PARAMETER ColorTolerance
  Per-channel difference from the border colour above which a pixel counts as content,
  in opaque mode (default 24).

.EXAMPLE
  ./scripts/crop-image.ps1 images/jp_quagsire_delta_pcg9_006.webp
  # -> images/jp_quagsire_delta_pcg9_006_c.png

.EXAMPLE
  ./scripts/crop-image.ps1 -Source images/raw.webp -Dest images/jp_slowbro_xyz_c.png -Pad 3
#>
param(
  [Parameter(Mandatory = $true, Position = 0)] [string]$Source,
  [Parameter(Position = 1)] [string]$Dest,
  [int]$Pad = 2,
  [int]$AlphaThreshold = 20,
  [int]$ColorTolerance = 24
)

Add-Type -AssemblyName PresentationCore

if (-not (Test-Path $Source)) { Write-Error "Source not found: $Source"; exit 1 }
$Source = (Resolve-Path $Source).Path
if (-not $Dest) {
  $dir = [IO.Path]::GetDirectoryName($Source)
  $base = [IO.Path]::GetFileNameWithoutExtension($Source)
  $Dest = Join-Path $dir "$base`_c.png"
}

# --- load + convert to Bgra32 ---
try {
  $fs = [IO.File]::OpenRead($Source)
  $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create(
    $fs,
    [System.Windows.Media.Imaging.BitmapCreateOptions]::PreservePixelFormat,
    [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad)
  $frame = $dec.Frames[0]
  $fs.Close()
} catch { Write-Error "Failed to load image: $($_.Exception.Message)"; exit 2 }

$conv = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap(
  $frame, [System.Windows.Media.PixelFormats]::Bgra32, $null, 0)
$w = $conv.PixelWidth; $h = $conv.PixelHeight; $stride = $w * 4
$buf = New-Object byte[] ($stride * $h)
$conv.CopyPixels($buf, $stride, 0)

# --- decide mode: transparent vs opaque ---
$transparent = 0
for ($y = 0; $y -lt $h; $y += 4) {           # sample every 4th row for speed
  $row = $y * $stride
  for ($x = 0; $x -lt $w; $x += 4) {
    if ($buf[$row + $x * 4 + 3] -lt 200) { $transparent++ }
  }
}
$useAlpha = $transparent -gt (($w * $h) / 16 * 0.03)   # >3% sampled pixels see-through

$minX = $w; $minY = $h; $maxX = -1; $maxY = -1

if ($useAlpha) {
  for ($y = 0; $y -lt $h; $y++) { $row = $y * $stride
    for ($x = 0; $x -lt $w; $x++) {
      if ($buf[$row + $x * 4 + 3] -gt $AlphaThreshold) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $mode = "alpha"
} else {
  # border colour = average of the four corners
  function Px([int]$x, [int]$y) { $i = $y * $stride + $x * 4; return @($buf[$i+2], $buf[$i+1], $buf[$i]) } # R,G,B
  $c1 = Px 0 0; $c2 = Px ($w-1) 0; $c3 = Px 0 ($h-1); $c4 = Px ($w-1) ($h-1)
  $br = [int](($c1[0]+$c2[0]+$c3[0]+$c4[0]) / 4)
  $bg = [int](($c1[1]+$c2[1]+$c3[1]+$c4[1]) / 4)
  $bb = [int](($c1[2]+$c2[2]+$c3[2]+$c4[2]) / 4)
  for ($y = 0; $y -lt $h; $y++) { $row = $y * $stride
    for ($x = 0; $x -lt $w; $x++) { $i = $row + $x * 4
      $dr = [Math]::Abs($buf[$i+2] - $br); $dg = [Math]::Abs($buf[$i+1] - $bg); $db = [Math]::Abs($buf[$i] - $bb)
      if ($dr -gt $ColorTolerance -or $dg -gt $ColorTolerance -or $db -gt $ColorTolerance) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $mode = "border(rgb $br,$bg,$bb)"
}

if ($maxX -lt 0) { Write-Error "No content detected (nothing to crop)"; exit 3 }

$minX = [Math]::Max(0, $minX - $Pad); $minY = [Math]::Max(0, $minY - $Pad)
$maxX = [Math]::Min($w - 1, $maxX + $Pad); $maxY = [Math]::Min($h - 1, $maxY + $Pad)
$cw = $maxX - $minX + 1; $ch = $maxY - $minY + 1

$rect = New-Object System.Windows.Int32Rect($minX, $minY, $cw, $ch)
$crop = New-Object System.Windows.Media.Imaging.CroppedBitmap($conv, $rect)
$enc = New-Object System.Windows.Media.Imaging.PngBitmapEncoder
$enc.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($crop))
$out = [IO.File]::Create($Dest); $enc.Save($out); $out.Close()

"cropped [$mode] $w x $h -> $cw x $ch  ratio=$([Math]::Round($cw / $ch, 3))  -> $Dest"
