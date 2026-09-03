#!/usr/bin/env bash
# Installation manuelle, sans marketplace.
#
# OMP découvre automatiquement les extensions déposées dans le dossier
# extensions de son répertoire agent (~/.omp/agent/extensions par défaut,
# surchargeable par PI_CODING_AGENT_DIR). Il n'y a rien à enregistrer dans
# settings.json ni dans config.yml : déposer le fichier suffit.
#
# Pour l'installation normale, préfère le marketplace :
#   /marketplace add <handle>/mem0-omp
#   /marketplace install omp-mem0-memory@mem0-omp
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.omp/agent}"
EXT_DIR="$AGENT_DIR/extensions"
TARGET="$EXT_DIR/omp-mem0-memory.ts"

mkdir -p "$EXT_DIR"
cp "$SRC_DIR/extension.ts" "$TARGET"
echo "Extension installée -> $TARGET"

cat << EOF

Relance omp (la découverte se fait au démarrage), ouvre une session dans un
projet, puis : /mem0-status

Si tu préfères garder l'extension là où elle est plutôt que de la copier, liste
son chemin dans la config à la place :

  # $AGENT_DIR/config.yml
  extensions:
    - $SRC_DIR/extension.ts

Attention : les tableaux de configuration remplacent, ils ne s'ajoutent pas. Si
tu as déjà une clé extensions, complète-la au lieu de l'écraser.

Le service mem0 reste à lancer séparément :
  cd ../mem0-stack && docker compose up -d
  curl http://localhost:8321/health

Variables d'env (optionnelles) :
  MEM0_HTTP_URL     défaut http://localhost:8321
  MEM0_HTTP_TOKEN   si défini côté serveur
  MEM0_PROJECT_ID   force le nom de projet ; sinon déduit du dépôt
  MEM0_AUTOSETUP=0  n'écrit jamais dans un dépôt (brief à poser à la main)
  MEM0_QUIET      `0`   réinjecte les souvenirs sans les afficher dans le transcript
EOF
