package dev.rivet.app.runtime

import android.content.Context
import android.system.Os
import android.util.Log
import dev.rivet.app.data.datastore.RIVET_BRIDGE_PORT
import dev.rivet.app.data.datastore.RIVET_SSH_PORT
import dev.rivet.app.data.datastore.RIVET_BRIDGE_TOKEN
import dev.rivet.app.device.DeviceControl
import java.io.File

/**
 * The on-device Linux runtime that hosts the agent CLIs.
 *
 * A full Ubuntu rootfs lives in app-data (`<filesDir>/rootfs`) and is run via proot,
 * which maps guest ELFs in userspace so the kernel never `execve`s an app_data_file —
 * the only way past Android's W^X exec wall at targetSdk >= 29. The OpenAI-compatible
 * bridge (`rivet-bridge-server-v2.js`) runs inside that rootfs as the non-root `rivet`
 * user (`proot -i 1000:1000`) and fronts the Claude + Grok CLIs on loopback :8765.
 *
 * This object owns the *idempotent* host-side scaffold and the canonical launch recipe.
 * Process lifecycle (start/keep-alive/stop) is [RivetRuntimeService]'s job.
 *
 * Hard-won proot invariants (do not "simplify"):
 *  - NEVER set PROOT_NO_SECCOMP=1 — ptrace-only mode breaks getcwd -> node process.cwd()
 *    throws `ENOSYS: uv_cwd` and npm/claude die. Seccomp (proot default) is required.
 *  - The patched libproot.so has its loader path baked to `<filesDir>/pl.so`; that must be
 *    a symlink to the executable loader in nativeLibraryDir (jniLibs stay executable; app-data
 *    does not). Likewise `libtalloc.so.2` is resolved from `<filesDir>/lib`.
 *  - Launch the host process with cwd INSIDE the rootfs so proot's getcwd translation works.
 */
object RivetRuntime {
    private const val TAG = "RivetRuntime"

    // First-run rootfs-install progress for the terminal's "setting up" screen (null when idle/ready).
    private val _setupProgress = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)
    val setupProgress: kotlinx.coroutines.flow.StateFlow<String?> = _setupProgress
    // Approximate entry count of the bundled rootfs, for a progress %. Over-estimates cap at 99%.
    private const val EXPECTED_ROOTFS_FILES = 11000

    /** Where the extracted Ubuntu rootfs lives in app-data. */
    fun rootfsDir(context: Context) = File(context.filesDir, "rootfs")

    /** True once the rootfs is populated enough to run node (B4b extraction is done / dev spike). */
    fun isRootfsReady(context: Context): Boolean =
        File(rootfsDir(context), "usr/local/bin/node").exists()

    /**
     * grok's session id for a conversation, if the bridge has one. grok 0.2.33 generates its
     * own session id (not the conversationId), which the bridge captures into grok-sessions.json
     * ({convId: grokSid}). The escalation button reads it to `grok --resume <grokSid>`.
     */
    fun grokSessionId(context: Context, conversationId: String): String? = try {
        val f = File(rootfsDir(context), "home/rivet/rivet-bridge/grok-sessions.json")
        if (f.exists()) org.json.JSONObject(f.readText()).optString(conversationId.lowercase(), "").ifBlank { null }
        else null
    } catch (_: Throwable) { null }

    private fun bridgeDir(context: Context) = File(rootfsDir(context), "home/rivet/rivet-bridge")

    // Serializes prepare() so the bridge + SSH supervise loops can't both run it (and double
    // extractBundledRootfs / overlay untar into the same dir) concurrently on a first run.
    private val prepareLock = Any()

    /**
     * Idempotent host-side prep. Safe to call on every launch. Recreates the filesDir
     * symlinks (wiped on reinstall), ensures tmp/lib dirs, the `rivet` guest user, DNS,
     * and refreshes the bundled bridge script + its auth token inside the rootfs.
     *
     * @return null on success, or a human-readable reason it can't run yet.
     */
    fun prepare(context: Context): String? = synchronized(prepareLock) {
        val rootfs = rootfsDir(context)
        if (!isRootfsReady(context)) {
            val err = extractBundledRootfs(context)
            if (err != null) return@synchronized err
        }
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val files = context.filesDir
        val lib = File(files, "lib").apply { mkdirs() }
        File(files, "tmp").mkdirs()

        // filesDir symlinks the patched proot needs (live outside the rootfs, wiped on reinstall).
        relink(File(lib, "libtalloc.so.2"), File(nativeDir, "libtalloc.so"))
        relink(File(files, "pl.so"), File(nativeDir, "libproot-loader.so"))

        // Inside-rootfs scaffold.
        ensureResolvConf(rootfs)
        ensureRivetUser(rootfs)
        ensureClaudeNativeBinary(context)
        ensureClaudeTrust(context)
        ensureNativeSsh(context)
        installBridge(context)
        installAgentContext(context)
        ensureMemoryPlugin(context)
        ensureRivetShared(context)
        ensureNetTools(context)
        ensureDenServer(context)
        ensureRivethubWeb(context)
        ensureFullRuntimeConfig(context)
        return@synchronized null
    }

    /**
     * The canonical proot+node command + environment that runs the bridge as `rivet`.
     * Caller (the service) launches this with [hostWorkingDir] as the process cwd.
     */
    fun bridgeCommand(context: Context): RuntimeCommand {
        val argv = listOf(prootBinary(context)) + prootArgvTail(context) +
            listOf("/usr/local/bin/node", "/home/rivet/rivet-bridge/rivet-bridge-server-v2.js")
        val env = baseEnv(context) + ("RIVET_BRIDGE_PORT" to RIVET_BRIDGE_PORT.toString())
        return RuntimeCommand(argv, env, hostHome(context))
    }

    /**
     * The real RivetOS den-server gateway (rivethub-web static + den API/WS) on loopback
     * [DEN_PORT]. Pure proot+node launch of the pre-bundled esbuild file; no token (loopback
     * only). Terminal routes stay off this increment (no arm64 pty.node — den-server returns
     * 503 for those). Caller supervises via [RivetRuntimeService] alongside the :8765 bridge.
     *
     * Prefer [fullRuntimeCommand] when [isFullRuntimeProvisioned] — the full runtime is a
     * superset (same gateway + core chat channel). This standalone path remains the fallback.
     */
    fun denCommand(context: Context): RuntimeCommand {
        val argv = listOf(prootBinary(context)) + prootArgvTail(context) +
            listOf("/usr/local/bin/node", "/home/rivet/rivet-den/den-server.bundle.mjs")
        val env = baseEnv(context) + mapOf(
            "RIVETOS_DEN_PORT" to DEN_PORT.toString(),
            "RIVETOS_DEN_HOST" to "127.0.0.1",
            "RIVETOS_DEN_STATIC_DIR" to "/home/rivet/rivethub-web/dist",
            "RIVETOS_DEN_STATE_DIR" to "/home/rivet/.rivetos/den",
            // Deliberately no RIVETOS_DEN_TERM — terminals off until arm64 pty.node lands.
        )
        return RuntimeCommand(argv, env, hostHome(context))
    }

    /**
     * True when the full RivetOS monorepo runtime is present in the rootfs
     * (`/home/rivet/rivetos/dist/rivetos.js`). Until then the standalone den bundle is used;
     * after [provisionFullRuntime] (or a hand-provisioned monorepo) the full runtime launches.
     */
    fun isFullRuntimeProvisioned(context: Context): Boolean =
        File(rootfsDir(context), "home/rivet/rivetos/dist/rivetos.js").exists()

    /** Non-null while [provisionFullRuntime] is running (short status for UI / notification). */
    private val _provisionProgress = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)
    val provisionProgress: kotlinx.coroutines.flow.StateFlow<String?> = _provisionProgress

    /** True while a provision job holds the concurrency lock. */
    fun isProvisioning(): Boolean = provisioning.get()

    // Only one provision at a time (UI tap + sticky service restart must not double-clone).
    private val provisioning = java.util.concurrent.atomic.AtomicBoolean(false)
    @Volatile private var provisionProcess: Process? = null

    /**
     * Clone + build the full RivetOS monorepo inside the rootfs so [isFullRuntimeProvisioned]
     * becomes true. Runs under proot as the `rivet` guest (same recipe as [denCommand] /
     * [fullRuntimeCommand]). Host-side writes the shell script, then ProcessBuilder streams
     * stdout to [onProgress] and logcat (`RivetProvision`).
     *
     * Idempotent: an existing clone is pulled and rebuilt. Concurrent calls are rejected
     * (returns false). Takes ~15 min on-device (clone, npm ci, nx build of ~39 projects, bundle).
     *
     * Must be invoked from a foreground service ([RivetRuntimeService] ACTION_PROVISION) so
     * Android does not kill the long-running process.
     *
     * @return true when `dist/rivetos.js` exists after a zero exit code.
     */
    fun provisionFullRuntime(context: Context, onProgress: (String) -> Unit): Boolean {
        if (!provisioning.compareAndSet(false, true)) {
            val msg = "Already provisioning — ignoring concurrent request"
            Log.w(PROVISION_TAG, msg)
            onProgress(msg)
            return false
        }
        try {
            if (!isRootfsReady(context)) {
                val msg = "Rootfs not ready — cannot provision"
                Log.e(PROVISION_TAG, msg)
                onProgress(msg)
                return false
            }
            // Ensure den config exists before the monorepo is ready to start.
            ensureFullRuntimeConfig(context)

            val scriptHost = File(rootfsDir(context), "home/rivet/.rivet-provision.sh")
            scriptHost.parentFile?.mkdirs()
            scriptHost.writeText(PROVISION_SCRIPT)
            scriptHost.setExecutable(true)

            fun progress(line: String) {
                Log.i(PROVISION_TAG, line)
                onProgress(line)
                // Short status for notification / drawer (keep last non-blank line snippet).
                val short = when {
                    line.contains("clone", ignoreCase = true) ||
                        line.contains("Cloning", ignoreCase = true) ||
                        line.contains("pull", ignoreCase = true) -> "downloading…"
                    line.contains("npm ci", ignoreCase = true) ||
                        line.contains("added", ignoreCase = true) -> "installing…"
                    line.contains("nx", ignoreCase = true) ||
                        line.contains("build", ignoreCase = true) ||
                        line.contains("Compil", ignoreCase = true) -> "building…"
                    line.contains("bundle", ignoreCase = true) -> "bundling…"
                    line.contains("done", ignoreCase = true) -> "finishing…"
                    else -> _provisionProgress.value ?: "starting…"
                }
                _provisionProgress.value = short
            }

            progress("Provisioning full RivetOS runtime…")
            _provisionProgress.value = "starting…"

            val argv = listOf(prootBinary(context)) + prootArgvTail(context) +
                listOf("/bin/bash", "/home/rivet/.rivet-provision.sh")
            val env = baseEnv(context) + mapOf(
                // Minimal rootfs has no CA store; public repo, content SHA-verified by git.
                "GIT_SSL_NO_VERIFY" to "true",
                // npm/nx need a writable cache under the guest home.
                "npm_config_cache" to "/home/rivet/.npm",
                "NX_DAEMON" to "false",
            )
            val p = ProcessBuilder(argv)
                .directory(hostHome(context))
                .redirectErrorStream(true)
                .apply { environment().putAll(env) }
                .start()
            provisionProcess = p

            p.inputStream.bufferedReader().forEachLine { line ->
                if (line.isNotBlank()) progress(line)
            }
            val code = p.waitFor()
            val ok = code == 0 && isFullRuntimeProvisioned(context)
            if (ok) {
                progress("Provision complete — full runtime ready")
                _provisionProgress.value = null
            } else {
                val msg = "Provision failed (exit=$code, built=${isFullRuntimeProvisioned(context)})"
                Log.e(PROVISION_TAG, msg)
                onProgress(msg)
                _provisionProgress.value = null
            }
            return ok
        } catch (t: Throwable) {
            Log.e(PROVISION_TAG, "provisionFullRuntime failed", t)
            onProgress("Provision error: ${t.message}")
            _provisionProgress.value = null
            return false
        } finally {
            provisionProcess = null
            provisioning.set(false)
        }
    }

    /** Best-effort kill of an in-flight provision proot process (service stop / destroy). */
    fun cancelProvision() {
        runCatching { provisionProcess?.destroyForcibly() }
        provisionProcess = null
        _provisionProgress.value = null
        // Leave provisioning flag to the finally block of provisionFullRuntime if still running.
    }

    /**
     * Host-side write of the full-runtime config into the rootfs if absent. App owns the
     * rootfs files (same pattern as resolv.conf / agent context). Den port + static_dir
     * live here so [fullRuntimeCommand] does not need RIVETOS_DEN_* env overrides.
     */
    fun ensureFullRuntimeConfig(context: Context) {
        try {
            val cfg = File(rootfsDir(context), "home/rivet/config.yaml")
            if (cfg.exists()) return
            cfg.parentFile?.mkdirs()
            // Exact content (host-side write; config.yaml drives den host/port/static_dir).
            cfg.writeText(
                "runtime:\n" +
                    "  workspace: /home/rivet/.rivetos/workspace\n" +
                    "  default_agent: rivet\n" +
                    "agents:\n" +
                    "  rivet:\n" +
                    "    provider: claude-cli\n" +
                    "providers:\n" +
                    "  claude-cli:\n" +
                    "    model: claude-opus-4-8\n" +
                    "den:\n" +
                    "  enabled: true\n" +
                    "  host: 127.0.0.1\n" +
                    "  port: 5174\n" +
                    "  static_dir: /home/rivet/rivethub-web/dist\n"
            )
            Log.i(TAG, "wrote full-runtime config at ${cfg.absolutePath}")
        } catch (t: Throwable) {
            Log.e(TAG, "ensureFullRuntimeConfig failed", t)
        }
    }

    /**
     * Full RivetOS runtime (`rivetos start -c config.yaml`) on loopback [DEN_PORT] —
     * same proot identity/env as [denCommand], but starts with cwd = monorepo root
     * (`/home/rivet/rivetos`) so workspace-mode plugin discovery finds `nx.json` +
     * `node_modules` (walking up from process.cwd()). Without that, discovery yields
     * 0 plugins and providers like claude-cli never register. Shared [prootArgvTail]
     * keeps guest `-w /home/rivet`; we `cd` into the monorepo via a login shell then
     * `exec` node so signals/supervision stay clean. Den settings come from
     * config.yaml only (no RIVETOS_DEN_* env). Caller uses the same RivetDen
     * supervise slot as the standalone den — never both at once (port collision).
     */
    fun fullRuntimeCommand(context: Context): RuntimeCommand {
        val argv = listOf(prootBinary(context)) + prootArgvTail(context) +
            listOf(
                "/bin/bash", "-lc",
                "cd /home/rivet/rivetos && exec /usr/local/bin/node dist/rivetos.js start -c $FULL_RUNTIME_CONFIG",
            )
        val env = baseEnv(context)
        return RuntimeCommand(argv, env, hostHome(context))
    }

    /**
     * The command that runs the SSH server (track B) — a **native (bionic) dropbear running
     * OUTSIDE proot**, the way Termux does it. This is what unlocks full interactive PTY
     * (`ssh -t` → a real `/dev/pts/N` controlling terminal): the pty is allocated host-side,
     * where Android's devpts actually works, then each session execs into the rootfs via proot,
     * inheriting that pty. (proot cannot back a guest-allocated controlling tty, which is why
     * the old in-rootfs dropbear only ever reached `ssh -T`.)
     *
     * The binary is shipped as a jniLib (`libdropbear.so`) so it's executable outside app-data's
     * W^X wall — same trick as libproot/libbusybox. Built from `native/dropbear/` with the
     * Android source patches (getpwnam-from-env shim, the Termux controlling-tty rewrite, the
     * reopen-before-close-master / SIGHUP / skip-utmp pty fixes). Verified full-PTY on-device.
     *
     * dropbear flags: `-F` foreground (service supervises via waitFor), `-E` log to stderr→logcat,
     * `-e` pass our env (LD_LIBRARY_PATH/PROOT_TMP_DIR/TZ) through to the session so proot runs,
     * `-r <hostkey>` app-owned persistent host key (the compiled `/etc/dropbear` default is
     * unwritable), `-p` bind [RIVET_SSH_PORT] on all interfaces, `-c <forced>` the rootfs-entry
     * command. Password auth is compiled out — key-only via [sshHomeDir]'s authorized_keys.
     */
    fun sshCommand(context: Context): RuntimeCommand {
        val proot = prootBinary(context)
        val rootfs = rootfsDir(context).absolutePath
        val guestPath = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        // dropbear's execchild chdir's to pw_dir (the ssh-home), but proot needs the HOST cwd
        // inside the rootfs for getcwd translation (same rule the bridge/terminal follow), so cd
        // there first. The proot tail drops the session into the rootfs as the rivet user;
        // --kill-on-exit tears down this session's proot subtree when the SSH session closes.
        // Guest HOME/USER/PATH are set here (execchild would otherwise leave HOME at the host
        // pw_dir); TERM + the proot host vars (LD_LIBRARY_PATH, PROOT_TMP_DIR) arrive via `-e`.
        val cdRootfs = "cd \"${hostHome(context).absolutePath}\"; "
        val prootHead = "HOME=/home/rivet USER=rivet PATH=$guestPath exec \"$proot\" --kill-on-exit " +
            "-r \"$rootfs\" -b /dev -b /proc -b /sys -i 1000:1000 -w /home/rivet /bin/bash -l"
        // Forced command: honor a one-shot `ssh rivet@phone <cmd>` (runs it inside the rootfs),
        // else give an interactive login shell. Runs under the session pty, so `ssh -t` is real.
        val forced = cdRootfs +
            "if [ -n \"\$SSH_ORIGINAL_COMMAND\" ]; then ${prootHead}c \"\$SSH_ORIGINAL_COMMAND\"; " +
            "else $prootHead; fi"
        val argv = listOf(
            dropbearBinary(context),
            "-F", "-E", "-e",
            "-r", hostKeyFile(context).absolutePath,
            "-p", RIVET_SSH_PORT.toString(),
            "-c", forced,
        )
        val env = baseEnv(context) + mapOf(
            // The synthesized `rivet` user the getpwnam shim hands dropbear (Android has no
            // /etc/passwd). pw_dir holds .ssh/authorized_keys; pw_shell runs the forced command.
            "RIVET_PW_DIR" to sshHomeDir(context).absolutePath,
            "RIVET_PW_SHELL" to "/system/bin/sh",
        )
        // cwd inside the rootfs so the session's proot getcwd-translates (same rule as the bridge).
        return RuntimeCommand(argv, env, hostHome(context))
    }

    /**
     * A PTY-ready command for the in-app terminal: run [guestCommand] inside the rootfs as
     * `rivet` under a real pty. Shaped for Termux's `TerminalSession(shellPath, cwd, args, env, …)`
     * — [executable] is argv[0], [args] are the rest (proot flags + the guest command).
     * e.g. guestCommand = listOf("/bin/bash", "-l") for an interactive shell, or
     * listOf("claude", "--resume", convId) to drop straight into an escalated session.
     */
    fun terminalCommand(context: Context, guestCommand: List<String>): PtyCommand {
        // Termux's TerminalSession uses `args` AS argv (argv[0] = args[0]) — it does NOT prepend
        // the executable the way ProcessBuilder does. So argv[0] must be the program name here,
        // else proot's argv[0] becomes "-r", the rootfs path shifts into the command slot, and
        // proot tries to exec the rootfs dir → "is not a regular file".
        val proot = prootBinary(context)
        val args = (listOf(proot) + prootArgvTail(context) + guestCommand).toTypedArray()
        // Termux's TerminalSession REPLACES the child environment (execve with exactly this
        // envp), unlike the bridge's ProcessBuilder which inherits + merges. proot needs the
        // Android system vars (ANDROID_ROOT, ANDROID_DATA, …) to run — without them it fails
        // ("rootfs is not a regular file"). So inherit the full env, then apply our overrides.
        val merged = LinkedHashMap<String, String>()
        merged.putAll(System.getenv())
        merged.putAll(baseEnv(context))
        merged["TERM"] = "xterm-256color"
        val env = merged.map { (k, v) -> "$k=$v" }.toTypedArray()
        return PtyCommand(
            executable = prootBinary(context),
            args = args,
            env = env,
            cwd = hostHome(context).absolutePath
        )
    }

    // --- shared proot invocation pieces ----------------------------------------------

    private fun prootBinary(context: Context) =
        File(context.applicationInfo.nativeLibraryDir, "libproot.so").absolutePath

    /** The native (bionic) dropbear server, shipped as an executable jniLib. */
    private fun dropbearBinary(context: Context) =
        File(context.applicationInfo.nativeLibraryDir, "libdropbear.so").absolutePath

    /** The native dropbearkey tool (host-key generator), shipped as an executable jniLib. */
    private fun dropbearKeyBinary(context: Context) =
        File(context.applicationInfo.nativeLibraryDir, "libdropbearkey.so").absolutePath

    /** App-owned, writable host-key dir (the compiled /etc/dropbear default is unwritable). */
    private fun hostKeyFile(context: Context) =
        File(File(context.filesDir, "dropbear").apply { mkdirs() }, "hk_ed25519")

    /**
     * The synthesized `rivet` user's home for native dropbear (pw_dir via RIVET_PW_DIR). Holds
     * `.ssh/authorized_keys`. dropbear's strict-perm check rejects any group/world-writable
     * component, so this whole subtree is kept owner-only (0700/0600).
     */
    private fun sshHomeDir(context: Context) = File(context.filesDir, "ssh-home")

    /** proot flags up to (not including) the guest command: rootfs, binds, change-id, guest cwd. */
    private fun prootArgvTail(context: Context): List<String> = listOf(
        "-r", rootfsDir(context).absolutePath,
        "-b", "/dev",
        "-b", "/proc",
        "-b", "/sys",
        "-i", "1000:1000",   // guest sees uid 1000 (rivet); real syscalls run as the app uid
        "-w", "/home/rivet"  // guest cwd
    )

    private fun baseEnv(context: Context): Map<String, String> {
        val nativeDir = context.applicationInfo.nativeLibraryDir
        val files = context.filesDir
        // Datahub creds for the baked-in rivet-memory plugin. Injected here (not a rootfs file) so
        // the secret never lives in the shipped asset; they flow bridge/SSH -> claude/grok -> the
        // MCP server (recall) + capture hooks, which read RIVETOS_PG_URL/EMBED_URL from the env.
        // Per-agent identity (RIVETOS_CAPTURE_AGENT=rivet-phone-claude|grok) is set in each agent's
        // hook launcher, not here. Empty creds => memory tools stay disabled (graceful).
        val memEnv = buildMap {
            val mesh = dev.rivet.app.net.MeshRuntimeConfig.current
            mesh.pgUrl.takeIf { it.isNotBlank() }?.let { put("RIVETOS_PG_URL", it) }
            mesh.embedUrl.takeIf { it.isNotBlank() }?.let { put("RIVETOS_EMBED_URL", it) }
            // Shared-filesystem NFS target for the rivet-shared wrapper (blank => wrapper errors
            // out with a clear message instead of dialing a default that isn't yours).
            mesh.sharedHost.takeIf { it.isNotBlank() }?.let { put("RIVET_SHARED_HOST", it) }
            mesh.sharedExport.takeIf { it.isNotBlank() }?.let { put("RIVET_SHARED_EXPORT", it) }
        }
        return memEnv + mapOf(
            "LD_LIBRARY_PATH" to "${File(files, "lib").absolutePath}:$nativeDir",
            "PROOT_TMP_DIR" to File(files, "tmp").absolutePath,
            // DELIBERATELY no PROOT_NO_SECCOMP — see class doc.
            "HOME" to "/home/rivet",
            "USER" to "rivet",
            // The Ubuntu base defaults to UTC; pin Eastern so the agents (and terminal) report
            // local time. tzdata is in the rootfs, so TZ resolves against /usr/share/zoneinfo.
            "TZ" to "America/New_York",
            // Guest PATH so node/claude/grok resolve inside the rootfs (else `spawn claude`
            // hits Android's /system/bin and fails ENOENT).
            "PATH" to "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        )
    }

    /** Host path that resolves inside the rootfs, so proot can translate getcwd. */
    private fun hostHome(context: Context) = File(rootfsDir(context), "home/rivet")

    // --- scaffold helpers -------------------------------------------------------------

    /** (Re)create [link] as a symlink to [target], replacing any stale entry. */
    private fun relink(link: File, target: File) {
        try {
            if (link.exists() || isSymlink(link)) link.delete()
            Os.symlink(target.absolutePath, link.absolutePath)
        } catch (t: Throwable) {
            Log.e(TAG, "relink ${link.absolutePath} -> ${target.absolutePath} failed", t)
        }
    }

    private fun ensureResolvConf(rootfs: File) {
        try {
            val resolv = File(rootfs, "etc/resolv.conf")
            if (!resolv.exists() || resolv.readText().isBlank()) {
                resolv.parentFile?.mkdirs()
                resolv.writeText("nameserver 1.1.1.1\nnameserver 8.8.8.8\n")
            }
        } catch (t: Throwable) {
            Log.e(TAG, "ensureResolvConf failed", t)
        }
    }

    /**
     * Ensure a non-root `rivet` user (uid/gid 1000) with passwordless sudo exists in the
     * guest. `useradd` fails under proot (missing /etc/passwd.lock), so append directly.
     * No-op if `rivet:` is already present (the dev-spike rootfs already has it).
     */
    private fun ensureRivetUser(rootfs: File) {
        try {
            val passwd = File(rootfs, "etc/passwd")
            if (!passwd.exists() || passwd.readText().lineSequence().any { it.startsWith("rivet:") }) return
            passwd.appendText("rivet:x:1000:1000:Rivet:/home/rivet:/bin/bash\n")
            File(rootfs, "etc/group").appendText("rivet:x:1000:\n")
            File(rootfs, "etc/shadow").appendText("rivet:!:19000:0:99999:7:::\n")
            File(rootfs, "etc/sudoers.d").mkdirs()
            File(rootfs, "etc/sudoers.d/rivet").apply {
                writeText("rivet ALL=(ALL) NOPASSWD:ALL\n")
                setReadable(true, false)
            }
            File(rootfs, "home/rivet").mkdirs()
        } catch (t: Throwable) {
            Log.e(TAG, "ensureRivetUser failed", t)
        }
    }

    /**
     * Give the on-device agents their bearings + the keys to drive the phone:
     *  - CLAUDE.md / GROK.md into the rivet home (where claude-code/grok pick them up) — written
     *    only if ABSENT, so the agents' own memory edits to these survive relaunches.
     *  - the device-control token + port at ~/.rivet/control.json INSIDE the rootfs — refreshed
     *    every launch. proot binds only /dev,/proc,/sys (no /sdcard), so the agents can't read the
     *    app's exported /sdcard/rivet/control.json; they need it here. Same token ControlServer checks.
     */
    private fun installAgentContext(context: Context) {
        try {
            val home = File(rootfsDir(context), "home/rivet").apply { mkdirs() }
            File(home, ".rivet").apply { mkdirs() }.also { dir ->
                File(dir, "control.json").writeText(
                    "{\"port\":${DeviceControl.CONTROL_PORT},\"token\":\"${DeviceControl.getControlToken(context)}\"}\n"
                )
            }
            for (name in listOf("CLAUDE.md", "GROK.md")) {
                val dst = File(home, name)
                if (!dst.exists()) {
                    context.assets.open(name).use { input -> dst.outputStream().use { input.copyTo(it) } }
                }
            }
        } catch (t: Throwable) {
            Log.e(TAG, "installAgentContext failed", t)
        }
    }

    /**
     * Install the rivet-memory plugin (recall MCP + capture hooks) for claude-code + grok so memory
     * self-provisions on a FRESH install, not just across app-updates. Ships as an APK asset overlay
     * ([MEMORY_OVERLAY_ASSET] = /opt/rivet-memory + /opt/rivet-memory-grok + register-memory.sh),
     * extracted via busybox tar, then registered idempotently inside proot — reproducing the
     * verified-live config (~/.claude.json mcpServers + ~/.claude/settings.json hooks + ~/.grok
     * config.toml mcp + a ~/.grok/hooks JSON file). Per-agent identity (rivet-phone-claude|grok) is baked
     * into the shipped launchers; datahub creds flow via [baseEnv] at runtime, never in the asset.
     * Gated on a rev marker: runs on a wiped reinstall + when the shipped plugin bumps, else skips.
     */
    private fun ensureMemoryPlugin(context: Context) {
        try {
            val rootfs = rootfsDir(context)
            val marker = File(rootfs, "opt/.rivet-memory-rev")
            if (marker.exists() && runCatching { marker.readText().trim() }.getOrNull() == MEMORY_OVERLAY_REV) return
            val busybox = File(context.applicationInfo.nativeLibraryDir, "libbusybox.so")
            if (!busybox.exists()) { Log.w(TAG, "busybox jniLib missing — skip memory plugin"); return }
            val tmp = File(context.filesDir, "mem-overlay.bin")
            context.assets.open(MEMORY_OVERLAY_ASSET).use { input ->
                tmp.outputStream().use { input.copyTo(it, 1 shl 20) }
            }
            val ex = ProcessBuilder(busybox.absolutePath, "tar", "-xzf", tmp.absolutePath, "-C", rootfs.absolutePath)
                .redirectErrorStream(true).start()
            val exOut = ex.inputStream.bufferedReader().readText(); val exCode = ex.waitFor()
            tmp.delete()
            if (exCode != 0) { Log.e(TAG, "memory overlay extract failed ($exCode): ${exOut.take(200)}"); return }
            // Register inside the rootfs as rivet (idempotent JSON/TOML merges). One-shot proot.
            val argv = listOf(prootBinary(context)) + prootArgvTail(context) + listOf("/bin/bash", "/opt/register-memory.sh")
            val p = ProcessBuilder(argv).directory(hostHome(context)).redirectErrorStream(true)
                .apply { environment().putAll(baseEnv(context)) }.start()
            val out = p.inputStream.bufferedReader().readText(); val code = p.waitFor()
            if (code == 0) {
                marker.writeText(MEMORY_OVERLAY_REV)
                Log.i(TAG, "memory plugin provisioned (rev $MEMORY_OVERLAY_REV): ${out.trim().takeLast(80)}")
            } else {
                Log.w(TAG, "memory plugin register exit=$code: ${out.take(200)}")
            }
        } catch (t: Throwable) {
            Log.e(TAG, "ensureMemoryPlugin failed", t)
        }
    }

    /**
     * Install the `rivet-shared` userspace NFS client so on-device agents can read/write the mesh
     * `/rivet-shared` export with no kernel mount (unrooted proot can't mount). Ships as an APK asset
     * overlay ([RIVET_SHARED_OVERLAY_ASSET] = /opt/rivet-shared/{bin,lib} + a `rivet-shared` wrapper over
     * libnfs's nfs-ls/cat/cp/stat, plus a /usr/local/bin symlink onto PATH). Pure extract — the PATH
     * symlink is baked into the tar, so unlike the memory plugin this needs no proot register step.
     * Gated on a rev marker: runs on a wiped reinstall + when the shipped overlay bumps, else skips.
     * The wrapper's NFS target comes from settings via baseEnv (RIVET_SHARED_HOST/EXPORT, NFSv4
     * port 2049) — same host on/off WiFi (off-WiFi routes through the relay). See AGENT.md.
     */
    private fun ensureRivetShared(context: Context) {
        try {
            val rootfs = rootfsDir(context)
            val marker = File(rootfs, "opt/.rivet-shared-rev")
            if (marker.exists() && runCatching { marker.readText().trim() }.getOrNull() == RIVET_SHARED_OVERLAY_REV) return
            val busybox = File(context.applicationInfo.nativeLibraryDir, "libbusybox.so")
            if (!busybox.exists()) { Log.w(TAG, "busybox jniLib missing — skip rivet-shared"); return }
            val tmp = File(context.filesDir, "rs-overlay.bin")
            context.assets.open(RIVET_SHARED_OVERLAY_ASSET).use { input ->
                tmp.outputStream().use { input.copyTo(it, 1 shl 20) }
            }
            val ex = ProcessBuilder(busybox.absolutePath, "tar", "-xzf", tmp.absolutePath, "-C", rootfs.absolutePath)
                .redirectErrorStream(true).start()
            val exOut = ex.inputStream.bufferedReader().readText(); val exCode = ex.waitFor()
            tmp.delete()
            if (exCode != 0) { Log.e(TAG, "rivet-shared overlay extract failed ($exCode): ${exOut.take(200)}"); return }
            marker.writeText(RIVET_SHARED_OVERLAY_REV)
            Log.i(TAG, "rivet-shared provisioned (rev $RIVET_SHARED_OVERLAY_REV)")
        } catch (t: Throwable) {
            Log.e(TAG, "ensureRivetShared failed", t)
        }
    }

    /**
     * Install curl, ping, and ip (+ shared libs) extracted from noble arm64 debs at build time.
     * Ships as [NET_TOOLS_OVERLAY_ASSET]; replaces any node-based shims at /usr/local/bin.
     * Gated on [NET_TOOLS_OVERLAY_REV] like the other overlays.
     */
    private fun ensureNetTools(context: Context) {
        try {
            val rootfs = rootfsDir(context)
            val marker = File(rootfs, "opt/.rivet-net-tools-rev")
            if (marker.exists() && runCatching { marker.readText().trim() }.getOrNull() == NET_TOOLS_OVERLAY_REV) return
            val busybox = File(context.applicationInfo.nativeLibraryDir, "libbusybox.so")
            if (!busybox.exists()) { Log.w(TAG, "busybox jniLib missing — skip net-tools"); return }
            val tmp = File(context.filesDir, "net-tools-overlay.bin")
            context.assets.open(NET_TOOLS_OVERLAY_ASSET).use { input ->
                tmp.outputStream().use { input.copyTo(it, 1 shl 20) }
            }
            val ex = ProcessBuilder(busybox.absolutePath, "tar", "-xzf", tmp.absolutePath, "-C", rootfs.absolutePath)
                .redirectErrorStream(true).start()
            val exOut = ex.inputStream.bufferedReader().readText(); val exCode = ex.waitFor()
            tmp.delete()
            if (exCode != 0) { Log.e(TAG, "net-tools overlay extract failed ($exCode): ${exOut.take(200)}"); return }
            marker.parentFile?.mkdirs()
            marker.writeText(NET_TOOLS_OVERLAY_REV)
            Log.i(TAG, "net-tools provisioned (rev $NET_TOOLS_OVERLAY_REV)")
        } catch (t: Throwable) {
            Log.e(TAG, "ensureNetTools failed", t)
        }
    }

    /**
     * Install the den-server esbuild bundle (`home/rivet/rivet-den/den-server.bundle.mjs`).
     * Pure extract — no proot register step (same shape as [ensureRivetShared]). Gated on
     * [DEN_OVERLAY_REV]; bump to re-extract on the next launch.
     */
    private fun ensureDenServer(context: Context) {
        try {
            val rootfs = rootfsDir(context)
            val marker = File(rootfs, "opt/.rivet-den-rev")
            if (marker.exists() && runCatching { marker.readText().trim() }.getOrNull() == DEN_OVERLAY_REV) return
            val busybox = File(context.applicationInfo.nativeLibraryDir, "libbusybox.so")
            if (!busybox.exists()) { Log.w(TAG, "busybox jniLib missing — skip den-server"); return }
            val tmp = File(context.filesDir, "den-overlay.bin")
            context.assets.open(DEN_OVERLAY_ASSET).use { input ->
                tmp.outputStream().use { input.copyTo(it, 1 shl 20) }
            }
            val ex = ProcessBuilder(busybox.absolutePath, "tar", "-xzf", tmp.absolutePath, "-C", rootfs.absolutePath)
                .redirectErrorStream(true).start()
            val exOut = ex.inputStream.bufferedReader().readText(); val exCode = ex.waitFor()
            tmp.delete()
            if (exCode != 0) { Log.e(TAG, "den overlay extract failed ($exCode): ${exOut.take(200)}"); return }
            marker.parentFile?.mkdirs()
            marker.writeText(DEN_OVERLAY_REV)
            Log.i(TAG, "den-server provisioned (rev $DEN_OVERLAY_REV)")
        } catch (t: Throwable) {
            Log.e(TAG, "ensureDenServer failed", t)
        }
    }

    /**
     * Install rivethub-web static build (`home/rivet/rivethub-web/dist/`). Pure extract —
     * same shape as [ensureRivetShared]. Gated on [WEB_OVERLAY_REV]; bump to re-extract.
     */
    private fun ensureRivethubWeb(context: Context) {
        try {
            val rootfs = rootfsDir(context)
            val marker = File(rootfs, "opt/.rivet-web-rev")
            if (marker.exists() && runCatching { marker.readText().trim() }.getOrNull() == WEB_OVERLAY_REV) return
            val busybox = File(context.applicationInfo.nativeLibraryDir, "libbusybox.so")
            if (!busybox.exists()) { Log.w(TAG, "busybox jniLib missing — skip rivethub-web"); return }
            val tmp = File(context.filesDir, "web-overlay.bin")
            context.assets.open(WEB_OVERLAY_ASSET).use { input ->
                tmp.outputStream().use { input.copyTo(it, 1 shl 20) }
            }
            val ex = ProcessBuilder(busybox.absolutePath, "tar", "-xzf", tmp.absolutePath, "-C", rootfs.absolutePath)
                .redirectErrorStream(true).start()
            val exOut = ex.inputStream.bufferedReader().readText(); val exCode = ex.waitFor()
            tmp.delete()
            if (exCode != 0) { Log.e(TAG, "web overlay extract failed ($exCode): ${exOut.take(200)}"); return }
            marker.parentFile?.mkdirs()
            marker.writeText(WEB_OVERLAY_REV)
            Log.i(TAG, "rivethub-web provisioned (rev $WEB_OVERLAY_REV)")
        } catch (t: Throwable) {
            Log.e(TAG, "ensureRivethubWeb failed", t)
        }
    }

    /**
     * First-run install: extract the bundled Ubuntu rootfs (node + claude + grok + creds)
     * from the APK asset into app-data via the busybox `tar` jniLib. Idempotent — only runs
     * when [isRootfsReady] is false, so a reinstall that wipes app-data self-heals on next
     * launch. Slow (~30–60s for ~260MB → ~780MB), so callers run it off the main thread.
     */
    private fun extractBundledRootfs(context: Context): String? {
        val rootfs = rootfsDir(context)
        val staging = File(context.filesDir, "rootfs.staging")
        val busybox = File(context.applicationInfo.nativeLibraryDir, "libbusybox.so")
        if (!busybox.exists()) return "busybox jniLib missing — can't extract rootfs"
        val tmpTar = File(context.filesDir, "rootfs.tar.gz")
        try {
            // Extract into a staging dir, verify completeness, then swap it into place. A first
            // run interrupted mid-extract (process recycled under I/O load) must never leave a
            // half-populated rootfs: the old code extracted straight into rootfsDir, so a partial
            // extract with node present made isRootfsReady lie and wedged every later launch.
            staging.deleteRecursively()
            staging.mkdirs()
            Log.i(TAG, "extracting bundled rootfs ($ROOTFS_ASSET) — first run, this takes a bit")
            context.assets.open(ROOTFS_ASSET).use { input ->
                tmpTar.outputStream().use { input.copyTo(it, 1 shl 20) }
            }
            _setupProgress.value = "Installing runtime…"
            val p = ProcessBuilder(busybox.absolutePath, "tar", "-xzvf", tmpTar.absolutePath, "-C", staging.absolutePath)
                .redirectErrorStream(true)
                .start()
            var files = 0
            val lastLines = ArrayDeque<String>()
            p.inputStream.bufferedReader().forEachLine { line ->
                files++
                if (lastLines.size >= 4) lastLines.removeFirst()
                lastLines.addLast(line)
                if (files % 150 == 0) {
                    val pct = (files * 100 / EXPECTED_ROOTFS_FILES).coerceAtMost(99)
                    _setupProgress.value = "Installing runtime… $pct%"
                }
            }
            val code = p.waitFor()
            if (code != 0) { staging.deleteRecursively(); return "rootfs extraction failed (busybox tar exit=$code): ${lastLines.joinToString("; ").take(300)}" }
            // Completeness gate: sentinels spread across the archive. If any is missing the extract
            // was truncated despite a 0 exit — discard so the next launch retries cleanly.
            val sentinels = listOf(
                "usr/local/bin/node",
                "usr/bin/bash",
                "usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1",
            )
            val missing = sentinels.firstOrNull { !File(staging, it).exists() }
            if (missing != null) { staging.deleteRecursively(); return "rootfs extracted but incomplete (missing $missing) — truncated?" }
            // Swap staging -> rootfs. Same filesystem (filesDir), so rename is atomic + cheap.
            rootfs.deleteRecursively()
            if (!staging.renameTo(rootfs)) { staging.deleteRecursively(); return "rootfs swap failed (rename)" }
            Log.i(TAG, "rootfs extracted OK")
            return null
        } catch (t: Throwable) {
            staging.deleteRecursively()
            return "rootfs extraction error: ${t.javaClass.simpleName}: ${t.message}"
        } finally {
            tmpTar.delete()
            _setupProgress.value = null
        }
    }

    /**
     * Point claude's launcher at its real native binary. claude-code ships `bin/claude.exe`
     * as a tiny placeholder that the package's postinstall (install.cjs) replaces with the
     * platform-native binary; the rootfs was staged with --ignore-scripts, so that never ran
     * ("claude native binary not installed"). Replicate its effect: symlink the launcher to
     * the linux-arm64 binary. Idempotent — skipped once it already points at the real binary.
     */
    private fun ensureClaudeNativeBinary(context: Context) {
        try {
            val rootfs = rootfsDir(context)
            // The standalone native binary (self-contained, like grok's). The npm launcher
            // stub at bin/claude.exe just errors "native binary not installed" because the
            // rootfs was staged --ignore-scripts. Skip the launcher entirely: point
            // /usr/local/bin/claude straight at the native binary (absolute symlink).
            val nativeAbs = "/usr/local/lib/node_modules/@anthropic-ai/claude-code-linux-arm64/claude"
            val native = File(rootfs, nativeAbs.removePrefix("/"))
            if (!native.exists()) {
                Log.w(TAG, "claude native binary not found at $nativeAbs")
                return
            }
            native.setExecutable(true, false)
            val binClaude = File(rootfs, "usr/local/bin/claude")
            val current = try {
                if (isSymlink(binClaude)) Os.readlink(binClaude.absolutePath) else null
            } catch (_: Throwable) { null }
            if (current != nativeAbs) {
                if (binClaude.exists() || isSymlink(binClaude)) binClaude.delete()
                Os.symlink(nativeAbs, binClaude.absolutePath)
                Log.i(TAG, "linked /usr/local/bin/claude -> native binary")
            }
        } catch (t: Throwable) {
            Log.e(TAG, "ensureClaudeNativeBinary failed", t)
        }
    }

    /**
     * Host-side setup for the native (bionic) dropbear SSH server (track B):
     *  - generate a persistent ed25519 host key (via the `dropbearkey` jniLib) into an app-owned,
     *    writable dir on first run — the compiled `/etc/dropbear` default path is unwritable;
     *  - stage `authorized_keys` into the synthesized rivet user's home ([sshHomeDir]), sourced
     *    from the rootfs's `~/.ssh/authorized_keys` (where the trusted keys already live), with
     *    the whole subtree locked to owner-only (0700/0600) so dropbear's strict-perm check passes.
     * Idempotent: the host key is generated once; authorized_keys is refreshed each call (cheap).
     */
    private fun ensureNativeSsh(context: Context) {
        try {
            // 1) Host key — generate once via the dropbearkey jniLib (runs natively, outside proot).
            val hk = hostKeyFile(context)
            if (!hk.exists()) {
                val p = ProcessBuilder(
                    dropbearKeyBinary(context), "-t", "ed25519", "-f", hk.absolutePath
                ).redirectErrorStream(true).start()
                val out = p.inputStream.bufferedReader().readText()
                val code = p.waitFor()
                if (code != 0) Log.e(TAG, "dropbearkey failed (exit=$code): ${out.take(200)}")
                else Log.i(TAG, "generated native dropbear host key")
            }

            // 2) authorized_keys — owner-only subtree, seeded from the rootfs's existing keys.
            val home = sshHomeDir(context).apply { mkdirs() }
            val dotssh = File(home, ".ssh").apply { mkdirs() }
            val authKeys = File(dotssh, "authorized_keys")
            val rootfsKeys = File(rootfsDir(context), "home/rivet/.ssh/authorized_keys")
            if (rootfsKeys.exists()) {
                rootfsKeys.copyTo(authKeys, overwrite = true)
            } else if (!authKeys.exists()) {
                Log.w(TAG, "no authorized_keys in rootfs — native SSH will reject all logins")
                authKeys.writeText("")
            }
            // dropbear rejects any group/world-writable path component → lock to owner-only.
            for (f in listOf(home, dotssh)) runCatching { Os.chmod(f.absolutePath, 0b111_000_000 /*0700*/) }
            runCatching { Os.chmod(authKeys.absolutePath, 0b110_000_000 /*0600*/) }
        } catch (t: Throwable) {
            Log.e(TAG, "ensureNativeSsh failed", t)
        }
    }

    /**
     * Pre-accept Claude Code's folder-trust dialog for the dirs the agent runs in, so the
     * in-app terminal doesn't prompt "Do you trust the files in this folder?". Trust lives in
     * ~/.claude.json under projects["<dir>"].hasTrustDialogAccepted. Idempotent (only writes
     * if something changed).
     */
    private fun ensureClaudeTrust(context: Context) {
        try {
            val cfg = File(rootfsDir(context), "home/rivet/.claude.json")
            if (!cfg.exists()) return
            val json = org.json.JSONObject(cfg.readText())
            val projects = json.optJSONObject("projects") ?: org.json.JSONObject().also { json.put("projects", it) }
            var changed = false
            for (dir in listOf("/home/rivet", "/home/rivet/rivet-bridge")) {
                val p = projects.optJSONObject(dir) ?: org.json.JSONObject().also { projects.put(dir, it); changed = true }
                if (!p.optBoolean("hasTrustDialogAccepted", false)) {
                    p.put("hasTrustDialogAccepted", true)
                    p.put("projectOnboardingSeenCount", 1)
                    p.put("hasClaudeMdExternalIncludesApproved", true)
                    p.put("hasClaudeMdExternalIncludesWarningShown", true)
                    changed = true
                }
            }
            if (changed) cfg.writeText(json.toString())
        } catch (t: Throwable) {
            Log.e(TAG, "ensureClaudeTrust failed", t)
        }
    }

    /** Copy the bundled bridge script into the rootfs and write its auth token. */
    private fun installBridge(context: Context) {
        try {
            val dir = bridgeDir(context).apply { mkdirs() }
            context.assets.open(BRIDGE_ASSET).use { input ->
                File(dir, BRIDGE_ASSET).outputStream().use { input.copyTo(it) }
            }
            File(dir, "token").writeText(RIVET_BRIDGE_TOKEN)
        } catch (t: Throwable) {
            Log.e(TAG, "installBridge failed", t)
        }
    }

    private fun isSymlink(f: File): Boolean = try {
        f.absoluteFile.canonicalFile != f.absoluteFile
    } catch (_: Throwable) { false }

    private const val BRIDGE_ASSET = "rivet-bridge-server-v2.js"
    // Gzipped tar of the full rootfs. Neutral .bin extension so AGP doesn't auto-gunzip it
    // at build time; stored uncompressed in the APK (see build.gradle noCompress) so the
    // large asset opens. The content is still gzip — extracted with `tar -xzf` below.
    private const val ROOTFS_ASSET = "rivet-rootfs.bin"
    // Gzipped tar of the rivet-memory plugin overlay (/opt/rivet-memory{,grok} + register script).
    // Same .bin/noCompress trick as the rootfs asset. Bump REV to re-provision on the next launch
    // when the shipped plugin changes (else the rev marker in the rootfs short-circuits it).
    private const val MEMORY_OVERLAY_ASSET = "rivet-memory-overlay.bin"
    // rev 2: durable offline outbox (rivet-memory-offline.sh) wraps both capture launchers so
    // captures made off-mesh aren't lost (the bundle's own spool is ephemeral) — replayed on reconnect.
    private const val MEMORY_OVERLAY_REV = "3"
    // Gzipped tar of the rivet-shared overlay (libnfs userspace client + `rivet-shared` wrapper +
    // a /usr/local/bin PATH symlink). Same .bin/noCompress trick. Bump REV to re-provision.
    private const val RIVET_SHARED_OVERLAY_ASSET = "rivet-shared-overlay.bin"
    // rev 2: wrapper claims uid/gid 2000 (RIVET_SHARED_UID/GID) so writes land as the shared rivet
    // identity on the no_all_squash home-WiFi export too (rev 1 wrote as the proot guest uid 1000).
    private const val RIVET_SHARED_OVERLAY_REV = "3"
    // Gzipped tar of curl + iputils-ping + iproute2 (/usr/bin, /usr/sbin, shared libs, /etc/iproute2).
    private const val NET_TOOLS_OVERLAY_ASSET = "rivet-net-tools-overlay.bin"
    private const val NET_TOOLS_OVERLAY_REV = "1"
    // Gzipped tar of den-server.bundle.mjs → home/rivet/rivet-den/. Same .bin/noCompress trick.
    private const val DEN_OVERLAY_ASSET = "rivet-den-overlay.bin"
    private const val DEN_OVERLAY_REV = "1"
    // Gzipped tar of rivethub-web dist → home/rivet/rivethub-web/dist/. Same .bin/noCompress trick.
    private const val WEB_OVERLAY_ASSET = "rivet-web-overlay.bin"
    private const val WEB_OVERLAY_REV = "1"

    /** Guest path to the full RivetOS monorepo entrypoint (when provisioned in-rootfs). */
    const val FULL_RUNTIME_JS = "/home/rivet/rivetos/dist/rivetos.js"
    /** Guest path to the full-runtime config written by [ensureFullRuntimeConfig]. */
    const val FULL_RUNTIME_CONFIG = "/home/rivet/config.yaml"

    /** Loopback port for the den-server gateway (rivethub-web + den API/WS). */
    const val DEN_PORT = 5174

    private const val PROVISION_TAG = "RivetProvision"

    /**
     * In-rootfs provision script (proven end-to-end on device).
     * - GIT_SSL_NO_VERIFY: minimal rootfs has no CA store; public repo.
     * - npm ci --ignore-scripts: no C++ toolchain; keeps optional prebuilt @esbuild/@nx arm64.
     * - Exit codes checked via set -e (do not pipe to tail before testing $?).
     */
    private val PROVISION_SCRIPT = """
        |#!/bin/bash
        |set -e
        |export GIT_SSL_NO_VERIFY=true
        |git config --global http.sslVerify false
        |cd /home/rivet
        |if [ -d rivetos/.git ]; then
        |  echo "RivetProvision: existing clone — pulling…"
        |  cd rivetos
        |  git pull --ff-only || true
        |else
        |  echo "RivetProvision: cloning rivetOS monorepo…"
        |  git clone --depth 1 https://github.com/philbert440/rivetOS rivetos
        |  cd rivetos
        |fi
        |echo "RivetProvision: npm ci (ignore-scripts, keep optional prebuilts)…"
        |npm ci --ignore-scripts --no-audit --no-fund
        |echo "RivetProvision: nx build (exclude container-rivetos,site)…"
        |npx nx run-many -t build --exclude container-rivetos,site --parallel=2
        |echo "RivetProvision: npm run bundle → dist/rivetos.js…"
        |npm run bundle
        |test -f dist/rivetos.js
        |echo "RivetProvision: done — dist/rivetos.js ready"
        |""".trimMargin()
}

/** A ready-to-launch native command: argv + extra env + the host cwd to start it in. */
data class RuntimeCommand(
    val argv: List<String>,
    val env: Map<String, String>,
    val workingDir: File,
)

/** A PTY command shaped for Termux's TerminalSession: argv0 + args + env ("K=V") + cwd. */
data class PtyCommand(
    val executable: String,
    val args: Array<String>,
    val env: Array<String>,
    val cwd: String,
)
