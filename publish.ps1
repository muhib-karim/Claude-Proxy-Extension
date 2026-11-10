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

# Refuse to continue if anything that must not ship (.secrets, .env*, keys, old .vsix files,
# tests, stray folders) would end up in the package. CI runs the same check.
Write-Host "Checking package contents..."
npm run --silent verify:package
if ($LASTEXITCODE -ne 0) {
    Write-Error "Package content check failed. Nothing was packaged or published."
    exit 1
}

# Package
Write-Host "Packaging Extension..."
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$vsix = "claude-proxy-status-$version.vsix"
npx -y @vscode/vsce@4.1.0 package --out $vsix
if ($LASTEXITCODE -ne 0) {
    Write-Error "Packaging failed."
    exit 1
}

# Publish
Write-Host "Publishing to Open VSX..."
npx -y ovsx publish $vsix -p $token

Write-Host "Done!"
