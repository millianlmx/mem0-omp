# Les deux plugins omp du dépôt (S-1 d'orchestrator-living-in-a-vps), copiés tels quels
# sous `$out/omp-mem0-req` et `$out/omp-mem0-memory`. Le module les relie à omp par
# `omp plugin link <dossier>` à chaque démarrage du service : le lien pointe dans le
# store, donc une mise à jour du flake change la cible du lien (et la définition de
# l'unité, qui redémarre).
{ runCommand }:
let
  version = (builtins.fromJSON (builtins.readFile ../omp-mem0-req/package.json)).version;
in
runCommand "omp-mem0-plugins-${version}" { } ''
  mkdir -p "$out"
  cp -r ${../omp-mem0-req} "$out/omp-mem0-req"
  cp -r ${../omp-mem0-memory} "$out/omp-mem0-memory"
''
