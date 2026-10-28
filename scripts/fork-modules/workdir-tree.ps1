param([Parameter(Mandatory)][string]$Root, [switch]$Apply)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class WorkdirHandle {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, ref uint info, uint size);
    public static void DeleteReadOnlyEntry(string path) {
        using (var handle = CreateFileW(path, 0x10000, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            // FileDispositionInfoEx: DELETE | POSIX_SEMANTICS | IGNORE_READONLY_ATTRIBUTE (Windows 10 1809+).
            uint flags = 0x13;
            if (!SetFileInformationByHandle(handle, 21, ref flags, 4)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
'@
$Root = [IO.Path]::GetFullPath($Root)
$entries = [Collections.Generic.List[object]]::new()
$result = @{ path = $Root; status = 'skipped'; bytes = 0L; removedBytes = 0L; reason = ''; detail = '' }
function Assert-Parents([string]$Path) {
    $parent = [IO.Path]::GetDirectoryName($Path)
    while ($parent) {
        if ([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) {
            throw "reparse-parent: $parent"
        }
        $parent = [IO.Path]::GetDirectoryName($parent)
    }
}
function Read-Tree([string]$Path) {
    $attributes = [IO.File]::GetAttributes($Path)
    $link = [bool]($attributes -band [IO.FileAttributes]::ReparsePoint)
    $directory = [bool]($attributes -band [IO.FileAttributes]::Directory)
    $size = if (!$link -and !$directory) { ([IO.FileInfo]::new($Path)).Length } else { 0L }
    $entries.Add(@{ path = $Path; directory = $directory; link = $link; bytes = $size })
    $result.bytes += $size
    if ($directory -and !$link) {
        foreach ($child in [IO.Directory]::EnumerateFileSystemEntries($Path)) { Read-Tree $child }
    }
}
try {
    Assert-Parents $Root
    $attributes = [IO.File]::GetAttributes($Root)
    if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
        $result.reason = 'reparse'
    } elseif (!($attributes -band [IO.FileAttributes]::Directory)) {
        $result.reason = 'not-directory'
    } else {
        Read-Tree $Root
        # Request DELETE access without deleting: detect deny-delete handles before removing any entries.
        foreach ($entry in $entries) {
            $handle = [WorkdirHandle]::CreateFileW($entry.path, 0x10000, 7, [IntPtr]::Zero, 3, 0x02200000, [IntPtr]::Zero)
            $winError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            try {
                if ($handle.IsInvalid) {
                    $result.reason = if ($winError -in 32,33) { 'locked' } else { 'inaccessible' }
                    $result.detail = "$($entry.path) (Win32 $winError)"
                    break
                }
            } finally { $handle.Dispose() }
        }
        if (!$result.reason) {
            if ($Apply) {
                for ($i = $entries.Count - 1; $i -ge 0; $i--) {
                    $entry = $entries[$i]
                    Assert-Parents $entry.path
                    # Non-recursive removal also removes a junction entry without following its target.
                    if ([IO.File]::GetAttributes($entry.path) -band [IO.FileAttributes]::ReadOnly) {
                        # Do not clear the attribute: a hardlink elsewhere may share it.
                        [WorkdirHandle]::DeleteReadOnlyEntry($entry.path)
                    } elseif ($entry.directory) { [IO.Directory]::Delete($entry.path) }
                    else { [IO.File]::Delete($entry.path) }
                    $result.removedBytes += $entry.bytes
                }
                $result.status = 'removed'
            } else { $result.status = 'would-remove' }
        }
    }
} catch {
    $winError = $_.Exception.HResult -band 0xffff
    $result.reason = if ($winError -in 32,33) { 'locked' } elseif ($_.Exception.Message -like '*reparse-parent:*') { 'reparse-parent' } else { 'removal-or-scan-failed' }
    $result.detail = $_.Exception.Message
}
$result | ConvertTo-Json -Compress
