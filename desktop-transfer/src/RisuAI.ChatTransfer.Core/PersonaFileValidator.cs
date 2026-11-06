using System.Buffers.Binary;
using System.Text;
using System.Text.Json;

namespace RisuAI.ChatTransfer.Core;

internal static class PersonaFileValidator
{
    private const int MaxMetadataChunkBytes = 4 * 1024 * 1024;
    private const int MaxImageDimension = 8192;
    private const long MaxImagePixels = 40_000_000;
    private const int MaxJsonDepth = 100;
    private const int MaxJsonNodes = 100_000;
    private static readonly byte[] PngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
    private static readonly HashSet<string> UnsafeKeys =
        new(StringComparer.Ordinal) { "__proto__", "prototype", "constructor" };

    public static async Task<ChatFileInfo> ValidateAsync(
        FileInfo file,
        string transferFileName,
        CancellationToken cancellationToken)
    {
        if (file.Length is < 1 or > PeerTransferProtocol.MaxFileBytes)
        {
            throw new InvalidDataException("페르소나 PNG는 1바이트 이상 64 MiB 이하여야 합니다.");
        }

        await using var stream = new FileStream(
            file.FullName,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            128 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        var signature = new byte[PngSignature.Length];
        await ReadExactlyAsync(stream, signature, cancellationToken).ConfigureAwait(false);
        if (!signature.AsSpan().SequenceEqual(PngSignature))
        {
            throw new InvalidDataException("선택한 파일은 올바른 PNG가 아닙니다.");
        }

        var sawHeader = false;
        var sawImageData = false;
        var sawEnd = false;
        byte[]? personaText = null;
        while (stream.Position < stream.Length)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var header = new byte[8];
            await ReadExactlyAsync(stream, header, cancellationToken).ConfigureAwait(false);
            var length = BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(0, 4));
            var typeBytes = header.AsSpan(4, 4).ToArray();
            var type = Encoding.ASCII.GetString(typeBytes);
            if ((long)length + 4 > stream.Length - stream.Position)
            {
                throw new InvalidDataException("PNG 청크 길이가 파일 범위를 벗어났습니다.");
            }
            if (!sawHeader && type != "IHDR")
            {
                throw new InvalidDataException("PNG의 첫 청크가 IHDR이 아닙니다.");
            }

            var capture = type == "IHDR" || type == "tEXt" && length <= MaxMetadataChunkBytes;
            var data = await ReadChunkAsync(
                stream,
                typeBytes,
                checked((int)length),
                capture,
                cancellationToken).ConfigureAwait(false);

            switch (type)
            {
                case "IHDR":
                    if (sawHeader || length != 13 || data is null)
                    {
                        throw new InvalidDataException("PNG IHDR 청크가 올바르지 않습니다.");
                    }
                    ValidateDimensions(data);
                    sawHeader = true;
                    break;
                case "IDAT":
                    if (!sawHeader) throw new InvalidDataException("PNG 이미지 데이터 순서가 올바르지 않습니다.");
                    sawImageData = true;
                    break;
                case "tEXt" when data is not null:
                    var separator = Array.IndexOf(data, (byte)0);
                    if (separator is > 0 and <= 79 &&
                        Encoding.Latin1.GetString(data, 0, separator) == "persona")
                    {
                        if (personaText is not null)
                        {
                            throw new InvalidDataException("페르소나 메타데이터가 중복된 PNG는 받을 수 없습니다.");
                        }
                        personaText = data[(separator + 1)..];
                    }
                    break;
                case "IEND":
                    if (length != 0) throw new InvalidDataException("PNG IEND 청크가 올바르지 않습니다.");
                    sawEnd = true;
                    break;
            }

            if (sawEnd) break;
        }

        if (!sawHeader || !sawImageData || !sawEnd || stream.Position != stream.Length)
        {
            throw new InvalidDataException("PNG 이미지가 완전하지 않거나 뒤에 불필요한 데이터가 있습니다.");
        }
        if (personaText is null)
        {
            throw new InvalidDataException("RisuAI 페르소나 메타데이터가 없는 PNG입니다.");
        }

        var persona = ParsePersona(personaText);
        return new ChatFileInfo(
            file.FullName,
            PeerTransferProtocol.SanitizeTransferFileName(transferFileName),
            file.Length,
            MessageCount: 0,
            ReferencedInlayCount: 0,
            ChatName: string.Empty,
            CharacterName: null,
            Kind: TransferPayloadKind.Persona,
            PersonaName: persona.Name,
            PersonaPromptCharacters: persona.PromptCharacters,
            PersonaHasNote: persona.HasNote);
    }

    private static async Task<byte[]?> ReadChunkAsync(
        Stream stream,
        byte[] type,
        int length,
        bool capture,
        CancellationToken cancellationToken)
    {
        var crc = new PngCrc32();
        crc.Update(type);
        byte[]? captured = capture ? new byte[length] : null;
        var buffer = new byte[Math.Min(64 * 1024, Math.Max(1, length))];
        var read = 0;
        while (read < length)
        {
            var count = Math.Min(buffer.Length, length - read);
            await ReadExactlyAsync(stream, buffer.AsMemory(0, count), cancellationToken).ConfigureAwait(false);
            crc.Update(buffer.AsSpan(0, count));
            if (captured is not null) buffer.AsSpan(0, count).CopyTo(captured.AsSpan(read));
            read += count;
        }

        var expectedBytes = new byte[4];
        await ReadExactlyAsync(stream, expectedBytes, cancellationToken).ConfigureAwait(false);
        var expected = BinaryPrimitives.ReadUInt32BigEndian(expectedBytes);
        if (crc.Value != expected) throw new InvalidDataException("PNG 무결성(CRC) 검증에 실패했습니다.");
        return captured;
    }

    private static void ValidateDimensions(byte[] header)
    {
        var width = BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(0, 4));
        var height = BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(4, 4));
        if (width is 0 or > MaxImageDimension || height is 0 or > MaxImageDimension ||
            (long)width * height > MaxImagePixels)
        {
            throw new InvalidDataException("페르소나 이미지 크기가 모바일 안전 범위를 벗어났습니다.");
        }
    }

    private static PersonaMetadata ParsePersona(byte[] text)
    {
        byte[] jsonBytes;
        try
        {
            jsonBytes = Convert.FromBase64String(Encoding.ASCII.GetString(text));
        }
        catch (FormatException error)
        {
            throw new InvalidDataException("페르소나 메타데이터의 Base64 형식이 올바르지 않습니다.", error);
        }
        if (jsonBytes.Length is < 2 or > MaxMetadataChunkBytes)
        {
            throw new InvalidDataException("페르소나 메타데이터 크기가 허용 범위를 벗어났습니다.");
        }

        try
        {
            using var document = JsonDocument.Parse(jsonBytes, new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = MaxJsonDepth,
            });
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidDataException("페르소나 메타데이터가 JSON 객체가 아닙니다.");
            }
            InspectJsonTree(root);
            if (!root.TryGetProperty("name", out var nameElement) || nameElement.ValueKind != JsonValueKind.String ||
                !root.TryGetProperty("personaPrompt", out var promptElement) || promptElement.ValueKind != JsonValueKind.String)
            {
                throw new InvalidDataException("페르소나 이름 또는 프롬프트가 없습니다.");
            }
            var name = nameElement.GetString()?.Trim() ?? string.Empty;
            var prompt = promptElement.GetString() ?? string.Empty;
            if (name.Length == 0 || name.Length > 1_000 || prompt.Length == 0 || prompt.Length > 2_000_000)
            {
                throw new InvalidDataException("페르소나 이름 또는 프롬프트 길이가 허용 범위를 벗어났습니다.");
            }
            var hasNote = false;
            if (root.TryGetProperty("note", out var note))
            {
                if (note.ValueKind is not (JsonValueKind.String or JsonValueKind.Null))
                {
                    throw new InvalidDataException("페르소나 노트 형식이 올바르지 않습니다.");
                }
                hasNote = note.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(note.GetString());
            }
            return new PersonaMetadata(name, prompt.Length, hasNote);
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("페르소나 메타데이터 JSON을 읽지 못했습니다.", error);
        }
        finally
        {
            Array.Clear(jsonBytes);
        }
    }

    private static void InspectJsonTree(JsonElement root)
    {
        var stack = new Stack<(JsonElement Element, int Depth)>();
        stack.Push((root, 0));
        var nodes = 0;
        while (stack.Count > 0)
        {
            var (element, depth) = stack.Pop();
            if (++nodes > MaxJsonNodes || depth > MaxJsonDepth)
            {
                throw new InvalidDataException("페르소나 메타데이터 구조가 너무 큽니다.");
            }
            if (element.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in element.EnumerateObject())
                {
                    if (UnsafeKeys.Contains(property.Name))
                    {
                        throw new InvalidDataException("페르소나 메타데이터에 허용되지 않는 객체 키가 있습니다.");
                    }
                    stack.Push((property.Value, depth + 1));
                }
            }
            else if (element.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in element.EnumerateArray()) stack.Push((item, depth + 1));
            }
        }
    }

    private static async Task ReadExactlyAsync(
        Stream stream,
        Memory<byte> destination,
        CancellationToken cancellationToken)
    {
        var offset = 0;
        while (offset < destination.Length)
        {
            var count = await stream.ReadAsync(destination[offset..], cancellationToken).ConfigureAwait(false);
            if (count == 0) throw new InvalidDataException("PNG 파일이 청크 중간에서 끝났습니다.");
            offset += count;
        }
    }

    private sealed record PersonaMetadata(string Name, int PromptCharacters, bool HasNote);

    private sealed class PngCrc32
    {
        private uint _state = uint.MaxValue;

        public void Update(ReadOnlySpan<byte> data)
        {
            foreach (var value in data)
            {
                _state ^= value;
                for (var bit = 0; bit < 8; bit++)
                {
                    _state = (_state & 1) != 0 ? (_state >> 1) ^ 0xedb88320u : _state >> 1;
                }
            }
        }

        public uint Value => ~_state;
    }
}
