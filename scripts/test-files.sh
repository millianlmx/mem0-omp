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
#   bash scripts/test-files.sh --scope=files <chemins…>  ceux qu'une liste de fichiers concerne
#   … --scope=changed[=<base>] --macos             la même sélection, réduite aux
#   … --scope=files --macos <chemins…>             fichiers de --scope=macos
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
#   (b) tout fichier de test dont le texte nomme un fichier du diff par son nom
#       (`chain.ts`, `README.md`) ou par la fin d'un import (`/chain"`) ;
#   (b') tout fichier de test dont les imports RELATIFS, suivis de proche en
#       proche (`from "./x.ts"`, `export … from`, `import("…")`, `import "…"`),
#       atteignent un fichier du diff — un test qui importe service.ts est
#       concerné par verdict.ts que service.ts importe, même sans le nommer ;
#   (c) les fichiers de `--scope=macos` si le diff touche omp-console/ hors `.md`
#       (un README ne change pas ce que swift ou xcodebuild compilent) ;
#   (d) TOUS les fichiers (hors outillage) si le diff touche ce qui conditionne
#       la suite entière : scripts/check.sh, scripts/test-files.sh, package.json,
#       tsconfig.json ou tsconfig.test.json à la racine.
# Repli : git absent, hors dépôt, ou diff vide ⇒ message sur stderr et liste
# complète (hors outillage), jamais une liste vide silencieuse. Un diff non vide
# que nul test ne concerne ⇒ message sur stderr, sortie 0, rien sur stdout :
# check.sh (`--tests-base`) lit « rien à lancer », pas « lance tout ».
#
# `--scope=files <chemins…>` : les mêmes règles (a), (b), (b'), (c), (d)
# appliquées à la liste reçue en arguments (chemins relatifs à la racine) au lieu
# du diff git. C'est l'entrée du harness (`npm run test:touched -- <fichiers>`),
# qui connaît déjà les fichiers touchés depuis la base du run. Une liste vide ou
# des fichiers que nul test ne concerne (LICENSE…) ⇒ message sur stderr, sortie 0,
# rien sur stdout — pas de repli à la liste complète.
#
# `--macos` (avec changed ou files) : la sélection est ensuite réduite aux
# fichiers de `--scope=macos`. C'est la part macOS d'une pull_request : les tests
# que le diff concerne ET qui ne prouvent quelque chose que sur un Mac.
#
# `--with-outillage` (avec changed ou files) : les fichiers de `--scope=outillage`
# sont des fichiers comme les autres, retenus par les mêmes règles et compris
# dans les replis. C'est ce que passe `check.sh --tests-base` : en CI, un diff qui
# touche scripts/release.ts doit lancer release.test.ts même s'il relance un
# check.sh entier dans sa copie. Sans l'option (harness, `test:touched`), ils
# restent exclus : un maillon qui vérifie son lot ne rejoue pas la suite.
#
# Jamais de liste vide silencieuse : option inconnue, aucun fichier de test dans
# test/, ou python3 absent ⇒ message sur stderr et sortie 1.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

scope=""
base="HEAD"
macos_only=0
with_outillage=0
changed_files=()
for arg in "$@"; do
  if [ "$scope" = "files" ] && [ "$arg" != "--macos" ] && [ "$arg" != "--with-outillage" ]; then
    changed_files+=("$arg")
    continue
  fi
  case "$arg" in
    --scope=macos) scope="macos" ;;
    --scope=outillage) scope="outillage" ;;
    --scope=changed) scope="changed" ;;
    --scope=changed=*) scope="changed"; base="${arg#--scope=changed=}" ;;
    --scope=files) scope="files" ;;
    --macos) macos_only=1 ;;
    --with-outillage) with_outillage=1 ;;
    *) echo "✗ option inconnue : $arg" >&2; exit 1 ;;
  esac
done
if [ "$scope" != "changed" ] && [ "$scope" != "files" ]; then
  if [ "$macos_only" -eq 1 ]; then
    echo "✗ --macos ne s'emploie qu'avec --scope=changed ou --scope=files" >&2
    exit 1
  fi
  if [ "$with_outillage" -eq 1 ]; then
    echo "✗ --with-outillage ne s'emploie qu'avec --scope=changed ou --scope=files" >&2
    exit 1
  fi
fi

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
elif [ "$scope" = "files" ]; then
  if [ "${#changed_files[@]}" -eq 0 ]; then
    echo "· aucun fichier reçu : rien à lancer" >&2
    exit 0
  fi
  changed="$(printf '%s\n' "${changed_files[@]}" | LC_ALL=C sort -u)"
  changed_status=0
fi

# Le filtre passe par python3, jamais par `grep -P` (rejeté par le grep BSD de
# macOS, voir `── Extension` de check.sh). L'ordre est celui du tri ci-dessus,
# reçu en arguments : python ne retrie rien.
MEM0_TEST_SCOPE="$scope" MEM0_TEST_CHANGED="$changed" MEM0_TEST_CHANGED_STATUS="$changed_status" \
MEM0_TEST_MACOS_ONLY="$macos_only" MEM0_TEST_WITH_OUTILLAGE="$with_outillage" \
python3 - "${files[@]}" <<'PY'
import os, re, sys
MACOS = re.compile(r"\b(swift|swiftc|xcodebuild|xcrun)\b|swift-app\.sh|ios-build\.sh")
OUTILLAGE = re.compile(r'\["scripts/check\.sh"\]|^\s*"scripts/release\.ts",$', re.M)
# Les imports relatifs d'un module TypeScript : `from "./x"`, `export … from`,
# `import("./x")`, `import "./x"` (effet de bord). Les paquets (`node:fs`,
# `@oh-my-pi/…`) ne sont pas suivis : ils ne vivent pas dans le diff.
IMPORTS = re.compile(r"""(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']""", re.M)
# Un fichier du diff qui conditionne toute la suite : la liste complète.
WHOLE_SUITE = {
    "scripts/check.sh",
    "scripts/test-files.sh",
    "package.json",
    "tsconfig.json",
    "tsconfig.test.json",
}

scope = os.environ["MEM0_TEST_SCOPE"]
macos_only = os.environ["MEM0_TEST_MACOS_ONLY"] == "1"
with_outillage = os.environ["MEM0_TEST_WITH_OUTILLAGE"] == "1"
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
    if macos_only:
        kept = [p for p in kept if is_macos(p)]
    if not kept:
        if scope in ("files", "changed"):
            print("· aucun test ne concerne ces fichiers : rien à lancer", file=sys.stderr)
            sys.exit(0)
        print("✗ aucun fichier de test retenu", file=sys.stderr)
        sys.exit(1)
    for path in kept:
        print(path)
    sys.exit(0)

def emit_everything(everything):
    # Les replis : la liste complète (hors outillage, sauf --with-outillage), jamais une sortie vide.
    if macos_only:
        everything = [p for p in everything if is_macos(p)]
    for path in everything:
        print(path)
    sys.exit(0)

if scope == "macos":
    emit([p for p in paths if is_macos(p)])
if scope == "outillage":
    emit([p for p in paths if is_outillage(p)])

# scope == "changed" ou "files" (même liste `changed`, reçue d'argv)
def retained(path):
    return with_outillage or not is_outillage(path)

everything = [p for p in paths if retained(p)]
complete = "liste complète" if with_outillage else "liste complète hors outillage"
changed = [line for line in os.environ["MEM0_TEST_CHANGED"].split("\n") if line.strip() != ""]
if os.environ["MEM0_TEST_CHANGED_STATUS"] != "0":
    print(f"· repli : {complete}", file=sys.stderr)
    emit_everything(everything)
if not changed:
    print(f"· diff vide depuis la base : {complete}", file=sys.stderr)
    emit_everything(everything)
changed_set = set(changed)

# (d) un fichier qui conditionne la suite entière.
whole = sorted(changed_set & WHOLE_SUITE)
if whole:
    print(f"· {', '.join(whole)} dans le diff : {complete}", file=sys.stderr)
    emit_everything(everything)

# (b') clôture des imports relatifs, calculée à la demande et mise en cache.
source_cache = {}

def read_source(path):
    if path not in source_cache:
        try:
            with open(path, encoding="utf-8") as handle:
                source_cache[path] = handle.read()
        except OSError:
            source_cache[path] = ""
    return source_cache[path]

def resolve_import(importer, spec):
    if not spec.startswith("."):
        return None
    target = os.path.normpath(os.path.join(os.path.dirname(importer), spec))
    candidates = [target, target + ".ts", target + "/index.ts"]
    if target.endswith(".js"):
        candidates.insert(1, target[:-3] + ".ts")
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None

def closure(path):
    seen = set()
    stack = [path]
    while stack:
        current = stack.pop()
        text = texts[current] if current in texts else read_source(current)
        for match in IMPORTS.finditer(text):
            resolved = resolve_import(current, match.group(1))
            if resolved is not None and resolved not in seen:
                seen.add(resolved)
                stack.append(resolved)
    return seen

kept = set()
# (a) les fichiers de test du diff eux-mêmes.
for path in changed:
    if path in texts:
        kept.add(path)
# (b) les tests qui nomment un fichier du diff.
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
# (b') les tests dont la clôture d'imports atteint un fichier du diff.
if sources:
    for path in paths:
        if path in kept:
            continue
        if closure(path) & changed_set:
            kept.add(path)
# (c) le diff touche omp-console/ (hors .md) : les tests qui dépendent de macOS.
if any(p.startswith("omp-console/") and not p.endswith(".md") for p in changed):
    for path in paths:
        if is_macos(path):
            kept.add(path)

emit([p for p in paths if p in kept and retained(p)])
PY
