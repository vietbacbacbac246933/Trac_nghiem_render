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

New-TextImage -TextPath (Join-Path $srcDir 'de-thi-4cau.txt') -OutPath (Join-Path $root 'de-thi-4cau.png')
New-TextImage -TextPath (Join-Path $srcDir 'de-thi-8cau.txt') -OutPath (Join-Path $root 'de-thi-8cau.png')
New-UnreadableImage -OutPath (Join-Path $root 'anh-mo.png')
