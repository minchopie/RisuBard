namespace RisuAI.ChatTransfer.Core;

public sealed class ReceivedChatFile : IDisposable
{
    private readonly string _temporaryPath;
    private int _disposed;

    internal ReceivedChatFile(string temporaryPath, ChatFileInfo info)
    {
        _temporaryPath = Path.GetFullPath(temporaryPath);
        Info = info;
    }

    public ChatFileInfo Info { get; }
    public string? SavedPath { get; private set; }

    public async Task<string> SaveToDirectoryAsync(
        string destinationDirectory,
        CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        ArgumentException.ThrowIfNullOrWhiteSpace(destinationDirectory);
        var directory = Path.GetFullPath(destinationDirectory);
        if (!Directory.Exists(directory)) throw new DirectoryNotFoundException("선택한 저장 폴더를 찾을 수 없습니다.");

        var safeName = PeerTransferProtocol.SanitizeTransferFileName(Info.TransferFileName);
        for (var index = 0; index < 10_000; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var finalName = AddCollisionSuffix(safeName, index);
            var destination = Path.Combine(directory, finalName);
            if (File.Exists(destination)) continue;

            var partial = Path.Combine(directory, $".{finalName}.{Guid.NewGuid():N}.partial");
            try
            {
                await using (var input = new FileStream(
                    _temporaryPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                    PeerTransferProtocol.IoChunkBytes, FileOptions.Asynchronous | FileOptions.SequentialScan))
                await using (var output = new FileStream(
                    partial, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                    PeerTransferProtocol.IoChunkBytes, FileOptions.Asynchronous | FileOptions.SequentialScan))
                {
                    await input.CopyToAsync(output, PeerTransferProtocol.IoChunkBytes, cancellationToken).ConfigureAwait(false);
                    await output.FlushAsync(cancellationToken).ConfigureAwait(false);
                    output.Flush(flushToDisk: true);
                }

                try
                {
                    File.Move(partial, destination, overwrite: false);
                    return destination;
                }
                catch (IOException) when (File.Exists(destination))
                {
                    File.Delete(partial);
                }
            }
            catch
            {
                try { if (File.Exists(partial)) File.Delete(partial); } catch { }
                throw;
            }
        }
        throw new IOException("같은 이름의 파일이 너무 많아 받은 파일을 저장하지 못했습니다.");
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        try { File.Delete(_temporaryPath); } catch { }
        GC.SuppressFinalize(this);
    }

    internal void MarkSaved(string path)
    {
        SavedPath = Path.GetFullPath(path);
    }

    private static string AddCollisionSuffix(string fileName, int index)
    {
        if (index == 0) return fileName;
        var extension = Path.GetExtension(fileName);
        return $"{Path.GetFileNameWithoutExtension(fileName)} ({index}){extension}";
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(Volatile.Read(ref _disposed) != 0, this);
    }
}
