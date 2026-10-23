#!/usr/bin/env bash
# Construit les apps jointes à chaque release GitHub (.github/workflows/release-assets.yml).
#
#   scripts/release-assets.sh mac   → OMP-Console-macOS.zip (le bundle .app)
#   scripts/release-assets.sh ios   → OMP-Console-iOS.ipa
#
# Chaque fichier est écrit dans omp-console/build/release-assets/ (ignoré par git),
# à côté de son empreinte `<fichier>.sha256`.
#
# L'app Mac est assemblée par scripts/swift-app.sh --no-tests : les tests ont déjà
# tourné sur la PR (job macos-app-swift), la release ne refait que le bundle. Sans
# identité d'équipe dans le trousseau, il est signé ad hoc : macOS le met en
# quarantaine au téléchargement (`xattr -dr com.apple.quarantine`), et Siri n'en
# exécute aucun intent (voir l'en-tête de swift-app.sh).
#
# L'IPA est construite en Release pour un appareil, SANS signature
# (CODE_SIGNING_ALLOWED=NO) : le dépôt n'a ni certificat ni profil Apple. Elle
# s'installe après re-signature par un outil qui signe avec ton compte (Sideloadly,
# AltStore, ou `xcrun` avec ton profil).
#
# Codes de sortie : 0 fichier écrit, 1 échec, 2 non exécuté (hors macOS ou Xcode
# inutilisable).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"
OUT="$ROOT/omp-console/build/release-assets"

app="${1:-}"
case "$app" in
  mac | ios) ;;
  *)
    echo "✗ usage : scripts/release-assets.sh mac|ios" >&2
    exit 1
    ;;
esac

if [ "$(uname -s)" != "Darwin" ]; then
  echo "· non exécuté : les apps ne se construisent que sous macOS ($(uname -s) détecté)"
  exit 2
fi

# Même résolution d'Xcode que scripts/ios-build.sh : DEVELOPER_DIR s'il est posé,
# sinon /Applications/Xcode.app.
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
if [ -z "${DEVELOPER_DIR:-}" ] || ! xcodebuild -showsdks >/dev/null 2>&1; then
  echo "· non exécuté : Xcode inutilisable (DEVELOPER_DIR, ou /Applications/Xcode.app)"
  exit 2
fi
export DEVELOPER_DIR

mkdir -p "$OUT"

# L'empreinte, nommée par le seul nom du fichier : `shasum -c` la vérifie à côté du
# fichier téléchargé.
empreinte() {
  (cd "$OUT" && shasum -a 256 "$1" > "$1.sha256")
  echo "  ✓ $OUT/$1 (+ .sha256)"
}

if [ "$app" = mac ]; then
  ZIP="OMP-Console-macOS.zip"
  if ! bash "$ROOT/scripts/swift-app.sh" --no-tests; then
    echo "✗ assemblage de l'app Mac échoué (scripts/swift-app.sh --no-tests)" >&2
    exit 1
  fi
  rm -f "$OUT/$ZIP"
  # `ditto` garde les droits d'exécution et la signature, que zip perdrait.
  if ! ditto -c -k --keepParent "$ROOT/omp-console/build/OMP Console.app" "$OUT/$ZIP"; then
    echo "✗ archive de l'app Mac échouée (ditto)" >&2
    exit 1
  fi
  empreinte "$ZIP"
  exit 0
fi

IPA="OMP-Console-iOS.ipa"
DERIVED="$ROOT/omp-console/build/ios-derived"
if ! xcodebuild build \
  -project omp-console/ios/OMPConsoleIOS.xcodeproj \
  -scheme OMPConsoleIOS \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -derivedDataPath "$DERIVED" \
  CODE_SIGNING_ALLOWED=NO; then
  echo "✗ compilation Release de l'app iOS échouée" >&2
  exit 1
fi
APP="$DERIVED/Build/Products/Release-iphoneos/OMPConsoleIOS.app"
if [ ! -d "$APP" ]; then
  echo "✗ app iOS introuvable après compilation : $APP" >&2
  exit 1
fi

# Une IPA est une archive zip dont la racine est `Payload/<app>.app`.
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir "$STAGE/Payload"
cp -R "$APP" "$STAGE/Payload/"
rm -f "$OUT/$IPA"
if ! (cd "$STAGE" && zip -qry "$OUT/$IPA" Payload); then
  echo "✗ archive de l'IPA échouée (zip)" >&2
  exit 1
fi
empreinte "$IPA"
exit 0
