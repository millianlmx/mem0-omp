#!/usr/bin/env bash
# Prouve des critères d'acceptation par les tests du DIFF courant, en une seule
# passe de `node --test`.
#
#   bash scripts/test-ac.sh AC-1 AC-2 …              diff depuis HEAD
#   bash scripts/test-ac.sh --base=<rev> AC-1 AC-2   diff depuis <rev>
#
# Pour chaque identifiant : les fichiers de test du diff (la définition de
# `scripts/test-files.sh --scope=changed[=<base>]`, restreinte à test/) dont le
# texte porte `AC-n` entier (ni `AC-10` pour `AC-1`, ni `XAC-1`) sont imprimés
# (`AC-n : <fichiers>` ou `AC-n : (aucun test dans le diff)`). Puis UN seul
# `node --test --test-reporter=tap --experimental-strip-types <fichiers uniques>`
# tourne, et le TAP est lu : un test dont le nom porte l'identifiant compte pour
# l'AC — `pass` si tous ses tests passent, `fail` si l'un tombe, `absent` si
# aucun test nommé ne l'a exécuté (y compris un test sauté). Sortie 1 dès qu'un
# AC est `fail` ou `absent` : un critère sans preuve n'est pas prouvé.
#
# Le TAP est ÉPINGLÉ (le rapport par défaut dépend de la version de Node) et
# conservé dans un fichier temporaire : en échec, les `not ok` sont recopiés.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

scope="--scope=changed"
ids=()
for arg in "$@"; do
  case "$arg" in
    --base=*) scope="--scope=changed=${arg#--base=}" ;;
    AC-*)
      case "${arg#AC-}" in
        ''|*[!0-9]*) echo "✗ identifiant invalide : $arg (attendu : AC-<n>)" >&2; exit 1 ;;
      esac
      ids+=("$arg")
      ;;
    *) echo "✗ option inconnue : $arg (attendu : --base=<rev>, AC-<n>…)" >&2; exit 1 ;;
  esac
done
if [ "${#ids[@]}" -eq 0 ]; then
  echo "✗ aucun identifiant AC-<n> reçu" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "✗ python3 introuvable" >&2
  exit 1
fi

# Les fichiers de test du diff ; un échec de test-files.sh (python3 absent,
# ensemble vide) est recopié et arrête tout.
if ! files_list="$(bash scripts/test-files.sh "$scope")"; then
  printf '%s\n' "$files_list" >&2
  exit 1
fi

# Étape 1 : quels fichiers du diff portent chaque identifiant. python imprime la
# liste des fichiers UNIQUES à lancer sur la dernière ligne, préfixée `FILES\t`.
mapping="$(MEM0_AC_IDS="${ids[*]}" MEM0_AC_FILES="$files_list" python3 - <<'PY'
import os, re, sys
ids = os.environ["MEM0_AC_IDS"].split()
files = [f for f in os.environ["MEM0_AC_FILES"].split("\n") if f.strip() != "" and f.startswith("test/")]
texts = {}
for path in files:
    with open(path, encoding="utf-8") as handle:
        texts[path] = handle.read()
to_run = []
for ac in ids:
    rule = re.compile(r"(?<![A-Za-z0-9])" + re.escape(ac) + r"(?![0-9])")
    found = [path for path in files if rule.search(texts[path])]
    if found:
        print(f"{ac} : {' '.join(found)}")
    else:
        print(f"{ac} : (aucun test dans le diff)")
    for path in found:
        if path not in to_run:
            to_run.append(path)
print("FILES\t" + " ".join(to_run))
PY
)" || exit 1
printf '%s\n' "$mapping" | grep -v $'^FILES\t'
to_run="$(printf '%s\n' "$mapping" | grep $'^FILES\t' | cut -f2-)"

# Étape 2 : une seule passe de node, puis le verdict par AC lu dans le TAP.
tap="$(mktemp)"
trap 'rm -f "$tap"' EXIT
if [ -n "$to_run" ]; then
  # shellcheck disable=SC2086 — la liste est volontairement éclatée en arguments.
  node --test --test-reporter=tap --experimental-strip-types $to_run >"$tap" 2>&1
  node_status=$?
  if [ "$node_status" -ne 0 ]; then
    printf '· node --test a rendu %s\n' "$node_status"
    grep -E '^ *not ok' "$tap" | head -n 40
  fi
fi

MEM0_AC_IDS="${ids[*]}" MEM0_AC_TAP="$tap" python3 - <<'PY'
import os, re, sys
ids = os.environ["MEM0_AC_IDS"].split()
# Une ligne de résultat TAP, à toute profondeur : `ok 3 - nom`, `not ok 3 - nom`,
# avec une directive `# SKIP`/`# TODO` éventuelle en fin de ligne.
line_rule = re.compile(r"^\s*(not ok|ok) \d+ - (.*?)(?:\s+# (SKIP|TODO)\b.*)?$")
results = []
with open(os.environ["MEM0_AC_TAP"], encoding="utf-8") as handle:
    for line in handle:
        match = line_rule.match(line.rstrip("\n"))
        if match:
            results.append((match.group(1), match.group(2), match.group(3)))
failed = False
for ac in ids:
    rule = re.compile(r"(?<![A-Za-z0-9])" + re.escape(ac) + r"(?![0-9])")
    mine = [(status, name, directive) for status, name, directive in results if rule.search(name)]
    ran = [entry for entry in mine if entry[2] is None]
    if any(status == "not ok" for status, _, _ in ran):
        verdict = "fail"
    elif ran:
        verdict = "pass"
    else:
        verdict = "absent"
    if verdict != "pass":
        failed = True
    print(f"{ac} : {verdict}")
sys.exit(1 if failed else 0)
PY
