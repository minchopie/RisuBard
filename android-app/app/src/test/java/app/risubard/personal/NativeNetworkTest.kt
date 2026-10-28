package app.risubard.personal

import org.junit.Assert.*
import org.junit.Test

/** JVM-only: the pure SSID/transport mapping the route depends on. Synthetic names only. */
class NativeNetworkTest {
    @Test fun ssidTextIsUnquotedAndUnknownOrRedactedIsNull() {
        assertEquals("Fixture Home", WifiNames.ssidOf("\"Fixture Home\""))
        assertEquals("plain", WifiNames.ssidOf("plain"))
        assertNull(WifiNames.ssidOf("<unknown ssid>")) // no permission / redacted on Android 12+
        assertNull(WifiNames.ssidOf("\"\"")); assertNull(WifiNames.ssidOf("0x")); assertNull(WifiNames.ssidOf(null))
        assertNull(WifiNames.ssidOf("bad\u0000name")); assertNull(WifiNames.ssidOf("x".repeat(65)))
    }
    @Test fun transportPrefersAnAvailableWifiEvenUnderAVpnDefaultRoute() {
        assertEquals("wifi", WifiNames.transportOf(wifi = true, ethernet = false, cellular = false, any = true))
        assertEquals("wifi", WifiNames.transportOf(wifi = true, ethernet = false, cellular = true, any = true)) // VPN/cellular default, Wi-Fi underneath
        assertEquals("cellular", WifiNames.transportOf(wifi = false, ethernet = false, cellular = true, any = true))
        assertEquals("ethernet", WifiNames.transportOf(wifi = false, ethernet = true, cellular = false, any = true))
        assertEquals("none", WifiNames.transportOf(wifi = false, ethernet = false, cellular = false, any = false))
        assertEquals("unknown", WifiNames.transportOf(wifi = false, ethernet = false, cellular = false, any = true))
    }
}
