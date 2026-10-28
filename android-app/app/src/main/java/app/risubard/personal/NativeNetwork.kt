package app.risubard.personal

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import org.json.JSONObject

/** Pure helpers (JVM-tested): SSID text and transport names exactly as the web side and the server route expect them. */
object WifiNames {
    /** WifiInfo.ssid is quoted when known; "<unknown ssid>" (redacted or no permission) is not a name and never matches a home. */
    fun ssidOf(raw: String?): String? {
        if (raw == null) return null
        val name = if (raw.length >= 2 && raw.startsWith("\"") && raw.endsWith("\"")) raw.substring(1, raw.length - 1) else raw
        return if (name.isEmpty() || name == "<unknown ssid>" || name == "0x" || name.length > 64 || name.any { it < ' ' || it == '\u007f' }) null else name
    }
    /** A Wi-Fi network present (even under a VPN default route) is "wifi"; otherwise the default network's transport. */
    fun transportOf(wifi: Boolean, ethernet: Boolean, cellular: Boolean, any: Boolean): String = when {
        wifi -> "wifi"; !any -> "none"; ethernet -> "ethernet"; cellular -> "cellular"; else -> "unknown"
    }
}

/**
 * Foreground-only Wi-Fi identity for the NAS route. Requires ACCESS_FINE_LOCATION at runtime (the OS condition for reading an SSID);
 * no background location is requested. Without the permission the SSID is unknown and the route stays external. A callback on the
 * Wi-Fi transport (not the default network) keeps following the underlying Wi-Fi while a VPN is active and while the app stays open.
 */
class NativeNetwork(private val activity: Activity) {
    @Volatile private var wifiCaps: NetworkCapabilities? = null
    private var callback: ConnectivityManager.NetworkCallback? = null
    private val cm get() = activity.getSystemService(ConnectivityManager::class.java)
    fun granted() = activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private abstract class Base : ConnectivityManager.NetworkCallback {
        constructor() : super()
        @androidx.annotation.RequiresApi(31) constructor(flags: Int) : super(flags)
    }
    @Synchronized fun start() {
        if (callback != null) return
        val onCaps: (NetworkCapabilities) -> Unit = { wifiCaps = it }
        val onLost: () -> Unit = { wifiCaps = null }
        val cb = if (Build.VERSION.SDK_INT >= 31) object : Base(ConnectivityManager.NetworkCallback.FLAG_INCLUDE_LOCATION_INFO) {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = onCaps(caps)
            override fun onLost(network: Network) = onLost()
        } else object : Base() {
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) = onCaps(caps)
            override fun onLost(network: Network) = onLost()
        }
        val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
        runCatching { cm.registerNetworkCallback(request, cb) }.onSuccess { callback = cb }
    }
    @Synchronized fun stop() { callback?.let { runCatching { cm.unregisterNetworkCallback(it) } }; callback = null; wifiCaps = null }

    /** Current view: transport + SSID (null when unknown/redacted/not permitted) + permission state. Never cached beyond the live callback. */
    fun info(): JSONObject {
        val wifi = wifiCaps
        val default = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
        val transport = WifiNames.transportOf(wifi != null, default?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true,
            default?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true, default != null)
        var ssid: String? = null
        if (wifi != null && granted()) {
            val fromCaps = if (Build.VERSION.SDK_INT >= 29) (wifi.transportInfo as? WifiInfo)?.ssid else null
            @Suppress("DEPRECATION") val legacy = if (fromCaps == null && Build.VERSION.SDK_INT < 31)
                activity.applicationContext.getSystemService(WifiManager::class.java)?.connectionInfo?.ssid else null
            ssid = WifiNames.ssidOf(fromCaps ?: legacy)
        }
        return JSONObject().put("transport", transport).put("ssid", ssid ?: JSONObject.NULL).put("permission", if (granted()) "granted" else "denied")
    }
    /** Foreground permission prompt (ACCESS_FINE_LOCATION only). After a grant the callback is re-registered so it carries location info. */
    fun requestPermission(): String {
        if (granted()) { start(); return "granted" }
        // Android 12+: COARSE and FINE must be requested together (the SSID needs FINE); foreground only, no background location.
        activity.runOnUiThread { activity.requestPermissions(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION), REQUEST) }
        return "requested"
    }
    fun onPermissionResult() { if (granted()) { stop(); start() } }
    companion object { const val REQUEST = 7343 }
}
