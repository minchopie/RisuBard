package app.risubard.personal

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.ServerSocket
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

internal object EmbeddedServer {
    data class Session(val origin: String, val cookie: String)
    private var process: Process? = null
    private var origin: String? = null
    private val http = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).readTimeout(5, TimeUnit.SECONDS).build()

    @Synchronized fun start(context: Context): Session {
        val app = context.applicationContext
        val data = File(app.filesDir, "user-data").apply { mkdirs() }
        val secret = InstallCredential(app).getOrCreate()
        val credentialFile = File(data, "__password")
        if (process?.isAlive == true && (!credentialFile.isFile || credentialFile.readText() != secret)) stop()
        if (process?.isAlive != true) {
            val runtime = unpack(app)
            val password = File(data, "__password")
            FileOutputStream(File(data, "__password.tmp")).use { it.write(secret.toByteArray()); it.fd.sync() }
            check(File(data, "__password.tmp").renameTo(password)) { "내부 인증 저장 실패" }
            val ready = File(data, ".android-server.json")
            check(!ready.exists() || ready.delete())
            val prefs = app.getSharedPreferences("runtime", Context.MODE_PRIVATE)
            val previous = prefs.getInt("port", 0)
            val port = try { ServerSocket(previous, 1, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort } }
                catch (_: java.io.IOException) { ServerSocket(0, 1, java.net.InetAddress.getByName("127.0.0.1")).use { it.localPort } }
            val builder = ProcessBuilder(File(app.applicationInfo.nativeLibraryDir, "libnode.so").absolutePath, "server/node/server.cjs")
                .directory(runtime).redirectErrorStream(true)
            builder.environment().apply {
                put("RISUBARD_DATA_ROOT", data.absolutePath)
                put("RISUBARD_EMBEDDED_ANDROID", "1")
                put("RISUBARD_NO_BACKUP_DIR", app.noBackupFilesDir.absolutePath) // NAS sync identity/vault/device key: never in any backup
                runCatching { TransferCredential.key(app) }.onSuccess { put("RISUBARD_TRANSFER_KEY", it) }
                if (BuildConfig.LOCAL_AI) put("RISUBARD_LOCAL_ENGINE", File(app.applicationInfo.nativeLibraryDir, "libllama-server.so").absolutePath)
                else remove("RISUBARD_LOCAL_ENGINE")
                put("PORT", port.toString())
                put("HOME", app.filesDir.absolutePath)
                put("TMPDIR", app.cacheDir.absolutePath)
                put("RISU_UPDATE_CHECK", "false")
                put("OPEN_BROWSER", "0")
                remove("NODE_OPTIONS"); remove("NODE_PATH")
            }
            // Keep server diagnostics in private storage; never forward bodies/credentials to logcat.
            val log = File(app.cacheDir, "embedded-server.log")
            if (log.length() > 2 * 1024 * 1024) {
                val previousLog = File(app.cacheDir, "embedded-server.previous.log")
                check(!previousLog.exists() || previousLog.delete())
                check(log.renameTo(previousLog))
            }
            builder.redirectOutput(ProcessBuilder.Redirect.appendTo(log))
            process = builder.start()
            try {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(90)
                while (!ready.exists()) {
                    check(process?.isAlive == true) { "내부 서버 시작 실패. 앱 진단 로그를 확인하세요." }
                    check(System.nanoTime() < deadline) { "내부 서버 시작 시간 초과" }
                    Thread.sleep(100)
                }
                val actualPort = JSONObject(ready.readText()).getInt("port")
                require(actualPort == port) { "내부 서버 포트가 변경됐어요. 다시 시도해 주세요." }
                origin = "http://127.0.0.1:$actualPort"
                check(prefs.edit().putInt("port", port).commit())
            } catch (error: Exception) {
                stop()
                throw error
            }
        }
        val address = checkNotNull(origin)
        val result = try { authenticate(address, secret) } catch (error: java.net.ConnectException) {
            // A closed listener cannot recover on retry while we keep reusing its process.
            stop()
            throw error
        }
        // Keep previous code until the new server has authenticated successfully.
        val base = File(app.filesDir, "runtime")
        val active = app.assets.open("runtime.sha256").bufferedReader().use { it.readText().trim() }
        base.listFiles()?.filter { it.name != active && it.name.matches(Regex("[a-f0-9]{64}(\\.part)?")) }
            ?.forEach { old ->
                runCatching {
                    // Early prototypes stored backups beside code; keep those directories recoverable.
                    val backups = File(old, "backups")
                    if (backups.exists() && backups.list()?.isEmpty() != true) return@runCatching
                    if (!java.nio.file.Files.isSymbolicLink(old.toPath()) && old.canonicalFile.parentFile == base.canonicalFile) {
                        java.nio.file.Files.walk(old.toPath()).use { paths ->
                            paths.sorted(Comparator.reverseOrder()).forEach { java.nio.file.Files.deleteIfExists(it) }
                        }
                    }
                }
            }
        return result
    }

    private fun authenticate(address: String, secret: String): Session {
        val login = Request.Builder().url("$address/api/login")
            .post(JSONObject().put("password", secret).toString().toRequestBody("application/json".toMediaType())).build()
        val token = http.newCall(login).execute().use { response ->
            check(response.isSuccessful) {
                if (response.code == 429) "내부 인증 재시도가 많아요. 잠시 후 다시 시도해 주세요." else "내부 서버 인증 실패"
            }
            JSONObject(checkNotNull(response.body).string()).getString("token")
        }
        // The WebView owns the writer session; native bootstrap must not send x-session-id.
        val session = Request.Builder().url("$address/api/session").header("risu-auth", token)
            .post("{}".toRequestBody("application/json".toMediaType())).build()
        return http.newCall(session).execute().use { response ->
            check(response.isSuccessful) { "내부 세션 생성 실패" }
            Session(address, checkNotNull(response.header("Set-Cookie")))
        }
    }

    private fun stop() {
        val child = process
        try {
            child?.let {
                try { it.outputStream.close() } catch (_: java.io.IOException) { it.destroy() }
                if (!it.waitFor(30, TimeUnit.SECONDS)) {
                    it.destroy()
                    if (!it.waitFor(5, TimeUnit.SECONDS)) it.destroyForcibly()
                }
            }
        } catch (error: InterruptedException) {
            child?.destroyForcibly()
            Thread.currentThread().interrupt()
            throw error
        } finally {
            process = null; origin = null
        }
    }

    private fun unpack(context: Context): File {
        val expected = context.assets.open("runtime.sha256").bufferedReader().use { it.readText().trim() }
        require(expected.matches(Regex("[a-f0-9]{64}")))
        val base = File(context.filesDir, "runtime").apply { mkdirs() }
        val target = File(base, expected)
        if (File(target, ".complete").isFile) return target
        val stage = File(base, "$expected.part")
        if (stage.exists()) check(stage.deleteRecursively())
        check(stage.mkdirs())
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            context.assets.open("runtime.zip").use { input ->
                java.security.DigestInputStream(input, digest).use { hashed ->
                    ZipInputStream(hashed).use { zip ->
                        while (true) {
                            val entry = zip.nextEntry ?: break
                            val file = File(stage, entry.name).canonicalFile
                            require(file.path.startsWith(stage.canonicalPath + File.separator)) { "런타임 경로 오류" }
                            if (entry.isDirectory) { file.mkdirs(); continue }
                            check(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs())
                            FileOutputStream(file).use { zip.copyTo(it); it.fd.sync() }
                        }
                        // Include the central directory/trailer that ZipInputStream does not consume.
                        val remaining = ByteArray(256 * 1024)
                        while (hashed.read(remaining) != -1) { }
                    }
                }
            }
            check(digest.digest().joinToString("") { "%02x".format(it) } == expected) { "런타임 해시 불일치" }
            FileOutputStream(File(stage, ".complete")).use { it.write(expected.toByteArray()); it.fd.sync() }
            check(stage.renameTo(target)) { "런타임 설치 실패" }
            return target
        } catch (error: Exception) { stage.deleteRecursively(); throw error }
    }
}
