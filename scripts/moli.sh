#!/usr/bin/env bash
# Moli épinglé (navigateur headless, serveur CDP) des tests du harness.
#   --prepare  télécharge l'archive de la plate-forme, vérifie son SHA-256 et
#              l'extrait dans .moli/v1.1.22/ (à la racine du clone)
#   --path     imprime le chemin du binaire
# MOLI_BIN remplace le binaire épinglé : --prepare vérifie alors seulement
# qu'il est exécutable. Codes : 0 prêt, 1 échec, 2 non exécuté (prérequis absent).
# Compatible bash 3.2 ; n'écrit jamais hors du clone.
set -euo pipefail

VERSION="1.1.22"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$ROOT/.moli"
DEST="$BASE/v$VERSION"

MODE="${1:-}"
case "$MODE" in
  --prepare | --path) ;;
  *)
    printf 'usage : bash scripts/moli.sh --prepare | --path\n' >&2
    exit 2
    ;;
esac

if [ -n "${MOLI_BIN:-}" ]; then
  MOLI_PATH="$MOLI_BIN"
else
  MOLI_PATH="$DEST/moli"
fi

if [ "$MODE" = "--path" ]; then
  printf '%s\n' "$MOLI_PATH"
  exit 0
fi

if [ -n "${MOLI_BIN:-}" ]; then
  if [ ! -x "$MOLI_BIN" ]; then
    printf 'MOLI_BIN n'"'"'est pas exécutable : %s\n' "$MOLI_BIN"
    exit 1
  fi
  printf '  moli fourni : %s\n' "$MOLI_BIN"
  exit 0
fi

if [ -x "$MOLI_PATH" ]; then
  printf '  déjà préparé : %s\n' "$MOLI_PATH"
  exit 0
fi

# Empreintes SHA-256 des archives de la release.
moli_sha256() {
  case "$1" in
    x86_64-unknown-linux-gnu) echo "7e10f9a5b62371da56203b21ac0172bbe3c3626de189fc3742b91b2e2b8cdd39" ;;
    aarch64-unknown-linux-gnu) echo "a199802d237fff981cb5a72ac075813af2510f5a4b51ce182d8fc18b5520210b" ;;
    aarch64-apple-darwin) echo "1498d3add44b888051fc29c2cb52dd4a5188128f17ec2c9060b2b42436e76dfd" ;;
    x86_64-apple-darwin) echo "f46620237211dde3b075f4f6260bac7b33671062186429dc1ef8f69244a03b65" ;;
    *) echo "" ;;
  esac
}

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) cible="x86_64-unknown-linux-gnu" ;;
  Linux/aarch64 | Linux/arm64) cible="aarch64-unknown-linux-gnu" ;;
  Darwin/arm64) cible="aarch64-apple-darwin" ;;
  Darwin/x86_64) cible="x86_64-apple-darwin" ;;
  *)
    printf 'non exécuté : plate-forme %s/%s sans binaire Moli publié\n' "$(uname -s)" "$(uname -m)"
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

asset="moli-$cible.tar.gz"
attendu="$(moli_sha256 "$cible")"
if [ -z "$attendu" ]; then
  printf 'empreinte inconnue pour %s : ajoute-la à scripts/moli.sh\n' "$asset"
  exit 1
fi

mkdir -p "$BASE"
# Temporaires du MÊME dossier : un arrêt en cours de route ne laisse jamais de
# dossier partiel à la place de .moli/v$VERSION/.
archive="$(mktemp "$BASE/.telechargement.XXXXXX")"
extrait="$(mktemp -d "$BASE/.extraction.XXXXXX")"
trap 'rm -rf "$archive" "$extrait"' EXIT

url="https://github.com/lexmount/moli/releases/download/v$VERSION/$asset"
if ! curl -fsSL --retry 5 --retry-delay 5 -o "$archive" "$url"; then
  printf 'téléchargement de Moli impossible : %s\n' "$url"
  exit 1
fi
obtenu="$($sha256 "$archive")"
obtenu="${obtenu%% *}"
if [ "$obtenu" != "$attendu" ]; then
  printf 'empreinte SHA-256 inattendue pour %s\n' "$asset"
  exit 1
fi
# L'archive contient un dossier moli-v<version>-<cible>/ : seul son exécutable est gardé.
if ! tar --no-same-owner -xzf "$archive" -C "$extrait" || [ ! -f "$extrait/moli-v$VERSION-$cible/moli" ]; then
  printf 'archive Moli sans exécutable moli\n'
  exit 1
fi
mv "$extrait/moli-v$VERSION-$cible/moli" "$extrait/moli"
rm -rf "$extrait/moli-v$VERSION-$cible"
chmod 0755 "$extrait/moli"
rm -rf "$DEST"
mv "$extrait" "$DEST"
printf '  préparé : %s\n' "$MOLI_PATH"
