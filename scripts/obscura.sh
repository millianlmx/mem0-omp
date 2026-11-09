#!/usr/bin/env bash
# Obscura épinglé (navigateur headless, serveur CDP) des tests du harness.
#   --prepare  télécharge l'archive de la plate-forme, vérifie son SHA-256 et
#              l'extrait dans .obscura/v0.2.6/ (à la racine du clone)
#   --path     imprime le chemin du binaire
# OBSCURA_BIN remplace le binaire épinglé : --prepare vérifie alors seulement
# qu'il est exécutable. Codes : 0 prêt, 1 échec, 2 non exécuté (prérequis absent).
# Compatible bash 3.2 ; n'écrit jamais hors du clone.
set -euo pipefail

VERSION="0.2.6"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/.obscura"
DEST="$BASE/v$VERSION"

MODE="${1:-}"
case "$MODE" in
  --prepare | --path) ;;
  *)
    printf 'usage : bash scripts/obscura.sh --prepare | --path\n' >&2
    exit 2
    ;;
esac

if [ -n "${OBSCURA_BIN:-}" ]; then
  OBSCURA_PATH="$OBSCURA_BIN"
else
  OBSCURA_PATH="$DEST/obscura"
fi

if [ "$MODE" = "--path" ]; then
  printf '%s\n' "$OBSCURA_PATH"
  exit 0
fi

if [ -n "${OBSCURA_BIN:-}" ]; then
  if [ ! -x "$OBSCURA_BIN" ]; then
    printf 'OBSCURA_BIN n'"'"'est pas exécutable : %s\n' "$OBSCURA_BIN"
    exit 1
  fi
  printf '  obscura fourni : %s\n' "$OBSCURA_BIN"
  exit 0
fi

if [ -x "$OBSCURA_PATH" ]; then
  printf '  déjà préparé : %s\n' "$OBSCURA_PATH"
  exit 0
fi

# Empreintes SHA-256 des archives de la release.
obscura_sha256() {
  case "$1" in
    x86_64-linux) echo "eed986e478c5ec5439f531f2d7fb6b0e36a356f1df7a6c44a8e8fd4f2486bd76" ;;
    aarch64-linux) echo "e12aff8bbe40326386a471060083e9cec5255b67048996b84f649efef10cac39" ;;
    aarch64-macos) echo "19faa248ac762f466ddb822dbb03ed4f097312d10d1a4d5b2143e6040a9bebd0" ;;
    x86_64-macos) echo "897f03df4e3d704f946c5e14c6a90a34e0d4e4ef898c4b3201771712962cd7fb" ;;
    *) echo "" ;;
  esac
}

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) cible="x86_64-linux" ;;
  Linux/aarch64 | Linux/arm64) cible="aarch64-linux" ;;
  Darwin/arm64) cible="aarch64-macos" ;;
  Darwin/x86_64) cible="x86_64-macos" ;;
  *)
    printf 'non exécuté : plate-forme %s/%s sans binaire Obscura publié\n' "$(uname -s)" "$(uname -m)"
    exit 2
    ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  printf 'non exécuté : curl absent\n'
  exit 2
fi
if command -v shasum >/dev/null 2>&1; then
  sha256="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  sha256="sha256sum"
else
  printf 'non exécuté : ni shasum ni sha256sum\n'
  exit 2
fi

asset="obscura-$cible.tar.gz"
attendu="$(obscura_sha256 "$cible")"
if [ -z "$attendu" ]; then
  printf 'empreinte inconnue pour %s : ajoute-la à scripts/obscura.sh\n' "$asset"
  exit 1
fi

mkdir -p "$BASE"
# Temporaires du MÊME dossier : un arrêt en cours de route ne laisse jamais de
# dossier partiel à la place de .obscura/v$VERSION/.
archive="$(mktemp "$BASE/.telechargement.XXXXXX")"
extrait="$(mktemp -d "$BASE/.extraction.XXXXXX")"
trap 'rm -rf "$archive" "$extrait"' EXIT

url="https://github.com/h4ckf0r0day/obscura/releases/download/v$VERSION/$asset"
if ! curl -fsSL -o "$archive" "$url"; then
  printf 'téléchargement d'"'"'Obscura impossible : %s\n' "$url"
  exit 1
fi
obtenu="$($sha256 "$archive")"
obtenu="${obtenu%% *}"
if [ "$obtenu" != "$attendu" ]; then
  printf 'empreinte SHA-256 inattendue pour %s\n' "$asset"
  exit 1
fi
if ! tar --no-same-owner -xzf "$archive" -C "$extrait" || [ ! -f "$extrait/obscura" ]; then
  printf 'archive Obscura sans exécutable obscura\n'
  exit 1
fi
chmod 0755 "$extrait/obscura"
rm -rf "$DEST"
mv "$extrait" "$DEST"
printf '  préparé : %s\n' "$OBSCURA_PATH"
