using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.RegularExpressions;

namespace RisuAI.ChatTransfer.Core;

/// <summary>Private, streaming archive staging. This class never reads or modifies the RisuAI DB.</summary>
public sealed class PlaySetArchive : IDisposable
{
    public const int ChunkSize = 256 * 1024;
    private readonly string root;
    private sealed class Writer : IDisposable
    {
        public readonly FileStream File;
        public readonly ZipArchive Zip;
        public readonly HashSet<string> Names = new(StringComparer.Ordinal);
        public Stream? Entry;
        public string? Name;
        public long Expected, Written;
        public IncrementalHash? Hash;
        public Writer(string path) { File = new(path, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None); Zip = new(File, ZipArchiveMode.Create, true); }
        public void Dispose() { Entry?.Dispose(); Hash?.Dispose(); Zip.Dispose(); File.Dispose(); }
    }
    private sealed class Reader : IDisposable
    {
        public readonly ZipArchive Zip;
        public readonly Stream Input;
        public readonly long Expected;
        public long Read; public long Touched = Environment.TickCount64;
        public Reader(string path, string name) {
            Zip = ZipFile.OpenRead(path);
            var entry = Zip.GetEntry(name);
            if (entry is null) { Zip.Dispose(); throw new InvalidDataException("Missing entry"); }
            Expected = entry.Length; Input = entry.Open();
        }
        public void Dispose() { Input.Dispose(); Zip.Dispose(); }
    }
    private readonly Dictionary<string, Writer> writers = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Reader> readers = new(StringComparer.Ordinal);
    public PlaySetArchive(string directory) { root = Path.GetFullPath(directory); Directory.CreateDirectory(root);
        foreach (var part in Directory.EnumerateFiles(root, "*.part")) {
            var name = Path.GetFileNameWithoutExtension(part);
            if (Guid.TryParseExact(name, "D", out _) && name == name.ToLowerInvariant()) File.Delete(part);
        }
    }
    public long AvailableBytes => new DriveInfo(Path.GetPathRoot(root)!).AvailableFreeSpace;
    private static void Handle(string id) { if (!Guid.TryParseExact(id, "D", out _) || id != id.ToLowerInvariant()) throw new ArgumentException("Invalid handle"); }
    public static void EntryName(string name) { if (name != "manifest.json" && !Regex.IsMatch(name, "^(records/[a-f0-9]{64}\\.json|blobs/[a-f0-9]{64})$", RegexOptions.CultureInvariant)) throw new InvalidDataException("Invalid ZIP member"); }
    public string FilePath(string id) { Handle(id); return Path.Combine(root, id + ".risuplay"); }
    private string Partial(string id) { Handle(id); return Path.Combine(root, id + ".part"); }
    public string Begin() { var id = Guid.NewGuid().ToString(); writers.Add(id, new(Partial(id))); return id; }
    public void BeginEntry(string id, string name, long bytes) {
        EntryName(name); var w = writers[id];
        if (w.Entry is not null || !w.Names.Add(name) || bytes < 0 || bytes > AvailableBytes) throw new IOException("Invalid entry or insufficient space");
        w.Name = name; w.Expected = bytes; w.Written = 0; w.Hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        w.Entry = w.Zip.CreateEntry(name, CompressionLevel.Fastest).Open();
    }
    public void Append(string id, byte[] bytes) {
        var w = writers[id];
        if (w.Entry is null || bytes.Length > ChunkSize || bytes.Length > w.Expected - w.Written || bytes.Length > AvailableBytes) throw new IOException("Invalid chunk or insufficient space");
        w.Entry.Write(bytes); w.Hash!.AppendData(bytes); w.Written += bytes.Length;
    }
    public void EndEntry(string id) {
        var w = writers[id]; if (w.Entry is null || w.Written != w.Expected) throw new IOException("Incomplete entry");
        var hash = Convert.ToHexString(w.Hash!.GetHashAndReset()).ToLowerInvariant();
        if (w.Name != "manifest.json" && !w.Name!.Contains(hash, StringComparison.Ordinal)) throw new InvalidDataException("Entry hash mismatch");
        w.Entry.Dispose(); w.Entry = null; w.Hash.Dispose(); w.Hash = null;
    }
    public string Finish(string id) {
        var w = writers[id]; if (w.Entry is not null || !w.Names.Contains("manifest.json")) throw new IOException("Incomplete archive");
        w.Zip.Dispose(); w.File.Flush(true); w.File.Dispose(); writers.Remove(id);
        File.Move(Partial(id), FilePath(id)); return id;
    }
    public async Task<string> ReceiveAsync(Stream source, CancellationToken cancellationToken = default) {
        var id = Guid.NewGuid().ToString();
        var budget = AvailableBytes / 2; long received = 0;
        try {
        await using (var output = new FileStream(Partial(id), FileMode.CreateNew, FileAccess.Write, FileShare.None, ChunkSize, true)) {
            var buffer = new byte[ChunkSize]; int n;
            while ((n = await source.ReadAsync(buffer, cancellationToken).ConfigureAwait(false)) > 0) {
                received = checked(received + n);
                if (n > AvailableBytes || received > budget) throw new IOException("Insufficient storage");
                await output.WriteAsync(buffer.AsMemory(0, n), cancellationToken).ConfigureAwait(false);
            }
            output.Flush(true);
        }
        Inspect(Partial(id)); File.Move(Partial(id), FilePath(id)); return id;
        } catch { File.Delete(Partial(id)); throw; }
    }
    public IReadOnlyList<(string Name, long Bytes)> Entries(string id) {
        return Inspect(FilePath(id));
    }
    private IReadOnlyList<(string Name, long Bytes)> Inspect(string path) {
        using var zip = ZipFile.OpenRead(path);
        var names = new HashSet<string>(StringComparer.Ordinal); var result = new List<(string, long)>(); long total = 0;
        foreach (var entry in zip.Entries) {
            EntryName(entry.FullName);
            if (!names.Add(entry.FullName) || ((entry.ExternalAttributes >> 16) & 0xf000) == 0xa000) throw new InvalidDataException("Duplicate entry or symlink");
            total = checked(total + entry.Length); if (total > AvailableBytes / 2) throw new IOException("Insufficient expanded storage");
            result.Add((entry.FullName, entry.Length));
        }
        if (!names.Contains("manifest.json")) throw new InvalidDataException("Missing manifest"); return result;
    }
    public string Digest(string id, string name, long expected) {
        EntryName(name); using var zip = ZipFile.OpenRead(FilePath(id));
        var entry = zip.GetEntry(name); if (entry is null || entry.Length != expected) throw new InvalidDataException("Unexpected entry size");
        using var input = entry.Open(); using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var buffer = new byte[ChunkSize]; long count = 0; int n;
        while ((n = input.Read(buffer)) > 0) { count = checked(count + n); if (count > expected) throw new InvalidDataException("Expanded size exceeded"); hash.AppendData(buffer, 0, n); }
        if (count != expected) throw new InvalidDataException("Truncated entry"); return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }
    public string OpenEntry(string id, string name) { EntryName(name);
        foreach (var key in readers.Where(p => Environment.TickCount64 - p.Value.Touched > 300_000).Select(p => p.Key).ToArray()) CloseEntry(key);
        if (readers.Count >= 64) throw new IOException("Too many open archive readers");
        var token = Guid.NewGuid().ToString(); readers.Add(token, new(FilePath(id), name)); return token; }
    public byte[] ReadChunk(string token) {
        var r = readers[token]; r.Touched = Environment.TickCount64; var bytes = new byte[ChunkSize]; var n = r.Input.Read(bytes);
        r.Read = checked(r.Read + n);
        if (r.Read > r.Expected || n == 0 && r.Read != r.Expected) throw new InvalidDataException("Expanded size mismatch"); return bytes[..n];
    }
    public void CloseEntry(string token) { if (readers.Remove(token, out var r)) r.Dispose(); }
    public void Abort(string id) { if (writers.Remove(id, out var w)) { try { w.Dispose(); } finally { File.Delete(Partial(id)); } } }
    public void Delete(string id) => File.Delete(FilePath(id));
    public void Dispose() { foreach (var id in writers.Keys.ToArray()) Abort(id); foreach (var id in readers.Keys.ToArray()) CloseEntry(id); }
}
