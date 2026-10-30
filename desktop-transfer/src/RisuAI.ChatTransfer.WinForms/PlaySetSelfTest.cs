using System.Buffers.Binary;
using System.IO.Pipes;
using System.Text.Json.Nodes;
using RisuAI.ChatTransfer.Core;

namespace RisuAI.ChatTransfer.WinForms;

internal static class PlaySetSelfTest
{
    private static void Check(bool value, string message) { if (!value) throw new InvalidDataException(message); }
    public static async Task Run(string folder, string fixture)
    {
        folder = Path.GetFullPath(folder); if (Directory.Exists(folder)) throw new IOException("Test directory already exists");
        Directory.CreateDirectory(folder);
        var pipeName = "RisuPlay-Test-" + Guid.NewGuid();
        string id, pin, archiveHandle;
        using (var service = new PlaySetService(null, folder, pipeName)) {
            id = service.DeviceId; pin = PlaySetTransport.Pin(service.Certificate);
            var nas = await service.Command("nas.save", new() { ["url"] = "https://nas.example/home/RisuAI/", ["username"] = "test-user", ["password"] = "test-only-password" });
            Check(nas!["hasPassword"]!.GetValue<bool>() && nas["password"] is null, "NAS secret exposed to UI");
            Check(!System.Text.Encoding.UTF8.GetString(File.ReadAllBytes(Path.Combine(folder, "nas-config.dat"))).Contains("test-only-password"), "NAS password stored in plaintext");
            await service.Command("nas.save", new() { ["url"] = "https://nas.example/home/RisuAI/", ["username"] = "test-user", ["password"] = "" });
            Check((await service.Command("nas.secret", new()))!["password"]!.GetValue<string>() == "test-only-password", "NAS saved password lost");
            try { await service.Command("nas.save", new() { ["url"] = "https://different.example/home/", ["username"] = "test-user", ["password"] = "" }); throw new Exception("NAS credential reused across endpoints"); } catch (InvalidDataException) { }

            using var stop = new CancellationTokenSource(); var server = service.Run(stop.Token);
            try {
                using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly)) {
                    await client.ConnectAsync(5000); var bytes = System.Text.Encoding.UTF8.GetBytes("{\"op\":\"identity\",\"args\":{}}"); var prefix = new byte[4]; BinaryPrimitives.WriteInt32BigEndian(prefix, bytes.Length);
                    await client.WriteAsync(prefix); await client.WriteAsync(bytes); await client.FlushAsync(); await client.ReadExactlyAsync(prefix); bytes = new byte[BinaryPrimitives.ReadInt32BigEndian(prefix)]; await client.ReadExactlyAsync(bytes);
                    Check(JsonNode.Parse(bytes)?["value"]?["id"]?.GetValue<string>() == id, "Named pipe identity mismatch");
                }
                try { await service.Command("state.write", new() { ["key"] = "identity", ["value"] = new JsonObject() }); throw new Exception("Identity overwrite accepted"); }
                catch (InvalidDataException) { }
                archiveHandle = (await service.Command("file.receive", new() { ["path"] = Path.GetFullPath(fixture) }))!.GetValue<string>();
                var inbox = (await service.Command("inbox.list", new()))!.AsArray(); Check(inbox.Count == 1, "Inbox missing");
                await service.Command("state.write", new() { ["key"] = "queue", ["value"] = inbox.DeepClone() });
                await service.Command("inbox.accept", new() { ["id"] = inbox[0]!["id"]!.GetValue<string>() });
                Check((await service.Command("inbox.list", new()))!.AsArray().Count == 0, "Inbox acceptance failed");
                try { await service.Command("archive.delete", new() { ["handle"] = archiveHandle }); throw new Exception("Queued file deletion accepted"); }
                catch (IOException) { }
                var entries = (await service.Command("archive.entries", new() { ["handle"] = archiveHandle }))!.AsArray();
                var blob = entries.First(e => e!["name"]!.GetValue<string>().StartsWith("blobs/", StringComparison.Ordinal))!;
                var asset = (await service.Command("asset.stage", new() { ["handle"] = archiveHandle, ["name"] = blob["name"]!.GetValue<string>(), ["filename"] = "large.bin" }))!.GetValue<string>();
                var info = await service.Command("asset.info", new() { ["path"] = asset }); Check(info!["bytes"]!.GetValue<long>() == blob["bytes"]!.GetValue<long>(), "Staged length mismatch");
                var chunk = (await service.Command("asset.readRange", new() { ["path"] = asset, ["offset"] = 3L, ["count"] = 256 * 1024 }))!.GetValue<string>(); Check(Convert.FromBase64String(chunk).Length == 256 * 1024, "Range read mismatch");
                await service.Command("asset.delete", new() { ["path"] = asset });
            } finally { stop.Cancel(); try { await server; } catch (OperationCanceledException) { } }
        }
        using (var restarted = new PlaySetService(null, folder, pipeName)) {
            Check((await restarted.Command("nas.secret", new()))!["password"]!.GetValue<string>() == "test-only-password", "NAS DPAPI credential lost after restart");
            var abandoned = Path.Combine(folder, "nas-config.dat." + Guid.NewGuid() + ".tmp");
            File.Copy(Path.Combine(folder, "nas-config.dat"), abandoned);
            var unrelated = Path.Combine(folder, "nas-config.dat.keep.tmp"); File.WriteAllText(unrelated, "keep");
            await restarted.Command("nas.clear", new());
            Check(!File.Exists(abandoned) && File.Exists(unrelated), "NAS clear must remove only owned credential temporary files");
            Check(!(await restarted.Command("nas.config", new()))!["hasPassword"]!.GetValue<bool>(), "NAS credential not cleared");
            File.WriteAllBytes(Path.Combine(folder, "nas-config.dat"), new byte[] { 1, 2, 3 });
            await restarted.Command("nas.save", new() { ["url"] = "https://nas.example/home/RisuAI/", ["username"] = "test-user", ["password"] = "replacement-test-password" });
            Check((await restarted.Command("nas.secret", new()))!["password"]!.GetValue<string>() == "replacement-test-password", "Corrupt NAS config blocked credential replacement");
            await restarted.Command("nas.clear", new());
            Check(restarted.DeviceId == id && PlaySetTransport.Pin(restarted.Certificate) == pin, "DPAPI identity changed after restart");
            var queue = (await restarted.Command("state.read", new() { ["key"] = "queue" }))!.AsArray(); Check(queue.Count == 1, "Queue lost on restart");
            Check((await restarted.Command("archive.entries", new() { ["handle"] = archiveHandle }))!.AsArray().Count >= 2, "Queued archive lost after restart");
        }
        Console.WriteLine("PASS: NAS DPAPI save/restart/clear and endpoint isolation; isolated Windows broker IPC, DPAPI identity restart, persistent queue, inbox protection, streamed asset ranges");
    }
}
