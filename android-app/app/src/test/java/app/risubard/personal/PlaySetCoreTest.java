package app.risubard.personal;

import java.io.ByteArrayInputStream;
import java.nio.file.Files;
import java.util.UUID;
import org.junit.Test;
import static org.junit.Assert.*;

public class PlaySetCoreTest {
    @Test public void closedTransportCannotBeRestarted() throws Exception {
        PlaySetTransport transport = new PlaySetTransport(null);
        transport.close();
        assertThrows(java.io.IOException.class, transport::start);
    }
    @Test public void sessionReadCannotCancelAlreadyAdmittedFifthAttempt() throws Exception {
        try (PlaySetTransport transport = new PlaySetTransport(null)) {
            transport.registration();
            java.lang.reflect.Field field = PlaySetTransport.class.getDeclaredField("registration"); field.setAccessible(true);
            PlaySetPairingWindow window = (PlaySetPairingWindow) field.get(transport);
            for (int i = 0; i < 4; i++) window.beginAttempt(UUID.randomUUID().toString()).close();
            try (PlaySetPairing fifth = window.beginAttempt(UUID.randomUUID().toString())) {
                java.lang.reflect.Method session = PlaySetTransport.class.getDeclaredMethod("session"); session.setAccessible(true);
                assertEquals("-", session.invoke(transport));
                assertThrows(IllegalStateException.class, () -> window.beginAttempt(UUID.randomUUID().toString()));
                final boolean[] saved = {false}; window.commit(() -> saved[0] = true);
                assertTrue(saved[0]); assertFalse(window.isActive());
            }
        }
    }

    @Test public void registrationBudgetIsNotReusable() throws Exception {
        try (PlaySetPairingWindow window = new PlaySetPairingWindow()) {
            assertTrue(window.displayCode().matches("[0-9]{6}"));
            for (int i = 0; i < 5; i++) window.beginAttempt(UUID.randomUUID().toString()).close();
            assertThrows(IllegalStateException.class, () -> window.beginAttempt(UUID.randomUUID().toString()));
        }
        PlaySetPairingWindow consumed = new PlaySetPairingWindow(); consumed.complete();
        assertThrows(IllegalStateException.class, consumed::displayCode);
    }
    @Test public void unexpectedRoundOrderFailsBeforeDerivation() throws Exception {
        try (PlaySetPairing p = new PlaySetPairing(UUID.randomUUID().toString(), UUID.randomUUID().toString(), "123456".toCharArray())) {
            assertThrows(IllegalStateException.class, () -> p.accept2("invalid"));
            assertThrows(IllegalStateException.class, () -> p.accept3("invalid"));
            assertThrows(IllegalStateException.class, () -> p.binding("a".repeat(64)));
        }
    }
    @Test public void invalidIncomingArchiveLeavesNoOrphan() throws Exception {
        java.io.File dir = Files.createTempDirectory("risuplay-invalid-").toFile();
        try (PlaySetArchive archive = new PlaySetArchive(dir)) {
            assertThrows(Exception.class, () -> archive.receive(new ByteArrayInputStream(new byte[] { 0, 1, 2, 3 })));
            assertEquals(0, dir.list().length);
        }
    }
    @Test public void startupSweepsOnlyUnfinishedUuidParts() throws Exception {
        java.io.File dir = Files.createTempDirectory("risuplay-restart-").toFile();
        String id = UUID.randomUUID().toString();
        Files.write(new java.io.File(dir, id + ".part").toPath(), new byte[] { 1 });
        Files.write(new java.io.File(dir, id + ".risuplay").toPath(), new byte[] { 2 });
        Files.write(new java.io.File(dir, "unrelated.part").toPath(), new byte[] { 3 });
        try (PlaySetArchive archive = new PlaySetArchive(dir)) {
            assertFalse(new java.io.File(dir, id + ".part").exists());
            assertTrue(new java.io.File(dir, id + ".risuplay").exists());
            assertTrue(new java.io.File(dir, "unrelated.part").exists());
        }
    }
    @Test public void secondOwnerCannotSweepAnActiveArchiveWriter() throws Exception {
        java.io.File dir = Files.createTempDirectory("risuplay-recreate-").toFile();
        try (PlaySetArchive first = new PlaySetArchive(dir)) {
            String id = first.begin();
            first.beginEntry(id, "manifest.json", 2);
            first.append(id, "{}".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            try (PlaySetArchive second = new PlaySetArchive(dir)) {
                assertTrue(new java.io.File(dir, id + ".part").exists());
                first.endEntry(id);
                assertEquals(id, first.finish(id));
                assertTrue(second.file(id).isFile());
                assertEquals(1, second.entries(id).size());
            }
        }
    }
}
