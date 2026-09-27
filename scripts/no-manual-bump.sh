#!/usr/bin/env bash
# Garde anti-bump manuel (S-3, BR-3) : une PR — autre qu'une PR de release — ne
# monte JAMAIS une version. Le seul auteur du bump est le job de release, qui le
# calcule d'après les commits conventionnels de la fusion ; un bump manuel
# produirait un double bump (version de la PR, puis version calculée par le job).
#
# Appelé par une étape du job `check` de `.github/workflows/check.yml` :
#   ./scripts/no-manual-bump.sh --base "${{ github.event.pull_request.base.sha }}"
#
# Les porteurs de version comparés ne sont pas listés ici : ils sont LUS sur
# l'arbre (les deux catalogues) et dans le git, comme le fait `check.sh` pour les
# versions — une liste en dur laisserait passer un porteur ajouté plus tard.
#
# La comparaison part du MERGE-BASE, jamais de la base elle-même : un bump
# légitime publié sur `main` entre-temps ne fait donc pas échouer la PR.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

base=""
head="HEAD"
while [ $# -gt 0 ]; do
  case "$1" in
    --base) base="${2:-}"; shift 2 2>/dev/null || shift ;;
    --head) head="${2:-}"; shift 2 2>/dev/null || shift ;;
    *) echo "✗ option inconnue : $1" >&2; exit 2 ;;
  esac
done

if [ -z "$base" ]; then
  echo "✗ base introuvable : --base est requis" >&2
  exit 1
fi

# Une base ou une tête irrésolue est nommée, jamais avalée : sans merge-base, la
# garde ne peut pas comparer, et un « ✓ » serait un mensonge.
merge_base="$(git merge-base "$base" "$head" 2>/dev/null)" || {
  echo "✗ base introuvable : $base" >&2
  exit 1
}
if [ -z "$merge_base" ]; then
  echo "✗ base introuvable : $base" >&2
  exit 1
fi

python3 - "$merge_base" "$head" <<'PY'
import json, subprocess, sys

base, head = sys.argv[1], sys.argv[2]
CATALOGS = [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"]
SUFFIX = ("le bump appartient au job de release : retire ce changement de la PR "
          "(PUBLISHING.md, § Mettre à jour)")


def git(*args):
    return subprocess.run(["git", *args], capture_output=True, text=True).stdout


def at(ref, rel):
    """Le fichier tel qu'il est dans `ref` ; None s'il n'y est pas."""
    out = subprocess.run(["git", "show", f"{ref}:{rel}"], capture_output=True, text=True)
    return out.stdout if out.returncode == 0 else None


def catalog(ref, rel):
    raw = at(ref, rel)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def carriers(ref):
    """Les porteurs de version d'un arbre : {(chemin, libellé): valeur}."""
    found = {}
    for rel in CATALOGS:
        cat = catalog(ref, rel)
        if cat is None:
            continue
        for entry in cat.get("plugins", []):
            source = entry.get("source")
            if isinstance(source, str) and source.startswith("./"):
                pkg_rel = f"{source[2:]}/package.json"
                raw = at(ref, pkg_rel)
                if raw is not None:
                    found[(pkg_rel, "version")] = json.loads(raw).get("version")
            found[(rel, f"version de {entry.get('name')}")] = entry.get("version")
        meta = cat.get("metadata") or {}
        if "version" in meta:
            found[(rel, "metadata.version")] = meta.get("version")
    # Les deux catalogues décrivent les mêmes porteurs : sans plus de détail, la
    # clé (chemin, libellé) garde un exemplaire par fichier PORTEUR.
    return found


before = carriers(base)
after = carriers(head)

bumped = [
    (path, label, before[key], value)
    for key, value in sorted(after.items())
    for path, label in [key]
    if key in before and before[key] != value
]

if not bumped:
    print("  ✓ aucune version montée à la main dans la PR")
    sys.exit(0)

# Une PR de release porte le trailer du commit de release : c'est le job lui-même
# qui a écrit ces versions, la garde n'a rien à redire.
trailer = git("log", "--fixed-strings", "--grep=Release-Event:", "--format=%H", "-n", "1",
              f"{base}..{head}").strip()
if trailer != "":
    print("  ✓ PR de release (trailer Release-Event) : les versions sont bumpées par le job")
    sys.exit(0)

for path, label, old, new in bumped:
    detail = f"version modifiée à la main ({old} → {new})" if label == "version" \
        else f"{label} modifiée à la main ({old} → {new})"
    print(f"  ✗ {path} : {detail} — {SUFFIX}")
sys.exit(1)
PY
