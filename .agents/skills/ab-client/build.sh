#!/bin/sh
# Builds the desktop app from this checkout as "AB Code.app": the stock unsigned macOS build with
# the Askew Brook icon and an ad-hoc signature. No update feed, so it never replaces itself.
set -eu

root=$(git rev-parse --show-toplevel)
cd "$root"
skill="$root/.agents/skills/ab-client"
out="$root/release/ab"
app="$out/AB Code.app"

node_version=$(sed -n 's/.*"node": "\([0-9.]*\)".*/\1/p' package.json | head -1)
pnpm_version=$(sed -n 's/.*"packageManager": "pnpm@\([0-9.]*\)".*/\1/p' package.json)
run() {
  npm exec --yes --package="node@$node_version" --package="pnpm@$pnpm_version" -- "$@"
}
arch=$(uname -m | sed 's/x86_64/x64/')

# Packaging infers an update feed from these; without one the app has no updater to run.
unset T3CODE_DESKTOP_UPDATE_REPOSITORY GITHUB_REPOSITORY

run pnpm install --frozen-lockfile
rm -rf "$out"
run pnpm exec vp run dist:desktop:artifact --platform mac --target zip --arch "$arch" --output-dir "$out"

ditto -x -k "$(ls "$out"/*.zip | head -1)" "$out/unpacked"
mv "$(ls -d "$out"/unpacked/*.app | head -1)" "$app"
rm -rf "$out/unpacked" "$out"/*.zip "$out"/*.blockmap "$out"/*.yml

iconset="$out/icon.iconset"
mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$skill/icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$((size * 2))" "$((size * 2))" "$skill/icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$app/Contents/Resources/icon.icns"
rm -rf "$iconset"

# Display name only: the bundle id, executable and data directory stay T3 Code's.
plist="$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName AB Code" -c "Set :CFBundleDisplayName AB Code" "$plist"

codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"

version=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$plist")
echo "built $app ($version)"
