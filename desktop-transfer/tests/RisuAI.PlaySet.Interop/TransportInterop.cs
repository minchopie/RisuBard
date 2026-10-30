using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using RisuAI.ChatTransfer.Core;

internal static class TransportInterop
{
    private sealed class Host(string root, string device) : IPlaySetTransportHost, IDisposable
    {
        public int DelayMilliseconds;
        public string DeviceId => device;
        public string Name => "CSharp test";
        private readonly ECDsa key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        private X509Certificate2? certificate;
        public X509Certificate2 Certificate => certificate ??= CreateCertificate();
        private X509Certificate2 CreateCertificate() {
            using var generated = new CertificateRequest("CN=RisuPlay", key, HashAlgorithmName.SHA256).CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(2));
            var pfx = generated.Export(X509ContentType.Pkcs12);
            try { return new X509Certificate2(pfx, (string?)null, X509KeyStorageFlags.UserKeySet); }
            finally { CryptographicOperations.ZeroMemory(pfx); }
        }
        private readonly ConcurrentDictionary<string, string> pins = new();
        private readonly ConcurrentDictionary<string, string> received = new();
        private readonly PlaySetArchive archive = new(root);
        public string? TrustedSpki(string id) => pins.GetValueOrDefault(id);
        public void Remember(string id, string name, string spki) => pins[id] = spki;
        public void Forget(string id) => pins.TryRemove(id, out var ignored);
        public async Task<string> ReceiveAsync(string device, string transfer, Stream bytes, long length, string hash, CancellationToken token) {
            var handle = await archive.ReceiveAsync(bytes, token);
            await using var file = File.OpenRead(archive.FilePath(handle));
            if (file.Length != length || Convert.ToHexString(await SHA256.HashDataAsync(file, token)).ToLowerInvariant() != hash) throw new InvalidDataException("Bad file hash");
            await Task.Delay(DelayMilliseconds, token);
            received[device + "/" + transfer] = "waiting"; return transfer;
        }
        public string Status(string device, string transfer) => received.GetValueOrDefault(device + "/" + transfer) ?? "unknown";
        public void Dispose() { archive.Dispose(); certificate?.Dispose(); key.Dispose(); }
    }
    internal static async Task Run(string root) {
        using var host = new Host(root, "22222222-2222-4222-8222-222222222222");
        using var transport = new PlaySetTransport(host);
        transport.Registration();
        var field = typeof(PlaySetTransport).GetField("registration", System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Instance)!;
        var window = (PlaySetPairingWindow)field.GetValue(transport)!;
        for (var i = 0; i < 4; i++) window.BeginAttempt(Guid.NewGuid().ToString()).Dispose();
        using (var fifth = window.BeginAttempt(Guid.NewGuid().ToString())) {
            if (transport.HasRegistration) throw new InvalidOperationException("Sixth admission must not be advertised");
            var saved = false; window.Commit(() => saved = true);
            if (!saved || window.IsActive) throw new InvalidOperationException("Already admitted fifth attempt was cancelled by lease status read");
        }
        var port = transport.Start(); var registration = transport.Registration();
        if (!transport.HasRegistration) throw new InvalidOperationException("Registration must retain foreground lease");
        Console.WriteLine($"READY|{port}|{registration.Code}|{host.DeviceId}");
        string? line;
        while ((line = Console.ReadLine()) is not null) {
            var p = line.Split('|');
            try {
                if (p[0] == "QUIT") break;
                else if (p[0] == "DELAY") { host.DelayMilliseconds = int.Parse(p[1]); Console.WriteLine("OK"); }
                else if (p[0] == "REG") Console.WriteLine("CODE|" + transport.Registration().Code);
                else if (p[0] == "FORGET") { host.Forget(p[1]); Console.WriteLine("OK"); }
                else if (p[0] == "PAIR") { await transport.PairAsync(p[1], int.Parse(p[2]), p[3], p[4].ToCharArray()); Console.WriteLine("OK"); }
                else if (p[0] == "SENDLEASE") {
                    var send = transport.SendAsync(p[1], int.Parse(p[2]), p[3], p[4], p[5]);
                    await Task.Delay(25);
                    if (!transport.HasConnections) throw new InvalidOperationException("Outbound operation must retain foreground lease");
                    var delivered = await send;
                    if (transport.HasConnections) throw new InvalidOperationException("Outbound operation lease leaked after delivery");
                    Console.WriteLine("SENT|" + delivered);
                }
                else if (p[0] == "SEND") Console.WriteLine("SENT|" + await transport.SendAsync(p[1], int.Parse(p[2]), p[3], p[4], p[5]));
                else if (p[0] == "STATUS") Console.WriteLine("STATE|" + await transport.StatusAsync(p[1], int.Parse(p[2]), p[3], p[4]));
                else throw new InvalidDataException("Invalid command");
            } catch (Exception e) { Console.Error.WriteLine(e.ToString()); Console.WriteLine("ERROR|" + e.GetType().Name); }
        }
    }
}
