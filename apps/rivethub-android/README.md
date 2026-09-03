# @rivetos/rivethub-android

RivetHub for Android — the desktop RivetHub app, phone-shaped. Kotlin / Jetpack Compose, Apache-2.0.
Package `io.rivethub.app`. Talks to a RivetOS den (device mTLS only); nothing runs on the phone.

Plan and slice status: see `AGENT.md`. Build: `./gradlew :app:assembleDebug :app:testDebugUnitTest`
(JDK 21, SDK 37).

## First run (until QR enrollment exists)

1. On the CA host: `scripts/rivet-ca.sh issue-client device:<your-device-id>` and export a PKCS#12
   that includes the chain (`openssl pkcs12 -export -in <crt> -inkey <key> -certfile <chain> -out <id>.p12`).
2. Ask the mesh operator to add `<your-device-id>` to the users registry (the gateway fails closed on an
   unknown device).
3. Copy the `.p12` to the phone, open RivetHub → Enroll: entry URL = your datahub gateway
   (`https://<node>:5174`), pick the file, enter its passphrase. Away from home, turn Tailscale on first.
