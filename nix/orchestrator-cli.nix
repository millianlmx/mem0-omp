# CLI `omp-orchestrator` (S-1 d'orchestrator-living-in-a-vps) : le script bash de
# nix/omp-orchestrator.sh, réglé sur l'installation. Aucun secret n'entre dans le
# paquet : `mem0TokenFile` est un CHEMIN que le script lit à l'exécution, en root.
# `writeShellScriptBin` et non `writeShellApplication` : pas de shellcheck dans la
# construction (le script est vérifié par test/vps/omp-orchestrator-cli.test.ts).
{
  lib,
  writeShellScriptBin,
  coreutils,
  curl,
  jq,
  sqlite,
  systemd,
  stateDir ? "/var/lib/omp-orchestrator",
  mem0Port ? 8321,
  mem0TokenFile ? "/run/secrets/omp-mem0-token",
  user ? "omp",
  group ? "omp",
}:
writeShellScriptBin "omp-orchestrator" ''
  export PATH=${
    lib.makeBinPath [
      coreutils
      curl
      jq
      sqlite
      systemd
    ]
  }:$PATH
  export OMP_ORCH_STATE_DIR=${lib.escapeShellArg stateDir}
  export OMP_ORCH_MEM0_PORT=${toString mem0Port}
  export OMP_ORCH_MEM0_TOKEN_FILE=${lib.escapeShellArg mem0TokenFile}
  export OMP_ORCH_USER=${lib.escapeShellArg user}
  export OMP_ORCH_GROUP=${lib.escapeShellArg group}
  ${builtins.readFile ./omp-orchestrator.sh}
''
