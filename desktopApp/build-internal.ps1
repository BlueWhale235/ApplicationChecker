param(
    [string]$BuildVersion = "",
    [string]$OutputPath = "",
    [switch]$SkipInstall,
    [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Split-Path -Parent $desktopRoot
$versionConfigPath = Join-Path $repositoryRoot "app-version.json"
$defaultOutputPath = Join-Path $desktopRoot ".stage/ApplicationChecker/internal"
$internalRoot = if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $defaultOutputPath
} else {
    [System.IO.Path]::GetFullPath($OutputPath)
}
$originalCi = $env:CI
$originalViteAppVersion = $env:VITE_APP_VERSION
$buildLockPath = Join-Path $desktopRoot ".cache/build.lock"
$buildLockStream = $null

if ([string]::IsNullOrWhiteSpace($BuildVersion)) {
    if (-not (Test-Path -LiteralPath $versionConfigPath)) {
        throw "Version config was not found: $versionConfigPath"
    }
    $BuildVersion = (Get-Content -LiteralPath $versionConfigPath -Raw -Encoding utf8 | ConvertFrom-Json).version
}
if ($BuildVersion -notmatch '^v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$') {
    throw "BuildVersion must be a semantic version such as v0.0.8 or v0.1.0-beta.1."
}
$normalizedBuildVersion = if ($BuildVersion.StartsWith("v")) { $BuildVersion } else { "v$BuildVersion" }

function Remove-InternalDirectory([string]$Name) {
    if ($Name -notin @("api", "runner", "web")) {
        throw "Refusing to remove an unsupported internal directory: $Name"
    }
    $root = [System.IO.Path]::GetFullPath($internalRoot)
    if ($root -eq [System.IO.Path]::GetPathRoot($root)) {
        throw "Refusing to use a filesystem root as InternalOutput: $root"
    }
    $target = Join-Path $root $Name
    if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
    }
}

function Compress-JavaScriptTree([string]$Path) {
    $javascriptFiles = @(Get-ChildItem -LiteralPath $Path -Recurse -Filter "*.js" -File)
    foreach ($javascriptFile in $javascriptFiles) {
        $temporaryPath = "$($javascriptFile.FullName).minified"
        & pnpm exec esbuild $javascriptFile.FullName `
            --minify `
            --platform=node `
            "--outfile=$temporaryPath"
        if ($LASTEXITCODE -ne 0) {
            throw "JavaScript minification failed: $($javascriptFile.FullName)"
        }
        Move-Item -LiteralPath $temporaryPath -Destination $javascriptFile.FullName -Force
    }
}

function Invoke-NccBundle(
    [string]$EntryPath,
    [string]$TargetPath,
    [string]$Label,
    [string]$InternalDirectoryName
) {
    for ($attempt = 1; $attempt -le 2; $attempt++) {
        & pnpm exec ncc build $EntryPath -o $TargetPath
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq 0) {
            return
        }
        if ($attempt -eq 1) {
            Write-Warning "$Label ncc bundling exited with code $exitCode. Removing partial output and retrying once."
            Remove-InternalDirectory $InternalDirectoryName
            Start-Sleep -Milliseconds 300
            continue
        }
        throw "$Label bundling failed after 2 attempts (ncc exit code $exitCode). Entry: $EntryPath; Target: $TargetPath"
    }
}

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $buildLockPath) | Out-Null
try {
    $buildLockStream = [System.IO.File]::Open(
        $buildLockPath,
        [System.IO.FileMode]::OpenOrCreate,
        [System.IO.FileAccess]::ReadWrite,
        [System.IO.FileShare]::None
    )
} catch {
    throw "Another desktop build is already running. Wait for it to finish before rebuilding internal files."
}

Push-Location $repositoryRoot
try {
    $env:CI = "true"
    $env:VITE_APP_VERSION = $normalizedBuildVersion
    Write-Host "Building internal runtime only ($normalizedBuildVersion)"
    Write-Host "Output: $internalRoot"

    if (-not $SkipInstall) {
        & pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "Workspace dependency restore failed." }
    }
    if (-not $SkipChecks) {
        & pnpm typecheck
        if ($LASTEXITCODE -ne 0) { throw "Type checking failed." }
        & pnpm test
        if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
    }

    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw "Workspace build failed." }

    New-Item -ItemType Directory -Force -Path $internalRoot | Out-Null
    foreach ($name in @("api", "runner", "web")) {
        Remove-InternalDirectory $name
    }

    $apiTarget = Join-Path $internalRoot "api"
    $runnerTarget = Join-Path $internalRoot "runner"
    Invoke-NccBundle (Join-Path $repositoryRoot "apps/api/dist/server.js") $apiTarget "API" "api"
    Invoke-NccBundle (Join-Path $repositoryRoot "apps/runner/dist/runner.js") $runnerTarget "Runner" "runner"
    Compress-JavaScriptTree $apiTarget
    Compress-JavaScriptTree $runnerTarget

    $webTarget = Join-Path $internalRoot "web"
    New-Item -ItemType Directory -Force -Path $webTarget | Out-Null
    Copy-Item -Path (Join-Path $repositoryRoot "apps/web/dist/*") -Destination $webTarget -Recurse -Force

    Write-Host "Internal runtime build completed."
    Write-Host "The desktop host, Node.js runtime and portable ZIP were not rebuilt."
} finally {
    $env:CI = $originalCi
    $env:VITE_APP_VERSION = $originalViteAppVersion
    Pop-Location
    $buildLockStream.Dispose()
}
