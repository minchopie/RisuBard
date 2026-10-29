package app.risubard.personal

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.security.spec.ECGenParameterSpec
import java.util.Date
import java.util.concurrent.ConcurrentHashMap
import javax.net.ssl.KeyManagerFactory
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import javax.net.ssl.X509KeyManager
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.SSLEngine
import java.net.Socket
import java.security.Principal
import javax.security.auth.x500.X500Principal

/** Foreground NSD and hardware/OS-keystore TLS identity. Discovery is only a hint, never authentication. */
class PlaySetNetwork(private val context: Context, private val hostFactory: (SSLContext) -> PlaySetTransport.Host) {
    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val discovered = ConcurrentHashMap<String, JSONObject>()
    private val trustFile = AtomicFile(File(context.filesDir, "play-set-trust.json"))
    private val trustLock = Any()
    private val tls = identity()
    private val host = hostFactory(tls)
    val transport = PlaySetTransport(host)
    @Volatile private var started = false
    private var resolverBusy = false
    private var resolutionEpoch = 0L
    private val resolverTimer = android.os.Handler(android.os.Looper.getMainLooper())
    private val resolutionQueue = java.util.ArrayDeque<NsdServiceInfo>()
    private val registrationListener = object : NsdManager.RegistrationListener {
        override fun onServiceRegistered(info: NsdServiceInfo) {}
        override fun onRegistrationFailed(info: NsdServiceInfo, error: Int) { lastError = "기기 공개 실패: $error" }
        override fun onServiceUnregistered(info: NsdServiceInfo) {}
        override fun onUnregistrationFailed(info: NsdServiceInfo, error: Int) {}
    }
    @Volatile var lastError = ""
        private set
    private val discoveryListener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(type: String) {}
        override fun onDiscoveryStopped(type: String) {}
        override fun onStartDiscoveryFailed(type: String, error: Int) { lastError = "기기 검색 실패: $error" }
        override fun onStopDiscoveryFailed(type: String, error: Int) {}
        override fun onServiceFound(info: NsdServiceInfo) {
            if (info.serviceType.trimEnd('.') != TYPE.trimEnd('.')) return
            synchronized(resolutionQueue) { if (started) { resolutionQueue.add(info); resolveNext() } }
        }
        override fun onServiceLost(info: NsdServiceInfo) { discovered.entries.removeIf { it.value.optString("service") == info.serviceName } }
    }
    @Suppress("DEPRECATION")
    private fun resolveNext() {
        if (resolverBusy || resolutionQueue.isEmpty()) return
        resolverBusy = true
        val info = resolutionQueue.removeFirst()
        val epoch = ++resolutionEpoch
        val timeout = Runnable {
            synchronized(resolutionQueue) {
                if (epoch == resolutionEpoch && resolverBusy) {
                    resolutionEpoch++; resolverBusy = false
                    lastError = "기기 주소 확인 시간이 초과되었습니다. 검색을 계속합니다."
                    resolveNext()
                }
            }
        }
        resolverTimer.postDelayed(timeout, 10_000)
        val listener = object : NsdManager.ResolveListener {
            private fun done() { synchronized(resolutionQueue) {
                if (epoch != resolutionEpoch) return
                resolverTimer.removeCallbacks(timeout); resolverBusy = false; resolutionEpoch++; resolveNext()
            } }
            override fun onResolveFailed(service: NsdServiceInfo, error: Int) { done() }
            override fun onServiceResolved(service: NsdServiceInfo) {
                synchronized(resolutionQueue) {
                    if (epoch != resolutionEpoch || !started) return
                    try {
                        val id = service.attributes["id"]?.toString(Charsets.UTF_8) ?: return
                        if (java.util.UUID.fromString(id).toString() != id || id == host.deviceId()) return
                        val address = service.host?.hostAddress ?: return
                        if (service.host.isAnyLocalAddress || service.host.isMulticastAddress || service.port !in 1..65535) return
                        val name = service.attributes["name"]?.toString(Charsets.UTF_8)?.take(80) ?: "RisuAI"
                        discovered[id] = JSONObject().put("id", id).put("name", name).put("address", address).put("port", service.port).put("service", service.serviceName).put("seenAt", System.currentTimeMillis())
                    } catch (_: Exception) {} finally { done() }
                }
            }
        }
        try { nsd.resolveService(info, listener) }
        catch (_: Exception) { listener.onResolveFailed(info, -1) }
    }

    @Synchronized fun start() {
        if (started) return
        val port = transport.start(); started = true
        val service = NsdServiceInfo().apply { serviceName = "RisuPlay-" + this@PlaySetNetwork.host.deviceId(); serviceType = TYPE; setPort(port); setAttribute("id", this@PlaySetNetwork.host.deviceId()); setAttribute("name", this@PlaySetNetwork.host.name().take(80)) }
        nsd.registerService(service, NsdManager.PROTOCOL_DNS_SD, registrationListener)
        nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
    }
    fun devices(): JSONArray {
        val out = JSONArray()
        discovered.values.sortedBy { it.optString("name") }.forEach { item ->
            out.put(JSONObject(item.toString()).put("registered", pin(item.getString("id")) != null))
        }
        return out
    }
    fun endpoint(id: String): JSONObject = discovered[id] ?: error("기기를 찾을 수 없습니다. 같은 Wi-Fi에서 앱을 열어 주세요.")
    private fun trust(): JSONObject {
        if (!trustFile.baseFile.exists() && !File(trustFile.baseFile.path + ".bak").exists()) return JSONObject()
        return JSONObject(trustFile.openRead().use { it.readBytes().toString(Charsets.UTF_8) })
    }
    fun pin(id: String): String? = synchronized(trustLock) { trust().optJSONObject(id)?.optString("spki") }
    fun remember(id: String, name: String, spki: String) = synchronized(trustLock) {
        require(java.util.UUID.fromString(id).toString() == id && spki.matches(Regex("[a-f0-9]{64}")))
        val next = trust().put(id, JSONObject().put("name", name).put("spki", spki))
        val out = trustFile.startWrite()
        try { out.write(next.toString().toByteArray(Charsets.UTF_8)); trustFile.finishWrite(out) } catch (e: Exception) { trustFile.failWrite(out); throw e }
    }
    fun forget(id: String) = synchronized(trustLock) {
        val next = trust(); next.remove(id); val out = trustFile.startWrite()
        try { out.write(next.toString().toByteArray(Charsets.UTF_8)); trustFile.finishWrite(out) } catch (e: Exception) { trustFile.failWrite(out); throw e }
    }
    @Synchronized fun close() {
        if (started) {
            try { nsd.stopServiceDiscovery(discoveryListener) } catch (_: Exception) {}
            try { nsd.unregisterService(registrationListener) } catch (_: Exception) {}
        }
        synchronized(resolutionQueue) {
            started = false; resolutionEpoch++; resolverBusy = false; resolutionQueue.clear(); resolverTimer.removeCallbacksAndMessages(null)
        }
        transport.close(); discovered.clear()
    }
    private fun identity(): SSLContext {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        // Conscrypt signs an already hashed TLS transcript with NONEwithECDSA.
        // v1 allowed SHA-256 only, which Keystore rejects as INCOMPATIBLE_DIGEST.
        // Key authorizations are immutable. Keep v1 and all app data, create v2,
        // and explicitly select it so KeyManager cannot pick the unusable v1 key.
        val alias = "risuplay-tls-v2"
        if (!store.containsAlias(alias)) {
            val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
            generator.initialize(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1")).setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
                .setCertificateSubject(X500Principal("CN=RisuPlay")).setCertificateSerialNumber(BigInteger(128, SecureRandom()).abs())
                .setCertificateNotBefore(Date(System.currentTimeMillis() - 86_400_000L)).setCertificateNotAfter(Date(System.currentTimeMillis() + 315_360_000_000L)).build())
            generator.generateKeyPair()
        }
        val managers = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm()).apply { init(store, null) }
        val delegate = managers.keyManagers.filterIsInstance<X509KeyManager>().first()
        val identityManager = object : X509ExtendedKeyManager() {
            override fun getClientAliases(type: String?, issuers: Array<out Principal>?): Array<String>? =
                delegate.getClientAliases(type, issuers)?.takeIf { alias in it }?.let { arrayOf(alias) }
            override fun getServerAliases(type: String?, issuers: Array<out Principal>?): Array<String>? =
                delegate.getServerAliases(type, issuers)?.takeIf { alias in it }?.let { arrayOf(alias) }
            override fun chooseClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String? =
                types?.firstOrNull { getClientAliases(it, issuers) != null }?.let { alias }
            override fun chooseServerAlias(type: String?, issuers: Array<out Principal>?, socket: Socket?): String? =
                getServerAliases(type, issuers)?.firstOrNull()
            override fun chooseEngineClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?): String? =
                chooseClientAlias(types, issuers, null)
            override fun chooseEngineServerAlias(type: String?, issuers: Array<out Principal>?, engine: SSLEngine?): String? =
                chooseServerAlias(type, issuers, null)
            override fun getCertificateChain(name: String?) = if (name == alias) delegate.getCertificateChain(alias) else null
            override fun getPrivateKey(name: String?) = if (name == alias) delegate.getPrivateKey(alias) else null
        }
        val validator = object : X509TrustManager {
            // Both identities are checked at RPT2 admission, before receiving any file. The PAKE channel
            // must first accept an unknown self-signed certificate to bind it to the one-time code.
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { require(chain.isNotEmpty()); chain[0].checkValidity() }
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) { require(chain.isNotEmpty()); chain[0].checkValidity() }
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        return SSLContext.getInstance("TLS").apply { init(arrayOf(identityManager), arrayOf(validator), SecureRandom()) }
    }
    companion object { const val TYPE = "_risuplay._tcp." }
}
