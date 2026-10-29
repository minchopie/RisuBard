using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;

namespace RisuAI.ChatTransfer.Core;

public interface IPlaySetTransportHost
{
    string DeviceId { get; }
    string Name { get; }
    X509Certificate2 Certificate { get; }
    string? TrustedSpki(string device);
    void Remember(string device, string name, string spki);
    Task<string> ReceiveAsync(string device, string transfer, Stream data, long length, string hash, CancellationToken token);
    string Status(string device, string transfer);
}

/// <summary>Java-compatible RPT2/1 mutual TLS. Admission is pinned trust or PAKE, never discovery alone.</summary>
public sealed class PlaySetTransport(IPlaySetTransportHost host) : IDisposable
{
    private readonly ConcurrentDictionary<TcpClient, byte> sockets = new();
    private int activeOperations;
    public bool HasConnections => !sockets.IsEmpty || Volatile.Read(ref activeOperations) != 0;
    public bool HasRegistration => Session() != "-";
    private IDisposable Operation() { Interlocked.Increment(ref activeOperations); return new OperationLease(this); }
    private sealed class OperationLease(PlaySetTransport owner) : IDisposable
    {
        private PlaySetTransport? active = owner;
        public void Dispose() { var value = Interlocked.Exchange(ref active, null); if (value is not null) Interlocked.Decrement(ref value.activeOperations); }
    }
    private readonly CancellationTokenSource stopping = new();
    private readonly SemaphoreSlim capacity = new(4);
    private readonly object registrationLock = new();
    private PlaySetPairingWindow? registration;
    private TcpListener? listener;
    private static readonly UTF8Encoding Utf8 = new(false, true);
    public int Start()
    {
        if (listener is not null) return ((IPEndPoint)listener.LocalEndpoint).Port;
        listener = new TcpListener(IPAddress.IPv6Any, 0); listener.Server.DualMode = true; listener.Start();
        _ = AcceptLoop(); return ((IPEndPoint)listener.LocalEndpoint).Port;
    }
    public (string Session, string Code) Registration()
    {
        lock (registrationLock) { registration?.Dispose(); registration = new PlaySetPairingWindow(); return (registration.SessionId, registration.DisplayCode); }
    }
    private string Session()
    {
        lock (registrationLock) {
            if (registration is null) return "-";
            try { _ = registration.DisplayCode; return registration.SessionId; }
            catch (InvalidOperationException) {
                // Exhausted admission must not consume the already admitted fifth attempt.
                if (!registration.IsActive) { registration.Dispose(); registration = null; }
                return "-";
            }
        }
    }
    private async Task AcceptLoop()
    {
        while (!stopping.IsCancellationRequested) {
            TcpClient client;
            try { client = await listener!.AcceptTcpClientAsync(stopping.Token).ConfigureAwait(false); }
            catch (Exception) when (stopping.IsCancellationRequested) { break; }
            catch (SocketException) { await Task.Delay(250, stopping.Token).ConfigureAwait(false); continue; }
            if (!await capacity.WaitAsync(0).ConfigureAwait(false)) { client.Dispose(); continue; }
            sockets[client] = 0;
            _ = Serve(client).ContinueWith(_ => { sockets.TryRemove(client, out var ignored); client.Dispose(); capacity.Release(); }, TaskScheduler.Default);
        }
    }
    private async Task Serve(TcpClient client)
    {
        try {
            using var connection = new Connection(client, stopping.Token);
            await connection.Tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions {
                ServerCertificate = host.Certificate, ClientCertificateRequired = true,
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                RemoteCertificateValidationCallback = (_, cert, _, _) => cert is not null,
            }, connection.Token).ConfigureAwait(false);
            await connection.Send($"RPT2/1|{host.DeviceId}|{Name(host.Name)}|{Session()}").ConfigureAwait(false);
            var request = (await connection.Read().ConfigureAwait(false)).Split('|');
            if (request.Length < 2) throw new InvalidDataException("Invalid request");
            if (request[0] == "PAIR") {
                if (request.Length != 4) throw new InvalidDataException("Invalid pairing request");
                var peer = Id(request[2]); var name = DecodeName(request[3]);
                PlaySetPairingWindow window; PlaySetPairing pairing;
                lock (registrationLock) {
                    window = registration ?? throw new InvalidOperationException("Registration unavailable");
                    if (window.SessionId != request[1]) throw new InvalidDataException("Wrong registration session");
                    pairing = window.BeginAttempt(host.DeviceId);
                }
                using (pairing) {
                    await Exchange(connection, pairing).ConfigureAwait(false);
                    var authenticated = pairing.AcceptBinding(await connection.Read().ConfigureAwait(false), RemotePin(connection));
                    if (authenticated != peer) throw new InvalidDataException("Pairing identity changed");
                    lock (registrationLock) {
                        if (registration != window) throw new InvalidOperationException("Registration replaced");
                        window.Commit(() => host.Remember(peer, name, RemotePin(connection))); registration = null;
                    }
                    await connection.Send("PAIRED").ConfigureAwait(false);
                }
                return;
            }
            var device = Id(request[1]); RequireTrust(connection, device);
            if (request[0] == "SEND" && request.Length == 5) {
                var transfer = Id(request[2]); var length = long.Parse(request[3], CultureInfo.InvariantCulture);
                if (length <= 0 || request[4].Length != 64 || request[4].Any(c => !char.IsAsciiHexDigit(c) || char.IsUpper(c))) throw new InvalidDataException("Invalid file metadata");
                await connection.Send("READY").ConfigureAwait(false);
                using var input = new LimitedInput(connection, length);
                using var verification = new CancellationTokenSource();
                var heartbeat = Task.Run(async () => {
                    while (true) {
                        await Task.Delay(5000, verification.Token).ConfigureAwait(false);
                        if (input.Remaining == 0) await connection.Send("VERIFYING").ConfigureAwait(false);
                    }
                });
                string result;
                try { result = await host.ReceiveAsync(device, transfer, input, length, request[4], connection.Token).ConfigureAwait(false); }
                finally { verification.Cancel(); try { await heartbeat.ConfigureAwait(false); } catch (OperationCanceledException) { } catch (IOException) { } catch (ObjectDisposedException) { } }
                if (input.Remaining != 0) throw new InvalidDataException("Incomplete received file");
                await connection.Send("DELIVERED|" + result).ConfigureAwait(false);
            } else if (request[0] == "STATUS" && request.Length == 3) {
                await connection.Send("STATUS|" + host.Status(device, Id(request[2]))).ConfigureAwait(false);
            } else throw new InvalidDataException("Unsupported RPT2 request");
        } catch (Exception) { /* Deliberately avoid logging peer payloads and pairing codes. */ }
    }
    public async Task PairAsync(string address, int port, string expectedDevice, char[] code, CancellationToken token = default)
    {
        using var operation = Operation();
        try {
            using var connection = await Connect(address, port, token).ConfigureAwait(false);
            var hello = await Hello(connection, expectedDevice).ConfigureAwait(false);
            if (hello[3] == "-") throw new InvalidOperationException("받는 기기에서 기기 등록을 열어 주세요.");
            await connection.Send($"PAIR|{Id(hello[3])}|{host.DeviceId}|{Name(host.Name)}").ConfigureAwait(false);
            using var pairing = new PlaySetPairing(hello[3], host.DeviceId, code);
            await Exchange(connection, pairing).ConfigureAwait(false);
            var authenticated = pairing.AcceptBinding(await connection.Read().ConfigureAwait(false), RemotePin(connection));
            if (authenticated != expectedDevice) throw new InvalidDataException("Pairing identity changed");
            if (await connection.Read().ConfigureAwait(false) != "PAIRED") throw new InvalidDataException("Registration not confirmed");
            host.Remember(expectedDevice, DecodeName(hello[2]), RemotePin(connection));
        } finally { Array.Clear(code); }
    }
    public async Task<string> SendAsync(string address, int port, string device, string transfer, string path, CancellationToken token = default, Action<long, long>? progress = null)
    {
        using var operation = Operation();
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, PlaySetArchive.ChunkSize, true);
        progress?.Invoke(0, file.Length);
        var hash = Convert.ToHexString(await SHA256.HashDataAsync(file, token).ConfigureAwait(false)).ToLowerInvariant(); file.Position = 0;
        using var connection = await Connect(address, port, token).ConfigureAwait(false);
        await Hello(connection, device).ConfigureAwait(false); RequireTrust(connection, device);
        await connection.Send($"SEND|{host.DeviceId}|{Id(transfer)}|{file.Length.ToString(CultureInfo.InvariantCulture)}|{hash}").ConfigureAwait(false);
        if (await connection.Read().ConfigureAwait(false) != "READY") throw new InvalidDataException("Receiver not ready");
        var buffer = new byte[PlaySetArchive.ChunkSize]; int n; long sent = 0;
        while ((n = await file.ReadAsync(buffer, token).ConfigureAwait(false)) > 0) {
            await connection.Tls.WriteAsync(buffer.AsMemory(0, n), connection.Token).ConfigureAwait(false); connection.Touch();
            sent += n; progress?.Invoke(sent, file.Length);
        }
        await connection.Tls.FlushAsync(connection.Token).ConfigureAwait(false);
        string response;
        do { response = await connection.Read().ConfigureAwait(false); } while (response == "VERIFYING");
        if (!response.StartsWith("DELIVERED|", StringComparison.Ordinal)) throw new InvalidDataException("Delivery not confirmed");
        return response[10..];
    }
    public async Task<string> StatusAsync(string address, int port, string device, string transfer, CancellationToken token = default)
    {
        using var operation = Operation();
        using var connection = await Connect(address, port, token).ConfigureAwait(false);
        await Hello(connection, device).ConfigureAwait(false); RequireTrust(connection, device);
        await connection.Send($"STATUS|{host.DeviceId}|{Id(transfer)}").ConfigureAwait(false);
        var response = await connection.Read().ConfigureAwait(false);
        if (!response.StartsWith("STATUS|", StringComparison.Ordinal)) throw new InvalidDataException("Invalid status"); return response[7..];
    }
    private async Task Exchange(Connection c, PlaySetPairing p)
    {
        await c.Send(p.Round1()).ConfigureAwait(false); p.Accept1(await c.Read().ConfigureAwait(false));
        await c.Send(p.Round2()).ConfigureAwait(false); p.Accept2(await c.Read().ConfigureAwait(false));
        await c.Send(p.Round3()).ConfigureAwait(false); p.Accept3(await c.Read().ConfigureAwait(false));
        using var localCertificate = new X509Certificate2(c.Tls.LocalCertificate ?? throw new InvalidDataException("Missing local TLS certificate"));
        await c.Send(p.Binding(Pin(localCertificate))).ConfigureAwait(false);
    }
    private async Task<Connection> Connect(string address, int port, CancellationToken token)
    {
        var client = new TcpClient(); var connection = new Connection(client, token, stopping.Token);
        try {
            await client.ConnectAsync(address, port, connection.Token).ConfigureAwait(false);
            await connection.Tls.AuthenticateAsClientAsync(new SslClientAuthenticationOptions {
                TargetHost = "RisuPlay", ClientCertificates = new X509CertificateCollection { host.Certificate },
                EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                RemoteCertificateValidationCallback = (_, cert, _, _) => cert is not null,
            }, connection.Token).ConfigureAwait(false);
            return connection;
        } catch { connection.Dispose(); throw; }
    }
    private static async Task<string[]> Hello(Connection c, string expected)
    {
        var hello = (await c.Read().ConfigureAwait(false)).Split('|');
        if (hello.Length != 4 || hello[0] != "RPT2/1" || Id(hello[1]) != expected) throw new InvalidDataException("Wrong RPT2 device/protocol"); return hello;
    }
    private void RequireTrust(Connection c, string device) { if (RemotePin(c) != host.TrustedSpki(device)) throw new AuthenticationException("Registered device key changed"); }
    public static string Pin(X509Certificate2 certificate) => Convert.ToHexString(SHA256.HashData(certificate.PublicKey.ExportSubjectPublicKeyInfo())).ToLowerInvariant();
    private static string RemotePin(Connection c) { using var cert = new X509Certificate2(c.Tls.RemoteCertificate ?? throw new AuthenticationException("Missing peer certificate")); return Pin(cert); }
    private static string Id(string id) { if (!Guid.TryParseExact(id, "D", out _) || id != id.ToLowerInvariant()) throw new InvalidDataException("Invalid UUID"); return id; }
    private static string Name(string name) => Convert.ToBase64String(Utf8.GetBytes(string.Concat(name.EnumerateRunes().Take(80).Select(r => r.ToString()))));
    private static string DecodeName(string name) { if (name.Length > 512) throw new InvalidDataException("Name too long"); return Utf8.GetString(Convert.FromBase64String(name)); }
    private sealed class Connection : IDisposable
    {
        private readonly TcpClient client;
        private readonly CancellationTokenSource idle;
        private SslStream? tls;
        private readonly SemaphoreSlim sendGate = new(1);
        public SslStream Tls => tls ??= new SslStream(client.GetStream(), false);
        public CancellationToken Token => idle.Token;
        public Connection(TcpClient client, params CancellationToken[] tokens) { this.client = client; idle = CancellationTokenSource.CreateLinkedTokenSource(tokens); Touch(); }
        public void Touch() => idle.CancelAfter(TimeSpan.FromSeconds(45));
        public async Task Send(string frame) {
            await sendGate.WaitAsync(Token).ConfigureAwait(false);
            try {
            var bytes = Utf8.GetBytes(frame); if (bytes.Length > 8192) throw new InvalidDataException("Frame too large");
            var size = new byte[4]; BinaryPrimitives.WriteInt32BigEndian(size, bytes.Length);
            await Tls.WriteAsync(size, Token).ConfigureAwait(false); await Tls.WriteAsync(bytes, Token).ConfigureAwait(false); await Tls.FlushAsync(Token).ConfigureAwait(false); Touch();
            } finally { sendGate.Release(); }
        }
        public async Task<string> Read() {
            var size = new byte[4]; await Tls.ReadExactlyAsync(size, Token).ConfigureAwait(false);
            var n = BinaryPrimitives.ReadInt32BigEndian(size); if (n < 1 || n > 8192) throw new InvalidDataException("Invalid RPT2 frame");
            var bytes = new byte[n]; await Tls.ReadExactlyAsync(bytes, Token).ConfigureAwait(false); Touch(); return Utf8.GetString(bytes);
        }
        public void Dispose() { idle.Cancel(); tls?.Dispose(); client.Dispose(); idle.Dispose(); }
    }
    private sealed class LimitedInput(Connection c, long length) : Stream
    {
        private readonly long total = length;
        public long Remaining { get; private set; } = length;
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) {
            if (Remaining == 0) return 0;
            var n = await c.Tls.ReadAsync(buffer[..(int)Math.Min(buffer.Length, Remaining)], token).ConfigureAwait(false);
            if (n == 0) throw new EndOfStreamException(); Remaining -= n; c.Touch(); return n;
        }
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false;
        public override long Length => total; public override long Position { get => total - Remaining; set => throw new NotSupportedException(); }
        public override void Flush() {} public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
    public void Dispose() { stopping.Cancel(); listener?.Stop(); foreach (var client in sockets.Keys) client.Dispose(); lock (registrationLock) registration?.Dispose(); }
}
