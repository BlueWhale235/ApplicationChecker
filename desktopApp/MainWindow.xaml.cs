using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace ApplicationChecker.Desktop;

public partial class MainWindow : Window
{
    private readonly DesktopPaths _paths = new(AppContext.BaseDirectory);
    private readonly ProcessSupervisor _processes = new();
    private bool _shutdownStarted;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += OnLoaded;
        Closed += OnClosed;
    }

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await StartAsync();
        }
        catch (Exception error)
        {
            TryWriteFatal(error);
            MessageBox.Show(
                $"{error.Message}\n\n详细日志目录：\n{_paths.Logs}",
                "求职进度启动失败",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Close();
        }
    }

    private async Task StartAsync()
    {
        StatusText.Text = "正在检查便携版运行环境…";
        _paths.EnsureDataDirectories();
        _paths.ValidateRuntime();
        var edgePath = FindEdge();
        EnsureWebView2Available();
        var settings = DesktopSettings.LoadOrCreate(_paths.Settings);

        var port = ReservePort();
        var baseUrl = $"http://127.0.0.1:{port}";
        var sessionToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(36));
        var common = new Dictionary<string, string>
        {
            ["NODE_ENV"] = "production",
            ["RUNNER_INTERNAL_TOKEN"] = settings.RunnerToken,
        };

        StatusText.Text = "正在启动本地服务…";
        var apiEnvironment = new Dictionary<string, string>(common)
        {
            ["DESKTOP_MODE"] = "1",
            ["DESKTOP_SESSION_TOKEN"] = sessionToken,
            ["WEB_HOST"] = "127.0.0.1",
            ["WEB_PORT"] = port.ToString(),
            ["DATA_PATH"] = _paths.Data,
            ["WEB_DIST_PATH"] = _paths.WebDist,
            ["APP_BASE_URL"] = baseUrl,
            ["RUNNER_URL"] = baseUrl,
            ["STATE_ENCRYPTION_KEY"] = settings.StateEncryptionKey,
        };
        var apiProcess = _processes.Start(
            _paths.NodeExecutable,
            _paths.ApiEntry,
            Path.GetDirectoryName(_paths.ApiEntry)!,
            apiEnvironment,
            Path.Combine(_paths.Logs, "api.log"));
        await WaitForHealthAsync(baseUrl, apiProcess, Path.Combine(_paths.Logs, "api.log"));

        StatusText.Text = "正在启动自动检查服务…";
        var runnerEnvironment = new Dictionary<string, string>(common)
        {
            ["APP_INTERNAL_URL"] = $"{baseUrl}/api",
            ["BROWSER_BIN"] = edgePath,
            ["BROWSER_DATA_PATH"] = _paths.Browser,
            ["TEMP"] = _paths.Temp,
            ["TMP"] = _paths.Temp,
        };
        _processes.Start(
            _paths.NodeExecutable,
            _paths.RunnerEntry,
            Path.GetDirectoryName(_paths.RunnerEntry)!,
            runnerEnvironment,
            Path.Combine(_paths.Logs, "runner.log"));

        StatusText.Text = "正在初始化 WebView2…";
        var webViewEnvironment = await CoreWebView2Environment.CreateAsync(null, _paths.WebView2);
        await Browser.EnsureCoreWebView2Async(webViewEnvironment);
        var cookie = Browser.CoreWebView2.CookieManager.CreateCookie("ac_desktop", sessionToken, "127.0.0.1", "/api");
        cookie.IsHttpOnly = true;
        cookie.SameSite = CoreWebView2CookieSameSiteKind.Strict;
        Browser.CoreWebView2.CookieManager.AddOrUpdateCookie(cookie);
        Browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
        Browser.CoreWebView2.Settings.IsStatusBarEnabled = false;
        Browser.Source = new Uri(baseUrl);
        Browser.Visibility = Visibility.Visible;
        LoadingPanel.Visibility = Visibility.Collapsed;
    }

    private static int ReservePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        return ((IPEndPoint)listener.LocalEndpoint).Port;
    }

    private static async Task WaitForHealthAsync(string baseUrl, System.Diagnostics.Process process, string apiLogPath)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow.AddSeconds(30);
        Exception? lastError = null;
        while (DateTime.UtcNow < deadline)
        {
            if (process.HasExited)
            {
                var detail = ReadLogTail(apiLogPath, 8);
                throw new InvalidOperationException(
                    $"本地服务启动失败，退出代码 {process.ExitCode}。\n日志：{apiLogPath}" +
                    (detail.Length > 0 ? $"\n\n{detail}" : ""));
            }
            try
            {
                using var response = await client.GetAsync($"{baseUrl}/api/health");
                if (response.IsSuccessStatusCode) return;
            }
            catch (Exception error)
            {
                lastError = error;
            }
            await Task.Delay(250);
        }
        throw new TimeoutException($"等待本地服务启动超时。{lastError?.Message}");
    }

    private static string ReadLogTail(string filename, int count)
    {
        try
        {
            return string.Join(Environment.NewLine, File.ReadLines(filename).TakeLast(count));
        }
        catch
        {
            return "";
        }
    }

    private static string FindEdge()
    {
        var roots = new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
            Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
        };
        var edge = roots.Select(root => Path.Combine(root, "Microsoft", "Edge", "Application", "msedge.exe"))
            .FirstOrDefault(File.Exists);
        return edge ?? throw new FileNotFoundException("未找到 Microsoft Edge，请先安装或修复 Edge。");
    }

    private static void EnsureWebView2Available()
    {
        try
        {
            _ = CoreWebView2Environment.GetAvailableBrowserVersionString();
        }
        catch (Exception error)
        {
            throw new InvalidOperationException("未找到 WebView2 Runtime，请先安装 Microsoft Edge WebView2 Runtime。", error);
        }
    }

    private void TryWriteFatal(Exception error)
    {
        try
        {
            Directory.CreateDirectory(_paths.Logs);
            File.AppendAllText(
                Path.Combine(_paths.Logs, "desktop.log"),
                $"[{DateTimeOffset.Now:O}] {error}\n");
        }
        catch { }
    }

    private async void OnClosed(object? sender, EventArgs e)
    {
        if (_shutdownStarted) return;
        _shutdownStarted = true;
        Browser.Dispose();
        await _processes.DisposeAsync();
    }
}
