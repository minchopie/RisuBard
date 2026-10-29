using System.Text.Json;

namespace RisuAI.ChatTransfer.Core;

public static class ChatFileValidator
{
    private const int MaxJsonDepth = 100;
    private const int MaxJsonNodes = 2_000_000;
    private const int MaxMessages = 1_000_000;
    private static readonly HashSet<string> UnsafeKeys =
        new(StringComparer.Ordinal) { "__proto__", "prototype", "constructor" };

    public static async Task<ChatFileInfo> ValidateAsync(string path, CancellationToken cancellationToken = default)
        => await ValidateAsync(path, Path.GetFileName(path), cancellationToken).ConfigureAwait(false);

    internal static async Task<ChatFileInfo> ValidateAsync(
        string path,
        string transferFileName,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        ArgumentException.ThrowIfNullOrWhiteSpace(transferFileName);
        var file = new FileInfo(Path.GetFullPath(path));
        if (!file.Exists) throw new FileNotFoundException("선택한 RisuAI 전송 파일을 찾을 수 없습니다.", file.FullName);
        var extension = Path.GetExtension(transferFileName);
        if (extension.Equals(".png", StringComparison.OrdinalIgnoreCase))
        {
            return await PersonaFileValidator.ValidateAsync(file, transferFileName, cancellationToken).ConfigureAwait(false);
        }
        if (!extension.Equals(".json", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidDataException("RisuAI 개별 대화 JSON 또는 페르소나 PNG만 선택할 수 있습니다.");
        }
        if (file.Length is < 1 or > PeerTransferProtocol.MaxFileBytes)
        {
            throw new InvalidDataException("채팅 파일은 1바이트 이상 64 MiB 이하여야 합니다.");
        }

        await using var stream = new FileStream(
            file.FullName,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            128 * 1024,
            FileOptions.Asynchronous | FileOptions.SequentialScan);
        using var document = await JsonDocument.ParseAsync(
            stream,
            new JsonDocumentOptions
            {
                AllowTrailingCommas = false,
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = MaxJsonDepth,
            },
            cancellationToken).ConfigureAwait(false);

        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object ||
            !root.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String ||
            !root.TryGetProperty("ver", out var version) || version.ValueKind != JsonValueKind.Number ||
            !version.TryGetInt32(out var versionNumber))
        {
            throw new InvalidDataException("표준 RisuAI 개별 채팅(risuChat v2) JSON이 아닙니다.");
        }

        var typeName = type.GetString();
        JsonElement chat;
        if (typeName == "risuAllChats" && versionNumber == 2)
        {
            if (!root.TryGetProperty("data", out var allChats) || allChats.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("전체 대화 파일의 채팅 목록이 올바르지 않습니다.");
            }
            if (allChats.GetArrayLength() != 1)
            {
                throw new InvalidDataException(
                    $"선택한 risuAllChats 파일에는 대화 {allChats.GetArrayLength():N0}개가 들어 있습니다.{Environment.NewLine}" +
                    "한 대화만 보내려면 PC RisuAI 채팅 목록에서 옮길 대화 행 오른쪽의 ↓를 누른 뒤 " +
                    "첫 항목 Export as JSON을 선택하세요. 목록 맨 아래의 전체 대화 다운로드 버튼은 사용하지 마세요.");
            }
            chat = allChats[0];
        }
        else if (typeName == "risuChat" && versionNumber == 2)
        {
            if (!root.TryGetProperty("data", out chat))
            {
                throw new InvalidDataException("채팅 데이터가 없습니다.");
            }
        }
        else
        {
            throw new InvalidDataException("표준 RisuAI 개별 채팅(risuChat v2) JSON이 아닙니다.");
        }
        if (chat.ValueKind != JsonValueKind.Object || !chat.TryGetProperty("message", out var messages) ||
            messages.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidDataException("채팅 데이터 또는 메시지 목록이 올바르지 않습니다.");
        }

        InspectJsonTree(root);
        var messageCount = messages.GetArrayLength();
        if (messageCount > MaxMessages) throw new InvalidDataException("채팅 메시지 수가 허용 범위를 초과했습니다.");

        var referencedInlays = new HashSet<string>(StringComparer.Ordinal);
        foreach (var message in messages.EnumerateArray())
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (message.ValueKind != JsonValueKind.Object ||
                !message.TryGetProperty("role", out var role) || role.ValueKind != JsonValueKind.String ||
                !message.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.String)
            {
                throw new InvalidDataException("문자열 role과 data를 가진 올바른 RisuAI 메시지가 아닙니다.");
            }
            CountReferencedInlays(data.GetString() ?? string.Empty, referencedInlays);
        }

        var chatName = chat.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String
            ? name.GetString() ?? "Imported Chat"
            : "Imported Chat";
        string? characterName = null;
        if (root.TryGetProperty("privateMobileChatSync", out var metadata) &&
            metadata.ValueKind == JsonValueKind.Object &&
            metadata.TryGetProperty("characterName", out var character) &&
            character.ValueKind == JsonValueKind.String)
        {
            characterName = character.GetString();
        }

        return new ChatFileInfo(
            file.FullName,
            PeerTransferProtocol.SanitizeTransferFileName(transferFileName),
            file.Length,
            messageCount,
            referencedInlays.Count,
            chatName,
            characterName);
    }

    private static void InspectJsonTree(JsonElement root)
    {
        var stack = new Stack<(JsonElement Element, int Depth)>();
        stack.Push((root, 0));
        var nodes = 0;
        while (stack.Count > 0)
        {
            var (element, depth) = stack.Pop();
            nodes++;
            if (nodes > MaxJsonNodes) throw new InvalidDataException("채팅 파일의 항목 수가 너무 많습니다.");
            if (depth > MaxJsonDepth) throw new InvalidDataException("채팅 파일의 중첩 깊이가 너무 큽니다.");

            if (element.ValueKind == JsonValueKind.Object)
            {
                foreach (var property in element.EnumerateObject())
                {
                    if (UnsafeKeys.Contains(property.Name))
                    {
                        throw new InvalidDataException("채팅 파일에 허용되지 않는 객체 키가 있습니다.");
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

    private static void CountReferencedInlays(string text, ISet<string> destination)
    {
        foreach (var prefix in new[] { "{{inlay::", "{{inlayed::", "{{inlayeddata::" })
        {
            var start = 0;
            while ((start = text.IndexOf(prefix, start, StringComparison.Ordinal)) >= 0)
            {
                start += prefix.Length;
                var end = text.IndexOf("}}", start, StringComparison.Ordinal);
                if (end < 0) break;
                if (end > start) destination.Add(text[start..end]);
                start = end + 2;
            }
        }
    }
}
