using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace RisuAI.ChatTransfer.Core;

public sealed record UsbDevice(string Serial, string Model, string TransportId)
{
    public override string ToString() => $"{Model} · {Serial}";
}

/// <summary>Uses the local ADB server's selected USB transport, without opening a forwarding port.</summary>
public sealed class UsbAdbTransport : IDisposable
{
    private readonly TcpClient _client;
    private readonly string _pin;
    private readonly CancellationTokenSource _lifetime = new(PeerTransferProtocol.SessionLifetime);
    private readonly CancellationTokenRegistration _disconnect;
    private bool _disposed;
    private UsbAdbTransport(TcpClient client, string pin)
    {
        _client = client;
        _pin = pin;
        _disconnect = _lifetime.Token.Register(() => _client.Dispose());
    }

    public static string? FindAdb()
    {
        return BundledAdb.EnsureAvailable();
    }

    private static async Task<string> RunAdbAsync(string adb, CancellationToken token, params string[] arguments)
    {
        var info = new ProcessStartInfo(adb) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        // Use only the local default server. Do not inherit a remote ADB server override.
        info.Environment.Remove("ADB_SERVER_SOCKET");
        info.Environment.Remove("ANDROID_ADB_SERVER_PORT");
        info.ArgumentList.Add("-H"); info.ArgumentList.Add("127.0.0.1");
        info.ArgumentList.Add("-P"); info.ArgumentList.Add("5037");
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        using var process = Process.Start(info) ?? throw new IOException("ADB를 실행하지 못했습니다.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
        var error = process.StandardError.ReadToEndAsync(timeout.Token);
        try { await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false); }
        catch { try { process.Kill(); } catch (InvalidOperationException) { } throw; }
        var result = await output.ConfigureAwait(false);
        await error.ConfigureAwait(false);
        if (process.ExitCode != 0) throw new IOException("USB 기기를 확인하지 못했습니다. 케이블과 USB 디버깅 승인을 확인하세요.");
        return result.Trim();
    }

    // ADB's structured connection_type is authoritative. Windows USB devices may have no devpath.
    internal static IReadOnlyList<UsbDevice> ParseDevices(byte[] data)
    {
        var devices = new List<UsbDevice>();
        foreach (var item in ProtoFields(data).Where(f => f.Number == 1 && f.Bytes is not null))
        {
            var fields = ProtoFields(item.Bytes!);
            ulong Number(int n) => fields.FirstOrDefault(f => f.Number == n).Value;
            string Text(int n) => Encoding.UTF8.GetString(fields.FirstOrDefault(f => f.Number == n).Bytes ?? []);
            if (Number(2) != 8 || Number(7) != 1 || Number(10) == 0) continue;
            var serial = Text(1);
            if (string.IsNullOrWhiteSpace(serial) || serial.Length > 256) continue;
            var model = Text(5);
            devices.Add(new UsbDevice(serial, string.IsNullOrWhiteSpace(model) ? "Android" : model, Number(10).ToString(CultureInfo.InvariantCulture)));
        }
        return devices;
    }

    private static List<(int Number, ulong Value, byte[]? Bytes)> ProtoFields(byte[] data)
    {
        var result = new List<(int, ulong, byte[]?)>();
        var offset = 0;
        ulong Varint() {
            ulong value = 0;
            for (var shift = 0; shift < 64; shift += 7) {
                if (offset >= data.Length) throw new InvalidDataException("ADB 기기 목록이 잘렸습니다.");
                var part = data[offset++];
                if (shift == 63 && part > 1) throw new InvalidDataException("ADB 정수 범위 오류");
                value |= (ulong)(part & 127) << shift;
                if ((part & 128) == 0) return value;
            }
            throw new InvalidDataException("ADB 정수 형식 오류");
        }
        while (offset < data.Length) {
            var tag = Varint();
            if (tag >> 3 == 0 || tag >> 3 > 536870911) throw new InvalidDataException("ADB 필드 형식 오류");
            var number = (int)(tag >> 3);
            var wire = tag & 7;
            if (wire == 0) { result.Add((number, Varint(), null)); continue; }
            var length = wire switch { 1 => 8UL, 5 => 4UL, 2 => Varint(), _ => throw new InvalidDataException("ADB 필드 종류 오류") };
            if (length > (ulong)(data.Length - offset)) throw new InvalidDataException("ADB 기기 목록 크기 오류");
            if (wire == 2) result.Add((number, 0, data.AsSpan(offset, (int)length).ToArray()));
            offset += (int)length;
        }
        return result;
    }

    public static async Task<IReadOnlyList<UsbDevice>> DiscoverAsync(string adb, CancellationToken token = default)
    {
        await RunAdbAsync(adb, token, "start-server").ConfigureAwait(false);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        using var client = new TcpClient(AddressFamily.InterNetwork);
        await client.ConnectAsync(IPAddress.Loopback, 5037, timeout.Token).ConfigureAwait(false);
        var stream = client.GetStream();
        await AdbRequestAsync(stream, "host:track-devices-proto-binary", timeout.Token).ConfigureAwait(false);
        var header = new byte[4];
        await stream.ReadExactlyAsync(header, timeout.Token).ConfigureAwait(false);
        if (!int.TryParse(Encoding.ASCII.GetString(header), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var length) || length < 0 || length > 65535)
            throw new InvalidDataException("ADB 기기 목록 크기가 올바르지 않습니다.");
        var data = new byte[length];
        await stream.ReadExactlyAsync(data, timeout.Token).ConfigureAwait(false);
        return ParseDevices(data);
    }

    public static async Task<UsbAdbTransport> ConnectAsync(string adb, UsbDevice selected, bool sendFromPc, TransferPayloadKind? kind, CancellationToken token)
    {
        var devices = await DiscoverAsync(adb, token).ConfigureAwait(false);
        if (!devices.Contains(selected)) throw new IOException("선택한 USB 기기가 변경되거나 분리되었습니다. 목록을 새로고침하세요.");
        var client = new TcpClient(AddressFamily.InterNetwork) { NoDelay = true };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        try
        {
            await client.ConnectAsync(IPAddress.Loopback, 5037, timeout.Token).ConfigureAwait(false);
            var stream = client.GetStream();
            await AdbRequestAsync(stream, $"host:transport-id:{selected.TransportId}", timeout.Token).ConfigureAwait(false);
            await AdbRequestAsync(stream, "localabstract:risu_mobile_private_usb_v1", timeout.Token).ConfigureAwait(false);
            var pin = await NegotiateAsync(stream, sendFromPc, kind, timeout.Token).ConfigureAwait(false);
            return new UsbAdbTransport(client, pin);
        }
        catch { client.Dispose(); throw; }
    }

    internal static async Task<string> NegotiateAsync(Stream stream, bool sendFromPc, TransferPayloadKind? kind, CancellationToken token)
    {
        var direction = sendFromPc ? 2 : 1;
        var payloadKind = kind is null ? 0 : kind == TransferPayloadKind.Persona ? 2 : 1;
        var request = new byte[16];
        BinaryPrimitives.WriteInt32BigEndian(request, 0x52555331);
        BinaryPrimitives.WriteInt32BigEndian(request.AsSpan(4), 1);
        BinaryPrimitives.WriteInt32BigEndian(request.AsSpan(8), direction);
        BinaryPrimitives.WriteInt32BigEndian(request.AsSpan(12), payloadKind);
        await stream.WriteAsync(request, token).ConfigureAwait(false);
        var reply = new byte[26];
        try
        {
            await stream.ReadExactlyAsync(reply, token).ConfigureAwait(false);
            if (BinaryPrimitives.ReadInt32BigEndian(reply) != 0x52555331 || BinaryPrimitives.ReadInt32BigEndian(reply.AsSpan(4)) != 1 ||
                BinaryPrimitives.ReadInt32BigEndian(reply.AsSpan(8)) != direction ||
                BinaryPrimitives.ReadInt32BigEndian(reply.AsSpan(12)) is not (1 or 2))
                throw new InvalidDataException("USB 전송 버전 또는 방향이 다릅니다.");
            if (sendFromPc && BinaryPrimitives.ReadInt32BigEndian(reply.AsSpan(12)) != payloadKind)
                throw new InvalidDataException("태블릿의 받기 종류와 PC 파일 종류가 다릅니다.");
            var pin = Encoding.ASCII.GetString(reply, 16, 10);
            if (!PeerTransferProtocol.IsValidPin(pin)) throw new InvalidDataException("USB 자동 인증 응답이 올바르지 않습니다.");
            return pin;
        }
        finally { System.Security.Cryptography.CryptographicOperations.ZeroMemory(reply); }
    }

    internal static async Task AdbRequestAsync(Stream stream, string service, CancellationToken token)
    {
        var bytes = Encoding.UTF8.GetBytes(service);
        await stream.WriteAsync(Encoding.ASCII.GetBytes(bytes.Length.ToString("X4", CultureInfo.InvariantCulture)), token).ConfigureAwait(false);
        await stream.WriteAsync(bytes, token).ConfigureAwait(false);
        var status = new byte[4];
        await stream.ReadExactlyAsync(status, token).ConfigureAwait(false);
        if (!status.AsSpan().SequenceEqual("OKAY"u8))
            throw new IOException("태블릿에서 USB 보내기·받기를 먼저 열고, 앱 버전과 PC 신뢰 승인을 확인하세요.");
    }

    public async Task<TransferResult> SendAsync(ChatFileInfo file, IProgress<TransferProgress>? progress, CancellationToken token)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, _lifetime.Token);
        using var server = new OneShotChatServer(file.FullPath, file.TransferFileName, IPAddress.Loopback, false, null, _client.GetStream(), _pin);
        return await server.ServeAsync(progress, linked.Token).ConfigureAwait(false);
    }

    public async Task<ReceivedChatFile> ReceiveAsync(string folder, IProgress<TransferProgress>? progress, CancellationToken token)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(token, _lifetime.Token);
        using var receiver = PeerTransferClient.ForUsb(_client.GetStream(), _pin);
        return await receiver.ReceiveAndSaveAsync(folder, progress, linked.Token).ConfigureAwait(false);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _disconnect.Dispose();
        _client.Dispose();
        _lifetime.Dispose();
    }
}
