#!/usr/bin/env bash
# Valide le dépôt avant publication. Attrape les pièges qui font échouer une
# installation marketplace de façon silencieuse — c'est-à-dire la totalité des
# pièges, parce qu'OMP ne dit pas grand-chose quand une extension ne charge pas.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
FAIL=0
fail() { echo "  ✗ $1"; FAIL=1; }
pass() { echo "  ✓ $1"; }

# Options de sélection, utilisées par les jobs macOS de la CI (check.yml) pour se
# partager le travail. Sans option, TOUT s'exécute, comme sur un poste ou depuis
# scripts/release.ts. La sélection passe par argv et jamais par une variable
# d'environnement : une variable serait héritée par les `bash scripts/check.sh`
# que la suite node relance dans ses copies jetables, et fausserait leurs
# verdicts. Rien de ce qui suit n'est exporté ni transmis aux processus enfants.
#
#   --sections=<id>[,<id>…]   n'exécute que ces sections (ordre du script) ;
#   --tests-scope=macos       `── Tests` ne lance que les fichiers de
#                             scripts/test-files.sh --scope=macos ;
#   --tests-part=1/2|2/2      découpe les TESTS de `── Tests` par TESTS_PART_PATTERN :
#                             1/2 = test/outillage/check.test.ts filtré par --test-name-pattern,
#                             2/2 = tout l'ensemble filtré par --test-skip-pattern.
#                             Les tests qui portent ce motif ne vivent que dans
#                             test/outillage/check.test.ts (criteria/AC-13 : un slug, un
#                             fichier), donc 1/2 ∪ 2/2 lance chaque test une fois.
SECTION_IDS="catalogue noms plugins versions extension types rust smoke tests noyau app-swift app-ios"
TESTS_PART_PATTERN='^socle-app-swift/'
sections=""
sections_set=0
tests_scope=""
tests_scope_set=0
tests_part=""
tests_part_set=0
usage_error() { echo "✗ $1" >&2; exit 1; }
for arg in "$@"; do
  case "$arg" in
    --sections=*)
      [ "$sections_set" -eq 1 ] && usage_error "option répétée : --sections"
      sections_set=1
      sections="${arg#--sections=}"
      ;;
    --tests-scope=*)
      [ "$tests_scope_set" -eq 1 ] && usage_error "option répétée : --tests-scope"
      tests_scope_set=1
      tests_scope="${arg#--tests-scope=}"
      ;;
    --tests-part=*)
      [ "$tests_part_set" -eq 1 ] && usage_error "option répétée : --tests-part"
      tests_part_set=1
      tests_part="${arg#--tests-part=}"
      ;;
    *)
      usage_error "option inconnue : $arg (attendu : --sections=…, --tests-scope=macos, --tests-part=1/2|2/2)"
      ;;
  esac
done
if [ "$sections_set" -eq 1 ]; then
  # Découpe à la main (et non par IFS) : une liste vide ou un élément vide
  # (`a,,b`, `a,`) est une section inconnue, jamais ignoré.
  rest="$sections,"
  while [ -n "$rest" ]; do
    id="${rest%%,*}"
    rest="${rest#*,}"
    case " $SECTION_IDS " in
      *" $id "*) [ -n "$id" ] || usage_error "section inconnue : « » (attendu : ${SECTION_IDS// /, })" ;;
      *) usage_error "section inconnue : « $id » (attendu : ${SECTION_IDS// /, })" ;;
    esac
  done
fi
if [ "$tests_scope_set" -eq 1 ] && [ "$tests_scope" != "macos" ]; then
  usage_error "--tests-scope : valeur inconnue « $tests_scope » (attendu : macos)"
fi
if [ "$tests_part_set" -eq 1 ] && [ "$tests_part" != "1/2" ] && [ "$tests_part" != "2/2" ]; then
  usage_error "--tests-part : valeur inconnue « $tests_part » (attendu : 1/2, 2/2)"
fi

# Vrai si la section <id> doit s'exécuter : toutes sans `--sections`.
section_on() {
  [ "$sections_set" -eq 0 ] && return 0
  case ",$sections," in
    *",$1,"*) return 0 ;;
  esac
  return 1
}


if section_on catalogue; then
echo "── Catalogue marketplace"

for f in .omp-plugin/marketplace.json .claude-plugin/marketplace.json; do
  if [ ! -f "$f" ]; then fail "$f manquant"; continue; fi
  python3 -c "import json,sys; json.load(open('$f'))" 2>/dev/null \
    && pass "$f est un JSON valide" || fail "$f est un JSON invalide"
done

# OMP lit .omp-plugin/ ; Claude Code lit .claude-plugin/. Un dépôt peut publier
# les deux, mais s'ils divergent l'un des deux publics installe autre chose.
if diff -q .omp-plugin/marketplace.json .claude-plugin/marketplace.json >/dev/null 2>&1; then
  pass "les deux catalogues sont identiques"
else
  fail "les catalogues .omp-plugin et .claude-plugin ont divergé"
fi
fi

if section_on noms; then
echo "── Noms"

python3 - <<'PY'
import json, re, sys
NAME = re.compile(r"^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$")
cat = json.load(open(".omp-plugin/marketplace.json"))
ok = True
def check(label, value):
    global ok
    if NAME.match(value):
        print(f"  ✓ {label} « {value} » respecte les règles de nommage")
    else:
        print(f"  ✗ {label} « {value} » invalide : minuscules, chiffres, tirets et points, "
              f"début et fin alphanumériques, 64 caractères max")
        ok = False
check("marketplace", cat["name"])
for p in cat["plugins"]:
    check("plugin", p["name"])
    pid = f'{p["name"]}@{cat["name"]}'
    if len(pid) > 128:
        print(f"  ✗ identifiant {pid} : plus de 128 caractères"); ok = False
if not cat.get("owner", {}).get("name"):
    print("  ✗ owner.name est obligatoire"); ok = False
else:
    print("  ✓ owner.name présent")
sys.exit(0 if ok else 1)
PY
[ $? -ne 0 ] && FAIL=1
fi

if section_on plugins; then
echo "── Plugins"

python3 - <<'PY'
import json, os, sys
cat = json.load(open(".omp-plugin/marketplace.json"))
root = cat.get("metadata", {}).get("pluginRoot", "")
ok = True
for p in cat["plugins"]:
    src = p["source"]
    if not isinstance(src, str):
        print(f"  · {p['name']} : source distante, non vérifiable ici")
        continue
    if not src.startswith("./"):
        print(f"  ✗ {p['name']} : une source relative doit commencer par ./"); ok = False; continue
    d = os.path.join(root, src[2:]) if root else src[2:]
    if not os.path.isdir(d):
        print(f"  ✗ {p['name']} : dossier {d} introuvable"); ok = False; continue

    pkg_path = os.path.join(d, "package.json")
    if not os.path.isfile(pkg_path):
        print(f"  ✗ {p['name']} : package.json manquant — sans lui l'extension ne sera jamais chargée")
        ok = False; continue
    pkg = json.load(open(pkg_path))
    # OMP lit pkg.omp, avec repli sur pkg.pi (clé héritée de pi-mono).
    manifest = pkg.get("omp") or pkg.get("pi")
    entries = (manifest or {}).get("extensions") or []
    if not entries:
        print(f"  ✗ {p['name']} : ni omp.extensions ni pi.extensions dans package.json")
        ok = False; continue
    print(f"  ✓ {p['name']} : {len(entries)} entrée(s) d'extension déclarée(s)")

    for e in entries:
        target = os.path.normpath(os.path.join(d, e))
        if os.path.isfile(target):
            print(f"    ✓ {e} existe")
        elif os.path.isdir(target):
            # Piège connu (issue #2713) : une entrée-dossier n'est résolue que si
            # elle contient un index.* DIRECT. Sinon l'install est rejetée, ou
            # l'extension est silencieusement ignorée au runtime.
            if any(os.path.isfile(os.path.join(target, f"index{x}")) for x in (".ts", ".js", ".mjs", ".cjs")):
                print(f"    ✓ {e} est un dossier avec un index direct")
            else:
                print(f"    ✗ {e} est un dossier sans index.{{ts,js,mjs,cjs}} direct — pointe un fichier")
                ok = False
        else:
            print(f"    ✗ {e} introuvable sur disque"); ok = False
sys.exit(0 if ok else 1)
PY
[ $? -ne 0 ] && FAIL=1

# Le tableau `commands` est ce que l'utilisateur lit pour savoir ce qu'il installe :
# une commande déclarée sans `registerCommand` est un bouton mort, l'inverse une
# commande invisible. Les deux ensembles doivent être identiques.
#
# Le balayage est RÉCURSIF sur les .ts du plugin : depuis le découpage en
# modules, les commandes peuvent vivre dans n'importe lequel (extension.ts n'est
# plus qu'une entrée de câblage).
python3 - <<'PY'
import json, os, re, sys
from pathlib import Path
cat = json.load(open(".omp-plugin/marketplace.json"))
root = cat.get("metadata", {}).get("pluginRoot", "")
ok = True
for p in cat["plugins"]:
    src = p["source"]
    if not isinstance(src, str):
        print(f"  · {p['name']} : source distante, commandes non vérifiables ici")
        continue
    d = os.path.join(root, src[2:]) if root else src[2:]
    ext = os.path.join(d, "extension.ts")
    if not os.path.isfile(ext):
        print(f"  ✗ {p['name']} : {ext} introuvable — commandes invérifiables"); ok = False; continue
    declared = set(p.get("commands") or [])
    registered = set()
    for f in Path(d).rglob("*.ts"):
        registered |= set(re.findall(r'registerCommand\(\s*["\']([^"\']+)["\']',
                                     f.read_text(encoding="utf-8")))
    missing = sorted(declared - registered)
    extra = sorted(registered - declared)
    if missing:
        print(f"  ✗ {p['name']} : commande déclarée sans registerCommand : {', '.join(missing)}")
        ok = False
    if extra:
        print(f"  ✗ {p['name']} : registerCommand absent du catalogue : {', '.join(extra)}")
        ok = False
    if not missing and not extra:
        print(f"  ✓ {p['name']} : {len(declared)} commande(s) déclarée(s), "
              f"{len(registered)} enregistrée(s)")
sys.exit(0 if ok else 1)
PY
[ $? -ne 0 ] && FAIL=1
fi

if section_on versions; then
echo "── Versions"

# Ce que le catalogue annonce doit être ce que le package.json porte : une entrée
# qui ment installe une version que l'utilisateur ne croit pas installer.
# `metadata.version` est facultative, mais si elle est là elle doit NOMMER une
# version publiée — sinon elle est invérifiable par construction.
python3 - <<'PY'
import json, os, sys
cat = json.load(open(".omp-plugin/marketplace.json"))
root = cat.get("metadata", {}).get("pluginRoot", "")
OK = True
published = []
for p in cat["plugins"]:
    src = p["source"]
    if not isinstance(src, str):
        print(f"  · {p['name']} : source distante, non vérifiable ici")
        continue
    if not src.startswith("./"):
        print(f"  ✗ {p['name']} : une source relative doit commencer par ./"); OK = False; continue
    d = os.path.join(root, src[2:]) if root else src[2:]
    pkg_path = os.path.join(d, "package.json")
    if not os.path.isfile(pkg_path):
        print(f"  ✗ {p['name']} : package.json introuvable — version invérifiable"); OK = False; continue
    actual = json.load(open(pkg_path)).get("version")
    entry = p.get("version")
    published.append(entry)
    if entry != actual:
        print(f"  ✗ {p['name']} : version d'entrée {entry} ≠ package.json {actual}"); OK = False
    else:
        print(f"  ✓ {p['name']} : version {actual} alignée sur le package.json")
meta = cat.get("metadata", {}).get("version")
if meta is None:
    pass  # champ facultatif : absent, il n'y a rien à vérifier
elif meta not in published:
    print(f"  ✗ metadata.version {meta} ne correspond à aucune version publiée "
          f"({', '.join(str(v) for v in published)})")
    OK = False
else:
    print(f"  ✓ metadata.version {meta} nomme une version publiée")
sys.exit(0 if OK else 1)
PY
[ $? -ne 0 ] && FAIL=1
fi

if section_on extension; then
echo "── Extension"

# Liste écrite en dur (et non déduite du catalogue) : la transpilation couvre les
# extensions DU DÉPÔT, y compris si un plugin venait à disparaître du catalogue.
if command -v npx >/dev/null 2>&1; then
  TRANSPILED=1
  for p in omp-mem0-memory omp-mem0-req; do
    if npx --yes esbuild@0.24.0 "$p/extension.ts" --format=esm --outfile=/dev/null --log-level=error 2>&1; then
      :
    else
      fail "$p/extension.ts ne se transpile pas"
      TRANSPILED=0
    fi
  done
  [ "$TRANSPILED" -eq 1 ] && pass "les 2 extensions se transpilent"
else
  echo "  · npx absent, transpilation non vérifiée (2 plugins)"
fi

# Un import de valeur (non type-only) depuis @oh-my-pi/pi-* crée une dépendance
# de résolution au runtime, qui casse selon la plateforme (cf. issue #1292).
# Le contrôle passe par python3, jamais par `grep -P` : le grep BSD de macOS
# rejette `-P` (et le lookahead sous `-E`), donc l'ancien contrôle échouait AVANT
# toute comparaison et affichait un « ✓ » mensonger (voir la doc §5).
#
# Le balayage est RÉCURSIF depuis que les extensions sont découpées en modules
# (`omp-mem0-req/*.ts`, `omp-mem0-req/panel/*.ts`) : ne contrôler que
# `extension.ts` laisserait passer un import de valeur écrit dans un module.
if command -v python3 >/dev/null 2>&1; then
python3 - <<'PY'
import re, sys
from pathlib import Path
pat = re.compile(r'^\s*import\s+(?!type\b)[^;]*from\s+["\']@oh-my-pi/', re.M)
hits = []
files = sorted(
    f
    for root in ("omp-mem0-memory", "omp-mem0-req")
    for f in Path(root).rglob("*.ts")
)
for f in files:
    src = f.read_text(encoding="utf-8")
    for m in pat.finditer(src):
        hits.append((str(f), src.count("\n", 0, m.start()) + 1))
for f, line in hits:
    print(f"  ✗ import de valeur depuis @oh-my-pi/* — {f}:{line} ; "
          f"préfère 'import type', effacé à la compilation")
if hits:
    sys.exit(1)
print("  ✓ aucun import de valeur depuis @oh-my-pi/* (2 plugins contrôlés)")
PY
[ $? -ne 0 ] && FAIL=1
else
  echo "  · python3 absent, contrôle d'import non vérifié"
fi
fi

if section_on types; then
echo "── Types"

# Le type-check vit dans scripts/typecheck.sh (créé par BR-7) : check.sh l'appelle
# et reste le seul porteur de la logique. Types de l'hôte absents ⇒ le script sort
# 0 en l'annonçant : on recopie son verdict sans jamais afficher un « ✓ » trompeur.
if [ -f scripts/typecheck.sh ]; then
  types_out="$(bash scripts/typecheck.sh 2>&1)"
  types_status=$?
  [ -n "$types_out" ] && printf '%s\n' "$types_out"
  if [ "$types_status" -eq 0 ]; then
    case "$types_out" in
      *"types de l'hôte absents"*) : ;;
      *) pass "les types de l'hôte encaissent le type-check des 2 plugins et des tests" ;;
    esac
  else
    errs="$(printf '%s\n' "$types_out" | grep -F 'error TS' | tr '\n' ' ')"
    fail "type-check : ${errs:-sortie non nulle sans erreur TS} (relance : ./scripts/typecheck.sh)"
  fi
else
  echo "  · scripts/typecheck.sh absent, type-check non vérifié"
fi
fi

if section_on rust; then
echo "── Rust mem0-rs"

# La crate mem0-stack/mem0-rs : clippy sans avertissement toléré sur toutes les
# cibles, `cargo test`, le binaire, puis le contrat boîte noire contre lui. Les
# trois étapes cargo tournent même si la précédente échoue, et leur sortie n'est
# imprimée qu'en cas d'échec ; le contrat n'exige que le binaire, et sa sortie
# est recopiée telle quelle.
# cargo ou clippy absent ⇒ saut annoncé sans ✓ — SAUF si MEM0_OMP_REQUIRE_RUST=1
# (posée par la CI) : là, c'est un échec. Les copies jetables des harnais posent
# MEM0_OMP_SKIP_RUST=1 pour ne rien compiler.
rust_manifest=(--manifest-path mem0-stack/mem0-rs/Cargo.toml --locked)
rust_contrat_start="bash scripts/mem0-http-contrat.sh --start-rs"
if [ -n "${MEM0_OMP_SKIP_RUST:-}" ]; then
  echo "  · ignorée (MEM0_OMP_SKIP_RUST=1)"
elif ! command -v cargo >/dev/null 2>&1; then
  if [ "${MEM0_OMP_REQUIRE_RUST:-}" = "1" ]; then
    fail "Rust mem0-rs — cargo absent (MEM0_OMP_REQUIRE_RUST=1)"
  else
    echo "  · cargo absent, sections Rust non exécutées (installe la toolchain : https://rustup.rs)"
  fi
elif ! cargo clippy --version >/dev/null 2>&1; then
  if [ "${MEM0_OMP_REQUIRE_RUST:-}" = "1" ]; then
    fail "Rust mem0-rs — cargo clippy absent (MEM0_OMP_REQUIRE_RUST=1)"
  else
    echo "  · cargo clippy absent, sections Rust non exécutées (rustup component add clippy)"
  fi
else
  if rust_out="$(cargo clippy "${rust_manifest[@]}" --all-targets -- -D warnings 2>&1)"; then
    pass "Rust mem0-rs : clippy sans avertissement (--all-targets -D warnings)"
  else
    printf '%s\n' "$rust_out"
    fail "Rust mem0-rs — clippy en échec (relance : cargo clippy --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked --all-targets -- -D warnings)"
  fi
  if rust_out="$(cargo test "${rust_manifest[@]}" 2>&1)"; then
    pass "Rust mem0-rs : cargo test conforme"
  else
    printf '%s\n' "$rust_out"
    fail "Rust mem0-rs — cargo test en échec (relance : cargo test --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked)"
  fi
  if rust_out="$(cargo build "${rust_manifest[@]}" 2>&1)"; then
    pass "Rust mem0-rs : binaire mem0-rs construit"
    rs_out="$(MEM0_CONTRAT_START="$rust_contrat_start" bash scripts/mem0-http-contrat.sh --run 2>&1)"
    rs_status=$?
    [ -n "$rs_out" ] && printf '%s\n' "$rs_out"
    case "$rs_status" in
      0)
        pass "Rust mem0-rs : contrat boîte noire conforme contre mem0-rs"
        ;;
      2)
        rs_reason="$(printf '%s\n' "$rs_out" | head -n 1)"
        if [ "${MEM0_OMP_REQUIRE_RUST:-}" = "1" ]; then
          fail "Rust mem0-rs — contrat boîte noire contre mem0-rs ${rs_reason}"
        else
          echo "  · ${rs_reason}"
        fi
        ;;
      *)
        fail "Rust mem0-rs — contrat boîte noire contre mem0-rs en échec (relance : MEM0_CONTRAT_START=\"$rust_contrat_start\" bash scripts/mem0-http-contrat.sh --run)"
        ;;
    esac
  else
    printf '%s\n' "$rust_out"
    fail "Rust mem0-rs — cargo build en échec (relance : cargo build --manifest-path mem0-stack/mem0-rs/Cargo.toml --locked)"
    echo "  · contrat boîte noire contre mem0-rs non exécuté (binaire absent)"
  fi
fi
fi

if section_on smoke; then
echo "── Plugins réels (OMP)"

# Le harnais (scripts/plugin-smoke.ts) charge chaque plugin du catalogue dans un
# VRAI OMP, vérifie ses commandes et invoque une commande (et un outil) en
# contrôlant le résultat observé. C'est le seul contrôle qui attrape une
# extension qui se transpile, passe tous les tests unitaires (faux `pi`) et ne
# s'enregistre pas au runtime.
#
# Prérequis absents (bun, hôte OMP) ⇒ on l'annonce sans ✓ mensonger, comme pour
# la transpilation — SAUF si MEM0_OMP_REQUIRE_SMOKE=1 (posée par la CI) : là, un
# prérequis manquant est un échec, jamais un skip silencieux.
smoke_host=""
for candidate in "${MEM0_OMP_HOST_MODULES:-}" "./node_modules" "${BUN_INSTALL:-$HOME/.bun}/install/global/node_modules"; do
  if [ -n "$candidate" ] && [ -f "$candidate/@oh-my-pi/pi-coding-agent/src/index.ts" ]; then
    smoke_host="$candidate"
    break
  fi
done
smoke_reason=""
if ! command -v bun >/dev/null 2>&1; then
  smoke_reason="bun absent"
elif [ -z "$smoke_host" ]; then
  smoke_reason="hôte OMP introuvable"
fi
if [ -n "$smoke_reason" ]; then
  if [ "${MEM0_OMP_REQUIRE_SMOKE:-}" = "1" ]; then
    fail "plugins réels : $smoke_reason"
  else
    echo "  · $smoke_reason, plugins réels non vérifiés"
  fi
else
  smoke_out="$(bun scripts/plugin-smoke.ts 2>&1)"
  smoke_status=$?
  [ -n "$smoke_out" ] && printf '%s\n' "$smoke_out"
  if [ "$smoke_status" -eq 0 ]; then
    pass "les 2 plugins se chargent et répondent dans un vrai OMP"
  else
    fail "plugins réels — relance : bun scripts/plugin-smoke.ts"
  fi
fi
fi

if section_on tests; then
echo "── Tests"

# La sortie de `node --test` est CONSERVÉE, jamais jetée : un job rouge doit
# pouvoir nommer le test tombé. Mesuré le 2026-09-24 (run 35994551671) : le job
# ubuntu a rendu un simple « ✗ tests unitaires » pendant que macOS passait le
# même arbre — un rouge indébogable, et pas seulement par manque de noms : un
# processus tué (mémoire) n'écrit AUCUNE ligne TAP, donc le code de sortie est
# la seule trace qui distingue « un test est tombé » de « le processus est mort ».
if command -v node >/dev/null 2>&1; then
  # L'ensemble de fichiers vient de scripts/test-files.sh, seul porteur de la
  # règle « dépend de macOS » ; un échec du script (python3 absent, ensemble
  # vide) rougit la section en recopiant sa sortie, sans lancer node.
  if [ -n "$tests_scope" ]; then
    tests_list="$(bash scripts/test-files.sh "--scope=$tests_scope" 2>&1)"
  else
    tests_list="$(bash scripts/test-files.sh 2>&1)"
  fi
  tests_list_status=$?
  test_files=()
  if [ "$tests_list_status" -eq 0 ]; then
    while IFS= read -r tests_file; do
      [ -n "$tests_file" ] || continue
      if [ "$tests_part" = "1/2" ] && [ "$tests_file" != "test/outillage/check.test.ts" ]; then
        continue
      fi
      test_files+=("$tests_file")
    done <<<"$tests_list"
  else
    [ -n "$tests_list" ] && printf '%s\n' "$tests_list" | sed 's/^/  /'
  fi
  tests_filter=()
  case "$tests_part" in
    1/2) tests_filter=("--test-name-pattern=$TESTS_PART_PATTERN") ;;
    2/2) tests_filter=("--test-skip-pattern=$TESTS_PART_PATTERN") ;;
  esac
  if [ "${#test_files[@]}" -eq 0 ]; then
    if [ "$tests_list_status" -eq 0 ] || printf '%s\n' "$tests_list" | grep -qF "aucun fichier de test retenu"; then
      fail "tests unitaires — aucun fichier de test retenu (--tests-scope=${tests_scope:-aucun}, --tests-part=${tests_part:-aucune})"
    else
      fail "tests unitaires — scripts/test-files.sh a échoué (relance : bash scripts/test-files.sh${tests_scope:+ --scope=$tests_scope})"
    fi
  else
    echo "  · ${#test_files[@]} fichier(s) de test : ${test_files[*]}"
    [ "${#tests_filter[@]}" -gt 0 ] && echo "  · filtre de noms : ${tests_filter[0]}"
    tests_log="$(mktemp)"
    # `--test-reporter=tap` est ÉPINGLÉ : le rapport par défaut dépend de la version
    # de Node (spec dès que la sortie n'est plus un terminal en v26, TAP en v22) et
    # le diagnostic ci-dessous lit un format, pas deux. `${a[@]+"${a[@]}"}` : un
    # tableau vide sous `set -u` est une erreur en bash 3.2 (celui des Mac).
    node --test --test-reporter=tap --experimental-strip-types ${tests_filter[@]+"${tests_filter[@]}"} "${test_files[@]}" >"$tests_log" 2>&1
    tests_status=$?
    if [ "$tests_status" -eq 0 ]; then
      # Un filtre de noms qui ne retient rien sort 0 SANS `# tests 0` : node
      # rapporte alors chaque FICHIER comme un test (`ok 1 - test/outillage/check.test.ts`,
      # mesuré sur node v26.7.0). Une part a lancé quelque chose seulement si une
      # ligne de premier niveau porte un autre nom que l'un des fichiers lancés ;
      # sinon c'est un échec, jamais un vert silencieux.
      tests_ran=1
      if [ -n "$tests_part" ]; then
        tests_ran="$(printf '%s\n' "${test_files[@]}" | awk '
          NR == FNR { launched[$0] = 1; next }
          /^(not )?ok [0-9]+ - / { name = $0; sub(/^(not )?ok [0-9]+ - /, "", name); if (!(name in launched)) n++ }
          END { print n + 0 }' - "$tests_log")"
      fi
      if [ "$tests_ran" -eq 0 ]; then
        fail "tests unitaires — aucun test exécuté pour --tests-part=$tests_part"
      else
        pass "tests unitaires (dedupe, buildIndex, nudge, perception du rappel, req/seeds)"
      fi
    else
      printf '  · node --test a rendu %s (137 = tué par SIGKILL, 143 = SIGTERM)\n' "$tests_status"
      # D'abord TOUS les noms, ensuite la preuve : le bloc de diagnostic est borné,
      # donc un plafond unique finissait par couper des noms de tests (mesuré le
      # 2026-09-24 : six échecs, deux preuves visibles).
      grep -E '^not ok' "$tests_log" | head -n 40
      # Puis les blocs de diagnostic TAP — le message d'assertion porte la preuve
      # (sortie du moteur, code de check.sh, diff), bornés à 60 lignes. Le bloc
      # s'arrête à la première ligne qui repart en colonne 0 (enregistrement suivant).
      awk '/^not ok/ { show = 1 } /^[^ ]/ && $0 !~ /^not ok/ { show = 0 } show' "$tests_log" | head -n 60
      if ! grep -qE '^not ok' "$tests_log"; then
        # Aucun test nommé : le processus est mort avant d'écrire (mémoire). La fin
        # du journal est alors la seule trace.
        tail -n 30 "$tests_log"
      fi
      grep -E '^# (tests|pass|fail|cancelled|skipped)' "$tests_log"
      fail "tests unitaires — relance : node --test --experimental-strip-types 'test/**/*.test.ts'"
    fi
    rm -f "$tests_log"
  fi
else
  echo "  · node absent, tests non exécutés"
fi
fi

if section_on noyau; then
echo "── Noyau partagé"

# `ConsoleCore` et `ConsoleClient` sont les cibles PARTAGÉES macOS/iOS : elles se
# compilent avec les Command Line Tools (donc sans SDK iOS) et ne doivent toucher
# AUCUNE API de plateforme. AppKit et UIKit ne se détectent pas à la compilation —
# chacun existe sur sa plateforme —, donc la portabilité se tient par un balayage
# de SOURCES : un `import AppKit` dans un fichier d'une cible partagée fait rougir
# ce contrôle.
#
# Le balayage ignore les COMMENTAIRES (ligne `//` et blocs `/* … */`) : un exemple
# cité dans un en-tête n'est pas un import. `SwiftUI` et `Observation`, eux, sont
# disponibles des DEUX côtés — ils ne sont pas interdits ; `Combine`, `Network` et
# `Security` sont des frameworks Foundation/systeme disponibles sur les deux.
#
# Ce contrôle ne demande que python3 (déjà requis par les sections précédentes) :
# ni macOS, ni toolchain Swift, donc il tourne aussi sous Ubuntu.
python3 - <<'PY'
import os, re, sys

ROOTS = [
    "omp-console/Sources/ConsoleCore",
    "omp-console/Sources/ConsoleClient",
]
IMPORT = re.compile(r"^\s*import\s+(AppKit|UIKit|Cocoa)\b")

for root in ROOTS:
    if not os.path.isdir(root):
        print(f"  ✗ cible partagée absente de Sources/ : « {root} » n'existe pas")
        sys.exit(1)


def code_part(line, in_block):
    """La ligne débarrassée de ses commentaires ; rend aussi l'état de bloc."""
    out = ""
    i = 0
    while i < len(line):
        if in_block:
            if line.startswith("*/", i):
                in_block = False
                i += 2
            else:
                i += 1
            continue
        if line.startswith("//", i):
            break
        if line.startswith("/*", i):
            in_block = True
            i += 2
            continue
        out += line[i]
        i += 1
    return out, in_block


faults = []
report = []
for root in ROOTS:
    target = os.path.basename(root)
    scanned = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            if not name.endswith(".swift"):
                continue
            path = os.path.join(dirpath, name)
            scanned += 1
            in_block = False
            with open(path, encoding="utf-8") as handle:
                for number, line in enumerate(handle, 1):
                    code, in_block = code_part(line.rstrip("\n"), in_block)
                    found = IMPORT.match(code)
                    if found:
                        faults.append((target, os.path.relpath(path), number, found.group(1)))
    report.append((target, scanned))

for target, path, number, module in faults:
    print(f"  ✗ la cible partagée {target} importe {module} : {path}:{number}")
if faults:
    sys.exit(1)
for target, scanned in report:
    print(f"  ✓ la cible partagée {target} n'importe ni AppKit ni UIKit ({scanned} fichiers balayés)")
PY
[ $? -ne 0 ] && FAIL=1
fi

if section_on app-swift; then
echo "── App Swift"

# L'assemblage du bundle .app vit dans scripts/swift-app.sh : check.sh l'appelle
# et RECOPIE son verdict, comme pour `── Types`. Codes du script : 0 assemblé,
# 2 « non exécuté » (hors macOS, un succès), tout autre échec. Sur un code 2, le
# script a déjà dit « non exécuté » — aucune ✓ n'est affichée, sinon la section
# mentirait sur ce qu'elle a vérifié.
#
# `MEM0_OMP_SKIP_SWIFT_APP=1` neutralise la section : le harnais de test lance
# check.sh une dizaine de fois dans des copies jetables, qui paieraient sinon
# chacune une compilation Swift complète (≈ 35 s). Une valeur vide vaut absence.
if [ -f scripts/swift-app.sh ]; then
  if [ -n "${MEM0_OMP_SKIP_SWIFT_APP:-}" ]; then
    echo "  · ignorée (MEM0_OMP_SKIP_SWIFT_APP=1)"
  else
    swift_out="$(bash scripts/swift-app.sh 2>&1)"
    swift_status=$?
    [ -n "$swift_out" ] && printf '%s\n' "$swift_out"
    case "$swift_status" in
      0) pass "App Swift : compilation, tests et bundle .app assemblés" ;;
      2) : ;;
      *) fail "App Swift — scripts/swift-app.sh a échoué (relance : bash scripts/swift-app.sh)" ;;
    esac
  fi
else
  fail "App Swift — scripts/swift-app.sh absent"
fi
fi

if section_on app-ios; then
echo "── App iOS"

# La compilation et les tests de l'app iOS vivent dans scripts/ios-build.sh :
# check.sh l'appelle et RECOPIE son verdict, comme la section `── App Swift`. Le
# dépôt reste CLT-only : rien dans cette section n'exige Xcode sur un poste qui ne
# l'a pas — le script sort 2 (« non exécuté ») et aucune ✓ n'est affichée, sinon la
# section mentirait sur ce qu'elle a vérifié.
#
# `MEM0_OMP_SKIP_IOS=1` neutralise la section : le harnais de test lance check.sh
# une dizaine de fois dans des copies jetables, qui paieraient sinon chacune une
# compilation iOS complète. Une valeur vide vaut absence.
#
# `MEM0_OMP_REQUIRE_IOS=1` (posée par la CI macOS) fait échouer un « non exécuté » :
# en CI, Xcode manquant est un échec, jamais un skip silencieux.
if [ -f scripts/ios-build.sh ]; then
  if [ -n "${MEM0_OMP_SKIP_IOS:-}" ]; then
    echo "  · ignorée (MEM0_OMP_SKIP_IOS=1)"
  else
    ios_out="$(bash scripts/ios-build.sh 2>&1)"
    ios_status=$?
    [ -n "$ios_out" ] && printf '%s\n' "$ios_out"
    case "$ios_status" in
      0)
        if printf '%s\n' "$ios_out" | grep -q "tests non exécutés"; then
          ios_cause="$(printf '%s\n' "$ios_out" | sed -n 's/.*tests non exécutés : //p' | head -n 1)"
          pass "App iOS : compilation (tests non exécutés : ${ios_cause:-cause inconnue})"
        else
          pass "App iOS : compilation et tests"
        fi
        ;;
      2)
        if [ "${MEM0_OMP_REQUIRE_IOS:-}" = "1" ]; then
          fail "App iOS — Xcode inutilisable (relance : DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer bash scripts/ios-build.sh)"
        fi
        ;;
      *)
        fail "App iOS — scripts/ios-build.sh a échoué (relance : bash scripts/ios-build.sh)"
        ;;
    esac
  fi
else
  fail "App iOS — scripts/ios-build.sh absent"
fi
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "Dépôt prêt à publier."
else
  echo "Corrige les points ci-dessus avant de publier." >&2
fi
exit "$FAIL"
