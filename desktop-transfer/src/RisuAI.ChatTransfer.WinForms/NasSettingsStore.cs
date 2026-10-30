using System.Security.Cryptography;
using System.Text.Json.Nodes;
namespace RisuAI.ChatTransfer.WinForms;

// Separate from the long-lived file broker: a previously running 1.4 broker can
// keep handling file.path/file.receive while the new helper handles NAS secrets.
internal static class NasSettingsStore
{
    internal static JsonNode? Command(string root, string op, JsonObject a)
    {
        var scope = Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Path.GetFullPath(root).ToUpperInvariant())));
        using var gate = new Mutex(false, "Local\\RisuAI.NasSettings." + scope);
        var held = false;
        try {
            try { held = gate.WaitOne(TimeSpan.FromSeconds(5)); } catch (AbandonedMutexException) { held = true; }
            if (!held) throw new InvalidDataException("NAS 설정이 다른 창에서 처리 중입니다. 잠시 후 다시 시도해 주세요.");
            return CommandLocked(root, op, a);
        } finally { if (held) gate.ReleaseMutex(); }
    }
    private static void ClearTemporary(string root)
    {
        foreach (var path in Directory.EnumerateFiles(root, "nas-config.dat.*.tmp")) {
            var name = Path.GetFileName(path);
            var id = name["nas-config.dat.".Length..^4];
            if (Guid.TryParseExact(id, "D", out _)) File.Delete(path);
        }
    }
    private static JsonNode? CommandLocked(string root, string op, JsonObject a)
    {
        if (op is not ("nas.config" or "nas.save" or "nas.clear" or "nas.secret")) throw new InvalidDataException("지원하지 않는 NAS 설정 명령입니다.");
        Directory.CreateDirectory(root);
        string Text(string name) => a[name]?.GetValue<string>() ?? throw new InvalidDataException("NAS 설정 항목이 누락되었습니다.");
                var path = Path.Combine(root, "nas-config.dat");
                JsonObject Load() => File.Exists(path) ? JsonNode.Parse(ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser))!.AsObject() : new();
                JsonObject Public(JsonObject c) => new() { ["url"] = c["url"]?.GetValue<string>() ?? "", ["username"] = c["username"]?.GetValue<string>() ?? "", ["hasPassword"] = !string.IsNullOrEmpty(c["password"]?.GetValue<string>()) };
                if (op == "nas.clear") { ClearTemporary(root); File.Delete(path); return null; }
                var config = op == "nas.save" && !string.IsNullOrEmpty(a["password"]?.GetValue<string>()) ? new JsonObject() : Load();
                if (op == "nas.secret") return config;
                if (op == "nas.config") return Public(config);
                if (op != "nas.save") throw new InvalidDataException("지원하지 않는 NAS 명령입니다.");
                var url = Text("url"); var user = Text("username"); var password = Text("password");
                if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != "https" || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0) throw new InvalidDataException("HTTPS WebDAV 폴더 주소를 입력해 주세요.");
                if (user.Length == 0 || user.Contains(':') || user.Any(char.IsControl)) throw new InvalidDataException("NAS 계정을 확인해 주세요.");
                if (password.Length == 0) {
                    if (config["url"]?.GetValue<string>() != url || config["username"]?.GetValue<string>() != user) throw new InvalidDataException("주소나 계정을 바꾸면 비밀번호를 다시 입력해 주세요.");
                    password = config["password"]?.GetValue<string>() ?? "";
                }
                if (password.Length == 0) throw new InvalidDataException("NAS 비밀번호를 입력해 주세요.");
                config = new JsonObject { ["url"] = url, ["username"] = user, ["password"] = password };
                AtomicBytes(path, ProtectedData.Protect(System.Text.Encoding.UTF8.GetBytes(config.ToJsonString()), null, DataProtectionScope.CurrentUser));
                return Public(config);

    }
    private static void AtomicBytes(string path, byte[] bytes)
    {
        ClearTemporary(Path.GetDirectoryName(path)!);
        var temporary = path + "." + Guid.NewGuid() + ".tmp";
        try {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { file.Write(bytes); file.Flush(true); }
            File.Move(temporary, path, true);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
}
