Add-Type -AssemblyName System.Drawing

$pngPath = 'C:\Users\Mica\Downloads\files\assets\icon_large.png'
$icoPath = 'C:\Users\Mica\Downloads\files\assets\icon_256.ico'

$png = [System.Drawing.Image]::FromFile($pngPath)
$bmp = New-Object System.Drawing.Bitmap($png, 256, 256)

# Save resized PNG to memory
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$pngBytes = $ms.ToArray()
$ms.Close()

# Build a valid ICO file with one 256x256 PNG entry
$icoStream = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$writer = New-Object System.IO.BinaryWriter($icoStream)

# ICO header
$writer.Write([int16]0)        # Reserved
$writer.Write([int16]1)        # Type: ICO
$writer.Write([int16]1)        # Number of images

# ICONDIRENTRY for 256x256 (0 = 256 in ICO format)
$writer.Write([byte]0)         # Width: 0 = 256
$writer.Write([byte]0)         # Height: 0 = 256
$writer.Write([byte]0)         # Color count
$writer.Write([byte]0)         # Reserved
$writer.Write([int16]1)        # Planes
$writer.Write([int16]32)       # Bit count
$writer.Write([int32]$pngBytes.Length)  # Size of image data
$writer.Write([int32]22)       # Offset: 6 (header) + 16 (entry) = 22

# Image data
$writer.Write($pngBytes)
$writer.Close()
$icoStream.Close()
$png.Dispose()
$bmp.Dispose()

Write-Host "ICO creado exitosamente: $icoPath"
Write-Host "Tamaño: $($pngBytes.Length) bytes"
