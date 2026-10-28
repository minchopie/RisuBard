using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using Org.BouncyCastle.Crypto.Agreement.JPake;
using BigInteger = Org.BouncyCastle.Math.BigInteger;

namespace RisuAI.ChatTransfer.Core;

/// <summary>RPT2 pairing codec. Independent of RPT1 and never negotiates a downgrade.</summary>
public sealed class PlaySetPairing : IDisposable
{
    private readonly JPakeParticipant participant;
    private readonly string session, device;
    private string? peer, own1, other1, own2, other2;
    private BigInteger? material;
    private byte[]? bindingKey;
    private bool confirmed, bound, round3Created;
    public PlaySetPairing(string sessionId, string deviceId, char[] code)
    {
        ValidateId(sessionId); ValidateId(deviceId);
        if (code.Length != 6 || code.Any(c => c is < '0' or > '9')) throw new ArgumentException("Six decimal digits required");
        session = sessionId; device = deviceId;
        participant = new JPakeParticipant(session + "/" + device, code);
    }
    private static void ValidateId(string id)
    {
        if (!Guid.TryParseExact(id, "D", out _) || id != id.ToLowerInvariant()) throw new ArgumentException("Canonical UUID required");
    }
    private string Encode(int round, params string[] fields) => string.Join('|', new[] { "RPT2", session, round.ToString(System.Globalization.CultureInfo.InvariantCulture), device }.Concat(fields));
    private string[] Decode(string line, int round, int values)
    {
        if (line.Length > 8192 || line.Contains('\n') || line.Contains('\r')) throw new InvalidDataException("Oversized pairing frame");
        var parts = line.Split('|');
        if (parts.Length != 4 + values || parts[0] != "RPT2" || parts[1] != session || parts[2] != round.ToString(System.Globalization.CultureInfo.InvariantCulture)) throw new InvalidDataException("Wrong RPT2 session/round");
        ValidateId(parts[3]);
        if (parts[3] == device || peer is not null && parts[3] != peer) throw new InvalidDataException("Pairing participant changed");
        peer ??= parts[3];
        return parts[4..];
    }
    private static string Hex(BigInteger n) => n.ToString(16);
    private static BigInteger Number(string value)
    {
        if (value.Length > 769 || !Regex.IsMatch(value, "^(0|-?[1-9a-f][0-9a-f]*)$", RegexOptions.CultureInvariant)) throw new InvalidDataException("Noncanonical integer");
        return new BigInteger(value, 16);
    }
    public string Round1()
    {
        var p = participant.CreateRound1PayloadToSend();
        own1 = Encode(1, Hex(p.Gx1), Hex(p.Gx2), Hex(p.KnowledgeProofForX1[0]), Hex(p.KnowledgeProofForX1[1]), Hex(p.KnowledgeProofForX2[0]), Hex(p.KnowledgeProofForX2[1]));
        return own1;
    }
    public void Accept1(string line)
    {
        var p = Decode(line, 1, 6).Select(Number).ToArray();
        participant.ValidateRound1PayloadReceived(new JPakeRound1Payload(session + "/" + peer, p[0], p[1], [p[2], p[3]], [p[4], p[5]]));
        other1 = line;
    }
    public string Round2()
    {
        var p = participant.CreateRound2PayloadToSend();
        own2 = Encode(2, Hex(p.A), Hex(p.KnowledgeProofForX2s[0]), Hex(p.KnowledgeProofForX2s[1]));
        return own2;
    }
    public void Accept2(string line)
    {
        if (own2 is null) throw new InvalidOperationException("Create local round 2 before accepting peer round 2");
        var p = Decode(line, 2, 3).Select(Number).ToArray();
        participant.ValidateRound2PayloadReceived(new JPakeRound2Payload(session + "/" + peer, p[0], [p[1], p[2]]));
        other2 = line;
        material = participant.CalculateKeyingMaterial();
    }
    public string Round3()
    {
        if (material is null) throw new InvalidOperationException("Missing key agreement");
        var output = Encode(3, Hex(participant.CreateRound3PayloadToSend(material).MacTag));
        round3Created = true; return output;
    }
    public void Accept3(string line)
    {
        if (!round3Created || own1 is null || other1 is null || own2 is null || other2 is null) throw new InvalidOperationException("Create all local rounds before accepting confirmation");
        var p = Decode(line, 3, 1);
        if (material is null) throw new InvalidOperationException("Missing key agreement");
        participant.ValidateRound3PayloadReceived(new JPakeRound3Payload(session + "/" + peer, Number(p[0])), material);
        var transcript = string.Join('\n', new[] { own1!, other1!, own2!, other2! }.Order(StringComparer.Ordinal));
        var salt = SHA256.HashData(Encoding.UTF8.GetBytes(transcript));
        var secret = material.ToByteArrayUnsigned();
        bindingKey = HKDF.DeriveKey(HashAlgorithmName.SHA256, secret, 32, salt, Encoding.UTF8.GetBytes("RPT2 pairing tls-binding v1"));
        CryptographicOperations.ZeroMemory(secret); material = null; confirmed = true;
    }
    private byte[] BindingMac(string sender, string spki)
    {
        if (!confirmed || bindingKey is null) throw new InvalidOperationException("Round 3 confirmation required");
        if (!Regex.IsMatch(spki, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant)) throw new InvalidDataException("Invalid SPKI digest");
        var ids = new[] { device, peer! }.Order(StringComparer.Ordinal);
        return HMACSHA256.HashData(bindingKey, Encoding.UTF8.GetBytes("RPT2|" + session + "|" + string.Join('|', ids) + "|" + sender + "|" + spki));
    }
    public string Binding(string ownTlsSpkiSha256) => Encode(4, ownTlsSpkiSha256, Convert.ToHexString(BindingMac(device, ownTlsSpkiSha256)).ToLowerInvariant());
    /// <summary>observedPeerSpkiSha256 MUST come from the actual TLS peer certificate, never its message.</summary>
    public string AcceptBinding(string line, string observedPeerSpkiSha256)
    {
        if (bound) throw new InvalidOperationException("Binding already consumed");
        var p = Decode(line, 4, 2);
        if (p[0] != observedPeerSpkiSha256 || !Regex.IsMatch(p[1], "^[a-f0-9]{64}$", RegexOptions.CultureInvariant) ||
            !CryptographicOperations.FixedTimeEquals(Convert.FromHexString(p[1]), BindingMac(peer!, p[0]))) throw new CryptographicException("TLS identity binding failed");
        bound = true;
        return peer!;
    }
    public void Dispose() { if (bindingKey is not null) CryptographicOperations.ZeroMemory(bindingKey); material = null; }
}
