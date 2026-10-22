using System.Diagnostics;
using System.Security.Cryptography;

namespace RisuAI.ChatTransfer.Core;

/// <summary>One foreground registration window. Transfer/reconnect lifetimes are unrelated.</summary>
public sealed class PlaySetPairingWindow : IDisposable
{
    public static readonly TimeSpan Lifetime = TimeSpan.FromMinutes(5);
    public const int AttemptLimit = 5;
    private readonly long started = Stopwatch.GetTimestamp();
    private readonly char[] code = RandomNumberGenerator.GetInt32(1_000_000).ToString("D6", System.Globalization.CultureInfo.InvariantCulture).ToCharArray();
    private int attempts;
    private bool consumed;
    public string SessionId { get; } = Guid.NewGuid().ToString();
    public bool IsActive { get { lock (this) return !consumed && Stopwatch.GetElapsedTime(started) < Lifetime; } }
    public string DisplayCode { get { lock (this) { Check(); return new string(code); } } }
    private void Check() {
        if (consumed || Stopwatch.GetElapsedTime(started) >= Lifetime || attempts >= AttemptLimit) throw new InvalidOperationException("Registration code expired or attempt limit reached");
    }
    public PlaySetPairing BeginAttempt(string deviceId) {
        lock (this) { Check(); attempts++; return new PlaySetPairing(SessionId, deviceId, code); }
    }
    /// <summary>Call only after round3, TLS SPKI binding, and durable trusted-device save succeed.</summary>
    public void Complete() {
        lock (this) {
            if (consumed || Stopwatch.GetElapsedTime(started) >= Lifetime) throw new InvalidOperationException("Registration window expired");
            Dispose();
        }
    }
    public void Commit(Action saveTrust) {
        lock (this) {
            if (consumed || Stopwatch.GetElapsedTime(started) >= Lifetime) throw new InvalidOperationException("Registration window expired");
            saveTrust(); Dispose();
        }
    }
    public void Dispose() { lock (this) { consumed = true; Array.Clear(code); } }
}
