using System.Diagnostics;

namespace ApplicationChecker.Desktop;

internal sealed class ProcessSupervisor : IAsyncDisposable
{
    private WindowsJobObject? _job;
    private readonly List<Process> _processes = [];
    private readonly List<Task> _logTasks = [];

    public Process Start(
        string executable,
        string argument,
        string workingDirectory,
        IReadOnlyDictionary<string, string> environment,
        string logPath)
    {
        var info = new ProcessStartInfo(executable)
        {
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        info.ArgumentList.Add(argument);
        foreach (var pair in environment)
            info.Environment[pair.Key] = pair.Value;

        _job ??= new WindowsJobObject();
        var process = Process.Start(info) ?? throw new InvalidOperationException($"无法启动 {Path.GetFileName(argument)}");
        try
        {
            _job.Assign(process);
        }
        catch
        {
            try
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
            catch { }
            process.Dispose();
            throw;
        }
        _processes.Add(process);
        _logTasks.Add(PumpLogsAsync(process, logPath));
        return process;
    }

    private static async Task PumpLogsAsync(Process process, string logPath)
    {
        await using var stream = new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
        await using var writer = new StreamWriter(stream) { AutoFlush = true };
        await writer.WriteLineAsync($"[{DateTimeOffset.Now:O}] process {process.Id} started");

        async Task PumpAsync(StreamReader reader, string channel)
        {
            while (await reader.ReadLineAsync() is { } line)
                await writer.WriteLineAsync($"[{DateTimeOffset.Now:O}] [{channel}] {line}");
        }

        await Task.WhenAll(
            PumpAsync(process.StandardOutput, "stdout"),
            PumpAsync(process.StandardError, "stderr"));
        await writer.WriteLineAsync($"[{DateTimeOffset.Now:O}] process {process.Id} exited ({process.ExitCode})");
    }

    public async ValueTask DisposeAsync()
    {
        foreach (var process in _processes.AsEnumerable().Reverse())
        {
            try
            {
                if (!process.HasExited)
                    process.Kill(entireProcessTree: true);
            }
            catch
            {
                // Best effort during application shutdown.
            }
        }

        foreach (var process in _processes)
        {
            try { await process.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5)); }
            catch { }
            process.Dispose();
        }
        try { await Task.WhenAll(_logTasks).WaitAsync(TimeSpan.FromSeconds(5)); }
        catch { }
        _processes.Clear();
        _logTasks.Clear();
        _job?.Dispose();
        _job = null;
    }
}
