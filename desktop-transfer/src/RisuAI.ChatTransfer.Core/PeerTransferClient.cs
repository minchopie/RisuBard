using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace RisuAI.ChatTransfer.Core;

public sealed class PeerTransferClient : IDisposable
{
    private static readonly TimeSpan ConnectTimeout = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan SocketOperationTimeout = TimeSpan.FromSeconds(30);

    private readonly PeerEndpoint _endpoint;
    private readonly string _pin;
    private Stream? _usbStream;
    private readonly Func<string, CancellationToken, Task<IPAddress[]>> _resolver;
    private readonly bool _allowLoopbackForTesting;
    private readonly CancellationTokenSource _stop = new();
    private TcpClient? _activeClient;
    private int _receiving;
    private int _disposed;

    public PeerTransferClient(PeerEndpoint endpoint, string pin)
        : this(endpoint, pin, Dns.GetHostAddressesAsync, allowLoopbackForTesting: false)
    {
    }

    internal PeerTransferClient(
        PeerEndpoint endpoint,
        string pin,
        Func<string, CancellationToken, Task<IPAddress[]>> resolver,
        bool allowLoopbackForTesting)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        ArgumentNullException.ThrowIfNull(resolver);
        if (endpoint.Port is < 1024 or > 65535) throw new ArgumentOutOfRangeException(nameof(endpoint));
        if (!PeerTransferProtocol.IsValidPin(pin))
        {
            throw new ArgumentException("PIN은 숫자 10자리여야 합니다.", nameof(pin));
        }
        _endpoint = endpoint;
        _pin = pin;
        _resolver = resolver;
        _allowLoopbackForTesting = allowLoopbackForTesting;
    }

    internal static PeerTransferClient ForUsb(Stream stream, string pin) => new(new PeerEndpoint("127.0.0.1", 1024), pin) { _usbStream = stream };

    public Task<ReceivedChatFile> ReceiveAsync(
        IProgress<TransferProgress>? progress = null,
        CancellationToken cancellationToken = default) =>
        ReceiveInternalAsync(destinationDirectory: null, progress, cancellationToken);

    public Task<ReceivedChatFile> ReceiveAndSaveAsync(
        string destinationDirectory,
        IProgress<TransferProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(destinationDirectory);
        var directory = Path.GetFullPath(destinationDirectory);
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException("선택한 저장 폴더를 찾을 수 없습니다.");
        return ReceiveInternalAsync(directory, progress, cancellationToken);
    }

    private async Task<ReceivedChatFile> ReceiveInternalAsync(
        string? destinationDirectory,
        IProgress<TransferProgress>? progress,
        CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        if (Interlocked.Exchange(ref _receiving, 1) != 0)
        {
            throw new InvalidOperationException("이 수신기는 이미 사용되었습니다.");
        }

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _stop.Token);
        var token = linked.Token;
        string? temporaryPath = null;
        var header = new byte[sizeof(int) * 3 + PeerTransferProtocol.SaltBytes + PeerTransferProtocol.ChallengeBytes];
        byte[]? salt = null;
        byte[]? challenge = null;
        byte[]? proof = null;
        byte[]? request = null;
        byte[]? nonce = null;
        byte[]? baseAad = null;
        ReceivedChatFile? pendingResult = null;

        try
        {
            Stream stream;
            if (_usbStream is not null) stream = _usbStream;
            else
            {
            var resolved = await PeerEndpointParser.ResolveAsync(
                _endpoint, _resolver, _allowLoopbackForTesting, token).WaitAsync(ConnectTimeout, token).ConfigureAwait(false);
            var client = new TcpClient(AddressFamily.InterNetwork) { NoDelay = true };
            _activeClient = client;
            await client.ConnectAsync(resolved, _endpoint.Port, token)
                .AsTask().WaitAsync(ConnectTimeout, token).ConfigureAwait(false);
            stream = client.GetStream();
            }

            await ReadExactlyAsync(stream, header, token).ConfigureAwait(false);
            if (BinaryPrimitives.ReadInt32BigEndian(header) != PeerTransferProtocol.Magic ||
                BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(sizeof(int))) != PeerTransferProtocol.Version)
            {
                throw new InvalidDataException("상대 기기의 대화 전송 프로토콜 버전이 호환되지 않습니다.");
            }
            var iterations = BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(sizeof(int) * 2));
            if (iterations is < 100_000 or > 1_000_000)
            {
                throw new InvalidDataException("상대 기기가 잘못된 암호화 비용을 보냈습니다.");
            }
            salt = header.AsSpan(sizeof(int) * 3, PeerTransferProtocol.SaltBytes).ToArray();
            challenge = header.AsSpan(sizeof(int) * 3 + PeerTransferProtocol.SaltBytes, PeerTransferProtocol.ChallengeBytes).ToArray();
            using var keys = PeerTransferProtocol.DeriveKeys(_pin, salt, iterations);
            proof = PeerTransferProtocol.CreateProof(keys.Authentication, challenge);
            request = new byte[sizeof(int) * 2 + proof.Length];
            BinaryPrimitives.WriteInt32BigEndian(request, PeerTransferProtocol.Magic);
            BinaryPrimitives.WriteInt32BigEndian(request.AsSpan(sizeof(int)), PeerTransferProtocol.Version);
            proof.CopyTo(request, sizeof(int) * 2);
            await WriteAsync(stream, request, token).ConfigureAwait(false);

            var status = new byte[1];
            await ReadExactlyAsync(stream, status, token).ConfigureAwait(false);
            if (status[0] == 0) throw new UnauthorizedAccessException("PIN이 틀렸거나 전송 요청이 만료되었습니다.");
            if (status[0] != 1) throw new InvalidDataException("상대 기기가 잘못된 인증 상태를 보냈습니다.");

            var intBuffer = new byte[sizeof(int)];
            await ReadExactlyAsync(stream, intBuffer, token).ConfigureAwait(false);
            var nameLength = BinaryPrimitives.ReadInt32BigEndian(intBuffer);
            if (nameLength is < 1 or > PeerTransferProtocol.MaxFileNameBytes)
            {
                throw new InvalidDataException("받은 파일 이름 길이가 허용 범위를 벗어났습니다.");
            }
            var nameBytes = new byte[nameLength];
            await ReadExactlyAsync(stream, nameBytes, token).ConfigureAwait(false);
            string wireFileName;
            try { wireFileName = new UTF8Encoding(false, true).GetString(nameBytes); }
            catch (DecoderFallbackException error) { throw new InvalidDataException("받은 파일 이름이 올바른 UTF-8이 아닙니다.", error); }
            var safeFileName = PeerTransferProtocol.SanitizeTransferFileName(wireFileName);

            var longBuffer = new byte[sizeof(long)];
            await ReadExactlyAsync(stream, longBuffer, token).ConfigureAwait(false);
            var fileBytes = BinaryPrimitives.ReadInt64BigEndian(longBuffer);
            if (fileBytes is < 1 or > PeerTransferProtocol.MaxFileBytes)
            {
                throw new InvalidDataException("받을 파일 크기가 1바이트–64 MiB 범위를 벗어났습니다.");
            }
            nonce = new byte[PeerTransferProtocol.NonceBytes];
            await ReadExactlyAsync(stream, nonce, token).ConfigureAwait(false);
            await ReadExactlyAsync(stream, longBuffer, token).ConfigureAwait(false);
            var encryptedBytes = BinaryPrimitives.ReadInt64BigEndian(longBuffer);
            if (encryptedBytes != PeerTransferProtocol.EncryptedPayloadBytes(fileBytes))
            {
                throw new InvalidDataException("암호화된 파일 크기가 메타데이터와 일치하지 않습니다.");
            }

            baseAad = PeerTransferProtocol.CreateBaseAad(challenge, wireFileName, fileBytes);
            temporaryPath = CreateTemporaryPath(Path.GetExtension(safeFileName));
            progress?.Report(new TransferProgress(0, fileBytes));
            await DecryptPayloadAsync(
                stream, temporaryPath, keys.Encryption, nonce, baseAad,
                fileBytes, encryptedBytes, progress, token).ConfigureAwait(false);

            var validated = await ChatFileValidator.ValidateAsync(temporaryPath, safeFileName, token).ConfigureAwait(false);
            var receivedInfo = validated with { TransferFileName = safeFileName };
            pendingResult = new ReceivedChatFile(temporaryPath, receivedInfo);
            temporaryPath = null;
            if (destinationDirectory is not null)
            {
                var savedPath = await pendingResult.SaveToDirectoryAsync(destinationDirectory, token).ConfigureAwait(false);
                pendingResult.MarkSaved(savedPath);
            }
            await WriteAsync(stream, new byte[] { 1 }, token).ConfigureAwait(false);
            await stream.FlushAsync(token).WaitAsync(SocketOperationTimeout, token).ConfigureAwait(false);
            var completed = pendingResult;
            pendingResult = null;
            return completed;
        }
        catch (TimeoutException error)
        {
            throw new IOException("연결 또는 전송 응답이 제한 시간 안에 오지 않았습니다.", error);
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
        {
            throw new OperationCanceledException("파일 받기를 취소했습니다.", _stop.Token);
        }
        catch (CryptographicException error)
        {
            throw new InvalidDataException("암호화 검증에 실패했습니다. 주소와 PIN을 확인하고 다시 보내세요.", error);
        }
        finally
        {
            if (temporaryPath is not null)
            {
                try { File.Delete(temporaryPath); } catch { }
            }
            pendingResult?.Dispose();
            _activeClient?.Dispose();
            _activeClient = null;
            ZeroSecrets(header, salt, challenge, proof, request, nonce, baseAad);
        }
    }

    public void Cancel()
    {
        try { _stop.Cancel(); } catch (ObjectDisposedException) { }
        try { _activeClient?.Dispose(); } catch { }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        Cancel();
        _stop.Dispose();
        GC.SuppressFinalize(this);
    }

    private static async Task DecryptPayloadAsync(
        Stream source,
        string outputPath,
        byte[] encryptionKey,
        byte[] nonce,
        byte[] baseAad,
        long fileBytes,
        long expectedEncryptedBytes,
        IProgress<TransferProgress>? progress,
        CancellationToken cancellationToken)
    {
        await using var output = new FileStream(
            outputPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
            PeerTransferProtocol.IoChunkBytes, FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var aes = new AesGcm(encryptionKey, PeerTransferProtocol.GcmTagBytes);
        long remaining = fileBytes;
        long transferred = 0;
        long consumed = 0;
        var chunkIndex = 0;
        while (remaining > 0)
        {
            var count = (int)Math.Min(PeerTransferProtocol.IoChunkBytes, remaining);
            var encrypted = new byte[count + PeerTransferProtocol.GcmTagBytes];
            var plaintext = new byte[count];
            var chunkNonce = PeerTransferProtocol.CreateChunkNonce(nonce, chunkIndex);
            var chunkAad = PeerTransferProtocol.CreateChunkAad(baseAad, chunkIndex, count);
            try
            {
                await ReadExactlyAsync(source, encrypted, cancellationToken).ConfigureAwait(false);
                aes.Decrypt(
                    chunkNonce,
                    encrypted.AsSpan(0, count),
                    encrypted.AsSpan(count, PeerTransferProtocol.GcmTagBytes),
                    plaintext,
                    chunkAad);
                await output.WriteAsync(plaintext, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                CryptographicOperations.ZeroMemory(encrypted);
                CryptographicOperations.ZeroMemory(plaintext);
                CryptographicOperations.ZeroMemory(chunkNonce);
                CryptographicOperations.ZeroMemory(chunkAad);
            }
            remaining -= count;
            transferred += count;
            consumed += count + PeerTransferProtocol.GcmTagBytes;
            chunkIndex++;
            progress?.Report(new TransferProgress(transferred, fileBytes));
        }
        if (consumed != expectedEncryptedBytes) throw new InvalidDataException("받은 암호화 데이터 길이가 일치하지 않습니다.");
        await output.FlushAsync(cancellationToken).ConfigureAwait(false);
        output.Flush(flushToDisk: true);
    }

    private static string CreateTemporaryPath(string extension)
    {
        var directory = Path.Combine(Path.GetTempPath(), "RisuAI-Chat-Transfer");
        Directory.CreateDirectory(directory);
        try
        {
            var staleBefore = DateTime.UtcNow.AddHours(-1);
            foreach (var stale in Directory.EnumerateFiles(directory, "received-*.*", SearchOption.TopDirectoryOnly))
            {
                try
                {
                    if (File.GetLastWriteTimeUtc(stale) < staleBefore) File.Delete(stale);
                }
                catch
                {
                    // Another process may still own a temporary receive file.
                }
            }
        }
        catch
        {
            // Cleanup is best effort; creating the new unique file remains the required operation.
        }
        return Path.Combine(directory, $"received-{Guid.NewGuid():N}{extension}");
    }

    private static async Task WriteAsync(Stream stream, ReadOnlyMemory<byte> bytes, CancellationToken cancellationToken)
    {
        await stream.WriteAsync(bytes, cancellationToken)
            .AsTask().WaitAsync(SocketOperationTimeout, cancellationToken).ConfigureAwait(false);
    }

    private static async Task ReadExactlyAsync(Stream stream, Memory<byte> destination, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < destination.Length)
        {
            var count = await stream.ReadAsync(destination[offset..], cancellationToken)
                .AsTask().WaitAsync(SocketOperationTimeout, cancellationToken).ConfigureAwait(false);
            if (count == 0) throw new EndOfStreamException("상대 기기가 전송을 완료하기 전에 연결을 닫았습니다.");
            offset += count;
        }
    }

    private static void ZeroSecrets(params byte[]?[] values)
    {
        foreach (var value in values)
        {
            if (value is not null) CryptographicOperations.ZeroMemory(value);
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
    }
}
