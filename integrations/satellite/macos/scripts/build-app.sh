#!/bin/zsh
# SPDX-License-Identifier: LicenseRef-BSL-1.1

set -euo pipefail

script_dir="${0:A:h}"
package_dir="${script_dir:h}"
app_path="$package_dir/.build/SatelliteBridge.app"
binary_path="$package_dir/.build/release/SatelliteBridge"

swift test --package-path "$package_dir"
swift build --package-path "$package_dir" -c release

case "$app_path" in
  "$package_dir"/.build/SatelliteBridge.app) ;;
  *) print -u2 "refusing unsafe app output path: $app_path"; exit 1 ;;
esac

rm -rf -- "$app_path"
mkdir -p "$app_path/Contents/MacOS" "$app_path/Contents/Resources"
cp "$binary_path" "$app_path/Contents/MacOS/SatelliteBridge"
cp "$package_dir/Resources/Info.plist" "$app_path/Contents/Info.plist"
codesign --force --deep --sign - "$app_path"

print "satellite_bridge_app=$app_path"

