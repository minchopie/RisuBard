using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;

namespace RisuAI.ChatTransfer.Core;

public sealed class OneShotChatServer : IDisposable
{
    private static readonly TimeSpan SocketOperationTimeout = TimeSpan.FromSeconds(30);

    private readonly FileStream _payload;
    private readonly long _fileBytes;
    private readonly string _fileName;
    private readonly TcpListener? _listener;
    private readonly Stream? _usbStream;
    private readonly CancellationTokenSource _stop = new();
    private int _disposed;
    private int _cancelled;
    private int _serving;

    public OneShotChatServer(string payloadPath, string fileName, IPAddress bindAddress)
        : this(payloadPath, fileName, bindAddress, allowLoopbackForTesting: false, sessionLifetime: null)
    {
    }

    internal OneShotChatServer(
        string payloadPath,
        string fileName,
        IPAddress bindAddress,
        bool allowLoopbackForTesting,
        TimeSpan? sessionLifetime, Stream? usbStream = null, string? usbPin = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(payloadPath);
        ArgumentNullException.ThrowIfNull(bindAddress);
        if (usbStream is null && !PeerTransferProtocol.IsAllowedPeerAddress(bindAddress) &&
            !(allowLoopbackForTesting && IPAddress.IsLoopback(bindAddress)))
        {
            throw new ArgumentException("같은 Wi-Fi/LAN 또는 Tailscale의 IPv4 주소만 사용할 수 있습니다.", nameof(bindAddress));
        }

        _fileName = PeerTransferProtocol.SanitizeTransferFileName(fileName);
        _payload = new FileStream(
            Path.GetFullPath(payloadPath),
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            PeerTransferProtocol.IoChunkBytes,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        _fileBytes = _payload.Length;
        if (_fileBytes is < 1 or > PeerTransferProtocol.MaxFileBytes)
        {
            _payload.Dispose();
            throw new InvalidDataException("보낼 파일은 1바이트 이상 64 MiB 이하여야 합니다.");
        }

        try
        {
            _usbStream = usbStream;
            if (usbStream is null)
            {
                _listener = new TcpListener(bindAddress, 0);
                _listener.Server.ExclusiveAddressUse = true;
                _listener.Start(5);
            }
        }
        catch
        {
            _payload.Dispose();
            throw;
        }

        Pin = usbPin ?? PeerTransferProtocol.GeneratePin();
        var lifetime = sessionLifetime ?? PeerTransferProtocol.SessionLifetime;
        if (lifetime <= TimeSpan.Zero || lifetime > PeerTransferProtocol.SessionLifetime)
        {
            Dispose();
            throw new ArgumentOutOfRangeException(nameof(sessionLifetime));
        }
        ExpiresAt = DateTimeOffset.UtcNow.Add(lifetime);
    }

    public string Pin { get; }
    public DateTimeOffset ExpiresAt { get; }
    public int Port => ((IPEndPoint)_listener!.LocalEndpoint).Port;
    public IPAddress BindAddress => ((IPEndPoint)_listener!.LocalEndpoint).Address;
    public string DisplayAddress => $"{BindAddress}:{Port}";

    public async Task<TransferResult> ServeAsync(
        IProgress<TransferProgress>? progress = null,
        CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        if (Interlocked.Exchange(ref _serving, 1) != 0)
        {
            throw new InvalidOperationException("이 일회용 전송 서버는 이미 시작되었습니다.");
        }
        var salt = PeerTransferProtocol.RandomBytes(PeerTransferProtocol.SaltBytes);
        var challenge = PeerTransferProtocol.RandomBytes(PeerTransferProtocol.ChallengeBytes);
        using var keys = PeerTransferProtocol.DeriveKeys(Pin, salt);
        var expectedProof = PeerTransferProtocol.CreateProof(keys.Authentication, challenge);
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _stop.Token);
        var remainingLifetime = ExpiresAt - DateTimeOffset.UtcNow;
        if (remainingLifetime <= TimeSpan.Zero)
        {
            ZeroSecrets(salt, challenge, expectedProof);
            StopListener();
            return new TransferResult(TransferOutcome.Expired);
        }
        lifetime.CancelAfter(remainingLifetime);

        var attempts = 0;
        try
        {
            if (_usbStream is not null)
            {
                var result = await ServeStreamAsync(_usbStream, salt, challenge, keys.Encryption, expectedProof, progress, lifetime.Token).ConfigureAwait(false);
                return new TransferResult(result == ConnectionResult.Sent ? TransferOutcome.Sent : TransferOutcome.Failed);
            }
            while (!lifetime.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await _listener!.AcceptTcpClientAsync(lifetime.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
                {
                    return CancellationResult(cancellationToken);
                }
                catch (SocketException error) when (lifetime.IsCancellationRequested || Volatile.Read(ref _disposed) != 0)
                {
                    return CancellationResult(cancellationToken, error.Message);
                }

                attempts++;
                ConnectionResult connectionResult;
                using (client)
                {
                    connectionResult = await ServeConnectionAsync(
                        client,
                        salt,
                        challenge,
                        keys.Encryption,
                        expectedProof,
                        progress,
                        lifetime.Token).ConfigureAwait(false);
                }

                if (connectionResult == ConnectionResult.Sent)
                {
                    return new TransferResult(TransferOutcome.Sent);
                }
                if (attempts >= PeerTransferProtocol.MaxAuthAttempts)
                {
                    return new TransferResult(TransferOutcome.TooManyAttempts);
                }
            }

            return CancellationResult(cancellationToken);
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested)
        {
            return CancellationResult(cancellationToken);
        }
        catch (Exception error)
        {
            return new TransferResult(TransferOutcome.Failed, error.Message);
        }
        finally
        {
            ZeroSecrets(salt, challenge, expectedProof);
            StopListener();
        }
    }

    public void Cancel()
    {
        Interlocked.Exchange(ref _cancelled, 1);
        try
        {
            _stop.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // The completed one-shot transfer has already released its cancellation source.
        }
        StopListener();
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try
        {
            _stop.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Dispose is idempotent.
        }
        StopListener();
        _stop.Dispose();
        _payload.Dispose();
        GC.SuppressFinalize(this);
    }

    private async Task<ConnectionResult> ServeConnectionAsync(
        TcpClient client,
        byte[] salt,
        byte[] challenge,
        byte[] encryptionKey,
        byte[] expectedProof,
        IProgress<TransferProgress>? progress,
        CancellationToken cancellationToken)
    {
        client.NoDelay = true;
        return await ServeStreamAsync(client.GetStream(), salt, challenge, encryptionKey, expectedProof, progress, cancellationToken).ConfigureAwait(false);
    }

    private async Task<ConnectionResult> ServeStreamAsync(Stream stream, byte[] salt, byte[] challenge, byte[] encryptionKey, byte[] expectedProof, IProgress<TransferProgress>? progress, CancellationToken cancellationToken)
    {
        using var connectionCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        var header = new byte[sizeof(int) * 3 + salt.Length + challenge.Length];
        var response = new byte[sizeof(int) * 2 + PeerTransferProtocol.ProofBytes];
        try
        {
            BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(0, sizeof(int)), PeerTransferProtocol.Magic);
            BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(sizeof(int), sizeof(int)), PeerTransferProtocol.Version);
            BinaryPrimitives.WriteInt32BigEndian(header.AsSpan(sizeof(int) * 2, sizeof(int)), PeerTransferProtocol.KdfIterations);
            salt.CopyTo(header, sizeof(int) * 3);
            challenge.CopyTo(header, sizeof(int) * 3 + salt.Length);
            await WriteAsync(stream, header, connectionCancellation.Token).ConfigureAwait(false);

            await ReadExactlyAsync(stream, response, connectionCancellation.Token).ConfigureAwait(false);
            var validHeader = BinaryPrimitives.ReadInt32BigEndian(response.AsSpan(0, sizeof(int))) == PeerTransferProtocol.Magic &&
                BinaryPrimitives.ReadInt32BigEndian(response.AsSpan(sizeof(int), sizeof(int))) == PeerTransferProtocol.Version;
            var validProof = CryptographicOperations.FixedTimeEquals(
                expectedProof,
                response.AsSpan(sizeof(int) * 2, PeerTransferProtocol.ProofBytes));
            if (!validHeader || !validProof)
            {
                await WriteAsync(stream, new byte[] { 0 }, connectionCancellation.Token).ConfigureAwait(false);
                return ConnectionResult.Rejected;
            }

            ReportProgress(progress, 0, _fileBytes);
            _payload.Position = 0;
            var nonce = PeerTransferProtocol.RandomBytes(PeerTransferProtocol.NonceBytes);
            var baseAad = PeerTransferProtocol.CreateBaseAad(challenge, _fileName, _fileBytes);
            var nameBytes = Encoding.UTF8.GetBytes(_fileName);
            var metadata = new byte[
                1 + sizeof(int) + nameBytes.Length + sizeof(long) + PeerTransferProtocol.NonceBytes + sizeof(long)];
            try
            {
                var offset = 0;
                metadata[offset++] = 1;
                BinaryPrimitives.WriteInt32BigEndian(metadata.AsSpan(offset, sizeof(int)), nameBytes.Length);
                offset += sizeof(int);
                nameBytes.CopyTo(metadata, offset);
                offset += nameBytes.Length;
                BinaryPrimitives.WriteInt64BigEndian(metadata.AsSpan(offset, sizeof(long)), _fileBytes);
                offset += sizeof(long);
                nonce.CopyTo(metadata, offset);
                offset += PeerTransferProtocol.NonceBytes;
                BinaryPrimitives.WriteInt64BigEndian(
                    metadata.AsSpan(offset, sizeof(long)),
                    PeerTransferProtocol.EncryptedPayloadBytes(_fileBytes));
                await WriteAsync(stream, metadata, connectionCancellation.Token).ConfigureAwait(false);

                await EncryptPayloadAsync(
                    stream,
                    encryptionKey,
                    nonce,
                    baseAad,
                    progress,
                    connectionCancellation.Token).ConfigureAwait(false);

                var acknowledgement = new byte[1];
                await ReadExactlyAsync(stream, acknowledgement, connectionCancellation.Token).ConfigureAwait(false);
                return acknowledgement[0] == 1 ? ConnectionResult.Sent : ConnectionResult.Failed;
            }
            finally
            {
                ZeroSecrets(nonce, baseAad, nameBytes, metadata);
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (IOException)
        {
            return ConnectionResult.Failed;
        }
        catch (SocketException)
        {
            return ConnectionResult.Failed;
        }
        catch (CryptographicException)
        {
            return ConnectionResult.Failed;
        }
        catch (TimeoutException)
        {
            return ConnectionResult.Failed;
        }
        finally
        {
            ZeroSecrets(header, response);
        }
    }

    private async Task EncryptPayloadAsync(
        Stream destination,
        byte[] encryptionKey,
        byte[] baseNonce,
        byte[] baseAad,
        IProgress<TransferProgress>? progress,
        CancellationToken cancellationToken)
    {
        var plaintext = new byte[PeerTransferProtocol.IoChunkBytes];
        var ciphertext = new byte[PeerTransferProtocol.IoChunkBytes];
        var tag = new byte[PeerTransferProtocol.GcmTagBytes];
        using var aes = new AesGcm(encryptionKey, PeerTransferProtocol.GcmTagBytes);
        long transferred = 0;
        var chunkIndex = 0;
        try
        {
            while (true)
            {
                var count = await _payload.ReadAsync(plaintext, cancellationToken).ConfigureAwait(false);
                if (count == 0) break;
                var chunkNonce = PeerTransferProtocol.CreateChunkNonce(baseNonce, chunkIndex);
                var chunkAad = PeerTransferProtocol.CreateChunkAad(baseAad, chunkIndex, count);
                try
                {
                    aes.Encrypt(
                        chunkNonce,
                        plaintext.AsSpan(0, count),
                        ciphertext.AsSpan(0, count),
                        tag,
                        chunkAad);
                    await WriteAsync(destination, ciphertext.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
                    await WriteAsync(destination, tag, cancellationToken).ConfigureAwait(false);
                }
                finally
                {
                    ZeroSecrets(chunkNonce, chunkAad);
                }

                transferred += count;
                chunkIndex++;
                ReportProgress(progress, transferred, _fileBytes);
            }
            await destination.FlushAsync(cancellationToken)
                .WaitAsync(SocketOperationTimeout, cancellationToken)
                .ConfigureAwait(false);

            if (transferred != _fileBytes)
            {
                throw new IOException("전송 중 원본 파일 크기가 달라졌습니다.");
            }
        }
        finally
        {
            ZeroSecrets(plaintext, ciphertext, tag);
        }
    }

    private static async Task WriteAsync(Stream stream, ReadOnlyMemory<byte> bytes, CancellationToken cancellationToken)
    {
        await stream.WriteAsync(bytes, cancellationToken)
            .AsTask()
            .WaitAsync(SocketOperationTimeout, cancellationToken)
            .ConfigureAwait(false);
    }

    private static async Task ReadExactlyAsync(Stream stream, Memory<byte> destination, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < destination.Length)
        {
            var count = await stream.ReadAsync(destination[offset..], cancellationToken)
                .AsTask()
                .WaitAsync(SocketOperationTimeout, cancellationToken)
                .ConfigureAwait(false);
            if (count == 0) throw new EndOfStreamException("상대 기기가 전송 연결을 종료했습니다.");
            offset += count;
        }
    }

    private TransferResult CancellationResult(CancellationToken externalToken, string? errorMessage = null)
    {
        var cancelled = Volatile.Read(ref _cancelled) != 0 || externalToken.IsCancellationRequested;
        return cancelled
            ? new TransferResult(TransferOutcome.Cancelled)
            : new TransferResult(TransferOutcome.Expired, errorMessage);
    }

    private static void ReportProgress(IProgress<TransferProgress>? progress, long transferred, long total)
    {
        try
        {
            progress?.Report(new TransferProgress(transferred, total));
        }
        catch (Exception)
        {
            // UI progress reporting must never corrupt or abort the encrypted transfer.
        }
    }

    private void StopListener()
    {
        try
        {
            _listener?.Stop();
        }
        catch (Exception) when (Volatile.Read(ref _disposed) != 0 || _stop.IsCancellationRequested)
        {
            // A completed or cancelled one-shot listener is already closed.
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
    }

    private static void ZeroSecrets(params byte[][] buffers)
    {
        foreach (var buffer in buffers) CryptographicOperations.ZeroMemory(buffer);
    }

    private enum ConnectionResult
    {
        Sent,
        Rejected,
        Failed,
    }
}
