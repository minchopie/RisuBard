package app.risubard.personal

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import android.content.Intent
import android.net.Uri
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit
import java.security.KeyStore

class RuntimeInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun onStart() {
        val report = Bundle()
        try {
            check(BuildConfig.DEBUG)
            EmbeddedServer.start(targetContext)
            val oldHash = java.security.MessageDigest.getInstance("SHA-256").digest(java.util.UUID.randomUUID().toString().toByteArray()).joinToString("") { "%02x".format(it) }
            val oldRuntime = File(targetContext.filesDir, "runtime/$oldHash")
            check(!oldRuntime.exists())
            val oldBackup = File(oldRuntime, "backups/prototype-backup.bin").apply { parentFile!!.mkdirs(); writeText("preserved prototype backup") }
            val emptyHash = java.security.MessageDigest.getInstance("SHA-256").digest(java.util.UUID.randomUUID().toString().toByteArray()).joinToString("") { "%02x".format(it) }
            val emptyRuntime = File(targetContext.filesDir, "runtime/$emptyHash")
            check(!emptyRuntime.exists())
            check(File(emptyRuntime, "backups").mkdirs())
            val preserved = File(targetContext.filesDir, "user-data/runtime-probe-preservation.txt")
            preserved.writeText("synthetic chat preservation marker")
            KeyStore.getInstance("AndroidKeyStore").apply { load(null); deleteEntry("risubard-embedded-v1") }
            var session = EmbeddedServer.start(targetContext)
            check(oldBackup.readText() == "preserved prototype backup")
            check(!emptyRuntime.exists())
            check(oldRuntime.deleteRecursively())
            report.putString("prototypeBackup", "nonempty backups retained; empty-backup-only old runtime removed")
            check(preserved.readText() == "synthetic chat preservation marker")
            val originField = EmbeddedServer::class.java.getDeclaredField("origin").apply { isAccessible = true }
            val processField = EmbeddedServer::class.java.getDeclaredField("process").apply { isAccessible = true }
            val closedPort = java.net.ServerSocket(0).use { it.localPort }
            originField.set(null, "http://127.0.0.1:$closedPort")
            try { EmbeddedServer.start(targetContext); error("closed listener accepted") }
            catch (_: java.net.ConnectException) { check(processField.get(null) == null) }
            session = EmbeddedServer.start(targetContext)
            val running = processField.get(null) as Process
            java.net.ServerSocket(0).use { stalled ->
                originField.set(null, "http://127.0.0.1:${stalled.localPort}")
                try { EmbeddedServer.start(targetContext); error("stalled listener accepted") }
                catch (_: java.net.SocketTimeoutException) {
                    check(processField.get(null) === running && running.isAlive)
                } finally { originField.set(null, session.origin) }
            }
            session = EmbeddedServer.start(targetContext)
            check(preserved.readText() == "synthetic chat preservation marker")
            val http = OkHttpClient()
            check(session.cookie.contains("HttpOnly") && session.cookie.contains("SameSite=Strict"))
            val auth = http.newCall(Request.Builder().url(session.origin + "/api/test_auth")
                .header("Cookie", session.cookie.substringBefore(';')).build()).execute().use {
                    check(it.isSuccessful); JSONObject(checkNotNull(it.body).string())
                }
            check(auth.getString("status") == "success")
            http.newCall(Request.Builder().url(session.origin + "/api/session/lock-status")
                .header("risu-auth", auth.getString("token")).header("x-session-id", "runtime-probe").build()).execute().use {
                    check(JSONObject(checkNotNull(it.body).string()).getString("state") == "free")
                }
            val hash = targetContext.assets.open("runtime.sha256").bufferedReader().use { it.readText().trim() }
            val root = File(targetContext.filesDir, "runtime/$hash")
            val output = File(targetContext.cacheDir, "runtime-probe-result.json")
            val process = ProcessBuilder(File(targetContext.applicationInfo.nativeLibraryDir, "libnode.so").absolutePath,
                "scripts/android/runtime-probe.cjs", File(targetContext.filesDir, "runtime-probe-data").absolutePath,
                session.origin, File(targetContext.filesDir, "user-data").absolutePath)
                .directory(root).redirectErrorStream(true).redirectOutput(output).start()
            check(process.waitFor(60, TimeUnit.SECONDS)) { "probe timeout" }
            check(process.exitValue() == 0) { output.readText().take(4000) }
            report.putString("runtime", output.readText())
            report.putString("auth", "session cookie success; writer free")
            report.putString("credentialRecovery", "Keystore key recreated; user-data marker preserved; running server restarted")
            report.putString("connectionRecovery", "Connection refused resets process; retry succeeds; read timeout preserves running server")
            val recoveryRoot = File(targetContext.filesDir, "user-data/trash/shutdown-recovery").apply { mkdirs() }
            val recoveryFile = File(recoveryRoot, "${java.util.UUID.randomUUID()}.bin")
            val linkedFile = File(recoveryRoot, "${java.util.UUID.randomUUID()}.bin")
            val exported = File(targetContext.cacheDir, "recovery-export-probe.bin")
            recoveryFile.writeText("synthetic recovery bytes")
            java.nio.file.Files.createSymbolicLink(linkedFile.toPath(), recoveryFile.toPath())
            var activity = startActivitySync(Intent(targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            try {
                runOnMainSync {
                    val listing = MainActivity::class.java.getDeclaredMethod("recoveryFiles").apply { isAccessible = true }
                    val files = listing.invoke(activity) as List<*>
                    check(files.contains(recoveryFile) && !files.contains(linkedFile))
                    MainActivity::class.java.getDeclaredField("recoveryExport").apply { isAccessible = true }.set(activity, recoveryFile)
                    MainActivity::class.java.getDeclaredMethod("onActivityResult", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Intent::class.java)
                        .apply { isAccessible = true }.invoke(activity, 102, Activity.RESULT_OK, Intent().setData(Uri.fromFile(exported)))
                }
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (!exported.isFile || exported.readText() != "synthetic recovery bytes") {
                    check(System.nanoTime() < deadline) { "recovery export timeout" }; Thread.sleep(100)
                }
                check(recoveryFile.readText() == "synthetic recovery bytes")
                report.putString("recoveryExport", "app-private recovery listed; symlink rejected; selected file copied through ContentResolver; original preserved (system picker not automated)")
                val archive = File(targetContext.filesDir, "play-sets/archives/${java.util.UUID.randomUUID()}.risuplay")
                archive.parentFile!!.mkdirs()
                java.util.zip.ZipOutputStream(archive.outputStream()).use { zip ->
                    zip.putNextEntry(java.util.zip.ZipEntry("manifest.json")); zip.write("{}".toByteArray()); zip.closeEntry()
                }
                val uri = androidx.core.content.FileProvider.getUriForFile(targetContext, "${targetContext.packageName}.playsets", archive)
                val inbox = File(targetContext.filesDir, "play-sets/state/inbox.json")
                val initialIds = if (inbox.exists()) org.json.JSONArray(inbox.readText()).let { rows -> (0 until rows.length()).map { rows.getJSONObject(it).getString("id") }.toSet() } else emptySet()
                val monitor = addMonitor(MainActivity::class.java.name, null, false)
                runOnMainSync {
                    MainActivity::class.java.getDeclaredField("transferPageLocal").apply { isAccessible = true }.setBoolean(activity, false)
                    MainActivity::class.java.getDeclaredMethod("onActivityResult", Int::class.javaPrimitiveType, Int::class.javaPrimitiveType, Intent::class.java)
                        .apply { isAccessible = true }.invoke(activity, PlaySetController.OPEN_FILE, Activity.RESULT_OK, Intent().setData(uri))
                    check((MainActivity::class.java.getDeclaredField("receivedIntent").apply { isAccessible = true }.get(activity) as Intent).data == uri)
                    callActivityOnNewIntent(activity, Intent(Intent.ACTION_MAIN))
                    check((MainActivity::class.java.getDeclaredField("receivedIntent").apply { isAccessible = true }.get(activity) as Intent).data == uri)
                    activity.recreate()
                }
                activity = checkNotNull(waitForMonitorWithTimeout(monitor, 15_000)) { "recreated activity missing" }
                removeMonitor(monitor)
                val receiveDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                while (true) {
                    val rows = if (inbox.exists()) org.json.JSONArray(inbox.readText()) else org.json.JSONArray()
                    if ((0 until rows.length()).any { !initialIds.contains(rows.getJSONObject(it).getString("id")) }) break
                    check(System.nanoTime() < receiveDeadline) { "picker result lost across recreation" }; Thread.sleep(100)
                }
                archive.delete()
                report.putString("pickerRecovery", "buffered result survives real Activity recreation and reaches the durable native inbox")
            } finally {
                runOnMainSync { activity.finish() }
                linkedFile.delete(); recoveryFile.delete(); exported.delete()
            }
            finish(Activity.RESULT_OK, report)
        } catch (error: Throwable) {
            report.putString("failure", error.stackTraceToString().take(5000))
            finish(Activity.RESULT_CANCELED, report)
        }
    }
}
