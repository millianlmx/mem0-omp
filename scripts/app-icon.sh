#!/usr/bin/env bash
# Dessine l'icône d'OMP Console et (ré)écrit ses quatre fichiers versionnés
# (feature ios-identite-app, S-2, BR-1) :
#   omp-console/ios/OMPConsoleIOS/Assets.xcassets/AppIcon.appiconset/AppIcon.png         (iOS, claire)
#   omp-console/ios/OMPConsoleIOS/Assets.xcassets/AppIcon.appiconset/AppIcon-dark.png    (iOS, sombre)
#   omp-console/ios/OMPConsoleIOS/Assets.xcassets/AppIcon.appiconset/AppIcon-tinted.png  (iOS, teintée)
#   omp-console/Bundle/AppIcon.icns                                                      (Mac)
#
# Une seule source de dessin, `scripts/app-icon/dessin.swift` : l'icône du Mac est
# construite depuis la variante CLAIRE, si bien que l'icône iOS est celle de l'app
# Mac. Le `.icns` est fait d'images carrées OPAQUES plein cadre : macOS 26 enferme
# dans un cadre gris toute icône héritée dont un pixel de bord a un alpha ≤ 252.
#
# Tout est écrit dans un dossier temporaire ; les fichiers du dépôt ne sont
# remplacés qu'une fois les quatre produits, jamais à moitié.
#
# Codes de sortie : 0 les quatre fichiers écrits, 1 échec (message `✗ …` sur
# stderr), 2 non exécuté (hors macOS).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$PWD"
ICONSET_DIR="$ROOT/omp-console/ios/OMPConsoleIOS/Assets.xcassets/AppIcon.appiconset"
ICNS="$ROOT/omp-console/Bundle/AppIcon.icns"
DESSIN="$ROOT/scripts/app-icon/dessin.swift"

for arg in "$@"; do
  echo "✗ argument inconnu : $arg (attendu : rien)" >&2
  exit 1
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "non exécuté : l'icône ne se dessine que sous macOS ($(uname -s) détecté)"
  exit 2
fi

for tool in xcrun sips iconutil; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "✗ $tool introuvable (relance : xcode-select --install)" >&2
    exit 1
  fi
done

if [ ! -d "$ICONSET_DIR" ]; then
  echo "✗ catalogue absent : ${ICONSET_DIR#"$ROOT"/} (relance : git checkout -- omp-console/ios/OMPConsoleIOS/Assets.xcassets)" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1) les trois variantes iOS.
if ! xcrun swift "$DESSIN" "$WORK/dessin" >"$WORK/dessin.log" 2>&1; then
  cat "$WORK/dessin.log" >&2
  echo "✗ dessin échoué (relance : xcrun swift scripts/app-icon/dessin.swift <dossier>)" >&2
  exit 1
fi
for variant in AppIcon.png AppIcon-dark.png AppIcon-tinted.png; do
  if [ ! -s "$WORK/dessin/$variant" ]; then
    echo "✗ variante absente après le dessin : $variant (relance : bash scripts/app-icon.sh)" >&2
    exit 1
  fi
done
echo "  ✓ trois variantes iOS dessinées (1024 × 1024, sans alpha)"

# 2) l'icône Mac, depuis la claire, aux dix tailles d'un `.iconset`.
ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for entry in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
  128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 512:icon_256x256@2x \
  512:icon_512x512 1024:icon_512x512@2x; do
  size="${entry%%:*}"
  name="${entry#*:}"
  if ! sips -z "$size" "$size" "$WORK/dessin/AppIcon.png" --out "$ICONSET/$name.png" >"$WORK/sips.log" 2>&1; then
    cat "$WORK/sips.log" >&2
    echo "✗ redimensionnement échoué : $name.png (relance : bash scripts/app-icon.sh)" >&2
    exit 1
  fi
done
if ! iconutil -c icns "$ICONSET" -o "$WORK/AppIcon.icns" >"$WORK/iconutil.log" 2>&1; then
  cat "$WORK/iconutil.log" >&2
  echo "✗ iconutil a échoué (relance : bash scripts/app-icon.sh)" >&2
  exit 1
fi
echo "  ✓ icône Mac assemblée (AppIcon.icns, 10 tailles)"

# 3) remplacement : chaque fichier est d'abord copié À CÔTÉ de sa destination,
#    puis renommé — un renommage dans un même dossier ne laisse jamais un fichier
#    tronqué. Les copies ne commencent qu'une fois les quatre produits présents.
staged=()
stage() {
  local source="$1" dest="$2"
  if ! cp "$source" "$dest.app-icon-tmp"; then
    for file in "${staged[@]}"; do rm -f "$file.app-icon-tmp"; done
    echo "✗ copie impossible vers ${dest#"$ROOT"/} (relance : bash scripts/app-icon.sh)" >&2
    exit 1
  fi
  staged+=("$dest")
}
stage "$WORK/dessin/AppIcon.png" "$ICONSET_DIR/AppIcon.png"
stage "$WORK/dessin/AppIcon-dark.png" "$ICONSET_DIR/AppIcon-dark.png"
stage "$WORK/dessin/AppIcon-tinted.png" "$ICONSET_DIR/AppIcon-tinted.png"
stage "$WORK/AppIcon.icns" "$ICNS"
for dest in "${staged[@]}"; do
  if ! mv -f "$dest.app-icon-tmp" "$dest"; then
    echo "✗ remplacement impossible : ${dest#"$ROOT"/} (relance : bash scripts/app-icon.sh)" >&2
    exit 1
  fi
done

for dest in "${staged[@]}"; do
  echo "  ✓ ${dest#"$ROOT"/}"
done
exit 0
