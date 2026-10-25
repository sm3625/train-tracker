# Trackside for iOS and Android

The site, packaged as a native app with [Capacitor](https://capacitorjs.com/). There is no separate app code: the app
ships the same `index.html` and `data/` as the website, and `build.mjs` adds two scripts ahead of the page's own.

## Setup

Needs Node 22 or newer. For iOS, Xcode (from the Mac App Store). For Android, Android Studio, which installs the
Android SDK.

```
cd app
npm install
npm run ios        # builds, copies into ios/, opens Xcode; press Run
npm run android    # the same for Android Studio
```

After changing `index.html` (or when the timetables change), run `npm run sync` to copy the page into both apps.
Xcode and Android Studio don't pick up the page on their own.

| Command | What it does |
|---|---|
| `npm run build` | Builds `www/` from `../index.html` and `../data/` |
| `npm run sync` | Builds, then copies `www/` and the plugins into `ios/` and `android/` |
| `npm run ios` / `npm run android` | Syncs one platform and opens it in Xcode or Android Studio |
| `npm run icons` | Regenerates every icon and launch screen from the SVGs in `assets/` (see `icons.mjs`) |

## How the app differs from the website

The page checks `IN_APP` (true only inside the app) for the few things that work differently:

- **Location** uses the native plugin (`@capacitor/geolocation`): the phone's own permission prompt, and it works under
  the app's `capacitor://` address, where the browser's location doesn't reliably.
- **Contacts** (`@capacitor-community/contacts`): Friends > "Find friends in your contacts" asks for permission, then
  sends the numbers only as SHA-256 hashes to see who's on Trackside (see Friends in `../worker/README.md`). The
  website has no such button. The App Store and Google Play ask about contacts in their privacy forms.
- **Share links** point at the website (`SITE_URL` in `../worker/wrangler.toml`), since the app's own address means
  nothing to anyone else.
- **Timetables** for the trip planner come from the website, which refreshes them weekly; the copy built into the app
  is only a fallback for when the site can't be reached. (Amtrak's covers about a week, so a built-in copy goes stale
  fast.)
- **Android's back button** steps back through dialogs and screens, as Escape does on the web, then leaves the app.
- **The status bar's** icons follow the theme picked in Settings (Light, Dark or Auto) rather than the phone's, so they
  stay readable over the map.

On Android, the app and the site in an Android browser both get a few touches of Material in place of Apple's
conventions (`:root[data-os="android"]` in `index.html`): solid surfaces instead of blurred ones, Roboto without the
tighter tracking SF wants, 28 dp sheet and dialog corners, Material switches and a back arrow. The Android icon is
adaptive, in two layers, and has a one-colour layer for Android 13's themed icons; iOS has a dark-mode icon.

## The feeds worker must allow the app

The iOS app loads its page from `capacitor://localhost` and the Android app from `https://localhost`. Both are in
`ALLOWED_ORIGINS` in `../worker/wrangler.toml`, and `npm test` in `worker/` fails if either goes missing. Without them
the app shows only Amtrak, VIA and Brightline: the commuter railroads come from the worker.

## Before releasing to the App Store or Google Play

- **The app id**, `io.github.sm3625.trackside` (in `capacitor.config.json`), can't be changed once an app is published.
  Change it now if you'd rather have another, then run `npx cap sync` and update the bundle id in Xcode.
- **iOS:** an Apple Developer account ($99 a year). In Xcode, pick your team under Signing & Capabilities, set the
  version, then Product > Archive and upload to App Store Connect. TestFlight first.
- **Android:** a Google Play developer account ($25 once). In Android Studio, Build > Generate Signed App Bundle, with
  an upload key you keep safe. Internal testing first.
- **Both stores** want a privacy policy (location is used on the device only) and screenshots. Apps with accounts must
  let people delete theirs from inside the app; Trackside's account settings already do.
- **Data terms:** Metrolink's feed terms limit it to internal use (see `../worker/README.md`). Get Metrolink's
  permission, or hide it with `HIDDEN_PROVIDERS` in `index.html`, before publishing. Positions for Amtrak come from
  the unofficial Amtraker API; say so in the store listing, as the site does.
