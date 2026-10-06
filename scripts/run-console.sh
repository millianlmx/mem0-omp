#!/usr/bin/env bash
# Recompiler OMP Console et relancer l'app — et, en option, les hooks git qui la
# recompilent après un pull.
#
# Pourquoi ce script : `scripts/swift-app.sh` fait la vérification COMPLÈTE
# (produit release, suite debug et bundle, ~1 min), ce qui est le bon geste avant
# un commit mais trop lent pour « je veux l'app avec le dernier code ». Ce script
# fait le tour court — compilation release seule, puis relance de l'app — et sait
# se brancher en hooks git.
#
# Modes :
#   (défaut) run     compile (rapide) puis relance l'app
#   build            compile et assemble le bundle, sans relancer
#   --tests          remplace la compilation rapide par la suite complète
#                    (délègue à scripts/swift-app.sh)
#   hook             point d'entrée des hooks git — voir « Hooks » ci-dessous
#   install-hook     installe .git/hooks/{post-merge,post-rewrite}
#   uninstall-hook   retire les hooks installés par ce script
#
# Hooks : après `git pull`, git exécute post-merge (fusion ou avance rapide) ou
# post-rewrite (pull.rebase=true — le réglage LOCAL de ce dépôt) ; les deux
# appellent ce script en mode `hook`, qui recompile le bundle si — et seulement
# si — les commits arrivés ont touché une ENTRÉE de l'app :
#   omp-console/Sources/**/*.swift, omp-console/Package.swift,
#   omp-console/Bundle/**  et  mem0-stack/mem0-http/** (embarqué dans le bundle
#   par swift-app.sh).
# Les tests, la documentation et le reste du dépôt ne déclenchent donc rien : un
# pull sans entrée d'app ne paie que la lecture du diff. Le point de comparaison
# est ORIG_HEAD, que git pose avant le pull (repli : HEAD@{1}).
# La compilation ne tourne que dans l'arbre PRINCIPAL du dépôt : les hooks vivent
# dans le dépôt COMMUN, donc ils tirent aussi dans les worktrees de pipeline, où
# les fusions de main sont fréquentes — chacun paierait sinon sa compilation.
# Forcer partout : MEM0_CONSOLE_HOOK_ALL_WORKTREES=1.
# Les hooks vivent dans .git/hooks, jamais versionnés : `install-hook` les
# (ré)installe — à refaire après un clone.
#
# Codes de sortie : 0 succès, 1 échec, 2 non exécuté (hors macOS).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1
ROOT="$(pwd -P)"
BUNDLE_REL="omp-console/build/OMP Console.app"
BUNDLE="$ROOT/$BUNDLE_REL"
BINARY="$BUNDLE/Contents/MacOS/OMPConsole"
HOOK_MARKER="OMP Console — installé par scripts/run-console.sh"
HOOKS=(post-merge post-rewrite)

usage() {
  cat <<'EOF'
usage: bash scripts/run-console.sh [--tests] [run|build|hook|install-hook|uninstall-hook]

  run (défaut)    compile en release puis relance l'app
  build           compile en release, sans relancer
  --tests         suite debug complète (scripts/swift-app.sh) au lieu du tour rapide
  hook            mode hook git : recompile après un pull qui a touché les entrées
                  de l'app ; aucun effet sinon
  install-hook    installe .git/hooks/post-merge et .git/hooks/post-rewrite
  uninstall-hook  retire les hooks posés par ce script
EOF
}

# La compilation rapide réutilise scripts/swift-app.sh (--no-tests) : une seule
# implementation de l'assemblage, et le dossier .build-run évite de corrompre le
# dossier de test .build-app.
build() {
  if [ -n "$with_tests" ]; then
    bash "$ROOT/scripts/swift-app.sh"
  else
    bash "$ROOT/scripts/swift-app.sh" --no-tests
  fi
}

# Le pkill vise le CHEMIN du binaire de CE bundle : une copie de fumée lancée
# depuis /tmp n'est jamais touchée.
restart_app() {
  if [ ! -x "$BINARY" ]; then
    echo "✗ binaire absent : $BINARY (lancez d'abord bash scripts/run-console.sh build)"
    exit 1
  fi
  if pgrep -f "$BINARY" >/dev/null 2>&1; then
    echo "  · arrêt de l'instance en cours…"
    pkill -f "$BINARY" >/dev/null 2>&1 || true
    waited=0
    while pgrep -f "$BINARY" >/dev/null 2>&1; do
      waited=$((waited + 1))
      [ "$waited" -eq 30 ] && pkill -9 -f "$BINARY" >/dev/null 2>&1 || true
      if [ "$waited" -gt 60 ]; then
        echo "✗ l'instance ne s'arrête pas (pkill -f \"$BINARY\")"
        exit 1
      fi
      sleep 0.1
    done
  fi
  if ! open "$BUNDLE"; then
    echo "✗ open a échoué : $BUNDLE_REL"
    exit 1
  fi
  echo "  ✓ OMP Console lancée ($BUNDLE_REL)"
}

# Le stub résout le script DANS L'ARBRE courant (git rev-parse --show-toplevel) :
# les hooks du dépôt commun servent donc chaque worktree avec sa propre copie.
# post-rewrite reçoit la liste des commits réécrits sur son entrée standard : le
# stub la draine pour ne pas laisser git écrire dans un tube fermé.
write_hook() {
  cat <<EOF
#!/bin/sh
# $HOOK_MARKER
# Recompile le bundle de l'app si le pull (fusion ou rebase) a apporté des
# entrées d'app ; ne fait rien sinon. Détails : scripts/run-console.sh.
case "\$0" in
  *post-rewrite*) cat >/dev/null 2>&1 || true ;;
esac
exec "\$(git rev-parse --show-toplevel)/scripts/run-console.sh" hook
EOF
}

hook_mode() {
  # Hors macOS le bundle ne s'assemble pas : un pull ailleurs sort proprement.
  [ "$(uname -s)" = "Darwin" ] || exit 0

  if [ "${MEM0_CONSOLE_HOOK_ALL_WORKTREES:-}" != "1" ]; then
    main_worktree="$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)"
    if [ -n "$main_worktree" ] && [ "$main_worktree" != "$ROOT" ]; then
      exit 0
    fi
  fi

  base="$(git rev-parse --verify --quiet ORIG_HEAD || true)"
  [ -n "$base" ] || base="$(git rev-parse --verify --quiet 'HEAD@{1}' || true)"
  if [ -z "$base" ]; then
    # Aucun point de comparaison (fusion écrasée, cas tordu) : recompiler par
    # précaution plutôt que de laisser l'app périmée.
    echo "OMP Console : point de comparaison absent — recompilation par précaution…"
  else
    changed="$(git diff --name-only "$base" HEAD 2>/dev/null |
      grep -E '^(omp-console/(Sources/.*\.swift|Package\.swift|Bundle/)|mem0-stack/mem0-http/)' || true)"
    [ -n "$changed" ] || exit 0
    echo "OMP Console : $(printf '%s\n' "$changed" | grep -c .) entrée(s) d'app modifiée(s) — recompilation…"
  fi
  if ! build; then
    echo "✗ OMP Console : recompilation après pull échouée — relance : bash scripts/run-console.sh" >&2
    exit 1
  fi
}

mode="run"
with_tests=""
for arg in "$@"; do
  case "$arg" in
    --tests) with_tests=1 ;;
    run | build | hook | install-hook | uninstall-hook) mode="$arg" ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "✗ argument inconnu : $arg"
      usage >&2
      exit 1
      ;;
  esac
done

case "$mode" in
  hook) hook_mode ;;
  install-hook)
    dir="$(git rev-parse --path-format=absolute --git-path hooks)"
    # Refuser d'écraser un hook étranger AVANT d'écrire quoi que ce soit.
    for h in "${HOOKS[@]}"; do
      if [ -e "$dir/$h" ] && ! grep -Fq "$HOOK_MARKER" "$dir/$h" 2>/dev/null; then
        echo "✗ $dir/$h existe et n'appartient pas à ce script — rien n'a été écrit"
        exit 1
      fi
    done
    for h in "${HOOKS[@]}"; do
      write_hook >"$dir/$h"
      chmod +x "$dir/$h"
      echo "  ✓ hook installé : $dir/$h"
    done
    echo "    (fichiers non versionnés : à réinstaller après un clone)"
    ;;
  uninstall-hook)
    dir="$(git rev-parse --path-format=absolute --git-path hooks)"
    removed=0
    for h in "${HOOKS[@]}"; do
      if [ -f "$dir/$h" ] && grep -Fq "$HOOK_MARKER" "$dir/$h" 2>/dev/null; then
        rm "$dir/$h"
        echo "  ✓ hook retiré : $dir/$h"
        removed=$((removed + 1))
      fi
    done
    [ "$removed" -gt 0 ] || echo "  · aucun hook de ce script dans $dir"
    ;;
  run | build)
    build
    status=$?
    [ "$status" -eq 0 ] || exit "$status"
    if [ -z "$with_tests" ]; then
      echo "  · suite de tests ignorée (ajoutez --tests pour la lancer)"
    fi
    [ "$mode" = "run" ] && restart_app
    ;;
esac

exit 0
