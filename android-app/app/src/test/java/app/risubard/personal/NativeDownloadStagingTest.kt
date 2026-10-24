package app.risubard.personal

import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.Base64

class NativeDownloadStagingTest {
    @Test fun binaryChunksSurvivePickerRecreationAndCancellationAllowsRetry() {
        val root = Files.createTempDirectory("download-test").toFile()
        try {
            val stage = NativeDownload.Staging(root)
            val bytes = ByteArray(10 * 1024 * 1024 + 17) { (it % 251).toByte() }
            val handle = stage.begin()
            var at = 0
            while (at < bytes.size) {
                val end = minOf(at + 256 * 1024, bytes.size)
                stage.append(handle, at.toLong(), Base64.getEncoder().encodeToString(bytes.copyOfRange(at, end)))
                at = end
            }
            val target = stage.target(handle, "캐릭터_chat.json", bytes.size.toLong())
            assertEquals("application/x-risubard-export", target.mimeType)
            assertEquals("캐릭터_chat.json", target.fileName)
            val lifecycle = NativeDownload.Lifecycle()
            assertTrue(lifecycle.request(target)); assertFalse(lifecycle.request(target))
            val recreated = NativeDownload.Lifecycle().apply { restore(lifecycle.saved()) }
            val restored = recreated.pickerAnswered()!!
            val output = ByteArrayOutputStream()
            assertEquals(bytes.size.toLong(), NativeDownload.Staging(root).copy(restored) { output })
            assertArrayEquals(bytes, output.toByteArray())
            stage.discard(restored)
            assertFalse(java.io.File(root, handle).exists())
            val retry = stage.target(stage.begin(), "empty.txt", 0)
            assertTrue(recreated.request(retry))
            stage.discard(recreated.pickerAnswered()) // cancelled picker
            assertEquals(0, root.listFiles()!!.size)
        } finally { root.deleteRecursively() }
    }

    @Test fun restartClearsOnlyAbandonedExportsAndPreservesRestoredPicker() {
        val root = Files.createTempDirectory("download-recovery").toFile()
        try {
            val abandoned = java.io.File(root, java.util.UUID.randomUUID().toString()).apply { writeText("partial") }
            val pending = java.io.File(root, java.util.UUID.randomUUID().toString()).apply { writeText("keep") }
            val other = java.io.File(root, "unrelated").apply { writeText("keep") }
            val saved = NativeDownload.Target("risubard-export:${pending.name}", "preset.risup", "application/x-risubard-export")
            val stage = NativeDownload.Staging(root, saved)
            assertFalse(abandoned.exists()); assertTrue(pending.exists()); assertTrue(other.exists())
            assertEquals("preset.risup", stage.target(pending.name, "preset.risup", 4).fileName)
            val active = stage.begin()
            NativeDownload.Staging(root)
            assertTrue(java.io.File(root, active).exists())
        } finally { root.deleteRecursively() }
    }

    @Test fun rejectsWrongOffsetsIncompleteFilesAndPathsWithoutDamagingBytes() {
        val root = Files.createTempDirectory("download-test").toFile()
        try {
            val stage = NativeDownload.Staging(root)
            val handle = stage.begin()
            stage.append(handle, 0, "AP8=")
            assertThrows(IllegalArgumentException::class.java) { stage.append(handle, 0, "AA==") }
            assertThrows(IllegalArgumentException::class.java) { stage.target(handle, "chat.json", 3) }
            assertThrows(IllegalArgumentException::class.java) { stage.discard("../outside") }
            val target = stage.target(handle, "../chat.json", 2)
            assertFalse(target.fileName.contains('/'))
            val output = ByteArrayOutputStream()
            stage.copy(target) { output }
            assertArrayEquals(byteArrayOf(0, -1), output.toByteArray())
            assertThrows(java.io.IOException::class.java) { stage.copy(target) { throw java.io.IOException("provider failed") } }
            stage.discard(target)
        } finally { root.deleteRecursively() }
    }
}
