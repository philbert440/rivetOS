# @rivetos/rivethub-android

RivetHub for Android — the desktop RivetHub app, phone-shaped. Kotlin / Jetpack Compose, Apache-2.0.
Package `io.rivethub.app`. Talks to a RivetOS den (device mTLS only); nothing runs on the phone.

Plan and slice status: see `AGENT.md`. Build: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
(JDK 21, SDK 37).

## First run — pairing QR (`rivetos local`)

1. On the computer: `rivetos local --device <your-device-id>`. It mints the phone's certificate, adds the
   device to the users registry, and — once the node is up — shows a pairing QR in the terminal.
2. On the phone (same network as the computer): RivetHub → Enroll → **Scan pairing QR**.

The QR carries the gateway URL, a one-time token (10 minutes, one use) and the SHA-256 of the
gateway's TLS certificate; the app pins that certificate to redeem the token at `POST /api/devices/pair`
for the PKCS#12 and its passphrase. The computer deletes its copy of the PKCS#12 on redemption. Expired
or used? Run the command again for a fresh code.

## First run — certificate file (mesh operators)

1. On the CA host: `scripts/rivet-ca.sh issue-client <your-device-id>` (the script prefixes `device:` itself) and export a PKCS#12
   that includes the chain (`openssl pkcs12 -export -in <crt> -inkey <key> -certfile <chain> -out <id>.p12`).
2. Ask the mesh operator to add `<your-device-id>` to the users registry (the gateway fails closed on an
   unknown device).
3. Copy the `.p12` to the phone, open RivetHub → Enroll: entry URL = your datahub gateway
   (`https://<node>:5174`), pick the file, enter its passphrase. Away from home, turn Tailscale on first.
