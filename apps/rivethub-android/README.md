# @rivetos/rivethub-android

RivetHub for Android — the desktop RivetHub app, phone-shaped. Kotlin / Jetpack Compose, Apache-2.0.
Package `io.rivethub.app`. Talks to a RivetOS den (device mTLS only); nothing runs on the phone.

Plan and slice status: see `AGENT.md`. Build: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
(JDK 21, SDK 37).

## First run — pairing QR

1. On the computer, show a pairing QR. Any one of:
   - RivetHub desktop or browser → **Settings → Pair a phone**: type a name, **Show pairing code**. The
     page says "Paired" once the phone has redeemed it, and the new phone works at once.
   - `rivetos pair <your-device-id>` on a node that is already set up (a mesh node, for example). Restart
     den afterwards: it reads the users registry at startup.
   - `rivetos local --device <your-device-id>` while setting up a single-machine install.

   Each mints the phone's certificate and shows the QR. When the node has a users registry
   (`users.json`), the device is added to it; without one, tenancy is off and every device the CA
   issues is already allowed.

2. On the phone (same network as the computer): RivetHub → Enroll → **Scan pairing QR**. Android 16+ asks
   for the Nearby devices (local network) permission first; without it the phone cannot reach the LAN.

The QR is an `intent:` link (VIEW + BROWSABLE, no package name, so the debug and release apps both open it).
The phone's system scanner opens RivetHub with it; **Scan pairing QR** reads the same code. Older
codes that are a `rivethub://` link or the raw JSON still scan inside the app. A link that opens the app from outside
(the camera app, a browser, another app) never pairs by itself: the app shows which computer it names and pairs only
when you confirm, since pairing replaces the phone's certificate. The link carries the gateway URL, a one-time token
(10 minutes, one use) and the SHA-256 of the gateway's TLS certificate; the app pins that certificate
to redeem the token at `POST /api/devices/pair` for the PKCS#12 and its passphrase. The computer deletes its copy of the PKCS#12 on redemption and keeps
the certificate so it can be revoked. Expired or used? Show a fresh code. A name that was already paired
is refused: pick a new name, or revoke the old certificate
(`scripts/rivet-ca.sh revoke device:<name>`) and delete `issued/device-<name>.crt`.

## First run — certificate file (mesh operators)

1. On the CA host: `scripts/rivet-ca.sh issue-client <your-device-id>` (the script prefixes `device:` itself) and export a PKCS#12
   that includes the chain (`openssl pkcs12 -export -in <crt> -inkey <key> -certfile <chain> -out <id>.p12`).
2. Ask the mesh operator to add `<your-device-id>` to the users registry (the gateway fails closed on an
   unknown device).
3. Copy the `.p12` to the phone, open RivetHub → Enroll: entry URL = your datahub gateway
   (`https://<node>:5174`), pick the file, enter its passphrase. Away from home, turn Tailscale on first.
