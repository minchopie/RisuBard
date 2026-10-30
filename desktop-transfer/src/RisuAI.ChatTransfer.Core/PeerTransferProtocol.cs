using System.Buffers.Binary;
using System.Net;
using System.Security.Cryptography;
using System.Text;

namespace RisuAI.ChatTransfer.Core;

public sealed class PeerKeys : IDisposable
{
    public PeerKeys(byte[] authentication, byte[] encryption)
    {
        Authentication = authentication;
        Encryption = encryption;
    }

    public byte[] Authentication { get; }
    public byte[] Encryption { get; }

    public void Dispose()
    {
        CryptographicOperations.ZeroMemory(Authentication);
        CryptographicOperations.ZeroMemory(Encryption);
    }
}

public static class PeerTransferProtocol
{
    public const int Magic = 0x52505431;
    public const int Version = 1;
    public const int KdfIterations = 310_000;
    public const long MaxFileBytes = 64L * 1024L * 1024L;
    public const int MaxAuthAttempts = 5;
    public const int SaltBytes = 16;
    public const int ChallengeBytes = 32;
    public const int ProofBytes = 32;
    public const int NonceBytes = 12;
    public const int GcmTagBytes = 16;
    public const int IoChunkBytes = 256 * 1024;
    public const int MaxFileNameBytes = 240;
    public static readonly TimeSpan SessionLifetime = TimeSpan.FromMinutes(5);

    private static readonly byte[] ProofLabel =
        Encoding.UTF8.GetBytes("RisuAI-Mobile-Private/chat-request/v1");

    public static string GeneratePin()
    {
        Span<char> digits = stackalloc char[10];
        for (var index = 0; index < digits.Length; index++)
        {
            digits[index] = (char)('0' + RandomNumberGenerator.GetInt32(10));
        }
        return new string(digits);
    }

    public static bool IsValidPin(string? pin) =>
        pin is { Length: 10 } && pin.All(character => character is >= '0' and <= '9');

    public static byte[] RandomBytes(int count) => RandomNumberGenerator.GetBytes(count);

    public static PeerKeys DeriveKeys(string pin, ReadOnlySpan<byte> salt, int iterations = KdfIterations)
    {
        ArgumentException.ThrowIfNullOrEmpty(pin);
        if (!IsValidPin(pin)) throw new ArgumentException("PIN must contain exactly 10 digits.", nameof(pin));
        if (salt.Length != SaltBytes) throw new ArgumentException("Invalid transfer salt.", nameof(salt));
        if (iterations is < 100_000 or > 1_000_000)
        {
            throw new ArgumentOutOfRangeException(nameof(iterations), "Invalid key derivation cost.");
        }

        var passwordBytes = Encoding.UTF8.GetBytes(pin);
        var material = new byte[64];
        try
        {
            Rfc2898DeriveBytes.Pbkdf2(
                passwordBytes,
                salt,
                material,
                iterations,
                HashAlgorithmName.SHA256);
            return new PeerKeys(material[..32], material[32..]);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(passwordBytes);
            CryptographicOperations.ZeroMemory(material);
        }
    }

    public static byte[] CreateProof(ReadOnlySpan<byte> authenticationKey, ReadOnlySpan<byte> challenge)
    {
        if (authenticationKey.Length != 32) throw new ArgumentException("Invalid authentication key.");
        if (challenge.Length != ChallengeBytes) throw new ArgumentException("Invalid transfer challenge.");

        var input = new byte[ProofLabel.Length + sizeof(int) + sizeof(int) + ChallengeBytes];
        try
        {
            var offset = 0;
            ProofLabel.CopyTo(input, offset);
            offset += ProofLabel.Length;
            BinaryPrimitives.WriteInt32BigEndian(input.AsSpan(offset, sizeof(int)), Magic);
            offset += sizeof(int);
            BinaryPrimitives.WriteInt32BigEndian(input.AsSpan(offset, sizeof(int)), Version);
            offset += sizeof(int);
            challenge.CopyTo(input.AsSpan(offset));

            using var hmac = new HMACSHA256(authenticationKey.ToArray());
            return hmac.ComputeHash(input);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(input);
        }
    }

    public static byte[] CreateBaseAad(ReadOnlySpan<byte> challenge, string fileName, long fileBytes)
    {
        if (challenge.Length != ChallengeBytes) throw new ArgumentException("Invalid transfer challenge.");
        if (fileBytes is < 1 or > MaxFileBytes) throw new ArgumentOutOfRangeException(nameof(fileBytes));
        var nameBytes = Encoding.UTF8.GetBytes(fileName);
        if (nameBytes.Length is < 1 or > MaxFileNameBytes)
        {
            throw new ArgumentException("Invalid transfer file name.", nameof(fileName));
        }

        var result = new byte[sizeof(int) + sizeof(int) + ChallengeBytes + sizeof(long) + sizeof(int) + nameBytes.Length];
        var offset = 0;
        BinaryPrimitives.WriteInt32BigEndian(result.AsSpan(offset, sizeof(int)), Magic);
        offset += sizeof(int);
        BinaryPrimitives.WriteInt32BigEndian(result.AsSpan(offset, sizeof(int)), Version);
        offset += sizeof(int);
        challenge.CopyTo(result.AsSpan(offset));
        offset += ChallengeBytes;
        BinaryPrimitives.WriteInt64BigEndian(result.AsSpan(offset, sizeof(long)), fileBytes);
        offset += sizeof(long);
        BinaryPrimitives.WriteInt32BigEndian(result.AsSpan(offset, sizeof(int)), nameBytes.Length);
        offset += sizeof(int);
        nameBytes.CopyTo(result, offset);
        CryptographicOperations.ZeroMemory(nameBytes);
        return result;
    }

    public static byte[] CreateChunkAad(ReadOnlySpan<byte> baseAad, int chunkIndex, int plaintextBytes)
    {
        if (chunkIndex < 0) throw new ArgumentOutOfRangeException(nameof(chunkIndex));
        if (plaintextBytes is < 1 or > IoChunkBytes) throw new ArgumentOutOfRangeException(nameof(plaintextBytes));

        var result = new byte[baseAad.Length + sizeof(int) + sizeof(int)];
        baseAad.CopyTo(result);
        BinaryPrimitives.WriteInt32BigEndian(result.AsSpan(baseAad.Length, sizeof(int)), chunkIndex);
        BinaryPrimitives.WriteInt32BigEndian(result.AsSpan(baseAad.Length + sizeof(int), sizeof(int)), plaintextBytes);
        return result;
    }

    public static byte[] CreateChunkNonce(ReadOnlySpan<byte> baseNonce, int chunkIndex)
    {
        if (baseNonce.Length != NonceBytes) throw new ArgumentException("Invalid transfer nonce.");
        if (chunkIndex < 0) throw new ArgumentOutOfRangeException(nameof(chunkIndex));

        var nonce = baseNonce.ToArray();
        var offset = NonceBytes - sizeof(int);
        var counter = BinaryPrimitives.ReadInt32BigEndian(nonce.AsSpan(offset, sizeof(int)));
        BinaryPrimitives.WriteInt32BigEndian(nonce.AsSpan(offset, sizeof(int)), counter ^ chunkIndex);
        return nonce;
    }

    public static long EncryptedPayloadBytes(long fileBytes)
    {
        if (fileBytes is < 1 or > MaxFileBytes) throw new ArgumentOutOfRangeException(nameof(fileBytes));
        var chunks = (fileBytes + IoChunkBytes - 1) / IoChunkBytes;
        return checked(fileBytes + chunks * GcmTagBytes);
    }

    public static string SanitizeJsonFileName(string raw)
        => SanitizeFileName(raw, ".json", "RisuAI-Chat");

    public static string SanitizeTransferFileName(string raw)
    {
        ArgumentNullException.ThrowIfNull(raw);
        if (raw.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
        {
            return SanitizeFileName(raw, ".json", "RisuAI-Chat");
        }
        if (raw.EndsWith(".png", StringComparison.OrdinalIgnoreCase))
        {
            return SanitizeFileName(raw, ".png", "RisuAI-Persona");
        }
        throw new InvalidDataException("직접 전송은 RisuAI 개별 대화 JSON 또는 페르소나 PNG만 허용합니다.");
    }

    private static string SanitizeFileName(string raw, string extension, string fallback)
    {
        ArgumentNullException.ThrowIfNull(raw);
        var characters = raw.Take(180).Select(character =>
            char.IsLetterOrDigit(character) || character is '.' or '-' or '_' or ' ' ? character : '_');
        var safe = new string(characters.ToArray()).Trim(' ', '.');
        var baseName = safe.EndsWith(extension, StringComparison.OrdinalIgnoreCase) ? safe[..^extension.Length] : safe;
        baseName = baseName.Trim(' ', '.');
        while (Encoding.UTF8.GetByteCount(baseName + extension) > MaxFileNameBytes && baseName.Length > 0)
        {
            baseName = baseName[..^1];
        }
        baseName = baseName.TrimEnd(' ', '.');
        return (baseName.Length == 0 ? fallback : baseName) + extension;
    }

    public static bool IsAllowedPeerAddress(IPAddress address)
    {
        if (address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork ||
            IPAddress.IsLoopback(address))
        {
            return false;
        }
        var bytes = address.GetAddressBytes();
        return bytes[0] == 10 ||
               bytes[0] == 172 && bytes[1] is >= 16 and <= 31 ||
               bytes[0] == 192 && bytes[1] == 168 ||
               bytes[0] == 100 && bytes[1] is >= 64 and <= 127;
    }

    public static bool IsTailscaleAddress(IPAddress address)
    {
        if (address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return false;
        var bytes = address.GetAddressBytes();
        return bytes[0] == 100 && bytes[1] is >= 64 and <= 127;
    }
}
