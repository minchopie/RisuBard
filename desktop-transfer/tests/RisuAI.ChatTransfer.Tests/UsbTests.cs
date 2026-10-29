using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using RisuAI.ChatTransfer.Core;

namespace RisuAI.ChatTransfer.Tests;

internal static partial class Program
{
    private static Task TestBundledAdbAsync()
    {
        var directory = CreateTempDirectory();
        try {
            var adb = BundledAdb.EnsureAvailable(directory);
            var original = File.ReadAllBytes(adb);
            if (original.Length < 100000 || original[0] != 'M' || original[1] != 'Z') throw new Exception("ADB payload missing");
            foreach (var name in new[] { "AdbWinApi.dll", "AdbWinUsbApi.dll", "NOTICE.txt" })
                if (!File.Exists(Path.Combine(Path.GetDirectoryName(adb)!, name))) throw new Exception("Missing companion: " + name);
            var stamp = File.GetLastWriteTimeUtc(adb);
            Equal(adb, BundledAdb.EnsureAvailable(directory), "stable bundle path");
            Equal(stamp, File.GetLastWriteTimeUtc(adb), "valid cache not rewritten");
            File.WriteAllText(adb, "corrupt fixture");
            BundledAdb.EnsureAvailable(directory);
            if (!original.SequenceEqual(File.ReadAllBytes(adb))) throw new Exception("Corrupt cache not restored");
            File.Delete(Path.Combine(Path.GetDirectoryName(adb)!, "AdbWinApi.dll"));
            BundledAdb.EnsureAvailable(directory);
            if (!File.Exists(Path.Combine(Path.GetDirectoryName(adb)!, "AdbWinApi.dll"))) throw new Exception("Missing DLL not restored");
            return Task.CompletedTask;
        } finally { SafeDeleteTempDirectory(directory); }
    }
    private static Task TestUsbDevicesAsync()
    {
        // Official Devices protobuf: serial=1, state=2, connection_type=7, transport_id=10.
        var usb = new byte[] { 10, 1, (byte)'A', 16, 8, 56, 1, 80, 7 };
        var wireless = new byte[] { 10, 1, (byte)'B', 16, 8, 56, 2, 80, 8 };
        var unauthorized = new byte[] { 10, 1, (byte)'C', 16, 3, 56, 1, 80, 9 };
        byte[] Envelope(byte[] body) => new byte[] { 10, (byte)body.Length }.Concat(body).ToArray();
        var devices = UsbAdbTransport.ParseDevices(Envelope(usb).Concat(Envelope(wireless)).Concat(Envelope(unauthorized)).ToArray());
        try { UsbAdbTransport.ParseDevices([10, 255, 255]); throw new Exception("truncation accepted"); } catch (InvalidDataException) { }
        Equal(1, devices.Count, "USB candidates exclude wireless, emulator, unauthorized, offline");
        Equal("7", devices[0].TransportId, "exact transport selection");
        return Task.CompletedTask;
    }

    private sealed class HandshakeStream(byte[] response) : Stream
    {
        private readonly MemoryStream _input = new(response);
        internal readonly MemoryStream Output = new();
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => _input.Read(buffer, offset, count);
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default) => _input.ReadAsync(buffer, token);
        public override void Write(byte[] buffer, int offset, int count) => Output.Write(buffer, offset, count);
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken token = default) => Output.WriteAsync(buffer, token);
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        protected override void Dispose(bool disposing) { if (disposing) { _input.Dispose(); Output.Dispose(); } base.Dispose(disposing); }
    }

    private static async Task TestUsbHandshakeAsync()
    {
        var reply = new byte[26];
        BinaryPrimitives.WriteInt32BigEndian(reply, 0x52555331);
        BinaryPrimitives.WriteInt32BigEndian(reply.AsSpan(4), 1);
        BinaryPrimitives.WriteInt32BigEndian(reply.AsSpan(8), 2);
        BinaryPrimitives.WriteInt32BigEndian(reply.AsSpan(12), 2);
        Encoding.ASCII.GetBytes("1234567890").CopyTo(reply, 16);
        using var good = new HandshakeStream(reply);
        Equal("1234567890", await UsbAdbTransport.NegotiateAsync(good, true, TransferPayloadKind.Persona, default), "automatic authentication");
        Equal(16L, good.Output.Length, "bounded request");
        using var wrongDirection = new HandshakeStream(reply);
        await ThrowsAsync<InvalidDataException>(() => UsbAdbTransport.NegotiateAsync(wrongDirection, false, null, default));
        using var wrongKind = new HandshakeStream(reply);
        await ThrowsAsync<InvalidDataException>(() => UsbAdbTransport.NegotiateAsync(wrongKind, true, TransferPayloadKind.Chat, default));
        reply[16] = 255;
        using var invalidPin = new HandshakeStream(reply);
        await ThrowsAsync<InvalidDataException>(() => UsbAdbTransport.NegotiateAsync(invalidPin, true, TransferPayloadKind.Persona, default));
        using var truncated = new HandshakeStream(reply[..8]);
        await ThrowsAsync<EndOfStreamException>(() => UsbAdbTransport.NegotiateAsync(truncated, true, TransferPayloadKind.Persona, default));
    }

    private static async Task TestUsbStreamsAsync()
    {
        using (var listener = new TcpListener(IPAddress.Loopback, 0)) {
            listener.Start();
            using var first = new TcpClient();
            await first.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
            using var second = await listener.AcceptTcpClientAsync();
            using var receiver = PeerTransferClient.ForUsb(first.GetStream(), "1234567890");
            var receiving = receiver.ReceiveAsync();
            receiver.Cancel();
            await ThrowsAsync<OperationCanceledException>(() => receiving.WaitAsync(TimeSpan.FromSeconds(2)));
        }
        var directory = CreateTempDirectory();
        try {
            var json = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(new { type = "risuChat", ver = 2, data = new { name = "USB fixture", message = new[] { new { role = "user", data = new string('가', 300_000) } } }, folders = Array.Empty<object>() }));
            var png = BuildPersonaPng("USB fixture", "Test persona", "Test note");
            foreach (var (name, bytes) in new[] { ("usb.json", json), ("usb.png", png) }) {
                var path = Path.Combine(directory, name);
                await File.WriteAllBytesAsync(path, bytes);
                // Alternate the TCP initiator to exercise both USB stream roles.
                foreach (var reverse in new[] { false, true }) {
                    using var listener = new TcpListener(IPAddress.Loopback, 0);
                    listener.Start();
                    using var first = new TcpClient();
                    await first.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port);
                    using var second = await listener.AcceptTcpClientAsync();
                    var senderStream = (reverse ? first : second).GetStream();
                    var receiverStream = (reverse ? second : first).GetStream();
                    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                    using var sender = new OneShotChatServer(path, name, IPAddress.Loopback, false, null, senderStream, "1234567890");
                    var sending = sender.ServeAsync(cancellationToken: timeout.Token);
                    using var receiver = PeerTransferClient.ForUsb(receiverStream, "1234567890");
                    using var received = await receiver.ReceiveAndSaveAsync(directory, cancellationToken: timeout.Token);
                    var actual = await File.ReadAllBytesAsync(received.SavedPath!);
                    True(bytes.AsSpan().SequenceEqual(actual), "USB bytes match");
                    True(received.SavedPath != path, "original preserved");
                    Equal(TransferOutcome.Sent, (await sending).Outcome, "USB stream sent");
                }
            }
        } finally { SafeDeleteTempDirectory(directory); }
    }
}
