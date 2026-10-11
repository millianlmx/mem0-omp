#!/usr/bin/env bash
# Imprime les fichiers de test node que `── Tests` de scripts/check.sh doit
# lancer, un chemin `test/<nom>.test.ts` par ligne, dans l'ordre du glob.
#
#   bash scripts/test-files.sh                 tous les test/*.test.ts
#   bash scripts/test-files.sh --scope=macos   ceux qui dépendent de macOS
#
# `--scope=macos` est la SEULE définition de « fichier de test qui appelle swift
# ou xcodebuild » (la CI macOS des pull_request ne lance que ceux-là) : un fichier
# est retenu si son nom commence par `ios-` ou si son contenu nomme swift, swiftc,
# xcodebuild, xcrun, swift-app.sh ou ios-build.sh. Aucune liste à tenir : un
# fichier nouveau est classé par son contenu, et la règle sur-inclut plutôt
# qu'elle ne saute un fichier en silence.
#
# Jamais de liste vide silencieuse : ensemble vide, option inconnue ou python3
# absent ⇒ message sur stderr et sortie 1.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

scope=""
for arg in "$@"; do
  case "$arg" in
    --scope=macos) scope="macos" ;;
    *) echo "✗ option inconnue : $arg" >&2; exit 1 ;;
  esac
done

shopt -s nullglob
files=(test/*.test.ts)
shopt -u nullglob

if [ "${#files[@]}" -eq 0 ]; then
  echo "✗ aucun fichier de test retenu" >&2
  exit 1
fi

if [ -z "$scope" ]; then
  printf '%s\n' "${files[@]}"
  exit 0
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 introuvable" >&2
  exit 1
fi

# Le filtre passe par python3, jamais par `grep -P` (rejeté par le grep BSD de
# macOS, voir `── Extension` de check.sh). L'ordre est celui du glob bash, reçu
# en arguments : python ne retrie rien.
python3 - "${files[@]}" <<'PY'
import os, re, sys
rule = re.compile(r"\b(swift|swiftc|xcodebuild|xcrun)\b|swift-app\.sh|ios-build\.sh")
kept = []
for path in sys.argv[1:]:
    if os.path.basename(path).startswith("ios-"):
        kept.append(path)
        continue
    with open(path, encoding="utf-8") as handle:
        if rule.search(handle.read()):
            kept.append(path)
if not kept:
    print("✗ aucun fichier de test retenu", file=sys.stderr)
    sys.exit(1)
for path in kept:
    print(path)
PY
