# Native (bionic) dropbear for RivetHub — the Termux-style full-SSH plan

Goal: full interactive SSH (`ssh -t`, line editing, TERM) into the on-device rootfs,
the way **Termux does it** — a **native (bionic) dropbear running OUTSIDE proot**, so it
allocates the controlling pty host-side (where Android's devpts works), then each session
`exec`s `proot … /bin/bash -l` to drop into the rootfs, inheriting that pty.

## ✅ BUILT + FULL-PTY VERIFIED THROUGH THE APP (2026-06-10)
Built against **NDK r27c (api 24)**, shipped as `libdropbear.so`/`libdropbearkey.so` jniLibs,
and confirmed end-to-end: `ssh -t rivet@<phone>:8022` from rivet-claude drops straight into
the rootfs with a real pty, running as **the RivetHub app uid** (the real seccomp target):

```
rivet@localhost:~$ tty        → /dev/pts/0            (real controlling terminal)
rivet@localhost:~$ echo $TERM → xterm-256color        (TERM propagated)
rivet@localhost:~$ id         → uid=1000(rivet) …      (inside the rootfs, proot -i 1000)
rivet@localhost:~$ stty -a    → speed 38400 baud …     (termios works)
```

Verified binaries are stashed at **`prebuilt/`** (stripped, dynamic, aarch64). The patch in
`android.patch` is the exact source that built them.

### The app-uid seccomp gotcha (only surfaces as the app, not under `adb shell`)
A standalone run under `adb shell` is the **`shell`** SELinux/seccomp domain; the app runs as
**`untrusted_app`**, whose seccomp filter is stricter. dropbear's pubkey path drops euid/egid
to the user to read `authorized_keys` (`setegid`→`setresgid`, syscall 149) — `untrusted_app`
**SIGSYS-kills** that. Fix: **`DROPBEAR_SVR_MULTIUSER 0`** (in `default_options.h`; it's a bare
`#define`, NOT `#ifndef`, so `localoptions.h` can't override it) compiles out every
`set*uid/gid` block — we run single-user as one fixed app uid anyway. That then trips
dropbear's `common-session.c` "non-multiuser requires a non-multiuser kernel" guard (a
`getgroups` probe) — neutralized (we run MULTIUSER=0 *deliberately* on a normal kernel).
Moral: **always validate native daemons as the app uid, not via `adb shell`.**

## Why the previous approaches couldn't reach 100% (2026-06-10, ditched)
- **dropbear UNDER proot** (shipped as `ad5ba3c`, glibc, in the rootfs): works for key auth,
  commands, scp, and `ssh -T` — but **not full PTY**. proot can't back a guest-allocated
  controlling tty (`/dev/pts/N: No such file`, `TIOCSCTTY: I/O error`).
- **static-glibc native dropbear** (outside proot): runs on Android, but **glibc's
  `openpty`/`ptsname` are broken on Android's devpts** — a 5-line test returned
  `name=/dev/pts/0` (wrong) every time. glibc assumes a glibc system; Android's devpts
  (`mode=600,ptmxmode=000`) needs **bionic**, which is why Termux builds against it.

Conclusion: **must build against bionic (Android NDK).** Everything else is solved.

## The 6 Android source patches (in `android.patch` + `localoptions.h`)
Apply to a fresh `dropbear-2024.86` source (`patch -p1 < android.patch`; drop in
`localoptions.h`). These are bionic-agnostic — they carry straight into the NDK build:
1. **`default_options.h` / `localoptions.h`** — `DROPBEAR_REEXEC 0` (proot can't `execveat`
   by fd; harmless natively too), `DROPBEAR_SVR_PASSWORD_AUTH 0` (key-only; avoids needing
   `crypt()`/libtermux-auth), and **`DROPBEAR_SVR_MULTIUSER 0`** (the app-uid seccomp fix —
   see above; must be set in `default_options.h`, it's a bare `#define`).
2. **`dbutil.c`** — appended `__wrap_getpwnam`/`__wrap_getpwuid` shim that synthesizes the
   `rivet` user from env (`RIVET_PW_DIR`, `RIVET_PW_SHELL`) since Android has no
   `/etc/passwd`. Link with `-Wl,--wrap=getpwnam -Wl,--wrap=getpwuid`.
3. **`svr-auth.c`** — short-circuit the `/etc/shells` validity check (absent on Android).
4. **`sshpty.c`** — (a) tolerate `chown`/`chmod` failure on the pts (non-root app uid),
   and (b) **rewrite `pty_make_controlling_tty` the Termux way**: `setsid()` then open the
   slave WITHOUT `O_NOCTTY` to auto-assign the controlling tty — NO `TIOCSCTTY`, NO
   `/dev/tty` dance (both throw I/O errors on Android).
5. **`svr-chansession.c`** (the three fixes that took it from `ssh -T` to full `ssh -t`,
   each found by on-device bisection):
   - **Re-open the slave BEFORE closing the master.** Stock order is `close(master)` then
     reopen-slave-by-name; on Android's devpts the `/dev/pts/N` node is only resolvable
     while *this process* holds a master fd, so the reopen got `ENOENT`. Reordered.
   - **Ignore `SIGHUP` across `close(master)`.** Once the child owns the pts as its ctty,
     closing the master delivers a SIGHUP that killed the session child before exec.
     `signal(SIGHUP, SIG_IGN)` around the close, restored to `SIG_DFL` before exec so the
     user's shell still hangs up normally on real disconnect.
   - **Skip the utmp/wtmp login record.** bionic has no working utmp; `login_login()` faults.
     `noptycommand` (the `ssh -T` path) never wrote it — which is why `-T` worked and `-t`
     didn't. Skipped.
6. **`common-session.c`** — neutralize the `#if !DROPBEAR_SVR_MULTIUSER` "requires a
   non-multiuser kernel" sanity guard (a `getgroups` probe). We run `MULTIUSER 0`
   deliberately on a normal multiuser kernel; the guard would otherwise `dropbear_exit` per
   connection (`Early exit: Non-multiuser Dropbear requires a non-multiuser kernel`).

## Build (verified recipe)
1. **Android NDK r27c** (`android-ndk-r27c-linux.zip`, ~634 MB). Extract with real `unzip`
   (NOT python zipfile — it mangles the toolchain symlinks). Build, then delete the NDK.
2. ```
   NDKBIN=$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin
   export CC=$NDKBIN/aarch64-linux-android24-clang AR=$NDKBIN/llvm-ar RANLIB=$NDKBIN/llvm-ranlib
   ./configure --host=aarch64-linux-android --disable-zlib --disable-pam
   patch -p1 < android.patch && cp localoptions.h src/localoptions.h
   make PROGRAMS="dropbear dropbearkey" MULTI=0 \
        LDFLAGS="-Wl,--wrap=getpwnam -Wl,--wrap=getpwuid"
   $NDKBIN/llvm-strip dropbear dropbearkey
   ```
   **DYNAMIC, not `-static`.** A static bionic binary trips the loader's TLS-alignment check
   (`executable's TLS segment is underaligned … needs to be at least 64`). Termux ships
   dynamic too — bionic libc is on-device, so dynamic is correct and simpler.
3. **Verify pty** standalone: push `dropbear`/`dropbearkey` to `/data/local/tmp`, gen a host
   key (`./dropbearkey -t ed25519 -f hk`), write `authorized_keys` into a 700 home, run
   `RIVET_PW_DIR=… RIVET_PW_SHELL=/system/bin/sh ./dropbear -F -E -e -r hk -p 2222`, then
   `ssh -t` in through a **real local pty** (a non-tty caller makes `ssh -tt` report
   "not a tty" even when the server side is fine — drive it via `pty.fork()`/`script`).
   Expect `tty → /dev/pts/N`. (Flags note: `-s`/`-g` don't exist once password auth is
   compiled out; use `-F -E -e -r <hostkey> -p <port>`.)

## App integration (reuses the existing track-B scaffolding)
- Bundle the binary as a **jniLib** (`jniLibs/arm64-v8a/libdropbear.so`) so it's executable
  outside app-data (W^X) — same pattern as `libbusybox.so`/`libproot.so`.
- New `RivetRuntime.sshCommand` runs `libdropbear.so` **natively** (no proot wrapper), with
  env `RIVET_PW_DIR=<filesDir>/.ssh-home`, `RIVET_PW_SHELL=<wrapper>`, and host keys in a
  writable dir (`-r <filesDir>/dropbear/hk_ed25519`; pre-generate via `dropbearkey` jniLib
  on first launch — `-R` writes to the compiled `/etc/dropbear` default, unwritable).
- **Session = enter the rootfs**: `RIVET_PW_SHELL` (or an authorized_keys `command=`) execs
  `proot … --kill-on-exit -r <rootfs> … /bin/bash -l` — the host pty is inherited, so the
  rootfs bash gets a real controlling tty → full `ssh -t`.
- **Keep** from track B: the sidebar SSH toggle, `RivetRuntimeService` supervision +
  wakelock, the `rivet_ssh_enabled` pref. **Replace**: the dropbear binary (rootfs overlay
  → jniLib) and the launch (proot-wrapped → native). The rootfs-overlay dropbear
  (`rivet-dropbear.bin`, `ensureDropbear`, `DROPBEAR_OVERLAY_REV`) can then be retired.
- host-side `~/.ssh/authorized_keys` = rivet-claude key (write at prepare() time, app-owned
  700/600 dir — dropbear's strict perm check rejects world-writable paths).

## Gotchas learned
- **DYNAMIC not static** — static bionic trips the loader TLS-alignment check (see Build §2).
- **`unzip`, not python**, to extract the NDK — python's `zipfile` drops the symlinks the
  clang wrappers rely on (`clang` → `clang-18`), giving "clang-18: command not found".
- The three `svr-chansession.c` fixes are ORDER-dependent on each other: reorder exposes the
  SIGHUP; SIGHUP fix exposes the utmp fault. Bisect with file-logging (`dropbear_log` after
  the pty dup2 goes to the pts → lost; write to a file instead).
- A non-tty SSH caller (e.g. a CI/agent shell) makes `ssh -tt host 'tty'` print "not a tty"
  even when the server pty is perfect — the *client* has no terminal to proxy. Always verify
  through a real local pty.
- dropbear's strict authorized_keys check rejects any **group/world-writable** path
  component (the test failed on a 777 home).
- adb `run-as` can't bind sockets / write app tmp (restricted SELinux domain) → can't test
  native dropbear as the app uid via run-as; must test via the integrated jniLib.
- adb shell reaps backgrounded processes on exit, AND a child that inherits the adb stdio
  pipe keeps the `adb shell` call from returning → run the server in a held foreground call
  (a backgrounded task on the driving host), connect from a separate call.
- Device testing path: rivet-claude → `ssh rivet@<phildesk-host>` (phildesk) →
  `"/mnt/c/Users/philb/AppData/Local/Android/Sdk/platform-tools/adb.exe"` (one wireless
  device, drop `-s`). Phone mesh IP `<phone-ip>` for direct `ssh -p <port>` from rivet-claude.
