# Publish Script
# Usage: .\publish.ps1

# Load .env variables
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        $name, $value = $_.Split('=', 2)
        Set-Content env:\$name $value
    }
}

$token = $env:OVSX_TOKEN

if (-not $token) {
    Write-Error "Token not found in .env or environment variables."
    exit 1
}

# Package
# vsce rejects SVG images in README.md, so package with the PNG render of the banner
Write-Host "Packaging Extension..."
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$vsix = "claude-proxy-status-$version.vsix"
$readmePath = Join-Path $PWD 'README.md'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$readme = [System.IO.File]::ReadAllText($readmePath, $utf8)
try {
    [System.IO.File]::WriteAllText($readmePath, $readme.Replace('docs/banner.svg', 'docs/banner.png'), $utf8)
    npx -y @vscode/vsce package --out $vsix
} finally {
    [System.IO.File]::WriteAllText($readmePath, $readme, $utf8)
}
if ($LASTEXITCODE -ne 0) {
    Write-Error "Packaging failed."
    exit 1
}

# Publish
Write-Host "Publishing to Open VSX..."
npx -y ovsx publish $vsix -p $token

Write-Host "Done!"
