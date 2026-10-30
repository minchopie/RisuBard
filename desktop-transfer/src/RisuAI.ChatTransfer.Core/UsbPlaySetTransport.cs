using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace RisuAI.ChatTransfer.Core;

/// <summary>RPU2 over the selected ADB USB transport; no TCP forwarding or legacy PIN exchange.</summary>
public sealed class UsbPlaySetTransport : IDisposable
{
    private const int Magic = 0x52505532;
    private readonly TcpClient client;
    private readonly CancellationTokenSource idle;
    private readonly SemaphoreSlim receiptLock = new(1, 1);
    private CancellationTokenSource? verification;
    private Task? heartbeat;
    private NetworkStream Stream => client.GetStream();
    private UsbPlaySetTransport(TcpClient client, CancellationTokenSource idle) { this.client = client; this.idle = idle; }
    private void Touch() => idle.CancelAfter(TimeSpan.FromSeconds(45));
    public static async Task<UsbPlaySetTransport> ConnectAsync(string adb, UsbDevice device, int operation, CancellationToken token = default, string socketName = "risu_play_set_usb_v2")
    {
        if (!(await UsbAdbTransport.DiscoverAsync(adb, token).ConfigureAwait(false)).Contains(device)) throw new IOException("USB 기기를 새로 선택해 주세요.");
        var client = new TcpClient(AddressFamily.InterNetwork) { NoDelay = true };
        var idle = CancellationTokenSource.CreateLinkedTokenSource(token); idle.CancelAfter(TimeSpan.FromSeconds(45));
        var transport = new UsbPlaySetTransport(client, idle);
        try {
            await client.ConnectAsync(IPAddress.Loopback, 5037, idle.Token).ConfigureAwait(false);
            await UsbAdbTransport.AdbRequestAsync(client.GetStream(), "host:transport-id:" + device.TransportId, idle.Token).ConfigureAwait(false);
            if (socketName is not ("risu_play_set_usb_v2" or "risubard_play_set_usb_v2")) throw new InvalidDataException("Unknown USB application");
            await UsbAdbTransport.AdbRequestAsync(client.GetStream(), "localabstract:" + socketName, idle.Token).ConfigureAwait(false);
            var header = new byte[12]; BinaryPrimitives.WriteInt32BigEndian(header, Magic); BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(4), 1); BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(8), operation);
            await transport.Write(header).ConfigureAwait(false); var reply = new byte[12]; await transport.Read(reply).ConfigureAwait(false);
            if (!header.SequenceEqual(reply)) throw new InvalidDataException("USB 플레이 세트 프로토콜이 다릅니다.");
            return transport;
        } catch { transport.Dispose(); throw; }
    }
    private async Task Read(Memory<byte> data) { await Stream.ReadExactlyAsync(data, idle.Token).ConfigureAwait(false); Touch(); }
    private async Task Write(ReadOnlyMemory<byte> data) { await Stream.WriteAsync(data, idle.Token).ConfigureAwait(false); Touch(); }
    private static string Id(string value) { if (!Guid.TryParseExact(value, "D", out _) || value != value.ToLowerInvariant()) throw new InvalidDataException("Invalid transfer ID"); return value; }
    private async Task<string> ReadId() { var bytes = new byte[36]; await Read(bytes).ConfigureAwait(false); return Id(Encoding.ASCII.GetString(bytes)); }
    private Task WriteId(string id) => Write(Encoding.ASCII.GetBytes(Id(id)));
    private async Task<string> ReadState()
    {
        var size = new byte[1]; await Read(size).ConfigureAwait(false); if (size[0] is 0 or > 64) throw new InvalidDataException("Invalid status");
        var bytes = new byte[size[0]]; await Read(bytes).ConfigureAwait(false); return Encoding.ASCII.GetString(bytes);
    }
    public async Task SendAsync(string path, string transfer, byte[] hash, Action<long, long> progress)
    {
        await using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, PlaySetArchive.ChunkSize, true);
        if (hash.Length != 32) throw new InvalidDataException("Invalid file hash");
        await WriteId(transfer).ConfigureAwait(false);
        var length = new byte[8]; BinaryPrimitives.WriteInt64BigEndian(length, file.Length); await Write(length).ConfigureAwait(false); await Write(hash).ConfigureAwait(false);
        if (await ReadState().ConfigureAwait(false) != "ready") throw new IOException("USB 받기를 준비하지 못했습니다.");
        var buffer = new byte[PlaySetArchive.ChunkSize]; int n; long sent = 0;
        while ((n = await file.ReadAsync(buffer, idle.Token).ConfigureAwait(false)) > 0) { await Write(buffer.AsMemory(0, n)).ConfigureAwait(false); sent += n; progress(sent, file.Length); }
        string status; do { status = await ReadState().ConfigureAwait(false); } while (status == "verifying");
        if (status != "delivered") throw new IOException("USB 전달 완료를 확인하지 못했습니다.");
    }
    public async Task<(string Handle, string Transfer, string Hash)> ReceiveAsync(PlaySetArchive archive, Action<long, long> progress)
    {
        if (await ReadState().ConfigureAwait(false) != "ready") throw new IOException("Android에서 보낼 세트를 선택하고 USB 보내기를 눌러 주세요.");
        var transfer = await ReadId().ConfigureAwait(false); var lengthBytes = new byte[8]; await Read(lengthBytes).ConfigureAwait(false);
        var length = BinaryPrimitives.ReadInt64BigEndian(lengthBytes); var expected = new byte[32]; await Read(expected).ConfigureAwait(false);
        if (length <= 0 || length > archive.AvailableBytes / 2) throw new IOException("플레이 세트를 저장할 공간이 부족합니다.");
        await Write(new byte[] { 1 }).ConfigureAwait(false);
        using var input = new LimitedInput(Stream, length, () => Touch(), progress);
        verification = new CancellationTokenSource();
        heartbeat = Task.Run(async () => { try { while (true) {
            await Task.Delay(5000, verification.Token).ConfigureAwait(false);
            if (input.Remaining != 0) continue;
            await receiptLock.WaitAsync(verification.Token).ConfigureAwait(false);
            try { if (!verification.IsCancellationRequested) await Write(new byte[] { 2 }).ConfigureAwait(false); }
            finally { receiptLock.Release(); }
        } } catch (OperationCanceledException) { } catch (IOException) { } catch (ObjectDisposedException) { } });
        var handle = await archive.ReceiveAsync(input, idle.Token).ConfigureAwait(false);
        if (input.Remaining != 0 || !CryptographicOperations.FixedTimeEquals(expected, input.Hash.GetHashAndReset())) { archive.Delete(handle); throw new InvalidDataException("USB 파일 해시가 다릅니다."); }
        // Caller durably queues the handle before acknowledging delivery.
        return (handle, transfer, Convert.ToHexString(expected).ToLowerInvariant());
    }
    public async Task AcknowledgeDelivery() {
        verification?.Cancel(); if (heartbeat is not null) await heartbeat.ConfigureAwait(false);
        await receiptLock.WaitAsync().ConfigureAwait(false);
        try { await Write(new byte[] { 1 }).ConfigureAwait(false); } finally { receiptLock.Release(); }
    }
    public async Task<string> StatusAsync(string transfer) { await WriteId(transfer).ConfigureAwait(false); return await ReadState().ConfigureAwait(false); }
    public async Task ReceiptAsync(string transfer, bool applied) { await WriteId(transfer).ConfigureAwait(false); await Write(new byte[] { applied ? (byte)1 : (byte)0 }).ConfigureAwait(false); if (await ReadState().ConfigureAwait(false) != "ok") throw new IOException("USB 상태 확인 실패"); }
    public void Dispose() { verification?.Cancel(); client.Dispose(); idle.Dispose(); }
    private sealed class LimitedInput(Stream source, long length, Action touch, Action<long, long> progress) : Stream
    {
        private readonly long total = length;
        public long Remaining { get; private set; } = length;
        public IncrementalHash Hash { get; } = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
        {
            if (Remaining == 0) return 0;
            var n = await source.ReadAsync(buffer[..(int)Math.Min(buffer.Length, Remaining)], token).ConfigureAwait(false);
            if (n == 0) throw new EndOfStreamException(); Hash.AppendData(buffer.Span[..n]); Remaining -= n; touch(); progress(total - Remaining, total); return n;
        }
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken token) => ReadAsync(buffer.AsMemory(offset, count), token).AsTask();
        public override int Read(byte[] buffer, int offset, int count) => ReadAsync(buffer.AsMemory(offset, count)).AsTask().GetAwaiter().GetResult();
        protected override void Dispose(bool disposing) { if (disposing) Hash.Dispose(); base.Dispose(disposing); }
        public override bool CanRead => true; public override bool CanSeek => false; public override bool CanWrite => false; public override long Length => total;
        public override long Position { get => total - Remaining; set => throw new NotSupportedException(); }
        public override void Flush() { } public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException(); public override void SetLength(long value) => throw new NotSupportedException(); public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
