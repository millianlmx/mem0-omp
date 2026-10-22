#!/usr/bin/env bash
# Imprime les fichiers de test node que `── Tests` de scripts/check.sh doit
# lancer, un chemin `test/<domaine>/<nom>.test.ts` par ligne, sous-dossiers
# compris, triés octet par octet (`LC_ALL=C sort`, l'ordre de listTestFiles de
# test/support/repo.ts). test/support/ ne porte aucun `.test.ts` : ses modules
# ne sont jamais lancés seuls.
#
#   bash scripts/test-files.sh                     tous les test/**/*.test.ts
#   bash scripts/test-files.sh --scope=macos       ceux qui dépendent de macOS
#   bash scripts/test-files.sh --scope=outillage   ceux qui relancent check.sh entier
#   bash scripts/test-files.sh --scope=changed     ceux que le diff courant concerne
#   bash scripts/test-files.sh --scope=changed=<base>   idem, diff depuis <base>
#
# `--scope=macos` est la SEULE définition de « fichier de test qui appelle swift
# ou xcodebuild » (la CI macOS des pull_request ne lance que ceux-là) : un fichier
# est retenu si son nom commence par `ios-` ou si son contenu nomme swift, swiftc,
# xcodebuild, xcrun, swift-app.sh ou ios-build.sh. Aucune liste à tenir : un
# fichier nouveau est classé par son contenu, et la règle sur-inclut plutôt
# qu'elle ne saute un fichier en silence.
#
# `--scope=outillage` : les fichiers qui relancent un check.sh COMPLET dans une
# copie (donc la suite entière) — ceux dont le contenu lance `["scripts/check.sh"]`
# sans option ou le moteur `"scripts/release.ts",` (argument de spawn seul sur sa
# ligne), qui l'appelle. check.sh les lance toujours ; `--scope=changed` ne les
# retient jamais (un maillon qui vérifie son lot ne doit pas rejouer la suite).
#
# `--scope=changed[=<base>]` (base par défaut : HEAD) : les fichiers du diff =
# `git diff --name-only <base>` + les fichiers non suivis non ignorés. Retenus :
#   (a) les test/**/*.test.ts du diff eux-mêmes ;
#   (b) tout fichier de test dont le texte nomme un fichier source du diff par
#       son nom (`chain.ts`) ou par la fin d'un import (`/chain"`) ;
#   (c) les fichiers de `--scope=macos` si le diff touche omp-console/.
# Repli : git absent, hors dépôt, ou diff vide ⇒ message sur stderr et liste
# complète (hors outillage), jamais une liste vide silencieuse.
#
# Jamais de liste vide silencieuse : ensemble vide, option inconnue ou python3
# absent ⇒ message sur stderr et sortie 1.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

scope=""
base="HEAD"
for arg in "$@"; do
  case "$arg" in
    --scope=macos) scope="macos" ;;
    --scope=outillage) scope="outillage" ;;
    --scope=changed) scope="changed" ;;
    --scope=changed=*) scope="changed"; base="${arg#--scope=changed=}" ;;
    *) echo "✗ option inconnue : $arg" >&2; exit 1 ;;
  esac
done

# `find`, jamais `**` : le bash 3.2 des Mac n'a pas `globstar`.
files=()
while IFS= read -r file; do
  files+=("$file")
done < <(find test -type f -name '*.test.ts' | LC_ALL=C sort)

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

# Le diff est calculé ici, en bash, pour que python ne dépende pas de git :
# `changed_status` vaut 0 si git a répondu, 1 sinon (python replie alors).
changed=""
changed_status=1
if [ "$scope" = "changed" ]; then
  if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    if diffed="$(git diff --name-only "$base" -- 2>&1)"; then
      untracked="$(git ls-files --others --exclude-standard 2>/dev/null)"
      changed="$(printf '%s\n%s\n' "$diffed" "$untracked" | LC_ALL=C sort -u)"
      changed_status=0
    else
      echo "✗ git diff --name-only $base a échoué : $diffed" >&2
    fi
  else
    echo "✗ git absent ou hors dépôt" >&2
  fi
fi

# Le filtre passe par python3, jamais par `grep -P` (rejeté par le grep BSD de
# macOS, voir `── Extension` de check.sh). L'ordre est celui du tri ci-dessus,
# reçu en arguments : python ne retrie rien.
MEM0_TEST_SCOPE="$scope" MEM0_TEST_CHANGED="$changed" MEM0_TEST_CHANGED_STATUS="$changed_status" \
python3 - "${files[@]}" <<'PY'
import os, re, sys
MACOS = re.compile(r"\b(swift|swiftc|xcodebuild|xcrun)\b|swift-app\.sh|ios-build\.sh")
OUTILLAGE = re.compile(r'\["scripts/check\.sh"\]|^\s*"scripts/release\.ts",$', re.M)

scope = os.environ["MEM0_TEST_SCOPE"]
paths = sys.argv[1:]
texts = {}
for path in paths:
    with open(path, encoding="utf-8") as handle:
        texts[path] = handle.read()

def is_macos(path):
    return os.path.basename(path).startswith("ios-") or MACOS.search(texts[path]) is not None

def is_outillage(path):
    return OUTILLAGE.search(texts[path]) is not None

def emit(kept):
    if not kept:
        print("✗ aucun fichier de test retenu", file=sys.stderr)
        sys.exit(1)
    for path in kept:
        print(path)
    sys.exit(0)

if scope == "macos":
    emit([p for p in paths if is_macos(p)])
if scope == "outillage":
    emit([p for p in paths if is_outillage(p)])

# scope == "changed"
everything = [p for p in paths if not is_outillage(p)]
changed = [line for line in os.environ["MEM0_TEST_CHANGED"].split("\n") if line.strip() != ""]
if os.environ["MEM0_TEST_CHANGED_STATUS"] != "0":
    print("· repli : liste complète hors outillage", file=sys.stderr)
    emit(everything)
if not changed:
    print("· diff vide depuis la base : liste complète hors outillage", file=sys.stderr)
    emit(everything)

kept = set()
# (a) les fichiers de test du diff eux-mêmes.
for path in changed:
    if path in texts:
        kept.add(path)
# (b) les tests qui nomment un fichier source du diff.
sources = [p for p in changed if p not in texts]
rules = []
for source in sources:
    name = os.path.basename(source)
    stem, ext = os.path.splitext(name)
    alternatives = [r"(?<![A-Za-z0-9_-])" + re.escape(name) + r"(?![A-Za-z0-9_])"]
    if ext:
        alternatives.append("/" + re.escape(stem) + r"[\"']")
    rules.append(re.compile("|".join(alternatives)))
if rules:
    for path in paths:
        if path in kept:
            continue
        text = texts[path]
        if any(rule.search(text) for rule in rules):
            kept.add(path)
# (c) le diff touche omp-console/ : les tests qui dépendent de macOS.
if any(p.startswith("omp-console/") for p in changed):
    for path in paths:
        if is_macos(path):
            kept.add(path)

emit([p for p in paths if p in kept and not is_outillage(p)])
PY
