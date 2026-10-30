import app.risubard.personal.PlaySetArchive;
import java.io.*;
import java.nio.file.*;
import java.util.*;

public class ArchiveDriver {
    public static void main(String[] args) throws Exception {
        try (PlaySetArchive store = new PlaySetArchive(new File(args[0])); InputStream input = new FileInputStream(args[1])) {
            String received = store.receive(input);
            List<PlaySetArchive.Entry> entries = store.entries(received);
            PlaySetArchive.Entry big = entries.stream().filter(e -> e.name.startsWith("blobs/")).findFirst().orElseThrow();
            if (big.bytes <= 64L*1024*1024 || !store.digest(received, big.name, big.bytes).equals(big.name.substring(6))) throw new AssertionError("Large entry corrupted");
            String output = store.begin();
            for (PlaySetArchive.Entry entry : entries) {
                store.beginEntry(output, entry.name, entry.bytes);
                String reader = store.openEntry(received, entry.name);
                try { byte[] chunk; while ((chunk = store.readChunk(reader)).length > 0) store.append(output, chunk); }
                finally { store.closeEntry(reader); }
                store.endEntry(output);
            }
            store.finish(output);
            Files.writeString(Path.of(args[0], "java-result.txt"), store.file(output).getAbsolutePath());
            try { PlaySetArchive.entryName("../database.bin"); throw new AssertionError("Traversal accepted"); } catch (IllegalArgumentException expected) { }
            System.out.println("PASS C# -> Java streaming 65 MiB ZIP, digest, re-export and traversal guard");
        }
    }
}
