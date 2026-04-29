#!/usr/bin/env bash
# Fetch third-party brand assets that aren't checked in raw.
# Currently: Google "G" sign-in logo from Google's public Identity images.
# Apple's Sign-in-with-Apple logo lives behind the Apple Developer login,
# so it has to be downloaded by hand and dropped into the AppleSignInLogo.imageset.
set -euo pipefail

cd "$(dirname "$0")/.."
ASSETS="PendingBot/Resources/Assets.xcassets"
OUT="$ASSETS/GoogleG.imageset"

URL="https://developers.google.com/identity/images/g-logo.png"
TMP="$(mktemp -t google-g.XXXXXX.png)"

echo "→ fetching $URL"
curl --fail --silent --show-error --location "$URL" -o "$TMP"

cp "$TMP" "$OUT/g-logo.png"
rm -f "$TMP"

echo "✓ wrote $OUT/g-logo.png (80x80, single scale; SwiftUI downsamples for 28pt display)"
