using System.Globalization;
using System.Net;

namespace RisuAI.ChatTransfer.Core;

public static class PeerEndpointParser
{
    public static PeerEndpoint Parse(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            throw new ArgumentException("Android 앱에 표시된 IP:포트 또는 Tailscale 주소를 입력하세요.", nameof(raw));
        }

        var value = raw.Trim();
        if (value.Length > 300 || value.Any(char.IsWhiteSpace) || value.IndexOfAny(['/', '\\', '@', '?', '#']) >= 0)
        {
            throw new ArgumentException("주소 형식이 올바르지 않습니다. 예: 192.168.0.20:45123", nameof(raw));
        }

        var separator = value.LastIndexOf(':');
        if (separator <= 0 || separator != value.IndexOf(':') || separator == value.Length - 1 ||
            !int.TryParse(value[(separator + 1)..], NumberStyles.None, CultureInfo.InvariantCulture, out var port) ||
            port is < 1024 or > 65535)
        {
            throw new ArgumentException("포트를 포함한 IPv4 또는 Tailscale 주소를 입력하세요. 포트 범위는 1024–65535입니다.", nameof(raw));
        }

        var host = value[..separator].ToLowerInvariant();
        if (TryParseStrictIpv4(host, out var address))
        {
            if (!PeerTransferProtocol.IsAllowedPeerAddress(address))
            {
                throw new ArgumentException("같은 Wi-Fi/LAN의 사설 IPv4 또는 Tailscale 100.64–100.127 주소만 허용됩니다.", nameof(raw));
            }
            return new PeerEndpoint(address.ToString(), port);
        }

        if (!IsValidTailscaleHost(host))
        {
            throw new ArgumentException("숫자 사설 IPv4 또는 .ts.net으로 끝나는 Tailscale 주소만 허용됩니다.", nameof(raw));
        }
        return new PeerEndpoint(host, port);
    }

    internal static async Task<IPAddress> ResolveAsync(
        PeerEndpoint endpoint,
        Func<string, CancellationToken, Task<IPAddress[]>> resolver,
        bool allowLoopbackForTesting,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(endpoint);
        ArgumentNullException.ThrowIfNull(resolver);

        IPAddress[] addresses;
        if (TryParseStrictIpv4(endpoint.Host, out var literal))
        {
            addresses = [literal];
        }
        else
        {
            addresses = await resolver(endpoint.Host, cancellationToken).ConfigureAwait(false);
        }

        var allowed = addresses
            .Where(address => PeerTransferProtocol.IsAllowedPeerAddress(address) ||
                allowLoopbackForTesting && IPAddress.IsLoopback(address))
            .OrderByDescending(PeerTransferProtocol.IsTailscaleAddress)
            .FirstOrDefault();
        return allowed ?? throw new InvalidDataException(
            "입력한 호스트가 사설 IPv4 또는 Tailscale IPv4로 확인되지 않았습니다.");
    }

    private static bool TryParseStrictIpv4(string value, out IPAddress address)
    {
        address = IPAddress.None;
        var parts = value.Split('.');
        if (parts.Length != 4) return false;
        Span<byte> octets = stackalloc byte[4];
        for (var index = 0; index < parts.Length; index++)
        {
            var part = parts[index];
            if (part.Length is < 1 or > 3 || part.Any(character => character is < '0' or > '9') ||
                part.Length > 1 && part[0] == '0' ||
                !byte.TryParse(part, NumberStyles.None, CultureInfo.InvariantCulture, out octets[index]))
            {
                return false;
            }
        }
        address = new IPAddress(octets);
        return true;
    }

    private static bool IsValidTailscaleHost(string host)
    {
        if (host.Length is < 8 or > 253 || !host.EndsWith(".ts.net", StringComparison.Ordinal)) return false;
        var labels = host.Split('.');
        if (labels.Length < 3) return false;
        foreach (var label in labels)
        {
            if (label.Length is < 1 or > 63 || label[0] == '-' || label[^1] == '-' ||
                label.Any(character => !(character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-')))
            {
                return false;
            }
        }
        return true;
    }
}
