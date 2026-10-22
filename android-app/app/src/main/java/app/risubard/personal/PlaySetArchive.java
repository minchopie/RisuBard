package app.risubard.personal;

import java.io.*;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.*;
import java.util.zip.*;

/** Streaming ZIP64-capable private staging store. All callers use opaque UUID handles. */
public final class PlaySetArchive implements AutoCloseable {
    public static final int CHUNK = 256 * 1024;
    private static final Set<File> recoveredRoots = new HashSet<>();
    private final File root;
    private final Map<String, Writer> writers = new HashMap<>();
    private final Map<String, Reader> readers = new HashMap<>();
    public static final class Entry {
        public final String name; public final long bytes;
        Entry(String name, long bytes) { this.name = name; this.bytes = bytes; }
    }
    private static final class Writer {
        final FileOutputStream file; final ZipOutputStream zip;
        long expected, written; MessageDigest hash; String entry;
        final Set<String> names = new HashSet<>();
        Writer(File target) throws Exception { file = new FileOutputStream(target); zip = new ZipOutputStream(new BufferedOutputStream(file)); }
    }
    private static final class Reader {
        final ZipFile zip; final InputStream input; final long expected; long read; long touched = System.nanoTime();
        Reader(File source, String name) throws Exception {
            zip = new ZipFile(source);
            ZipEntry entry = zip.getEntry(name);
            if (entry == null) { zip.close(); throw new IOException("Missing entry"); }
            expected = entry.getSize(); input = zip.getInputStream(entry);
        }
        void close() throws Exception { try { input.close(); } finally { zip.close(); } }
    }
    public PlaySetArchive(File root) throws IOException { this.root = root.getCanonicalFile(); if (!this.root.isDirectory() && !this.root.mkdirs()) throw new IOException("Cannot create play-set store");
        // Recover once per process, not per Activity: a retiring controller can
        // still own a partial stream when its replacement is constructed.
        synchronized (recoveredRoots) {
            if (!recoveredRoots.contains(this.root)) {
                File[] parts = this.root.listFiles((dir, name) -> name.matches("[a-f0-9-]{36}\\.part"));
                if (parts != null) for (File part : parts) Files.deleteIfExists(part.toPath());
                recoveredRoots.add(this.root);
            }
        }
    }
    private static void handle(String id) { if (!UUID.fromString(id).toString().equals(id)) throw new IllegalArgumentException("Invalid handle"); }
    public static void entryName(String name) {
        if (!name.equals("manifest.json") && !name.matches("(records/[a-f0-9]{64}\\.json|blobs/[a-f0-9]{64})")) throw new IllegalArgumentException("Invalid ZIP member");
    }
    public File file(String id) { handle(id); return new File(root, id + ".risuplay"); }
    private File partial(String id) { handle(id); return new File(root, id + ".part"); }
    public long availableBytes() { return root.getUsableSpace(); }
    public synchronized String begin() throws Exception {
        String id = UUID.randomUUID().toString(); writers.put(id, new Writer(partial(id))); return id;
    }
    private Writer writer(String id) { Writer w = writers.get(id); if (w == null) throw new IllegalArgumentException("Unknown writer"); return w; }
    public synchronized void beginEntry(String id, String name, long bytes) throws Exception {
        entryName(name); Writer w = writer(id);
        if (w.entry != null || !w.names.add(name) || bytes < 0 || bytes > availableBytes()) throw new IOException("Invalid entry or insufficient space");
        w.entry = name; w.expected = bytes; w.written = 0; w.hash = MessageDigest.getInstance("SHA-256");
        w.zip.putNextEntry(new ZipEntry(name));
    }
    public synchronized void append(String id, byte[] chunk) throws Exception {
        Writer w = writer(id);
        if (w.entry == null || chunk.length > CHUNK || chunk.length > w.expected - w.written || chunk.length > availableBytes()) throw new IOException("Invalid chunk or insufficient space");
        w.zip.write(chunk); w.hash.update(chunk); w.written += chunk.length;
    }
    public synchronized void endEntry(String id) throws Exception {
        Writer w = writer(id);
        if (w.entry == null || w.written != w.expected) throw new IOException("Incomplete entry");
        String digest = hex(w.hash.digest());
        if (!w.entry.equals("manifest.json") && !w.entry.contains(digest)) throw new IOException("Entry hash mismatch");
        w.zip.closeEntry(); w.entry = null;
    }
    public synchronized String finish(String id) throws Exception {
        Writer w = writer(id);
        if (w.entry != null || !w.names.contains("manifest.json")) throw new IOException("Incomplete archive");
        w.zip.finish(); w.zip.flush(); w.file.getFD().sync(); w.zip.close(); writers.remove(id);
        Files.move(partial(id).toPath(), file(id).toPath(), StandardCopyOption.ATOMIC_MOVE);
        return id;
    }
    /** Copy incoming stream incrementally, fsync and retain until explicit queue processing/cancel. */
    public String receive(InputStream source) throws Exception {
        String id = UUID.randomUUID().toString();
        long budget = availableBytes() / 2, received = 0;
        try {
          try (FileOutputStream output = new FileOutputStream(partial(id))) {
            byte[] buffer = new byte[CHUNK]; int n;
            while ((n = source.read(buffer)) != -1) {
                received = Math.addExact(received, n);
                if (n > availableBytes() || received > budget) throw new IOException("Insufficient storage");
                output.write(buffer, 0, n);
            }
            output.getFD().sync();
          }
          inspect(partial(id));
          Files.move(partial(id).toPath(), file(id).toPath(), StandardCopyOption.ATOMIC_MOVE);
          return id;
        } catch (Exception error) {
          Files.deleteIfExists(partial(id).toPath());
          throw error;
        }
    }
    public List<Entry> entries(String id) throws Exception {
        return inspect(file(id));
    }
    private List<Entry> inspect(File path) throws Exception {
        List<Entry> out = new ArrayList<>(); Set<String> names = new HashSet<>(); long total = 0;
        try (ZipFile zip = new ZipFile(path)) {
            Enumeration<? extends ZipEntry> entries = zip.entries();
            while (entries.hasMoreElements()) {
                ZipEntry e = entries.nextElement(); entryName(e.getName());
                if (e.isDirectory() || !names.add(e.getName()) || e.getSize() < 0) throw new IOException("Invalid ZIP structure");
                total = Math.addExact(total, e.getSize());
                if (total > availableBytes() / 2) throw new IOException("Insufficient expanded storage");
                out.add(new Entry(e.getName(), e.getSize()));
            }
        }
        if (!names.contains("manifest.json")) throw new IOException("Missing manifest");
        return out;
    }
    public String digest(String id, String name, long expected) throws Exception {
        entryName(name); MessageDigest hash = MessageDigest.getInstance("SHA-256"); long count = 0;
        try (ZipFile zip = new ZipFile(file(id))) {
            ZipEntry entry = zip.getEntry(name);
            if (entry == null || entry.getSize() != expected) throw new IOException("Unexpected entry size");
            try (InputStream input = zip.getInputStream(entry)) {
                byte[] buffer = new byte[CHUNK]; int n;
                while ((n = input.read(buffer)) != -1) { count = Math.addExact(count, n); if (count > expected) throw new IOException("Expanded size exceeded"); hash.update(buffer, 0, n); }
            }
        }
        if (count != expected) throw new IOException("Truncated entry"); return hex(hash.digest());
    }
    public synchronized String openEntry(String id, String name) throws Exception {
        entryName(name);
        for (String key : new ArrayList<>(readers.keySet())) if (System.nanoTime() - readers.get(key).touched > java.util.concurrent.TimeUnit.MINUTES.toNanos(5)) closeEntry(key);
        if (readers.size() >= 64) throw new IOException("Too many open archive readers");
        String token = UUID.randomUUID().toString(); readers.put(token, new Reader(file(id), name)); return token;
    }
    public synchronized byte[] readChunk(String token) throws Exception {
        Reader reader = readers.get(token); if (reader == null) throw new IOException("Unknown reader");
        reader.touched = System.nanoTime();
        byte[] chunk = new byte[CHUNK]; int n = reader.input.read(chunk);
        if (n < 0) { if (reader.read != reader.expected) throw new IOException("Truncated entry"); return new byte[0]; }
        reader.read = Math.addExact(reader.read, n);
        if (reader.read > reader.expected) throw new IOException("Expanded size exceeded"); return Arrays.copyOf(chunk, n);
    }
    public synchronized void closeEntry(String token) throws Exception { Reader r = readers.remove(token); if (r != null) r.close(); }
    public synchronized void abort(String id) throws Exception { Writer w = writers.remove(id); if (w != null) { try { w.zip.close(); } finally { Files.deleteIfExists(partial(id).toPath()); } } }
    public void delete(String id) throws IOException { Files.deleteIfExists(file(id).toPath()); }
    private static String hex(byte[] data) { StringBuilder b = new StringBuilder(); for (byte v : data) b.append(String.format(Locale.ROOT, "%02x", v & 255)); return b.toString(); }
    @Override public synchronized void close() throws Exception {
        for (String id : new ArrayList<>(writers.keySet())) abort(id);
        for (String token : new ArrayList<>(readers.keySet())) closeEntry(token);
        // Completed incoming files and queue journals deliberately survive app destruction.
    }
}
