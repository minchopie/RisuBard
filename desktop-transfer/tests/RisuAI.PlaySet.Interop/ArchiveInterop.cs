using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using RisuAI.ChatTransfer.Core;

internal static class ArchiveInterop
{
    public static void Create(string directory)
    {
        using var archive = new PlaySetArchive(directory);
        var block = new byte[PlaySetArchive.ChunkSize]; new Random(947).NextBytes(block);
        const int chunks = 260; // 65 MiB uncompressed; deliberately exceeds legacy 64 MiB.
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        for (var i = 0; i < chunks; i++) hash.AppendData(block);
        var digest = Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
        var id = archive.Begin();
        var metadata = Encoding.UTF8.GetBytes("{\"fixture\":\"한글 상태\"}");
        archive.BeginEntry(id, "manifest.json", metadata.Length); archive.Append(id, metadata); archive.EndEntry(id);
        archive.BeginEntry(id, "blobs/" + digest, (long)block.Length * chunks);
        for (var i = 0; i < chunks; i++) archive.Append(id, block);
        archive.EndEntry(id); archive.Finish(id);
        if (archive.Digest(id, "blobs/" + digest, (long)block.Length * chunks) != digest) throw new Exception("Native roundtrip failed");
        File.WriteAllText(Path.Combine(directory, "fixture.json"), JsonSerializer.Serialize(new { path = archive.FilePath(id), digest, bytes = (long)block.Length * chunks }));
        try { PlaySetArchive.EntryName("../database.bin"); throw new Exception("Traversal accepted"); } catch (InvalidDataException) { }
        var broken = archive.Begin();
        archive.BeginEntry(broken, "blobs/" + new string('0', 64), 1); archive.Append(broken, [1]);
        try { archive.EndEntry(broken); throw new Exception("Corrupt content accepted"); } catch (InvalidDataException) { archive.Abort(broken); }
        Console.WriteLine("PASS C# streaming 65 MiB ZIP, content hash and traversal guard");
    }
    public static void Verify(string directory, string path)
    {
        using var archive = new PlaySetArchive(directory);
        using var source = File.OpenRead(path);
        var id = archive.ReceiveAsync(source).GetAwaiter().GetResult();
        var entry = archive.Entries(id).Single(e => e.Name.StartsWith("blobs/", StringComparison.Ordinal));
        if (archive.Digest(id, entry.Name, entry.Bytes) != entry.Name[6..] || entry.Bytes <= 64 * 1024 * 1024) throw new Exception("Java ZIP roundtrip failed");
        Console.WriteLine("PASS Java -> C# streaming ZIP roundtrip");
    }
}
