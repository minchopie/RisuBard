using System.Net;

namespace RisuAI.ChatTransfer.Core;

public sealed record ChatFileInfo(
    string FullPath,
    string TransferFileName,
    long Bytes,
    int MessageCount,
    int ReferencedInlayCount,
    string ChatName,
    string? CharacterName,
    TransferPayloadKind Kind = TransferPayloadKind.Chat,
    string? PersonaName = null,
    int PersonaPromptCharacters = 0,
    bool PersonaHasNote = false);

public enum TransferPayloadKind
{
    Chat,
    Persona,
}

public sealed record LocalPeerAddress(IPAddress Address, string InterfaceName, string Kind)
{
    public string DisplayName => $"{Kind} · {Address} · {InterfaceName}";
    public override string ToString() => DisplayName;
}

public sealed record TransferProgress(long TransferredBytes, long TotalBytes);

public sealed record PeerEndpoint(string Host, int Port)
{
    public override string ToString() => $"{Host}:{Port}";
}

public enum TransferOutcome
{
    Sent,
    Expired,
    Cancelled,
    TooManyAttempts,
    Failed,
}

public sealed record TransferResult(TransferOutcome Outcome, string? ErrorMessage = null);
