# Android App Links — assetlinks.json

`assetlinks.json` proves `flickto.app` is allowed to open the Android
app. Without it, `autoVerify` in the app's manifest fails and `https://flickto.app/share/<code>`
links open in the browser instead of the app.

## Current state & before publishing

`sha256_cert_fingerprints` currently holds the **debug keystore** SHA-256
(`25:3E:FF:…:71:83`), so links open a **sideloaded debug build** during testing.
Before shipping to production, add the fingerprint of the cert that signs the
**installed** release APK (keep the debug one or drop it — your call):

- **Google Play App Signing** (the usual case): Play Console → your app →
  *Test and release* → *App integrity* → *App signing* → copy the
  **SHA-256 certificate fingerprint**. This is the key Google re-signs with, so
  it's the one that matters for Play installs.
- **Local / sideloaded build:** run
  `keytool -list -v -keystore <your.keystore> -alias <alias>` and copy the
  `SHA256` line.

The colon-separated hex (e.g. `AB:CD:EF:...`) goes straight into the array.

## Supporting both keys

You can list more than one fingerprint. To make links work for both Play
installs **and** sideloaded/debug builds, add both:

```json
"sha256_cert_fingerprints": [
  "<play-app-signing-sha256>",
  "<upload-or-debug-sha256>"
]
```

## Verifying after deploy

- File must be reachable at `https://flickto.app/.well-known/assetlinks.json`
  over HTTPS, `Content-Type: application/json`, no redirects.
- Check with Google's tester:
  `https://digitalassetlinks.googleapis.com/v1/statements:list?source.web.site=https://flickto.app&relation=delegate_permission/common.handle_all_urls`
- On a device: `adb shell pm get-app-links com.flickto.app` should show the
  domain as `verified`.
