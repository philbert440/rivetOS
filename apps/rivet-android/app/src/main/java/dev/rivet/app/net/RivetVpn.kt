package dev.rivet.app.net

import android.content.Context
import android.content.Intent
import android.net.VpnService
import android.system.Os
import android.util.Log
import com.wireguard.android.backend.Backend
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import com.wireguard.config.Config
import com.wireguard.config.Interface
import com.wireguard.config.Peer
import com.wireguard.crypto.Key
import com.wireguard.crypto.KeyPair
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/**
 * In-app mesh VPN — a single WireGuard tunnel ([GoBackend]) peering to the rivet-prod relay, which
 * bridges into the home mesh. Gives the on-device agents + rivet-memory plugin reach to datahub
 * (Postgres) and the embed endpoint whether the phone is on home WiFi or away.
 *
 * Split-tunnel: only the configured allowed-IPs range (the mesh subnet) routes through the
 * tunnel; all other phone traffic stays direct → minimal exposure, better battery.
 *
 * All coordinates (relay endpoint/pubkey, address assignment, subnets) come from user-entered
 * settings ([MeshRuntimeConfig]) — nothing is baked into the build.
 *
 * Security model:
 *  - The phone's PRIVATE key is generated on-device on first use and persisted app-private
 *    (filesDir/wg/private.key, 0600). It never leaves the device.
 *  - We only ever publish the PUBLIC key (surfaced via the control server /status) — that's what
 *    gets registered as this device's peer on the relay, which should firewall the device to the
 *    minimum services it needs (least privilege).
 *
 * GoBackend's VpnService does not go foreground (an active VPN keeps the process alive); doze is
 * covered by RivetRuntimeService's FGS + wakelock.
 */
object RivetVpn {
    private const val TAG = "RivetVpn"
    const val TUNNEL_NAME = "rivet-mesh"

    enum class Status { DOWN, UP, ERROR }

    private val _status = MutableStateFlow(Status.DOWN)
    val status: StateFlow<Status> = _status.asStateFlow()

    @Volatile private var backend: Backend? = null

    private val tunnel = object : Tunnel {
        override fun getName() = TUNNEL_NAME
        override fun onStateChange(newState: Tunnel.State) {
            _status.value = if (newState == Tunnel.State.UP) Status.UP else Status.DOWN
            Log.i(TAG, "tunnel state -> $newState")
        }
    }

    /** True when the relay coordinates are configured in settings (else the Mesh VPN toggle stays disabled). */
    val isConfigured: Boolean
        get() = MeshRuntimeConfig.current.let {
            it.wgEndpoint.isNotBlank() && it.wgPeerPublicKey.isNotBlank() &&
                it.wgAddress.isNotBlank() && it.wgAllowedIps.isNotBlank()
        }

    private fun keyFile(context: Context): File {
        val dir = File(context.filesDir, "wg").apply { mkdirs() }
        return File(dir, "private.key")
    }

    /** Load-or-generate the device keypair; private key persisted app-private (0600). */
    @Synchronized
    private fun keyPair(context: Context): KeyPair {
        val f = keyFile(context)
        if (f.exists()) {
            runCatching { return KeyPair(Key.fromBase64(f.readText().trim())) }
                .onFailure {
                    // Corruption: regenerating changes our PUBLIC key, which orphans the peer on the
                    // relay → tunnel stays down until the relay is re-registered with the new pubkey.
                    // Preserve the bad file + log loudly so it's noticed rather than silently broken.
                    Log.e(TAG, "WG private key UNREADABLE — regenerating; relay peer must be re-registered with new pubkey", it)
                    runCatching { f.copyTo(File(f.parentFile, "private.key.corrupt"), overwrite = true) }
                }
        }
        val kp = KeyPair()
        f.writeText(kp.privateKey.toBase64())
        runCatching { Os.chmod(f.absolutePath, 0b110_000_000) } // 0600
        Log.i(TAG, "generated WG keypair, pub=${kp.publicKey.toBase64()}")
        return kp
    }

    /** Base64 public key for this device — feed this to rivet-prod as the peer key. */
    fun publicKeyBase64(context: Context): String = keyPair(context).publicKey.toBase64()

    private fun buildConfig(context: Context): Config {
        val cfg = MeshRuntimeConfig.current
        val iface = Interface.Builder()
            .setKeyPair(keyPair(context))
            .parseAddresses(cfg.wgAddress)
            .build()
        val peer = Peer.Builder()
            .parsePublicKey(cfg.wgPeerPublicKey)
            .parseEndpoint(cfg.wgEndpoint)
            .parseAllowedIPs(cfg.wgAllowedIps)
            .setPersistentKeepalive(25)
            .build()
        return Config.Builder().setInterface(iface).addPeer(peer).build()
    }

    /** VPN consent intent if consent isn't yet granted, else null. Must be launched from an Activity. */
    fun consentIntent(context: Context): Intent? = VpnService.prepare(context)

    /**
     * True when the phone is already on the home/mesh LAN (an underlying, non-VPN network has an
     * IPv4 in the configured home-subnet prefix). There the tunnel is redundant and would overlap
     * the subnet it's sitting on, so the runtime auto-disables it. Permission-free (no SSID/location).
     */
    fun isOnHomeNetwork(context: Context): Boolean {
        val prefix = MeshRuntimeConfig.current.homeSubnet
        if (prefix.isBlank()) return false
        val cm = context.getSystemService(android.net.ConnectivityManager::class.java) ?: return false
        for (net in cm.allNetworks) {
            val caps = cm.getNetworkCapabilities(net) ?: continue
            // Skip our own VPN transport so we test the UNDERLYING network, not tun0.
            if (caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) continue
            val lp = cm.getLinkProperties(net) ?: continue
            for (la in lp.linkAddresses) {
                val a = la.address
                if (a is java.net.Inet4Address && a.hostAddress?.startsWith(prefix) == true) return true
            }
        }
        return false
    }

    @Synchronized
    private fun backend(context: Context): Backend =
        backend ?: GoBackend(context.applicationContext).also { backend = it }

    /** Bring the tunnel up. Blocking I/O — call off the main thread. */
    fun up(context: Context) {
        if (!isConfigured) {
            Log.w(TAG, "WG not configured (set relay coordinates in Settings → Node & Mesh); skipping up")
            return
        }
        try {
            backend(context).setState(tunnel, Tunnel.State.UP, buildConfig(context))
            _status.value = Status.UP
        } catch (t: Throwable) {
            _status.value = Status.ERROR
            Log.e(TAG, "tunnel up failed", t)
        }
    }

    /** Bring the tunnel down. Blocking I/O — call off the main thread. */
    fun down(context: Context) {
        try {
            backend?.setState(tunnel, Tunnel.State.DOWN, null)
        } catch (t: Throwable) {
            Log.e(TAG, "tunnel down failed", t)
        } finally {
            _status.value = Status.DOWN
        }
    }
}
