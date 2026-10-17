# Tao anh mau cho test OCR (chay tren Windows: powershell -ExecutionPolicy Bypass -File make-fixtures.ps1)
# Anh duoc ve bang GDI+ nen chu tieng Viet hien thi dung.
Add-Type -AssemblyName System.Drawing

$root   = $PSScriptRoot
$srcDir = Join-Path $root 'src'

function New-TextImage {
    param([string]$TextPath, [string]$OutPath, [int]$FontSize = 34)

    $text  = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
    $lines = $text -split "`r?`n"

    $lineH = [int]($FontSize * 1.55)
    $pad   = 32
    $w     = 1500
    $h     = [Math]::Max(240, ($lines.Count * $lineH) + ($pad * 2))

    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $font  = New-Object System.Drawing.Font('Arial', $FontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = [System.Drawing.Brushes]::Black

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $g.DrawString($lines[$i], $font, $brush, (New-Object System.Drawing.PointF($pad, ($pad + $i * $lineH))))
    }

    $g.Dispose(); $font.Dispose()
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ('saved: ' + $OutPath)
}

# Anh mo / khong co chu: nen trang + vach xam mo (OCR khong doc duoc gi)
function New-UnreadableImage {
    param([string]$OutPath)

    $w = 900; $h = 420
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $rnd = New-Object System.Random 20240517
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(214, 214, 214)), 1
    for ($i = 0; $i -lt 500; $i++) {
        $g.DrawLine($pen, $rnd.Next($w), $rnd.Next($h), $rnd.Next($w), $rnd.Next($h))
    }
    $pen.Dispose(); $g.Dispose()
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ('saved: ' + $OutPath)
}

# Anh de thi co DAP AN DUNG GACH CHAN (kieu rat pho bien trong de in tu Word).
# Quy uoc trong file nguon:
#   [U]  dong dau = gach chan CHI chu cai dap an (vi du "D.")
#   [UU] dong dau = gach chan CA DONG
function New-UnderlineImage {
    param([string]$TextPath, [string]$OutPath, [int]$FontSize = 34)

    $text  = [System.IO.File]::ReadAllText($TextPath, [System.Text.Encoding]::UTF8)
    $lines = $text -split "`r?`n"

    $lineH = [int]($FontSize * 1.72)
    $pad   = 30
    $w     = 1750
    $h     = [Math]::Max(300, ($lines.Count * $lineH) + ($pad * 2))

    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::White)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

    $normal = New-Object System.Drawing.Font('Arial', $FontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $under  = New-Object System.Drawing.Font('Arial', $FontSize, ([System.Drawing.FontStyle]::Regular -bor [System.Drawing.FontStyle]::Underline), [System.Drawing.GraphicsUnit]::Pixel)
    $brush  = [System.Drawing.Brushes]::Black

    for ($i = 0; $i -lt $lines.Count; $i++) {
        $line = $lines[$i]
        $y = $pad + $i * $lineH
        $all = $false; $letter = $false
        if ($line.StartsWith('[UU]')) { $all = $true; $line = $line.Substring(4) }
        elseif ($line.StartsWith('[U]')) { $letter = $true; $line = $line.Substring(3) }

        if ($all) {
            $g.DrawString($line, $under, $brush, (New-Object System.Drawing.PointF([single]$pad, [single]$y)))
        } elseif ($letter) {
            $idx = $line.IndexOf('. ')
            if ($idx -ge 0) {
                $head = $line.Substring(0, $idx + 1)
                $tail = $line.Substring($idx + 1)
                $g.DrawString($head, $under, $brush, (New-Object System.Drawing.PointF([single]$pad, [single]$y)))
                $size = $g.MeasureString($head, $under)
                $x2 = [single]$pad + [single]$size.Width
                $g.DrawString($tail, $normal, $brush, (New-Object System.Drawing.PointF([single]$x2, [single]$y)))
            } else {
                $g.DrawString($line, $under, $brush, (New-Object System.Drawing.PointF([single]$pad, [single]$y)))
            }
        } else {
            $g.DrawString($line, $normal, $brush, (New-Object System.Drawing.PointF([single]$pad, [single]$y)))
        }
    }

    $g.Dispose(); $normal.Dispose(); $under.Dispose()
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Output ('saved: ' + $OutPath)
}

New-TextImage -TextPath (Join-Path $srcDir 'de-thi-4cau.txt') -OutPath (Join-Path $root 'de-thi-4cau.png')
New-TextImage -TextPath (Join-Path $srcDir 'de-thi-8cau.txt') -OutPath (Join-Path $root 'de-thi-8cau.png')
New-UnderlineImage -TextPath (Join-Path $srcDir 'de-thi-gach-chan.txt') -OutPath (Join-Path $root 'de-thi-gach-chan.png')
New-UnreadableImage -OutPath (Join-Path $root 'anh-mo.png')
