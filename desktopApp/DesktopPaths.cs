namespace ApplicationChecker.Desktop;

internal sealed class DesktopPaths
{
    public string Root { get; }
    public string Data { get; }
    public string WebView2 { get; }
    public string Browser { get; }
    public string Logs { get; }
    public string Temp { get; }
    public string Settings { get; }
    public string RuntimeRoot { get; }
    public string NodeExecutable { get; }
    public string ApiEntry { get; }
    public string RunnerEntry { get; }
    public string WebDist { get; }

    public DesktopPaths(string root)
    {
        Root = Path.GetFullPath(root);
        Data = Path.Combine(Root, "data");
        WebView2 = Path.Combine(Data, "webview2");
        Browser = Path.Combine(Data, "browser");
        Logs = Path.Combine(Data, "logs");
        Temp = Path.Combine(Data, "tmp");
        Settings = Path.Combine(Data, "desktop-settings.json");
        RuntimeRoot = Path.Combine(Root, "internal");
        NodeExecutable = Path.Combine(RuntimeRoot, "node", "node.exe");
        ApiEntry = Path.Combine(RuntimeRoot, "api", "index.js");
        RunnerEntry = Path.Combine(RuntimeRoot, "runner", "index.js");
        WebDist = Path.Combine(RuntimeRoot, "web");
    }

    public void EnsureDataDirectories()
    {
        foreach (var directory in new[] { Data, WebView2, Browser, Logs, Temp })
            Directory.CreateDirectory(directory);

        var probe = Path.Combine(Data, $".write-test-{Guid.NewGuid():N}");
        File.WriteAllText(probe, "ok");
        File.Delete(probe);
    }

    public void ValidateRuntime()
    {
        var missing = new[] { NodeExecutable, ApiEntry, RunnerEntry, Path.Combine(WebDist, "index.html") }
            .Where(path => !File.Exists(path))
            .ToArray();
        if (missing.Length > 0)
            throw new FileNotFoundException($"便携版运行文件不完整：{string.Join(", ", missing.Select(Path.GetFileName))}");
    }
}
