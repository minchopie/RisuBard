using System.Security.Cryptography;

namespace RisuAI.ChatTransfer.Core;

internal static class BundledAdb
{
    internal static string EnsureAvailable(string? cacheRoot = null)
    {
        var names = new[] { "adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt" };
        var files = names.Select(name => {
            using var stream = typeof(BundledAdb).Assembly.GetManifestResourceStream("BundledAdb." + name)
                ?? throw new IOException("내장 USB 도구를 읽지 못했습니다. 전송기를 다시 복사하세요.");
            using var memory = new MemoryStream();
            stream.CopyTo(memory);
            return (Name: name, Bytes: memory.ToArray());
        }).ToArray();
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in files) hash.AppendData(SHA256.HashData(file.Bytes));
        var version = Convert.ToHexString(hash.GetHashAndReset());
        var folder = Path.Combine(cacheRoot ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RisuAI-Chat-Transfer", "tools"), version);
        using var gate = new Mutex(false, "Local\\RisuAI-Adb-" + version);
        var acquired = false;
        try {
            try { acquired = gate.WaitOne(TimeSpan.FromSeconds(15)); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) throw new IOException("USB 도구 준비가 지연되고 있습니다. 잠시 후 다시 시도하세요.");
            Directory.CreateDirectory(folder);
            foreach (var file in files) {
                var path = Path.Combine(folder, file.Name);
                if (File.Exists(path) && SHA256.HashData(File.ReadAllBytes(path)).AsSpan().SequenceEqual(SHA256.HashData(file.Bytes))) continue;
                var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
                try { File.WriteAllBytes(temporary, file.Bytes); File.Move(temporary, path, true); }
                finally { if (File.Exists(temporary)) File.Delete(temporary); }
            }
            return Path.Combine(folder, "adb.exe");
        } finally { if (acquired) gate.ReleaseMutex(); }
    }
}
