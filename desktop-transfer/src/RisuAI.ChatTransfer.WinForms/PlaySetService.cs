using System.Buffers.Binary;
using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json.Nodes;
using RisuAI.ChatTransfer.Core;

namespace RisuAI.ChatTransfer.WinForms;

/// <summary>Current-user file/transport broker. It never reads or writes the application database.</summary>
internal sealed class PlaySetService : IPlaySetTransportHost, IDisposable
{
    internal static string? BardDataRoot { get; set; }
    internal static string Profile => BardDataRoot is null ? "co.aiclient.risu.mgefix" : "app.risubard.personal";
    internal static string BardInstance => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(Path.GetFullPath(BardDataRoot!))))[..16];
    internal static string PipeName => (BardDataRoot is null ? "RisuAI.PlaySet.MGEFix." : "RisuBard.PlaySet." + BardInstance + ".") + Environment.UserName.Replace('\\', '_');
    private static string UsbSocket => BardDataRoot is null ? "risu_play_set_usb_v2" : "risubard_play_set_usb_v2";
    private readonly string root;
    private readonly string assets;
    private readonly string instancePipeName;
    private readonly object metadata = new();
    private readonly SemaphoreSlim archiveSerial = new(1);
    private readonly PlaySetArchive archive;
    private PlaySetTransport transport;
    private readonly System.Threading.Timer foregroundLease;
    private long lastClient = Environment.TickCount64;
    private int notifyingUsb;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, string> outgoing = new(StringComparer.Ordinal);
    private PlaySetDiscovery? discovery;
    private string? appPath;
    public string DeviceId { get; }
    public string Name => Environment.MachineName;
    public X509Certificate2 Certificate { get; }

    public PlaySetService(string? application, string? testDirectory = null, string? testPipeName = null)
    {
        if (application is not null) ValidateApplication(application);
        root = testDirectory ?? (BardDataRoot is null ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RisuAI-PlaySet", Profile) : Path.Combine(BardDataRoot, "transfer-native"));
        assets = testDirectory is null ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Profile, "assets") : Path.Combine(testDirectory, "test-assets");
        instancePipeName = testPipeName ?? PipeName;
        Directory.CreateDirectory(root); Directory.CreateDirectory(assets);
        archive = new PlaySetArchive(Path.Combine(root, "archives"));
        var identity = Read("identity");
        DeviceId = identity?["id"]?.GetValue<string>() ?? Guid.NewGuid().ToString();
        if (!Guid.TryParseExact(DeviceId, "D", out _) || DeviceId != DeviceId.ToLowerInvariant()) throw new InvalidDataException("기기 식별 정보가 손상되었습니다. 기존 등록 정보를 보존했습니다.");
        if (identity?["id"] is null) Write("identity", new JsonObject { ["id"] = DeviceId, ["name"] = Name });
        var certificatePath = Path.Combine(root, "identity.dpapi");
        byte[] pfx;
        if (File.Exists(certificatePath)) pfx = ProtectedData.Unprotect(File.ReadAllBytes(certificatePath), null, DataProtectionScope.CurrentUser);
        else {
            using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            var request = new CertificateRequest("CN=RisuPlay", key, HashAlgorithmName.SHA256);
            using var certificate = request.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddYears(10));
            pfx = certificate.Export(X509ContentType.Pfx);
            AtomicBytes(certificatePath, ProtectedData.Protect(pfx, null, DataProtectionScope.CurrentUser));
        }
        try { Certificate = new X509Certificate2(pfx, (string?)null, X509KeyStorageFlags.UserKeySet); }
        finally { CryptographicOperations.ZeroMemory(pfx); }
        transport = new PlaySetTransport(this);
        foregroundLease = new System.Threading.Timer(_ => {
            _ = NotifyUsbReceipts();
            if (Environment.TickCount64 - Interlocked.Read(ref lastClient) <= 60_000) return;
            // Registration commit takes registrationLock before saving metadata; keep this check outside metadata.
            var keepRegistration = transport.HasRegistration;
            lock (metadata) {
                if (Environment.TickCount64 - Interlocked.Read(ref lastClient) <= 60_000 || transport.HasConnections || keepRegistration || discovery is null) return;
                discovery.Dispose(); discovery = null; transport.Dispose(); transport = new PlaySetTransport(this);
            }
        }, null, 30_000, 30_000);
        appPath = Read("application")?["path"]?.GetValue<string>();
        if (application is not null) Register(application);
    }
    private static void AtomicBytes(string path, byte[] bytes)
    {
        var temporary = path + "." + Guid.NewGuid() + ".tmp";
        try {
            using (var file = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { file.Write(bytes); file.Flush(true); }
            File.Move(temporary, path, true);
        } finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }
    private string StatePath(string key)
    {
        if (key is not ("queue" or "journal" or "identity" or "inbox" or "deliveries" or "trust" or "application")) throw new InvalidDataException("Unknown state key");
        return Path.Combine(root, key + ".json");
    }
    private JsonNode? Read(string key) { lock (metadata) { var path = StatePath(key); return File.Exists(path) ? JsonNode.Parse(File.ReadAllBytes(path)) : null; } }
    private void Write(string key, JsonNode? value) { lock (metadata) AtomicBytes(StatePath(key), System.Text.Encoding.UTF8.GetBytes(value?.ToJsonString() ?? "null")); }
    private static void ValidateApplication(string path)
    {
        if (!File.Exists(path) || !Path.GetFileName(path).Equals(BardDataRoot is null ? "RisuAI-MGE-Fix.exe" : "RisuBard.exe", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("앱 실행 경로를 확인해 주세요.");
    }
    private void Register(string path)
    {
        path = Path.GetFullPath(path); ValidateApplication(path);
        appPath = path; Write("application", new JsonObject { ["path"] = path, ["profile"] = Profile });
    }
    public string? TrustedSpki(string device) => Read("trust")?[device]?["spki"]?.GetValue<string>();
    public void Remember(string device, string name, string spki)
    {
        lock (metadata) { var trust = Read("trust") as JsonObject ?? new(); trust[device] = new JsonObject { ["name"] = name, ["spki"] = spki }; Write("trust", trust); }
    }
    private void StartNetwork() { lock (metadata) discovery ??= new PlaySetDiscovery(DeviceId, Name, transport.Start()); }
    public async Task<string> ReceiveAsync(string device, string transfer, Stream data, long length, string hash, CancellationToken token)
    {
        using var digest = new DigestStream(data);
        var handle = await archive.ReceiveAsync(digest, token).ConfigureAwait(false);
        try {
            if (digest.Bytes != length || digest.Finish() != hash) throw new InvalidDataException("Received file hash mismatch");
            lock (metadata) {
                // The durable inbox is also the receipt. A single replace commits both.
                var inbox = Read("inbox") as JsonArray ?? new();
                var existing = inbox.FirstOrDefault(e => e?["id"]?.GetValue<string>() == transfer);
                if (existing is not null) {
                    if (existing["trustedDevice"]?.GetValue<string>() != device || existing["hash"]?.GetValue<string>() != hash) throw new InvalidDataException("Transfer identity reused");
                    archive.Delete(handle); return transfer;
                }
                inbox.Add(new JsonObject { ["id"] = transfer, ["fileHandle"] = handle, ["state"] = "received", ["receivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["trustedDevice"] = device, ["hash"] = hash, ["accepted"] = false });
                Write("inbox", inbox);
            }
        } catch { archive.Delete(handle); throw; }
        return transfer;
    }
    public string Status(string device, string transfer)
    {
        var entry = (Read("inbox") as JsonArray)?.FirstOrDefault(e => e?["id"]?.GetValue<string>() == transfer);
        if (entry?["trustedDevice"]?.GetValue<string>() != device) throw new InvalidDataException("Unknown transfer");
        return (Read("queue") as JsonArray)?.FirstOrDefault(e => e?["id"]?.GetValue<string>() == transfer)?["state"]?.GetValue<string>() ?? "waiting";
    }
    internal async Task<JsonNode?> Command(string op, JsonObject a)
    {
        Interlocked.Exchange(ref lastClient, Environment.TickCount64);
        string S(string key) => a[key]?.GetValue<string>() ?? throw new InvalidDataException("Missing " + key);
        if (op.StartsWith("nas.", StringComparison.Ordinal)) {
            lock (metadata) return NasSettingsStore.Command(root, op, a);
        }
        if (op == "capabilities") return new JsonObject { ["usbHost"] = true };
        if (op == "usb.start") return null;
        if (op.StartsWith("usb.", StringComparison.Ordinal)) {
            if (op == "usb.progress") return outgoing.TryGetValue(S("transfer"), out var progress) ? JsonNode.Parse(progress) : throw new InvalidDataException("전송 기록을 찾을 수 없습니다. 앱을 다시 연 경우 받은 기기의 대기열을 확인해 주세요.");
            var adb = UsbAdbTransport.FindAdb() ?? throw new IOException("내장 ADB를 준비하지 못했습니다.");
            if (op == "usb.devices") return new JsonArray((await UsbAdbTransport.DiscoverAsync(adb).ConfigureAwait(false)).Select(d => (JsonNode)new JsonObject { ["serial"] = d.Serial, ["model"] = d.Model, ["transportId"] = d.TransportId }).ToArray());
            var rawDevice = a["device"]!.AsObject();
            var device = new UsbDevice(rawDevice["serial"]!.GetValue<string>(), rawDevice["model"]!.GetValue<string>(), rawDevice["transportId"]!.GetValue<string>());
            if (op == "usb.status") { using var connection = await UsbPlaySetTransport.ConnectAsync(adb, device, 3, socketName: UsbSocket).ConfigureAwait(false); return JsonValue.Create(await connection.StatusAsync(S("transfer")).ConfigureAwait(false)); }
            if (op is not ("usb.send" or "usb.receive")) throw new InvalidDataException("Unknown USB command");
            var job = S("transfer"); var path = op == "usb.send" ? archive.FilePath(S("handle")) : null;
            if (!Guid.TryParseExact(job, "D", out _) || !outgoing.TryAdd(job, new JsonObject { ["state"] = "preparing", ["sent"] = 0, ["total"] = path is null ? 0 : new FileInfo(path).Length }.ToJsonString())) throw new InvalidDataException("Invalid USB job");
            _ = Task.Run(async () => {
                try {
                    void Progress(long sent, long total) { outgoing[job] = new JsonObject { ["state"] = "sending", ["sent"] = sent, ["total"] = total }.ToJsonString(); }
                    if (path is not null) {
                        byte[] hash; using (var source = File.OpenRead(path)) hash = await SHA256.HashDataAsync(source).ConfigureAwait(false);
                        using var connection = await UsbPlaySetTransport.ConnectAsync(adb, device, 1, socketName: UsbSocket).ConfigureAwait(false);
                        await connection.SendAsync(path, job, hash, Progress).ConfigureAwait(false);
                        outgoing[job] = new JsonObject { ["state"] = "delivered", ["transfer"] = job }.ToJsonString();
                    } else {
                        using var connection = await UsbPlaySetTransport.ConnectAsync(adb, device, 2, socketName: UsbSocket).ConfigureAwait(false);
                        var incoming = await connection.ReceiveAsync(archive, Progress).ConfigureAwait(false);
                        lock (metadata) {
                            var inbox = Read("inbox") as JsonArray ?? new();
                            var existing = inbox.FirstOrDefault(e => e?["id"]?.GetValue<string>() == incoming.Transfer);
                            if (existing is not null) {
                                archive.Delete(incoming.Handle);
                                if (existing["hash"]?.GetValue<string>() != incoming.Hash || existing["trustedDevice"]?.GetValue<string>() != "usb:adb") throw new InvalidDataException("Conflicting USB transfer ID");
                            }
                            else { inbox.Add(new JsonObject { ["id"] = incoming.Transfer, ["fileHandle"] = incoming.Handle, ["hash"] = incoming.Hash, ["state"] = "received", ["receivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["trustedDevice"] = "usb:adb", ["usbDevice"] = rawDevice.DeepClone(), ["accepted"] = false }); Write("inbox", inbox); }
                        }
                        await connection.AcknowledgeDelivery().ConfigureAwait(false);
                        outgoing[job] = new JsonObject { ["state"] = "delivered", ["transfer"] = incoming.Transfer }.ToJsonString();
                    }
                } catch (Exception e) { outgoing[job] = new JsonObject { ["state"] = "failed", ["error"] = e.Message }.ToJsonString(); }
            });
            return JsonValue.Create(job);
        }
        if (op.StartsWith("network.", StringComparison.Ordinal)) {
            if (op == "network.progress") return outgoing.TryGetValue(S("transfer"), out var progress) ? JsonNode.Parse(progress) : throw new InvalidDataException("전송 기록을 찾을 수 없습니다. 앱을 다시 연 경우 받은 기기의 대기열을 확인해 주세요.");
            StartNetwork();
            if (op == "network.start") return null;
            if (op == "network.devices") return new JsonArray(discovery!.Devices().Select(d => (JsonNode)new JsonObject { ["id"] = d.Id, ["name"] = d.Name, ["address"] = d.Address, ["port"] = d.Port, ["registered"] = TrustedSpki(d.Id) is not null }).ToArray());
            if (op == "network.registration") { var value = transport.Registration(); return new JsonObject { ["session"] = value.Session, ["code"] = value.Code, ["expiresAt"] = DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds() }; }
            if (op == "network.forget") { lock (metadata) { var trust = Read("trust") as JsonObject ?? new(); trust.Remove(S("device")); Write("trust", trust); } return null; }
            var endpoint = discovery!.Endpoint(S("device"));
            if (op == "network.pair") { await transport.PairAsync(endpoint.Address, endpoint.Port, endpoint.Id, S("code").ToCharArray()).ConfigureAwait(false); return null; }
            if (op == "network.send") {
                var transfer = S("transfer"); var path = archive.FilePath(S("handle"));
                if (!Guid.TryParseExact(transfer, "D", out _) || !outgoing.TryAdd(transfer, new JsonObject { ["state"] = "sending", ["sent"] = 0, ["total"] = new FileInfo(path).Length }.ToJsonString())) throw new InvalidDataException("Invalid transfer");
                _ = Task.Run(async () => {
                    try {
                        var result = await transport.SendAsync(endpoint.Address, endpoint.Port, endpoint.Id, transfer, path, progress: (sent, total) => outgoing[transfer] = new JsonObject { ["state"] = "sending", ["sent"] = sent, ["total"] = total }.ToJsonString()).ConfigureAwait(false);
                        outgoing[transfer] = new JsonObject { ["state"] = "delivered", ["transfer"] = result }.ToJsonString();
                    } catch (Exception e) { outgoing[transfer] = new JsonObject { ["state"] = "failed", ["error"] = e.Message }.ToJsonString(); }
                });
                return JsonValue.Create(transfer);
            }
            if (op == "network.status") return JsonValue.Create(await transport.StatusAsync(endpoint.Address, endpoint.Port, endpoint.Id, S("transfer")).ConfigureAwait(false));
            throw new InvalidDataException("Unknown network command");
        }
        await archiveSerial.WaitAsync().ConfigureAwait(false);
        try {
            switch (op) {
                case "bard.export": {
                    if (BardDataRoot is null || !Guid.TryParseExact(S("id"), "D", out _)) throw new InvalidDataException("Invalid Bard export");
                    var path = Path.Combine(BardDataRoot, "play-transfer", S("id"), "export.risuplay");
                    using var source = File.OpenRead(path); return JsonValue.Create(await archive.ReceiveAsync(source).ConfigureAwait(false));
                }
                case "identity": return new JsonObject { ["id"] = DeviceId, ["name"] = Name };
                case "application.register": if (S("profile") != Profile) throw new InvalidDataException("Wrong application profile"); Register(S("path")); return null;
                case "application.open": {
                    if (appPath is null || !File.Exists(appPath)) throw new IOException("MGE Fix 앱을 한 번 실행하거나 실행 파일을 선택해 등록해 주세요.");
                    var command = new ProcessStartInfo(appPath) { UseShellExecute = false }; command.ArgumentList.Add("--play-set-inbox"); Process.Start(command); return null;
                }
                case "archive.begin": return JsonValue.Create(archive.Begin());
                case "archive.beginEntry": archive.BeginEntry(S("handle"), S("name"), a["bytes"]!.GetValue<long>()); return null;
                case "archive.append": archive.Append(S("handle"), Convert.FromBase64String(S("data"))); return null;
                case "archive.endEntry": archive.EndEntry(S("handle")); return null;
                case "archive.finish": return JsonValue.Create(archive.Finish(S("handle")));
                case "archive.abort": archive.Abort(S("handle")); return null;
                case "archive.delete": lock (metadata) { if ((Read("inbox") as JsonArray ?? new()).Any(e => e?["fileHandle"]?.GetValue<string>() == S("handle"))) throw new IOException("받은 플레이 세트는 대기열에 보존됩니다."); archive.Delete(S("handle")); } return null;
                case "archive.available": return JsonValue.Create(archive.AvailableBytes);
                case "archive.entries": return new JsonArray(archive.Entries(S("handle")).Select(e => (JsonNode)new JsonObject { ["name"] = e.Name, ["bytes"] = e.Bytes }).ToArray());
                case "archive.digest": return JsonValue.Create(archive.Digest(S("handle"), S("name"), a["bytes"]!.GetValue<long>()));
                case "archive.openEntry": return JsonValue.Create(archive.OpenEntry(S("handle"), S("name")));
                case "archive.readChunk": return JsonValue.Create(Convert.ToBase64String(archive.ReadChunk(S("token"))));
                case "archive.closeEntry": archive.CloseEntry(S("token")); return null;
                case "state.read": if (S("key") is not ("queue" or "journal")) throw new InvalidDataException("Private broker state"); return Read(S("key"));
                case "state.write": if (S("key") is not ("queue" or "journal")) throw new InvalidDataException("Private broker state"); Write(S("key"), a["value"]); if (S("key") == "queue") _ = NotifyUsbReceipts(); return null;
                case "inbox.list": return new JsonArray((Read("inbox") as JsonArray ?? new()).Where(e => e?["accepted"]?.GetValue<bool>() != true).Select(e => e!.DeepClone()).ToArray());
                case "inbox.accept": lock (metadata) { var inbox = Read("inbox") as JsonArray ?? new(); var item = inbox.FirstOrDefault(e => e?["id"]?.GetValue<string>() == S("id")); if (item is not null) item["accepted"] = true; Write("inbox", inbox); } return null;
                case "asset.stage": {
                    var extension = Path.GetExtension(S("filename")).TrimStart('.');
                    if (extension.Length is < 1 or > 12 || extension.Any(c => !char.IsAsciiLetterOrDigit(c))) extension = "bin";
                    var target = a["target"]?.GetValue<string>() ?? "assets/risuplay-" + Guid.NewGuid() + "." + extension;
                    if (!System.Text.RegularExpressions.Regex.IsMatch(target, "^assets/risuplay-[a-f0-9-]{36}\\.[A-Za-z0-9]{1,12}$")) throw new InvalidDataException("Invalid asset destination");
                    var filename = target[7..];
                    var path = Path.Combine(assets, filename); var token = archive.OpenEntry(S("handle"), S("name"));
                    var created = false;
                    try { using var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None); created = true; byte[] chunk; while ((chunk = archive.ReadChunk(token)).Length > 0) output.Write(chunk); output.Flush(true); }
                    catch { if (created) File.Delete(path); throw; }
                    finally { archive.CloseEntry(token); }
                    return JsonValue.Create("assets/" + filename);
                }
                case "asset.info": { var file = SourceAsset(S("path")); return new JsonObject { ["bytes"] = file.Length, ["mime"] = "application/octet-stream" }; }
                case "asset.readRange": {
                    var file = SourceAsset(S("path")); var offset = a["offset"]!.GetValue<long>(); var count = a["count"]!.GetValue<int>();
                    if (offset < 0 || count < 0 || count > PlaySetArchive.ChunkSize || offset > file.Length || count > file.Length - offset) throw new InvalidDataException("Invalid asset range");
                    using var input = file.OpenRead(); input.Position = offset; var bytes = new byte[count]; input.ReadExactly(bytes); return JsonValue.Create(Convert.ToBase64String(bytes));
                }
                case "asset.delete": {
                    var path = S("path"); if (!System.Text.RegularExpressions.Regex.IsMatch(path, "^assets/risuplay-[a-f0-9-]{36}\\.[A-Za-z0-9]{1,12}$")) throw new InvalidDataException("Invalid asset path");
                    File.Delete(Path.Combine(assets, path[7..])); return null;
                }
                case "file.stage":
                case "file.receive": {
                    var path = Path.GetFullPath(S("path"));
                    if (!Path.GetExtension(path).Equals(".risuplay", StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Select a .risuplay file");
                    using var source = File.OpenRead(path); var handle = await archive.ReceiveAsync(source).ConfigureAwait(false);
                    if (op == "file.stage") return JsonValue.Create(handle);
                    lock (metadata) { var inbox = Read("inbox") as JsonArray ?? new(); inbox.Add(new JsonObject { ["id"] = Guid.NewGuid().ToString(), ["fileHandle"] = handle, ["state"] = "received", ["receivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["trustedDevice"] = null, ["accepted"] = false }); Write("inbox", inbox); }
                    return JsonValue.Create(handle);
                }
                case "file.path": return JsonValue.Create(archive.FilePath(S("handle")));
                case "file.share": {
                    var path = archive.FilePath(S("handle")); if (!File.Exists(path)) throw new FileNotFoundException("플레이 세트 파일을 찾을 수 없습니다.");
                    var command = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = false, CreateNoWindow = true };
                    command.ArgumentList.Add("--play-set-share"); command.ArgumentList.Add(path); Process.Start(command);
                    return JsonValue.Create("share-sheet-requested");
                }
                default: throw new InvalidDataException("Unknown play-set command");
            }
        } finally { archiveSerial.Release(); }
    }
    internal async Task Run(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested) {
            NamedPipeServerStream? pipe = null;
            try {
                pipe = new NamedPipeServerStream(instancePipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (IOException) { pipe?.Dispose(); await Task.Delay(250, cancellationToken).ConfigureAwait(false); continue; }
            catch { pipe?.Dispose(); throw; }
            _ = Serve(pipe);
        }
    }
    private FileInfo SourceAsset(string path)
    {
        if (!path.StartsWith("assets/", StringComparison.Ordinal) || path[7..].IndexOfAny(['/', '\\', ':']) >= 0 || path[7..] is "" or "." or "..") throw new InvalidDataException("Invalid local asset");
        var file = new FileInfo(Path.Combine(assets, path[7..])); if (!file.Exists || file.Attributes.HasFlag(FileAttributes.ReparsePoint)) throw new IOException("Local asset missing"); return file;
    }
    private sealed class DigestStream(Stream source) : Stream
    {
        private readonly IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        public long Bytes { get; private set; }
        public string Finish() => Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) { var count = await source.ReadAsync(buffer, token).ConfigureAwait(false); hash.AppendData(buffer.Span[..count]); Bytes += count; return count; }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) => ReadAsync(buffer.AsMemory(offset, count), token).AsTask();
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        protected override void Dispose(bool disposing) { if (disposing) hash.Dispose(); base.Dispose(disposing); }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException(); public override long Position { get => Bytes; set => throw new NotSupportedException(); }
        public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
    private async Task NotifyUsbReceipts()
    {
        if (Interlocked.Exchange(ref notifyingUsb, 1) != 0) return;
        try {
            var queue = Read("queue") as JsonArray ?? new();
            foreach (var item in Read("inbox") as JsonArray ?? new()) {
                if (item?["usbDevice"] is not JsonObject device || item["receiptSent"]?.GetValue<bool>() == true) continue;
                var id = item["id"]!.GetValue<string>(); if (!queue.Any(e => e?["id"]?.GetValue<string>() == id && e["state"]?.GetValue<string>() == "applied")) continue;
                try {
                    var adb = UsbAdbTransport.FindAdb(); if (adb is null) return;
                    using var connection = await UsbPlaySetTransport.ConnectAsync(adb, new(device["serial"]!.GetValue<string>(), device["model"]!.GetValue<string>(), device["transportId"]!.GetValue<string>()), 4, socketName: UsbSocket).ConfigureAwait(false);
                    await connection.ReceiptAsync(id, true).ConfigureAwait(false);
                    lock (metadata) { var inbox = Read("inbox") as JsonArray ?? new(); var saved = inbox.FirstOrDefault(e => e?["id"]?.GetValue<string>() == id); if (saved is not null) saved["receiptSent"] = true; Write("inbox", inbox); }
                } catch (Exception) { /* Retain the receipt for the next foreground retry. */ }
            }
        } finally { Interlocked.Exchange(ref notifyingUsb, 0); }
    }
    private async Task Serve(NamedPipeServerStream pipe)
    {
        using (pipe) {
            try {
                using var readTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                var prefix = new byte[4]; await pipe.ReadExactlyAsync(prefix, readTimeout.Token).ConfigureAwait(false);
                var count = BinaryPrimitives.ReadInt32BigEndian(prefix); if (count is < 1 or > 12 * 1024 * 1024) return;
                var bytes = new byte[count]; await pipe.ReadExactlyAsync(bytes, readTimeout.Token).ConfigureAwait(false);
                var request = JsonNode.Parse(bytes)?.AsObject() ?? throw new InvalidDataException("Invalid request");
                JsonObject response;
                try {
                    var work = Command(request["op"]!.GetValue<string>(), request["args"]?.AsObject() ?? new());
                    if (BardDataRoot is not null) while (!work.IsCompleted) {
                        if (await Task.WhenAny(work, Task.Delay(15_000)).ConfigureAwait(false) == work) break;
                        var heartbeat = System.Text.Encoding.UTF8.GetBytes("{\"pending\":true}");
                        BinaryPrimitives.WriteInt32BigEndian(prefix, heartbeat.Length);
                        await pipe.WriteAsync(prefix).ConfigureAwait(false); await pipe.WriteAsync(heartbeat).ConfigureAwait(false); await pipe.FlushAsync().ConfigureAwait(false);
                    }
                    response = new JsonObject { ["value"] = await work.ConfigureAwait(false) };
                }
                catch (Exception e) { response = new JsonObject { ["error"] = e.Message }; }
                var encoded = System.Text.Encoding.UTF8.GetBytes(response.ToJsonString()); BinaryPrimitives.WriteInt32BigEndian(prefix, encoded.Length);
                await pipe.WriteAsync(prefix).ConfigureAwait(false); await pipe.WriteAsync(encoded).ConfigureAwait(false); await pipe.FlushAsync().ConfigureAwait(false);
            } catch (IOException) { } catch (System.Text.Json.JsonException) { } catch (OperationCanceledException) { }
        }
    }
    public void Dispose() { foregroundLease.Dispose(); discovery?.Dispose(); transport.Dispose(); archive.Dispose(); Certificate.Dispose(); archiveSerial.Dispose(); }
}
