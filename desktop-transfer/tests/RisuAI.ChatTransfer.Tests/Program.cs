using System.Buffers.Binary;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RisuAI.ChatTransfer.Core;

namespace RisuAI.ChatTransfer.Tests;

internal static partial class Program
{
    private static readonly List<(string Name, Func<Task> Run)> Tests =
    [
        ("bundled ADB extraction and repair", TestBundledAdbAsync),
        ("USB device filtering", TestUsbDevicesAsync),
        ("USB handshake guards", TestUsbHandshakeAsync),
        ("USB stream JSON and PNG round trips", TestUsbStreamsAsync),
        ("protocol known vector", TestProtocolKnownVectorAsync),
        ("address and filename guards", TestGuardsAsync),
        ("receiver endpoint guards", TestEndpointGuardsAsync),
        ("risuChat v2 validation", TestValidationAsync),
        ("persona PNG validation and encrypted round trip", TestPersonaRoundTripAsync),
        ("wrong PIN then encrypted round trip", TestRoundTripAsync),
        ("production receiver and collision-safe save", TestProductionReceiverAsync),
        ("cancel and expiry", TestCancelAndExpiryAsync),
    ];

    private static async Task<int> Main(string[] args)
    {
        if (args.Length == 3 && args[0].Equals("device-server", StringComparison.Ordinal))
        {
            return await RunDeviceServerAsync(args[1], args[2]).ConfigureAwait(false);
        }
        if (args.Length == 6 && args[0].Equals("device-client", StringComparison.Ordinal))
        {
            return await RunDeviceClientAsync(args[1], args[2], args[3], args[4], args[5]).ConfigureAwait(false);
        }

        var failed = 0;
        foreach (var test in Tests)
        {
            try
            {
                await test.Run().ConfigureAwait(false);
                Console.WriteLine($"PASS  {test.Name}");
            }
            catch (Exception error)
            {
                failed++;
                Console.Error.WriteLine($"FAIL  {test.Name}: {error}");
            }
        }

        Console.WriteLine($"RESULT  {Tests.Count - failed}/{Tests.Count} passed");
        return failed == 0 ? 0 : 1;
    }

    private static async Task<int> RunDeviceClientAsync(
        string endpointText,
        string pin,
        string outputDirectory,
        string expectedSha256,
        string expectedName)
    {
        try
        {
            var endpoint = PeerEndpointParser.Parse(endpointText);
            using var client = new PeerTransferClient(endpoint, pin);
            using var received = await client.ReceiveAndSaveAsync(outputDirectory).ConfigureAwait(false);
            Equal(expectedName, received.Info.TransferFileName, "device file name");
            await using var hashStream = File.OpenRead(received.Info.FullPath);
            var sha256 = Convert.ToHexString(await SHA256.HashDataAsync(hashStream).ConfigureAwait(false));
            Equal(expectedSha256.ToUpperInvariant(), sha256, "device SHA-256");
            var savedPath = received.SavedPath ?? throw new InvalidOperationException("Device receive did not save the file.");
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                state = "complete",
                file = savedPath,
                bytes = received.Info.Bytes,
                sha256,
            }));
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 5;
        }
    }

    private static async Task<int> RunDeviceServerAsync(string payloadPath, string bindAddressText)
    {
        if (!IPAddress.TryParse(bindAddressText, out var bindAddress) ||
            (!PeerTransferProtocol.IsAllowedPeerAddress(bindAddress) && !IPAddress.IsLoopback(bindAddress)))
        {
            Console.Error.WriteLine("Device server requires an allowed private or Tailscale IPv4 address.");
            return 2;
        }

        try
        {
            var file = await ChatFileValidator.ValidateAsync(payloadPath).ConfigureAwait(false);
            await using var hashStream = File.OpenRead(file.FullPath);
            var sha256 = Convert.ToHexString(await SHA256.HashDataAsync(hashStream).ConfigureAwait(false));
            using var server = new OneShotChatServer(
                file.FullPath,
                file.TransferFileName,
                bindAddress,
                allowLoopbackForTesting: IPAddress.IsLoopback(bindAddress),
                sessionLifetime: null);
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                state = "ready",
                address = server.DisplayAddress,
                pin = server.Pin,
                expiresAt = server.ExpiresAt,
                bytes = file.Bytes,
                sha256,
            }));
            Console.Out.Flush();
            var result = await server.ServeAsync().ConfigureAwait(false);
            Console.WriteLine(JsonSerializer.Serialize(new { state = "complete", outcome = result.Outcome.ToString() }));
            return result.Outcome == TransferOutcome.Sent ? 0 : 3;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            return 4;
        }
    }

    private static Task TestProtocolKnownVectorAsync()
    {
        const string pin = "0123456789";
        var salt = Enumerable.Range(0, 16).Select(value => (byte)value).ToArray();
        var challenge = Enumerable.Range(32, 32).Select(value => (byte)value).ToArray();
        using var keys = PeerTransferProtocol.DeriveKeys(pin, salt);
        Equal(
            "ff648d0edb22a278aba6e4aacfbb4692d2057ff12ae46669cb06106a4ad7bc9a",
            Convert.ToHexString(keys.Authentication).ToLowerInvariant(),
            "authentication key");
        Equal(
            "9dcfe828e5972c68f313ceab298ac7af40b1e4f9b025aa4e35bad2e75074ece3",
            Convert.ToHexString(keys.Encryption).ToLowerInvariant(),
            "encryption key");
        Equal(
            "80911cadf82905e9858d3641ab581ccb533765276fce8675c13b3a9c81bb843b",
            Convert.ToHexString(PeerTransferProtocol.CreateProof(keys.Authentication, challenge)).ToLowerInvariant(),
            "proof");
        Equal(
            "5250543100000001202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f000000000008001100000015323032362d30392d30345f31322d33342e6a736f6e",
            Convert.ToHexString(PeerTransferProtocol.CreateBaseAad(challenge, "2026-09-04_12-34.json", 524_305)).ToLowerInvariant(),
            "base AAD");
        Equal(
            "404142434445464748494a49",
            Convert.ToHexString(PeerTransferProtocol.CreateChunkNonce(
                Enumerable.Range(64, 12).Select(value => (byte)value).ToArray(),
                2)).ToLowerInvariant(),
            "chunk nonce");
        Equal(524_353L, PeerTransferProtocol.EncryptedPayloadBytes(524_305), "wire payload size");
        for (var index = 0; index < 100; index++)
        {
            True(PeerTransferProtocol.IsValidPin(PeerTransferProtocol.GeneratePin()), "generated PIN");
        }
        return Task.CompletedTask;
    }

    private static Task TestGuardsAsync()
    {
        foreach (var allowed in new[] { "10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.2", "100.64.0.1", "100.127.255.254" })
        {
            True(PeerTransferProtocol.IsAllowedPeerAddress(IPAddress.Parse(allowed)), $"allowed address {allowed}");
        }
        foreach (var blocked in new[] { "127.0.0.1", "169.254.1.1", "172.32.0.1", "100.128.0.1", "8.8.8.8", "224.0.0.1" })
        {
            True(!PeerTransferProtocol.IsAllowedPeerAddress(IPAddress.Parse(blocked)), $"blocked address {blocked}");
        }
        Equal("_bad_name_.json", PeerTransferProtocol.SanitizeJsonFileName("../bad:name?.json"), "safe file name");
        Equal("_bad_name_.png", PeerTransferProtocol.SanitizeTransferFileName("../bad:name?.png"), "safe persona file name");
        Throws<InvalidDataException>(() => PeerTransferProtocol.SanitizeTransferFileName("unexpected.bin"));
        var boundedName = PeerTransferProtocol.SanitizeJsonFileName(new string('가', 180) + ".json");
        True(Encoding.UTF8.GetByteCount(boundedName) <= PeerTransferProtocol.MaxFileNameBytes, "bounded UTF-8 file name");
        True(boundedName.EndsWith(".json", StringComparison.Ordinal), "JSON extension after truncation");
        True(PeerTransferProtocol.IsTailscaleAddress(IPAddress.Parse("100.100.10.20")), "Tailscale address");
        return Task.CompletedTask;
    }

    private static async Task TestPersonaRoundTripAsync()
    {
        var directory = CreateTempDirectory();
        try
        {
            var personaPath = Path.Combine(directory, "함건희_export.png");
            var personaBytes = BuildPersonaPng("함건희", "모험가 페르소나 설명", "식별 노트");
            await File.WriteAllBytesAsync(personaPath, personaBytes).ConfigureAwait(false);
            var info = await ChatFileValidator.ValidateAsync(personaPath).ConfigureAwait(false);
            Equal(TransferPayloadKind.Persona, info.Kind, "persona payload kind");
            Equal("함건희", info.PersonaName ?? string.Empty, "persona name");
            Equal(11, info.PersonaPromptCharacters, "persona prompt length");
            True(info.PersonaHasNote, "persona note detection");

            var noMetadataPath = Path.Combine(directory, "plain.png");
            await File.WriteAllBytesAsync(noMetadataPath, GetBasePng()).ConfigureAwait(false);
            await ThrowsAsync<InvalidDataException>(() => ChatFileValidator.ValidateAsync(noMetadataPath)).ConfigureAwait(false);

            var tamperedPath = Path.Combine(directory, "tampered.png");
            var tampered = personaBytes.ToArray();
            tampered[^5] ^= 0x01;
            await File.WriteAllBytesAsync(tamperedPath, tampered).ConfigureAwait(false);
            await ThrowsAsync<InvalidDataException>(() => ChatFileValidator.ValidateAsync(tamperedPath)).ConfigureAwait(false);

            using var server = new OneShotChatServer(
                personaPath,
                Path.GetFileName(personaPath),
                IPAddress.Loopback,
                allowLoopbackForTesting: true,
                sessionLifetime: TimeSpan.FromSeconds(30));
            var serverTask = server.ServeAsync();
            var endpoint = new PeerEndpoint("fixture.tail.ts.net", server.Port);
            static Task<IPAddress[]> ResolveLoopback(string _, CancellationToken __) =>
                Task.FromResult(new[] { IPAddress.Loopback });

            using var client = new PeerTransferClient(endpoint, server.Pin, ResolveLoopback, allowLoopbackForTesting: true);
            using var received = await client.ReceiveAsync().ConfigureAwait(false);
            Equal(TransferPayloadKind.Persona, received.Info.Kind, "received persona payload kind");
            Equal("함건희_export.png", received.Info.TransferFileName, "received persona file name");
            var receivedBytes = await File.ReadAllBytesAsync(received.Info.FullPath).ConfigureAwait(false);
            True(personaBytes.AsSpan().SequenceEqual(receivedBytes), "received persona bytes");
            var saved = await received.SaveToDirectoryAsync(directory).ConfigureAwait(false);
            Equal("함건희_export (1).png", Path.GetFileName(saved), "persona collision-safe name");
            var result = await serverTask.WaitAsync(TimeSpan.FromSeconds(30)).ConfigureAwait(false);
            Equal(TransferOutcome.Sent, result.Outcome, "persona server outcome");
        }
        finally
        {
            SafeDeleteTempDirectory(directory);
        }
    }

    private static Task TestEndpointGuardsAsync()
    {
        Equal(new PeerEndpoint("192.168.50.92", 45123), PeerEndpointParser.Parse(" 192.168.50.92:45123 "), "private endpoint");
        Equal(new PeerEndpoint("tablet.tail123.ts.net", 65535), PeerEndpointParser.Parse("TABLET.tail123.ts.net:65535"), "Tailscale DNS endpoint");
        foreach (var blocked in new[]
        {
            "8.8.8.8:45123", "127.0.0.1:45123", "192.168.0.2:80", "https://192.168.0.2:45123",
            "device.example.com:45123", "bad_.tail.ts.net:45123", "192.168.001.2:45123", "192.168.0.2:45123/path",
        })
        {
            Throws<ArgumentException>(() => PeerEndpointParser.Parse(blocked));
        }
        return Task.CompletedTask;
    }

    private static async Task TestValidationAsync()
    {
        var directory = CreateTempDirectory();
        try
        {
            var validPath = Path.Combine(directory, "chat.json");
            var valid = new
            {
                type = "risuChat",
                ver = 2,
                data = new
                {
                    name = "Test Chat",
                    message = new[]
                    {
                        new { role = "user", data = "hello {{inlay::image-a}}" },
                        new { role = "char", data = "world {{inlayed::image-a}} {{inlayeddata::image-b}}" },
                    },
                },
                folders = Array.Empty<object>(),
                privateMobileChatSync = new { characterName = "Test Character" },
            };
            await File.WriteAllTextAsync(validPath, JsonSerializer.Serialize(valid), Encoding.UTF8).ConfigureAwait(false);
            var info = await ChatFileValidator.ValidateAsync(validPath).ConfigureAwait(false);
            Equal(2, info.MessageCount, "message count");
            Equal(2, info.ReferencedInlayCount, "inlay count");
            Equal("Test Chat", info.ChatName, "chat name");
            True(info.CharacterName == "Test Character", "character name");

            var singleAllChatsPath = Path.Combine(directory, "single-all.json");
            await File.WriteAllTextAsync(
                singleAllChatsPath,
                "{\"type\":\"risuAllChats\",\"ver\":2,\"data\":[{\"name\":\"Only Chat\",\"message\":[{\"role\":\"user\",\"data\":\"hello\"}]}],\"folders\":[]}",
                Encoding.UTF8)
                .ConfigureAwait(false);
            var singleAllChatsInfo = await ChatFileValidator.ValidateAsync(singleAllChatsPath).ConfigureAwait(false);
            Equal(1, singleAllChatsInfo.MessageCount, "single all-chat message count");
            Equal("Only Chat", singleAllChatsInfo.ChatName, "single all-chat name");

            var allChatsPath = Path.Combine(directory, "multiple-all.json");
            await File.WriteAllTextAsync(
                allChatsPath,
                "{\"type\":\"risuAllChats\",\"ver\":2,\"data\":[{\"name\":\"Chat 1\"},{\"name\":\"Chat 2\"}]}",
                Encoding.UTF8)
                .ConfigureAwait(false);
            var allChatsError = await ThrowsAsync<InvalidDataException>(
                () => ChatFileValidator.ValidateAsync(allChatsPath)).ConfigureAwait(false);
            True(allChatsError.Message.Contains("대화 2개", StringComparison.Ordinal), "all-chat count guidance");
            True(allChatsError.Message.Contains("대화 행 오른쪽의 ↓", StringComparison.Ordinal), "single-chat export guidance");

            var unsafePath = Path.Combine(directory, "unsafe.json");
            await File.WriteAllTextAsync(
                unsafePath,
                "{\"type\":\"risuChat\",\"ver\":2,\"data\":{\"message\":[],\"__proto__\":{}}}",
                Encoding.UTF8).ConfigureAwait(false);
            await ThrowsAsync<InvalidDataException>(() => ChatFileValidator.ValidateAsync(unsafePath)).ConfigureAwait(false);
        }
        finally
        {
            SafeDeleteTempDirectory(directory);
        }
    }

    private static async Task TestRoundTripAsync()
    {
        var directory = CreateTempDirectory();
        try
        {
            var payloadPath = Path.Combine(directory, "2026-09-04_12-34.json");
            var json = JsonSerializer.Serialize(new
            {
                type = "risuChat",
                ver = 2,
                data = new
                {
                    name = "Large Chat",
                    message = new[] { new { role = "user", data = new string('x', 700_000) } },
                },
                folders = Array.Empty<object>(),
            });
            await File.WriteAllTextAsync(payloadPath, json, new UTF8Encoding(false)).ConfigureAwait(false);
            var expected = await File.ReadAllBytesAsync(payloadPath).ConfigureAwait(false);
            using var server = new OneShotChatServer(
                payloadPath,
                Path.GetFileName(payloadPath),
                IPAddress.Loopback,
                allowLoopbackForTesting: true,
                sessionLifetime: TimeSpan.FromSeconds(20));
            var progressEvents = new List<TransferProgress>();
            var serverTask = server.ServeAsync(new InlineProgress<TransferProgress>(progressEvents.Add));

            var rejected = await ReceiveAsync(server.Port, "9999999999", acknowledge: false).ConfigureAwait(false);
            True(rejected is null, "wrong PIN rejection");
            var received = await ReceiveAsync(server.Port, server.Pin, acknowledge: true).ConfigureAwait(false);
            True(received is not null, "authenticated receive");
            True(expected.AsSpan().SequenceEqual(received), "decrypted bytes");

            var result = await serverTask.WaitAsync(TimeSpan.FromSeconds(20)).ConfigureAwait(false);
            Equal(TransferOutcome.Sent, result.Outcome, "server outcome");
            True(progressEvents.Count >= 3, "chunk progress events");
            Equal(expected.LongLength, progressEvents[^1].TransferredBytes, "final progress");
        }
        finally
        {
            SafeDeleteTempDirectory(directory);
        }
    }

    private static async Task TestProductionReceiverAsync()
    {
        var directory = CreateTempDirectory();
        try
        {
            var payloadPath = Path.Combine(directory, "2026-09-04_12-34.json");
            var json = JsonSerializer.Serialize(new
            {
                type = "risuChat",
                ver = 2,
                data = new
                {
                    name = "Bidirectional Chat",
                    message = new[]
                    {
                        new { role = "user", data = new string('가', 300_000) },
                        new { role = "char", data = "reply" },
                    },
                },
                folders = Array.Empty<object>(),
            });
            await File.WriteAllTextAsync(payloadPath, json, new UTF8Encoding(false)).ConfigureAwait(false);
            var expected = await File.ReadAllBytesAsync(payloadPath).ConfigureAwait(false);
            using var server = new OneShotChatServer(
                payloadPath,
                Path.GetFileName(payloadPath),
                IPAddress.Loopback,
                allowLoopbackForTesting: true,
                sessionLifetime: TimeSpan.FromSeconds(30));
            var serverProgress = new List<TransferProgress>();
            var serverTask = server.ServeAsync(new InlineProgress<TransferProgress>(serverProgress.Add));
            var endpoint = new PeerEndpoint("fixture.tail.ts.net", server.Port);
            static Task<IPAddress[]> ResolveLoopback(string _, CancellationToken __) =>
                Task.FromResult(new[] { IPAddress.Loopback });

            using (var rejectedClient = new PeerTransferClient(
                endpoint, "9999999999", ResolveLoopback, allowLoopbackForTesting: true))
            {
                await ThrowsAsync<UnauthorizedAccessException>(() => rejectedClient.ReceiveAsync()).ConfigureAwait(false);
            }

            var clientProgress = new List<TransferProgress>();
            using (var client = new PeerTransferClient(
                endpoint, server.Pin, ResolveLoopback, allowLoopbackForTesting: true))
            using (var received = await client.ReceiveAsync(new InlineProgress<TransferProgress>(clientProgress.Add)).ConfigureAwait(false))
            {
                Equal("2026-09-04_12-34.json", received.Info.TransferFileName, "received transfer name");
                Equal(2, received.Info.MessageCount, "received message count");
                var receivedBytes = await File.ReadAllBytesAsync(received.Info.FullPath).ConfigureAwait(false);
                True(expected.AsSpan().SequenceEqual(receivedBytes), "production receiver bytes");

                var first = await received.SaveToDirectoryAsync(directory).ConfigureAwait(false);
                var second = await received.SaveToDirectoryAsync(directory).ConfigureAwait(false);
                Equal("2026-09-04_12-34 (1).json", Path.GetFileName(first), "first collision-safe name");
                Equal("2026-09-04_12-34 (2).json", Path.GetFileName(second), "second collision-safe name");
                var savedBytes = await File.ReadAllBytesAsync(second).ConfigureAwait(false);
                True(expected.AsSpan().SequenceEqual(savedBytes), "saved receiver bytes");
            }

            var result = await serverTask.WaitAsync(TimeSpan.FromSeconds(30)).ConfigureAwait(false);
            Equal(TransferOutcome.Sent, result.Outcome, "receiver server outcome");
            Equal(expected.LongLength, clientProgress[^1].TransferredBytes, "receiver final progress");
            Equal(expected.LongLength, serverProgress[^1].TransferredBytes, "sender final progress");
        }
        finally
        {
            SafeDeleteTempDirectory(directory);
        }
    }

    private static async Task TestCancelAndExpiryAsync()
    {
        var directory = CreateTempDirectory();
        try
        {
            var payloadPath = Path.Combine(directory, "chat.json");
            await File.WriteAllTextAsync(
                payloadPath,
                "{\"type\":\"risuChat\",\"ver\":2,\"data\":{\"message\":[]}}",
                Encoding.UTF8).ConfigureAwait(false);

            using (var cancelledServer = new OneShotChatServer(
                payloadPath,
                "chat.json",
                IPAddress.Loopback,
                allowLoopbackForTesting: true,
                sessionLifetime: TimeSpan.FromSeconds(5)))
            {
                var resultTask = cancelledServer.ServeAsync();
                cancelledServer.Cancel();
                var result = await resultTask.WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
                Equal(TransferOutcome.Cancelled, result.Outcome, "cancel outcome");
            }

            using (var expiredServer = new OneShotChatServer(
                payloadPath,
                "chat.json",
                IPAddress.Loopback,
                allowLoopbackForTesting: true,
                sessionLifetime: TimeSpan.FromMilliseconds(150)))
            {
                var result = await expiredServer.ServeAsync().WaitAsync(TimeSpan.FromSeconds(5)).ConfigureAwait(false);
                Equal(TransferOutcome.Expired, result.Outcome, "expiry outcome");
            }
        }
        finally
        {
            SafeDeleteTempDirectory(directory);
        }
    }

    private static async Task<byte[]?> ReceiveAsync(int port, string pin, bool acknowledge)
    {
        using var cancellation = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        using var client = new TcpClient(AddressFamily.InterNetwork) { NoDelay = true };
        await client.ConnectAsync(IPAddress.Loopback, port, cancellation.Token).ConfigureAwait(false);
        var stream = client.GetStream();

        var header = new byte[sizeof(int) * 3 + PeerTransferProtocol.SaltBytes + PeerTransferProtocol.ChallengeBytes];
        await ReadExactlyAsync(stream, header, cancellation.Token).ConfigureAwait(false);
        Equal(PeerTransferProtocol.Magic, BinaryPrimitives.ReadInt32BigEndian(header), "server magic");
        Equal(PeerTransferProtocol.Version, BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(4)), "server version");
        var iterations = BinaryPrimitives.ReadInt32BigEndian(header.AsSpan(8));
        Equal(PeerTransferProtocol.KdfIterations, iterations, "KDF iterations");
        var salt = header.AsSpan(12, PeerTransferProtocol.SaltBytes).ToArray();
        var challenge = header.AsSpan(12 + PeerTransferProtocol.SaltBytes, PeerTransferProtocol.ChallengeBytes).ToArray();
        using var keys = PeerTransferProtocol.DeriveKeys(pin, salt, iterations);
        var proof = PeerTransferProtocol.CreateProof(keys.Authentication, challenge);
        var request = new byte[sizeof(int) * 2 + proof.Length];
        BinaryPrimitives.WriteInt32BigEndian(request, PeerTransferProtocol.Magic);
        BinaryPrimitives.WriteInt32BigEndian(request.AsSpan(4), PeerTransferProtocol.Version);
        proof.CopyTo(request, 8);
        await stream.WriteAsync(request, cancellation.Token).ConfigureAwait(false);

        var status = new byte[1];
        await ReadExactlyAsync(stream, status, cancellation.Token).ConfigureAwait(false);
        if (status[0] == 0) return null;
        Equal((byte)1, status[0], "authentication status");

        var intBuffer = new byte[sizeof(int)];
        await ReadExactlyAsync(stream, intBuffer, cancellation.Token).ConfigureAwait(false);
        var nameLength = BinaryPrimitives.ReadInt32BigEndian(intBuffer);
        True(nameLength is >= 1 and <= PeerTransferProtocol.MaxFileNameBytes, "file name length");
        var nameBytes = new byte[nameLength];
        await ReadExactlyAsync(stream, nameBytes, cancellation.Token).ConfigureAwait(false);
        var fileName = Encoding.UTF8.GetString(nameBytes);
        Equal("2026-09-04_12-34.json", fileName, "file name");

        var longBuffer = new byte[sizeof(long)];
        await ReadExactlyAsync(stream, longBuffer, cancellation.Token).ConfigureAwait(false);
        var fileBytes = BinaryPrimitives.ReadInt64BigEndian(longBuffer);
        var nonce = new byte[PeerTransferProtocol.NonceBytes];
        await ReadExactlyAsync(stream, nonce, cancellation.Token).ConfigureAwait(false);
        await ReadExactlyAsync(stream, longBuffer, cancellation.Token).ConfigureAwait(false);
        var encryptedBytes = BinaryPrimitives.ReadInt64BigEndian(longBuffer);
        Equal(PeerTransferProtocol.EncryptedPayloadBytes(fileBytes), encryptedBytes, "encrypted payload size");

        var baseAad = PeerTransferProtocol.CreateBaseAad(challenge, fileName, fileBytes);
        using var output = new MemoryStream(checked((int)fileBytes));
        using var aes = new AesGcm(keys.Encryption, PeerTransferProtocol.GcmTagBytes);
        long remaining = fileBytes;
        long consumed = 0;
        var chunkIndex = 0;
        while (remaining > 0)
        {
            var count = (int)Math.Min(PeerTransferProtocol.IoChunkBytes, remaining);
            var encrypted = new byte[count + PeerTransferProtocol.GcmTagBytes];
            await ReadExactlyAsync(stream, encrypted, cancellation.Token).ConfigureAwait(false);
            var plaintext = new byte[count];
            var chunkNonce = PeerTransferProtocol.CreateChunkNonce(nonce, chunkIndex);
            var chunkAad = PeerTransferProtocol.CreateChunkAad(baseAad, chunkIndex, count);
            aes.Decrypt(
                chunkNonce,
                encrypted.AsSpan(0, count),
                encrypted.AsSpan(count, PeerTransferProtocol.GcmTagBytes),
                plaintext,
                chunkAad);
            await output.WriteAsync(plaintext, cancellation.Token).ConfigureAwait(false);
            CryptographicOperations.ZeroMemory(encrypted);
            CryptographicOperations.ZeroMemory(plaintext);
            CryptographicOperations.ZeroMemory(chunkNonce);
            CryptographicOperations.ZeroMemory(chunkAad);
            remaining -= count;
            consumed += count + PeerTransferProtocol.GcmTagBytes;
            chunkIndex++;
        }
        Equal(encryptedBytes, consumed, "consumed encrypted bytes");
        if (acknowledge)
        {
            await stream.WriteAsync(new byte[] { 1 }, cancellation.Token).ConfigureAwait(false);
            await stream.FlushAsync(cancellation.Token).ConfigureAwait(false);
        }
        CryptographicOperations.ZeroMemory(header);
        CryptographicOperations.ZeroMemory(salt);
        CryptographicOperations.ZeroMemory(challenge);
        CryptographicOperations.ZeroMemory(proof);
        CryptographicOperations.ZeroMemory(request);
        CryptographicOperations.ZeroMemory(nonce);
        CryptographicOperations.ZeroMemory(baseAad);
        return output.ToArray();
    }

    private static async Task ReadExactlyAsync(Stream stream, Memory<byte> buffer, CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < buffer.Length)
        {
            var count = await stream.ReadAsync(buffer[offset..], cancellationToken).ConfigureAwait(false);
            if (count == 0) throw new EndOfStreamException();
            offset += count;
        }
    }

    private static byte[] BuildPersonaPng(string name, string prompt, string note)
    {
        var png = GetBasePng();
        var personaJson = JsonSerializer.SerializeToUtf8Bytes(new { name, personaPrompt = prompt, note });
        var text = Encoding.ASCII.GetBytes("persona\0" + Convert.ToBase64String(personaJson));
        using var output = new MemoryStream(png.Length + text.Length + 12);
        output.Write(png, 0, png.Length - 12);
        WritePngChunk(output, "tEXt", text);
        output.Write(png, png.Length - 12, 12);
        return output.ToArray();
    }

    private static byte[] GetBasePng() => Convert.FromBase64String(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");

    private static void WritePngChunk(Stream destination, string type, byte[] data)
    {
        var header = new byte[8];
        BinaryPrimitives.WriteUInt32BigEndian(header.AsSpan(0, 4), checked((uint)data.Length));
        Encoding.ASCII.GetBytes(type).CopyTo(header, 4);
        destination.Write(header);
        destination.Write(data);
        var crcInput = header.AsSpan(4, 4).ToArray().Concat(data).ToArray();
        var crc = new byte[4];
        BinaryPrimitives.WriteUInt32BigEndian(crc, ComputeCrc32(crcInput));
        destination.Write(crc);
    }

    private static uint ComputeCrc32(ReadOnlySpan<byte> data)
    {
        var state = uint.MaxValue;
        foreach (var value in data)
        {
            state ^= value;
            for (var bit = 0; bit < 8; bit++)
            {
                state = (state & 1) != 0 ? (state >> 1) ^ 0xedb88320u : state >> 1;
            }
        }
        return ~state;
    }

    private static string CreateTempDirectory()
    {
        var root = Path.GetFullPath(Path.GetTempPath());
        var directory = Path.Combine(root, $"risu-chat-transfer-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        return directory;
    }

    private static void SafeDeleteTempDirectory(string directory)
    {
        var root = Path.GetFullPath(Path.GetTempPath());
        var target = Path.GetFullPath(directory);
        if (!target.StartsWith(root, StringComparison.OrdinalIgnoreCase) ||
            !Path.GetFileName(target).StartsWith("risu-chat-transfer-tests-", StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Refusing to remove a directory outside the test temp root.");
        }
        if (Directory.Exists(target)) Directory.Delete(target, recursive: true);
    }

    private static async Task<TException> ThrowsAsync<TException>(Func<Task> operation) where TException : Exception
    {
        try
        {
            await operation().ConfigureAwait(false);
        }
        catch (TException error)
        {
            return error;
        }
        throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
    }

    private static void Throws<TException>(Action operation) where TException : Exception
    {
        try
        {
            operation();
        }
        catch (TException)
        {
            return;
        }
        throw new InvalidOperationException($"Expected {typeof(TException).Name}.");
    }

    private static void True(bool condition, string label)
    {
        if (!condition) throw new InvalidOperationException($"Assertion failed: {label}");
    }

    private static void Equal<T>(T expected, T actual, string label) where T : notnull
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"Assertion failed: {label}; expected={expected}; actual={actual}");
        }
    }

    private sealed class InlineProgress<T>(Action<T> report) : IProgress<T>
    {
        public void Report(T value) => report(value);
    }
}
