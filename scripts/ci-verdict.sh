#!/usr/bin/env bash
# Deux modes.
#
# 1. Agrégateur — verdict du job « check (macos-latest) » de
#    .github/workflows/check.yml (S-2) : il reçoit le résultat de chaque job macOS
#    dont il dépend et ne réussit que si TOUS ont réussi.
#
#      bash scripts/ci-verdict.sh <job>=<résultat> [<job>=<résultat>…]
#
#    Appelé avec `needs.<job>.result` (success, failure, cancelled, skipped). Seul
#    `success` passe : un job sauté ou annulé n'a rien vérifié, et l'agrégateur est
#    un statut requis de `main` — s'il réussissait sur un job sauté, la fusion
#    passerait sans les vérifications macOS. Une valeur vide ou inconnue échoue
#    aussi : jamais de verdict vert par défaut.
#
# 2. Tests instables — dit si TOUS les tests en échec d'un premier `swift test`
#    sont au registre scripts/tests-instables-connus.json, donc relançables.
#
#      bash scripts/ci-verdict.sh --instables <nom imprimé> [<nom imprimé>…]
#
#    Un nom imprimé est celui de la ligne d'échec de Swift Testing : `"<nom
#    affiché>"` entre guillemets (l'identifiant est alors son premier jeton
#    `<slug>/AC-<n>`, ou le nom affiché entier) ou `fonction()` sans guillemets.
#    Les jugements vont sur stderr ; stdout ne porte que les filtres
#    `swift test --filter` des tests à relancer, un par ligne, sans doublon.
#    Code 0 si tous sont au registre ; 1 si un seul n'y est pas, si son entrée
#    est expirée, si aucun nom n'est donné ou si le registre est absent ou non
#    conforme — stdout reste alors vide : aucune relance.
#
#    Chaque entrée porte `raison` (pourquoi le test est toléré) et `expire`
#    (AAAA-MM-JJ, dernier jour UTC où la relance vaut) ; `issue` (le suivi) est
#    facultative. Passé `expire`, l'entrée ne relance plus rien : le test doit
#    être corrigé, ou l'entrée prolongée en le disant dans la PR.
set -uo pipefail

if [ "${1:-}" = "--instables" ]; then
  shift
  if [ $# -eq 0 ]; then
    echo "✗ aucun test à juger" >&2
    exit 1
  fi
  registre="$(dirname "${BASH_SOURCE[0]}")/tests-instables-connus.json"
  python3 - "$registre" "$@" <<'PY'
import datetime, json, re, sys

SLUG = re.compile(r"[a-z0-9][a-z0-9-]*/AC-[0-9]+")
FONCTION = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\(\)")
CLES = {"identifiant", "filtre", "occurrence", "raison", "expire"}
FACULTATIVES = {"issue"}
DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")

def date_expiration(texte):
    """La date `AAAA-MM-JJ` d'expiration, ou None si elle n'en est pas une."""
    if not DATE.fullmatch(texte):
        return None
    try:
        return datetime.date.fromisoformat(texte)
    except ValueError:
        return None

def registre(chemin):
    """Les entrées du registre par identifiant, ou None s'il n'est pas conforme."""
    try:
        with open(chemin, encoding="utf-8") as f:
            racine = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(racine, dict) or set(racine) != {"tests"} or not isinstance(racine["tests"], list):
        return None
    entrees = {}
    for e in racine["tests"]:
        if not isinstance(e, dict) or not CLES <= set(e) <= CLES | FACULTATIVES:
            return None
        if not all(isinstance(e[k], str) and e[k] for k in e):
            return None
        if date_expiration(e["expire"]) is None:
            return None
        ident = e["identifiant"]
        if not (SLUG.fullmatch(ident) or FONCTION.fullmatch(ident)) or ident in entrees:
            return None
        entrees[ident] = e
    return entrees

def identifiant(nom):
    if len(nom) >= 2 and nom.startswith('"') and nom.endswith('"'):
        affiche = nom[1:-1]
        jeton = affiche.split(" ", 1)[0]
        return jeton if SLUG.fullmatch(jeton) else affiche
    return nom

entrees = registre(sys.argv[1])
if entrees is None:
    print("✗ registre des tests instables illisible : scripts/tests-instables-connus.json", file=sys.stderr)
    sys.exit(1)

aujourdhui = datetime.datetime.now(datetime.timezone.utc).date()
filtres, tous = [], True
for nom in sys.argv[2:]:
    ident = identifiant(nom)
    e = entrees.get(ident)
    if e is None:
        print(f"  ✗ {ident} : absent du registre des tests instables", file=sys.stderr)
        tous = False
        continue
    if date_expiration(e["expire"]) < aujourdhui:
        print(
            f"  ✗ {ident} : entrée du registre expirée le {e['expire']} ({e['raison']}) — corrige le test ou prolonge l'entrée",
            file=sys.stderr,
        )
        tous = False
        continue
    print(f"  ✓ {ident} : instable connu ({e['occurrence']})", file=sys.stderr)
    if e["filtre"] not in filtres:
        filtres.append(e["filtre"])

if not tous:
    print("✗ au moins un test en échec n'est pas au registre des tests instables : aucune relance", file=sys.stderr)
    sys.exit(1)
for f in filtres:
    print(f)
PY
  [ $? -eq 0 ] || exit 1
  exit 0
fi

if [ $# -eq 0 ]; then
  echo "✗ aucun job à juger"
  exit 1
fi

status=0
for arg in "$@"; do
  case "$arg" in
    *=*) ;;
    *)
      echo "✗ argument invalide : $arg"
      exit 1
      ;;
  esac
  job="${arg%%=*}"
  result="${arg#*=}"
  if [ "$result" = "success" ]; then
    echo "  ✓ $job : success"
  else
    echo "  ✗ $job : ${result:-(vide)}"
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo "✗ check (macos-latest) : au moins un job macOS n'a pas réussi"
fi
exit "$status"
