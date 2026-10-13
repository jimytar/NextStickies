#!/usr/bin/env bash
# Builds everything in Docker (same as CI): tests, Windows app + NSIS installer, Linux AppImage.
#   ./build.sh                 app + AppImage + installer into ./out
#   ./build.sh app             tested Windows app files into ./out/app and the AppImage into ./out/linux
#   ./build.sh installer [dir] installer into ./out/installer from ./out/app (or [dir], e.g. a signed copy)
# VERSION defaults to the next version from scripts/next-version.sh (0.0.0 if there is nothing new).
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${VERSION:-$(scripts/next-version.sh)}"
VERSION="${VERSION:-0.0.0}"

build_app() {
  rm -rf out/app out/linux
  docker buildx build --network host --target app-out --build-arg VERSION="$VERSION" --output type=local,dest=out/app .
  docker buildx build --network host --target appimage-out --build-arg VERSION="$VERSION" --output type=local,dest=out/linux .
}

build_installer() {
  local app="${1:-out/app}"
  rm -rf out/installer
  docker buildx build --network host --target installer-out --build-arg VERSION="$VERSION" \
    --build-context appfiles="$app" --output type=local,dest=out/installer .
}

case "${1:-all}" in
  app) build_app ;;
  installer) build_installer "${2:-}" ;;
  all) build_app && build_installer ;;
  *) echo "usage: $0 [app|installer [dir]|all]" >&2; exit 2 ;;
esac
echo "Version $VERSION →" out/installer/*.exe out/linux/*.AppImage 2>/dev/null || true
