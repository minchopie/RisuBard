using System.Collections.Concurrent;
using System.Net;
using Makaretu.Dns;

namespace RisuAI.ChatTransfer.Core;

/// <summary>RFC 6763 discovery only. An announcement never creates trust.</summary>
public sealed class PlaySetDiscovery : IDisposable
{
    public sealed record Device(string Id, string Name, string Address, int Port, long SeenAt);
    private readonly ServiceDiscovery discovery = new();
    private readonly ServiceProfile profile;
    private readonly ConcurrentDictionary<string, Device> devices = new(StringComparer.Ordinal);
    private readonly string ownId;
    public PlaySetDiscovery(string id, string name, int port)
    {
        ownId = id;
        profile = new ServiceProfile("RisuPlay-" + id, "_risuplay._tcp", checked((ushort)port));
        profile.AddProperty("id", id); profile.AddProperty("name", name);
        discovery.ServiceInstanceDiscovered += (_, e) => Receive(e);
        discovery.ServiceInstanceShutdown += (sender, e) => {
            var instance = e.ServiceInstanceName.ToString();
            foreach (var device in devices.Keys.Where(key => instance.StartsWith("RisuPlay-" + key + ".", StringComparison.OrdinalIgnoreCase))) devices.TryRemove(device, out _);
        };
        discovery.Advertise(profile); discovery.QueryServiceInstances("_risuplay._tcp");
    }
    private void Receive(ServiceInstanceDiscoveryEventArgs e)
    {
        if (!e.ServiceInstanceName.ToString().EndsWith("._risuplay._tcp.local", StringComparison.OrdinalIgnoreCase)) return;
        var records = e.Message.Answers.Concat(e.Message.AdditionalRecords).ToArray();
        var srv = records.OfType<SRVRecord>().FirstOrDefault(r => r.Name == e.ServiceInstanceName);
        var txt = records.OfType<TXTRecord>().FirstOrDefault(r => r.Name == e.ServiceInstanceName);
        if (srv is null || txt is null || srv.Port == 0) return;
        var id = txt.Strings.FirstOrDefault(v => v.StartsWith("id=", StringComparison.Ordinal))?[3..];
        if (id is null || !Guid.TryParseExact(id, "D", out _) || id != id.ToLowerInvariant() || id == ownId) return;
        var name = txt.Strings.FirstOrDefault(v => v.StartsWith("name=", StringComparison.Ordinal))?[5..] ?? "RisuAI";
        // Prefer a routable IPv4 address; IPv6 scope is retained from the datagram endpoint.
        var address = records.OfType<ARecord>().FirstOrDefault(r => r.Name == srv.Target)?.Address
            ?? records.OfType<AAAARecord>().FirstOrDefault(r => r.Name == srv.Target)?.Address;
        if (address is null) return;
        if (address.IsIPv6LinkLocal && address.ScopeId == 0 && e.RemoteEndPoint.Address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6) address.ScopeId = e.RemoteEndPoint.Address.ScopeId;
        devices[id] = new(id, name[..Math.Min(name.Length, 80)], address.ToString(), srv.Port, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }
    public IReadOnlyList<Device> Devices()
    {
        discovery.QueryServiceInstances("_risuplay._tcp");
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        foreach (var item in devices) if (now - item.Value.SeenAt > 120_000) devices.TryRemove(item.Key, out _);
        return devices.Values.OrderBy(d => d.Name, StringComparer.Ordinal).ToArray();
    }
    public Device Endpoint(string id) => Devices().FirstOrDefault(d => d.Id == id) ?? throw new IOException("기기를 다시 검색해 주세요.");
    public void Dispose() { discovery.Unadvertise(); discovery.Dispose(); }
}
