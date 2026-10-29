using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace RisuAI.ChatTransfer.Core;

public static class NetworkAddressCatalog
{
    public static IReadOnlyList<LocalPeerAddress> Discover()
    {
        var found = new List<(LocalPeerAddress Address, int Priority)>();
        NetworkInterface[] interfaces;
        try
        {
            interfaces = NetworkInterface.GetAllNetworkInterfaces();
        }
        catch (Exception error) when (error is NetworkInformationException or PlatformNotSupportedException)
        {
            return Array.Empty<LocalPeerAddress>();
        }

        foreach (var networkInterface in interfaces)
        {
            if (networkInterface.OperationalStatus != OperationalStatus.Up ||
                networkInterface.NetworkInterfaceType == NetworkInterfaceType.Loopback)
            {
                continue;
            }

            IPInterfaceProperties properties;
            try
            {
                properties = networkInterface.GetIPProperties();
            }
            catch (Exception error) when (error is NetworkInformationException or UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var unicast in properties.UnicastAddresses)
            {
                var address = unicast.Address;
                if (address.AddressFamily != AddressFamily.InterNetwork ||
                    !PeerTransferProtocol.IsAllowedPeerAddress(address))
                {
                    continue;
                }

                var tailscale = PeerTransferProtocol.IsTailscaleAddress(address);
                var physical = networkInterface.NetworkInterfaceType is
                    NetworkInterfaceType.Wireless80211 or NetworkInterfaceType.Ethernet or NetworkInterfaceType.GigabitEthernet;
                var priority = physical && !tailscale ? 0 : tailscale ? 1 : 2;
                found.Add((
                    new LocalPeerAddress(
                        address,
                        networkInterface.Name,
                        tailscale ? "Tailscale" : physical ? "Wi-Fi/LAN" : "가상 네트워크"),
                    priority));
            }
        }

        return found
            .GroupBy(item => item.Address.Address)
            .Select(group => group.OrderBy(item => item.Priority).First())
            .OrderBy(item => item.Priority)
            .ThenBy(item => item.Address.Address.ToString(), StringComparer.Ordinal)
            .Select(item => item.Address)
            .ToArray();
    }
}
