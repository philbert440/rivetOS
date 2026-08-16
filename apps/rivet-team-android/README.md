# @rivetos/rivet-team-android

Jetpack Compose client for rivet-team. **Apache-2.0**. Written new — not a
fork of `apps/rivet-android` (AGPL RikkaHub) and not a copy of that tree.

Phone-first messaging app: **who is this** → **roster of personas as
contacts** → **one thread**. That IA is the OpenMausBot / Grok Bot shape
(bots you talk to like chats). Source is ours; do not vendor OpenMausBot.

Stub gateway so a reviewer can send a message and see a working chip + reply.

## Assemble

Needs Android SDK 35 + JDK 17. From this directory, after generating the
wrapper (Android Studio Import, or `gradle wrapper` if you have Gradle 8.11):

    ./gradlew :app:assembleDebug

APK: `app/build/outputs/apk/debug/app-debug.apk`

This slice ships `gradle-wrapper.properties` (Gradle 8.11.1) and project
files. If `gradlew` is missing, open the folder in Android Studio and let
it generate the wrapper, or run `gradle wrapper --gradle-version 8.11.1`.

## License boundary

- This directory: Apache-2.0 (see LICENSE).
- Do not copy source from `apps/rivet-android`.
- Do not vendor OpenMausBot.
