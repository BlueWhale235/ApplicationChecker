param(
    [string]$NodeVersion = "v24.18.0",
    [string]$BuildVersion = "",
    [switch]$SkipInstall,
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
$versionConfigPath = Join-Path $repositoryRoot "app-version.json"
$originalCi = $env:CI
$originalViteAppVersion = $env:VITE_APP_VERSION
$isWindowsPlatform = [System.IO.Path]::DirectorySeparatorChar -eq '\'
$pathComparison = if ($isWindowsPlatform) {
    [System.StringComparison]::OrdinalIgnoreCase
} else {
    [System.StringComparison]::Ordinal
}

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
$assemblyVersion = $normalizedBuildVersion.Substring(1)

function Get-DirectoryPrefix([string]$Path) {
    $separator = [System.IO.Path]::DirectorySeparatorChar
    $trimCharacters = [char[]]@(
        [System.IO.Path]::DirectorySeparatorChar,
        [System.IO.Path]::AltDirectorySeparatorChar
    )
    return [System.IO.Path]::GetFullPath($Path).TrimEnd($trimCharacters) + $separator
}

function Remove-BuildDirectory([string]$Path) {
    $resolvedDesktop = Get-DirectoryPrefix $desktopRoot
    $resolvedTarget = [System.IO.Path]::GetFullPath($Path)
    if (-not $resolvedTarget.StartsWith($resolvedDesktop, $pathComparison)) {
        throw "Refusing to remove a path outside desktopApp: $resolvedTarget"
    }
    if (Test-Path -LiteralPath $resolvedTarget) {
        Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
    }
}

function Test-WindowsPortableExecutable([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return $stream.ReadByte() -eq 0x4D -and $stream.ReadByte() -eq 0x5A
    } finally {
        $stream.Dispose()
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

Push-Location $repositoryRoot
try {
    $env:CI = "true"
    $env:VITE_APP_VERSION = $normalizedBuildVersion
    Write-Host "Building Application Checker $normalizedBuildVersion"
    $buildNodeVersion = (& node --version).Trim()
    if ($buildNodeVersion -ne $NodeVersion) {
        throw "The build Node.js version is $buildNodeVersion, but the portable runtime is $NodeVersion. Use the same version so native modules are ABI-compatible."
    }
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

    Remove-BuildDirectory $stageRoot
    New-Item -ItemType Directory -Force -Path $publishRoot, $artifactsRoot, $cacheRoot | Out-Null

    & dotnet publish (Join-Path $desktopRoot "ApplicationChecker.Desktop.csproj") `
        --configuration Release `
        --runtime win-x64 `
        --self-contained false `
        -p:Version=$assemblyVersion `
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
            $resolvedPublish = Get-DirectoryPrefix $publishRoot
            if (-not $resolvedCulture.StartsWith($resolvedPublish, $pathComparison)) {
                throw "Refusing to remove a culture directory outside the publish root: $resolvedCulture"
            }
            Remove-Item -LiteralPath $resolvedCulture -Recurse -Force
        }
    }

    $nodeDistributionName = "node-$NodeVersion-win-x64"
    $nodeCache = Join-Path $cacheRoot $nodeDistributionName
    $legacyNodeArchive = Join-Path $cacheRoot "$nodeDistributionName.zip"
    $cachedNodeExecutable = Join-Path $nodeCache "node.exe"
    $cachedNodeLicense = Join-Path $nodeCache "LICENSE"
    $hasExtractedNodeCache = (
        (Test-Path -LiteralPath $cachedNodeExecutable -PathType Leaf) -and
        (Test-Path -LiteralPath $cachedNodeLicense -PathType Leaf) -and
        (Test-WindowsPortableExecutable $cachedNodeExecutable)
    )

    if (-not $hasExtractedNodeCache) {
        if (Test-Path -LiteralPath $nodeCache) {
            Write-Host "Removing incomplete Node.js extracted cache..."
            Remove-BuildDirectory $nodeCache
        }

        $temporarySuffix = [System.Guid]::NewGuid().ToString("N")
        $nodeArchive = Join-Path $cacheRoot "$nodeDistributionName-$temporarySuffix.zip"
        $nodeExtract = Join-Path $cacheRoot "$nodeDistributionName-extract-$temporarySuffix"
        try {
            if (Test-Path -LiteralPath $legacyNodeArchive -PathType Leaf) {
                Write-Host "Migrating the existing Node.js archive to an extracted cache..."
                Move-Item -LiteralPath $legacyNodeArchive -Destination $nodeArchive
            } else {
                $nodeUrl = "https://nodejs.org/dist/$NodeVersion/$nodeDistributionName.zip"
                Write-Host "Downloading Node.js $NodeVersion..."
                Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeArchive
            }

            Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
            $extractedNodeSource = Join-Path $nodeExtract $nodeDistributionName
            $extractedNodeExecutable = Join-Path $extractedNodeSource "node.exe"
            $extractedNodeLicense = Join-Path $extractedNodeSource "LICENSE"
            if (-not (Test-Path -LiteralPath $extractedNodeExecutable -PathType Leaf) -or
                -not (Test-Path -LiteralPath $extractedNodeLicense -PathType Leaf) -or
                -not (Test-WindowsPortableExecutable $extractedNodeExecutable)) {
                throw "The downloaded Node.js package does not contain a valid Windows x64 runtime."
            }

            Move-Item -LiteralPath $extractedNodeSource -Destination $nodeCache
            Write-Host "Cached the extracted Node.js runtime at $nodeCache"
        } finally {
            if (Test-Path -LiteralPath $nodeArchive) {
                Remove-Item -LiteralPath $nodeArchive -Force
            }
            if (Test-Path -LiteralPath $nodeExtract) {
                Remove-BuildDirectory $nodeExtract
            }
        }
    } else {
        Write-Host "Using the extracted Node.js cache at $nodeCache"
        if (Test-Path -LiteralPath $legacyNodeArchive -PathType Leaf) {
            Remove-Item -LiteralPath $legacyNodeArchive -Force
        }
    }

    $nodeSource = $nodeCache
    $nodeTarget = Join-Path $publishRoot "internal/node"
    New-Item -ItemType Directory -Force -Path $nodeTarget | Out-Null
    Copy-Item -LiteralPath (Join-Path $nodeSource "node.exe") -Destination $nodeTarget -Force
    Copy-Item -LiteralPath (Join-Path $nodeSource "LICENSE") -Destination $nodeTarget -Force

    $pnpmVirtualStore = Join-Path $repositoryRoot "node_modules/.pnpm"
    $betterSqlitePackages = @(
        Get-ChildItem -LiteralPath $pnpmVirtualStore -Directory -Filter "better-sqlite3@*" |
            ForEach-Object { Join-Path $_.FullName "node_modules/better-sqlite3" } |
            Where-Object { Test-Path -LiteralPath $_ }
    )
    if ($betterSqlitePackages.Count -eq 0) {
        throw "better-sqlite3 package directory was not found."
    }
    $installedNativeModules = @(
        $betterSqlitePackages |
            ForEach-Object { Join-Path $_ "build/Release/better_sqlite3.node" } |
            Where-Object { Test-Path -LiteralPath $_ }
    )
    $hasWindowsNativeModule = $installedNativeModules.Count -eq $betterSqlitePackages.Count -and @(
        $installedNativeModules | Where-Object { -not (Test-WindowsPortableExecutable $_) }
    ).Count -eq 0
    if (-not $hasWindowsNativeModule) {
        # pnpm rebuild can reuse its Linux side-effects cache even after setting
        # npm_config_platform. Invoke prebuild-install directly so a Linux runner
        # always replaces the ELF binary with the Windows x64 prebuild.
        $runtimeNodeVersion = $NodeVersion.TrimStart("v")
        foreach ($betterSqlitePackage in $betterSqlitePackages) {
            $packageBuildDirectory = Join-Path $betterSqlitePackage "build"
            if (Test-Path -LiteralPath $packageBuildDirectory) {
                Remove-Item -LiteralPath $packageBuildDirectory -Recurse -Force
            }
            $prebuildInstall = Join-Path (Split-Path -Parent $betterSqlitePackage) "prebuild-install/bin.js"
            if (-not (Test-Path -LiteralPath $prebuildInstall)) {
                throw "prebuild-install was not found for better-sqlite3."
            }
            Push-Location $betterSqlitePackage
            try {
                & node $prebuildInstall `
                    "--platform=win32" `
                    "--arch=x64" `
                    "--runtime=node" `
                    "--target=$runtimeNodeVersion" `
                    --force
                if ($LASTEXITCODE -ne 0) {
                    throw "Windows better-sqlite3 prebuild download failed."
                }
            } finally {
                Pop-Location
            }
            $nativeModule = Join-Path $betterSqlitePackage "build/Release/better_sqlite3.node"
            if (-not (Test-Path -LiteralPath $nativeModule) -or
                -not (Test-WindowsPortableExecutable $nativeModule)) {
                throw "Downloaded better-sqlite3 module is not a Windows PE binary."
            }
        }
    } else {
        Write-Host "Using the existing Windows x64 better-sqlite3 native module."
    }

    $apiTarget = Join-Path $publishRoot "internal/api"
    $runnerTarget = Join-Path $publishRoot "internal/runner"
    & pnpm exec ncc build (Join-Path $repositoryRoot "apps\api\dist\server.js") -o $apiTarget
    if ($LASTEXITCODE -ne 0) { throw "API bundle failed." }
    & pnpm exec ncc build (Join-Path $repositoryRoot "apps\runner\dist\runner.js") -o $runnerTarget
    if ($LASTEXITCODE -ne 0) { throw "Runner bundle failed." }
    Compress-JavaScriptTree $apiTarget
    Compress-JavaScriptTree $runnerTarget

    $nativeModules = @(Get-ChildItem -LiteralPath $apiTarget -Recurse -Filter "*.node" -File)
    if ($nativeModules.Count -eq 0) {
        throw "API bundle does not contain the required Windows native module."
    }
    foreach ($nativeModule in $nativeModules) {
        if (-not (Test-WindowsPortableExecutable $nativeModule.FullName)) {
            throw "Native module is not a Windows PE binary: $($nativeModule.FullName)"
        }
    }

    $webTarget = Join-Path $publishRoot "internal/web"
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
    $env:VITE_APP_VERSION = $originalViteAppVersion
    Pop-Location
}
