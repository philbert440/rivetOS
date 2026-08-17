# @rivetos/rivet-team-android

WebView host for rivet-team-web. **Apache-2.0**. Not a fork of
`apps/rivet-android` (AGPL RikkaHub).

The UI is the OpenMausBot messaging shell, talking to the rivet-team
stub/live gateway. Faces are Rivet den-bot, not OpenMausBot mascots.
Do not vendor OpenMausBot source.

## Assemble

Needs Android SDK 35 + JDK 17, and a Vite build of `../rivet-team-web`
copied to `app/src/main/assets/www`.

    (cd ../rivet-team-web && npm install && npm run build)
    rm -rf app/src/main/assets/www
    mkdir -p app/src/main/assets
    cp -a ../rivet-team-web/dist app/src/main/assets/www
    ./gradlew :app:assembleDebug

APK: `app/build/outputs/apk/debug/app-debug.apk`

## License boundary

- This directory: Apache-2.0 (see LICENSE).
- Do not copy source from `apps/rivet-android`.
- Do not vendor OpenMausBot (harness, Electron, cursor avatar).
