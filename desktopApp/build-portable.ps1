param(
    [string]$NodeVersion = "v24.18.0",
    [switch]$SkipChecks
)

$ErrorActionPreference = "Stop"
$desktopRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repositoryRoot = Split-Path -Parent $desktopRoot
$stageRoot = Join-Path $desktopRoot ".stage"
$publishRoot = Join-Path $stageRoot "ApplicationChecker"
$artifactsRoot = Join-Path $desktopRoot "artifacts"
$cacheRoot = Join-Path $desktopRoot ".cache"
$zipPath = Join-Path $artifactsRoot "ApplicationChecker-portable-win-x64.zip"
$originalCi = $env:CI

function Remove-BuildDirectory([string]$Path) {
    $resolvedDesktop = [System.IO.Path]::GetFullPath($desktopRoot).TrimEnd('\') + '\'
    $resolvedTarget = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolvedTarget.StartsWith($resolvedDesktop, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove a path outside desktopApp: $resolvedTarget"
    }
    if (Test-Path -LiteralPath $resolvedTarget) {
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }
}

Push-Location $repositoryRoot
try {
    $env:CI = "true"
    $buildNodeVersion = (& node --version).Trim()
    if ($buildNodeVersion -ne $NodeVersion) {
        throw "The build Node.js version is $buildNodeVersion, but the portable runtime is $NodeVersion. Use the same version so native modules are ABI-compatible."
    }
    & pnpm install --frozen-lockfile
    if ($LASTEXITCODE -ne 0) { throw "Workspace dependency restore failed." }

    if (-not $SkipChecks) {
        & pnpm typecheck
        if ($LASTEXITCODE -ne 0) { throw "Type checking failed." }
        & pnpm test
        if ($LASTEXITCODE -ne 0) { throw "Tests failed." }
    }

    & pnpm build
    if ($LASTEXITCODE -ne 0) { throw "Workspace build failed." }

    Remove-BuildDirectory $stageRoot
    New-Item -ItemType Directory -Force -Path $publishRoot, $artifactsRoot, $cacheRoot | Out-Null

    & dotnet publish (Join-Path $desktopRoot "ApplicationChecker.Desktop.csproj") `
        --configuration Release `
        --runtime win-x64 `
        --self-contained false `
        --output $publishRoot
    if ($LASTEXITCODE -ne 0) { throw "Desktop host publish failed." }

    # Framework-dependent publishing must not accidentally ship a private .NET/WPF runtime.
    $forbiddenRuntimeFiles = @(
        "coreclr.dll",
        "hostfxr.dll",
        "hostpolicy.dll",
        "System.Private.CoreLib.dll",
        "PresentationFramework.dll"
    )
    foreach ($runtimeFile in $forbiddenRuntimeFiles) {
        if (Test-Path -LiteralPath (Join-Path $publishRoot $runtimeFile)) {
            throw "Framework-dependent package unexpectedly contains .NET runtime file: $runtimeFile"
        }
    }

    # Keep only neutral English and Simplified Chinese optional package resources.
    $culturesToRemove = @("cs", "de", "es", "fr", "it", "ja", "ko", "pl", "pt-BR", "ru", "tr", "zh-Hant")
    foreach ($culture in $culturesToRemove) {
        $culturePath = Join-Path $publishRoot $culture
        if (Test-Path -LiteralPath $culturePath) {
            $resolvedCulture = [System.IO.Path]::GetFullPath($culturePath)
            $resolvedPublish = [System.IO.Path]::GetFullPath($publishRoot).TrimEnd('\') + '\'
            if (-not $resolvedCulture.StartsWith($resolvedPublish, [System.StringComparison]::OrdinalIgnoreCase)) {
                throw "Refusing to remove a culture directory outside the publish root: $resolvedCulture"
            }
            Remove-Item -LiteralPath $resolvedCulture -Recurse -Force
        }
    }

    $nodeArchive = Join-Path $cacheRoot "node-$NodeVersion-win-x64.zip"
    if (-not (Test-Path -LiteralPath $nodeArchive)) {
        $nodeUrl = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
        Write-Host "Downloading Node.js $NodeVersion..."
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeArchive
    }
    $nodeExtract = Join-Path $stageRoot "node-extract"
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
    $nodeSource = Join-Path $nodeExtract "node-$NodeVersion-win-x64"
    $nodeTarget = Join-Path $publishRoot "internal\node"
    New-Item -ItemType Directory -Force -Path $nodeTarget | Out-Null
    Copy-Item -LiteralPath (Join-Path $nodeSource "node.exe") -Destination $nodeTarget -Force
    Copy-Item -LiteralPath (Join-Path $nodeSource "LICENSE") -Destination $nodeTarget -Force

    $apiTarget = Join-Path $publishRoot "internal\api"
    $runnerTarget = Join-Path $publishRoot "internal\runner"
    & pnpm exec ncc build (Join-Path $repositoryRoot "apps\api\dist\server.js") -o $apiTarget
    if ($LASTEXITCODE -ne 0) { throw "API bundle failed." }
    & pnpm exec ncc build (Join-Path $repositoryRoot "apps\runner\dist\runner.js") -o $runnerTarget
    if ($LASTEXITCODE -ne 0) { throw "Runner bundle failed." }

    $webTarget = Join-Path $publishRoot "internal\web"
    New-Item -ItemType Directory -Force -Path $webTarget | Out-Null
    Copy-Item -Path (Join-Path $repositoryRoot "apps\web\dist\*") -Destination $webTarget -Recurse -Force

    $dataTarget = Join-Path $publishRoot "data"
    New-Item -ItemType Directory -Force -Path $dataTarget | Out-Null
    Set-Content -LiteralPath (Join-Path $dataTarget "README.txt") -Encoding UTF8 -Value @"
Application Checker portable data directory.
Database, screenshots, settings, WebView2 data, browser profiles, logs and temporary files stay here.
"@

    if (Test-Path -LiteralPath $zipPath) {
        Remove-Item -LiteralPath $zipPath -Force
    }
    Compress-Archive -Path (Join-Path $publishRoot "*") -DestinationPath $zipPath -CompressionLevel Optimal
    $sizeMb = [Math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)
    Write-Host "Portable package created: $zipPath ($sizeMb MB)"
}
finally {
    $env:CI = $originalCi
    Pop-Location
}
