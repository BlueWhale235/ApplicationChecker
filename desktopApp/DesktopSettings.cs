using System.Security.Cryptography;
using System.Text.Json;

namespace ApplicationChecker.Desktop;

internal sealed record DesktopSettings(string RunnerToken, string StateEncryptionKey)
{
    public static DesktopSettings LoadOrCreate(string filename)
    {
        if (File.Exists(filename))
        {
            var existing = JsonSerializer.Deserialize<DesktopSettings>(File.ReadAllText(filename));
            if (existing is not null &&
                existing.RunnerToken.Length >= 32 &&
                Convert.TryFromBase64String(existing.StateEncryptionKey, new Span<byte>(new byte[64]), out var bytes) &&
                bytes == 32)
                return existing;
            throw new InvalidDataException("data/desktop-settings.json 无效，请修复或移走该文件后重试。");
        }

        var settings = new DesktopSettings(
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(36)),
            Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)));
        File.WriteAllText(filename, JsonSerializer.Serialize(settings, new JsonSerializerOptions { WriteIndented = true }));
        return settings;
    }
}
