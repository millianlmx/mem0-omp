# Le harness sur NixOS — l'équivalent déclaratif de deploy/install.sh.
#
#   imports = [ /chemin/du/clone/omp-harness/deploy/nixos/module.nix ];
#   services.omp-harness = {
#     enable = true;
#     ompBin = "/run/current-system/sw/bin/omp";
#     settings.repos = [ { name = "mon-produit"; path = "/var/lib/omp-harness/repos/mon-produit"; … } ];
#   };
#
# Mêmes users, mêmes droits, mêmes tranches et le même lanceur root que sur Debian ;
# seuls les chemins changent (store Nix, /run/wrappers/bin/sudo, bash du store).
# Les secrets (jeton mem0, clés des fournisseurs) ne passent JAMAIS par le store :
# `omp-harness-secrets` les crée une fois dans /etc/omp-harness, root seul.
{ config, lib, pkgs, ... }:

let
  cfg = config.services.omp-harness;
  repo = ../../..;

  # Le service et le plugin mémoire, côte à côte (scope.ts importe ../omp-mem0-memory).
  src = lib.fileset.toSource {
    root = repo;
    fileset = lib.fileset.unions [ (repo + "/omp-harness") (repo + "/omp-mem0-memory") ];
  };

  mem0Dir = repo + "/mem0-stack/mem0-rs";
  mem0-rs = pkgs.rustPlatform.buildRustPackage {
    pname = "mem0-rs";
    version = "0.1.0";
    src = lib.fileset.toSource {
      root = mem0Dir;
      fileset = lib.fileset.unions [ (mem0Dir + "/Cargo.toml") (mem0Dir + "/Cargo.lock") (mem0Dir + "/src") ];
    };
    cargoLock.lockFile = mem0Dir + "/Cargo.lock";
    doCheck = false;
  };

  # Le lanceur root, shebang réécrit vers le bash du store.
  launcher = pkgs.runCommand "omp-harness-systemd-run" { } ''
    install -Dm755 ${../omp-harness-systemd-run} $out/bin/omp-harness-systemd-run
    patchShebangs $out/bin
  '';
  launcherBin = "${launcher}/bin/omp-harness-systemd-run";
  shell = "${pkgs.bash}/bin/bash";

  gitconfig = pkgs.writeText "omp-harness-gitconfig" ''
    # Les worktrees changent de propriétaire entre service, runners et jobs heavy.
    [safe]
    	directory = *
  '';

  defaults = {
    listen = { host = "127.0.0.1"; port = 8790; };
    dataDir = "/var/lib/omp-harness/state";
    worktreesDir = "/var/lib/omp-harness/worktrees";
    ompBin = cfg.ompBin;
    launcher = [ "/run/wrappers/bin/sudo" "-n" launcherBin ];
    runner.extensions = [ "${src}/omp-mem0-memory/extension.ts" ];
    heavy = {
      user = "omp-heavy";
      inherit shell;
      cargoTargetRoot = "/var/cache/omp-harness/cargo";
      readWritePaths = [ "/var/cache/omp-harness/sccache" "/var/cache/omp-harness/pnpm-store" "/var/lib/omp-heavy" ];
      env = {
        HOME = "/var/lib/omp-heavy";
        PATH = lib.concatStringsSep ":" [ (lib.makeBinPath cfg.heavyPackages) "/run/current-system/sw/bin" ];
      };
    };
    oracle = if cfg.mem0.enable then { url = "http://127.0.0.1:8321"; token = null; } else null;
  };
  harnessConfig = (pkgs.formats.json { }).generate "omp-harness-config.json" (lib.recursiveUpdate defaults cfg.settings);

  launcherConf = ''
    # Généré par le module NixOS — lu, jamais sourcé, par le lanceur root.
    WORKTREES_ROOT=/var/lib/omp-harness/worktrees
    WRITABLE_ROOTS=/var/lib/omp-harness/worktrees /var/cache/omp-harness /var/lib/omp-heavy
    HEAVY_USER=omp-heavy
    RUNNER_USER=omp-runner
    WORK_GROUP=omp-work
    HEAVY_SLICE=omp-harness-heavy.slice
    RUNNER_SLICE=omp-harness-runners.slice
    OMP_BIN=${cfg.ompBin}
    RUNNER_ENV_FILE=/etc/omp-harness/runner.env
    HEAVY_HIDDEN=/var/lib/omp-runner /var/lib/omp-harness/state /var/lib/omp-mem0 /etc/omp-harness /run/dbus /run/docker.sock /var/run/docker.sock /run/systemd/private
    HEAVY_SHELL=${shell}
  '';

  homes = { omp-harness = "/var/lib/omp-harness"; omp-runner = "/var/lib/omp-runner"; omp-heavy = "/var/lib/omp-heavy"; };
in
{
  options.services.omp-harness = {
    enable = lib.mkEnableOption "le harness de pipelines OMP (omp-harness)";

    ompBin = lib.mkOption {
      type = lib.types.str;
      example = "/run/current-system/sw/bin/omp";
      description = "Le binaire `omp` des runners : chemin absolu, épinglé par le lanceur root.";
    };

    nodejs = lib.mkPackageOption pkgs "nodejs_22" { };

    heavyPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      example = lib.literalExpression "[ pkgs.nodejs_22 pkgs.cargo pkgs.rustc ]";
      description = "Les outils des tests et builds des dépôts (PATH des jobs heavy, avant celui du système).";
    };

    settings = lib.mkOption {
      type = (pkgs.formats.json { }).type;
      default = { };
      description = ''
        Fusionné par-dessus les défauts du module dans /etc/omp-harness/config.json : `repos`,
        `models`, `providers`, `review`, slots… (voir deploy/config.example.json). Aucun secret ici :
        le fichier vient du store.
      '';
    };

    mem0 = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "L'oracle mem0-rs (la mémoire du projet) sur 127.0.0.1:8321.";
      };
      environment = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = {
          OMLX_BASE_URL = "http://homelab:8000/v1";
          OMLX_LLM_MODEL = "qwen3-8b";
          OMLX_EMBED_MODEL = "bge-m3";
          EMBEDDING_DIMS = "1024";
        };
        description = "Réglages non secrets de mem0-rs ; OMLX_API_TOKEN va dans /etc/omp-harness/mem0.env.";
      };
    };

    zram = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "8 Go de swap zram (zstd), comme deploy/zram-generator.conf.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups = { omp-work = { }; omp-harness = { }; omp-runner = { }; omp-heavy = { }; omp-mem0 = { }; };
    users.users = {
      omp-harness = { isSystemUser = true; group = "omp-harness"; extraGroups = [ "omp-work" ]; home = homes.omp-harness; description = "OMP harness - service"; };
      omp-runner = { isSystemUser = true; group = "omp-runner"; extraGroups = [ "omp-work" ]; home = homes.omp-runner; description = "OMP harness - runners"; };
      omp-heavy = { isSystemUser = true; group = "omp-heavy"; extraGroups = [ "omp-work" ]; home = homes.omp-heavy; description = "OMP harness - jobs heavy"; };
      omp-mem0 = { isSystemUser = true; group = "omp-mem0"; home = "/var/lib/omp-mem0"; description = "OMP harness - oracle mem0-rs"; };
    };

    # deploy/tmpfiles.conf, plus le safe.directory git de chaque user.
    systemd.tmpfiles.rules = [
      "d /var/lib/omp-harness                0750 omp-harness omp-work -"
      "d /var/lib/omp-harness/state          0700 omp-harness omp-harness -"
      "d /var/lib/omp-harness/repos          2750 omp-harness omp-work -"
      "d /var/lib/omp-harness/worktrees      2750 omp-harness omp-work -"
      "d /var/cache/omp-harness              2770 omp-harness omp-work -"
      "d /var/cache/omp-harness/cargo        2770 omp-harness omp-work -"
      "d /var/cache/omp-harness/sccache      2770 omp-harness omp-work -"
      "d /var/cache/omp-harness/pnpm-store   2770 omp-harness omp-work -"
      "d /var/lib/omp-runner                 0700 omp-runner omp-runner -"
      "d /var/lib/omp-heavy                  0700 omp-heavy omp-heavy -"
      "d /var/lib/omp-mem0                   0700 omp-mem0 omp-mem0 -"
      "d /etc/omp-harness                    0755 root root -"
    ] ++ lib.mapAttrsToList (_: home: "L+ ${home}/.gitconfig - - - - ${gitconfig}") homes;

    # La SEULE élévation du service : le lanceur root, qui valide chaque ligne.
    security.sudo.extraRules = [
      { users = [ "omp-harness" ]; runAs = "root"; commands = [ { command = launcherBin; options = [ "NOPASSWD" ]; } ]; }
    ];

    environment.etc."omp-harness/launcher.conf".text = launcherConf;
    environment.etc."omp-harness/config.json" = { source = harnessConfig; mode = "0640"; group = "omp-harness"; };
    environment.systemPackages = [ cfg.nodejs pkgs.git pkgs.util-linux ];

    systemd.slices = {
      omp-harness = { description = "OMP harness — budget mémoire total"; sliceConfig = { MemoryMax = "16G"; MemoryHigh = "15G"; }; };
      omp-harness-runners = {
        description = "OMP harness — runners";
        sliceConfig = { MemoryMax = "5G"; ManagedOOMMemoryPressure = "kill"; ManagedOOMMemoryPressureLimit = "80%"; ManagedOOMPreference = "avoid"; };
      };
      omp-harness-heavy = {
        description = "OMP harness — jobs heavy";
        sliceConfig = { MemoryMax = "8G"; ManagedOOMMemoryPressure = "kill"; ManagedOOMMemoryPressureLimit = "60%"; ManagedOOMSwap = "kill"; };
      };
    };

    # Le jeton mem0 partagé (mem0-rs, service, runners) : créé une fois, root seul, hors du store.
    systemd.services.omp-harness-secrets = {
      description = "OMP harness — secrets de /etc/omp-harness";
      wantedBy = [ "multi-user.target" ];
      before = [ "omp-harness.service" "omp-harness-mem0.service" ];
      path = [ pkgs.coreutils ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      script = ''
        set -eu
        cd /etc/omp-harness
        [ -e env ] || install -m 0640 -g omp-harness /dev/null env
        [ -e runner.env ] || install -m 0600 /dev/null runner.env
        if [ ! -e mem0.env ]; then
          token="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
          install -m 0600 /dev/null mem0.env
          printf 'MEM0_HTTP_TOKEN=%s\n# OMLX_API_TOKEN=\n' "$token" > mem0.env
          printf 'MEM0_HTTP_TOKEN=%s\n' "$token" >> env
          printf 'MEM0_HTTP_URL=http://127.0.0.1:8321\nMEM0_HTTP_TOKEN=%s\n' "$token" >> runner.env
        fi
      '';
    };

    systemd.services.omp-harness-mem0 = lib.mkIf cfg.mem0.enable {
      description = "OMP harness — oracle mem0-rs (mémoire du projet)";
      after = [ "network-online.target" "tailscaled.service" "omp-harness-secrets.service" ];
      wants = [ "network-online.target" ];
      requires = [ "omp-harness-secrets.service" ];
      before = [ "omp-harness.service" ];
      wantedBy = [ "multi-user.target" ];
      environment = cfg.mem0.environment // { MEM0_DB_PATH = "/var/lib/omp-mem0/mem0-rs.db"; };
      serviceConfig = {
        User = "omp-mem0";
        Group = "omp-mem0";
        EnvironmentFile = "/etc/omp-harness/mem0.env";
        ExecStart = "${mem0-rs}/bin/mem0-rs --host 127.0.0.1 --port 8321";
        Restart = "on-failure";
        RestartSec = 5;
        MemoryMax = "512M";
        OOMScoreAdjust = -500;
        ManagedOOMPreference = "omit";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ReadWritePaths = [ "/var/lib/omp-mem0" ];
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
      };
    };

    systemd.services.omp-harness = {
      description = "OMP harness — Pipeline Service (API REST + SSE, runners, heavy)";
      after = [ "network-online.target" "omp-harness-secrets.service" ] ++ lib.optional cfg.mem0.enable "omp-harness-mem0.service";
      wants = [ "network-online.target" ] ++ lib.optional cfg.mem0.enable "omp-harness-mem0.service";
      requires = [ "omp-harness-secrets.service" ];
      wantedBy = [ "multi-user.target" ];
      restartTriggers = [ harnessConfig launcherConf ];
      path = [ pkgs.git pkgs.openssh ];
      serviceConfig = {
        Type = "simple";
        User = "omp-harness";
        Group = "omp-harness";
        SupplementaryGroups = [ "omp-work" ];
        UMask = "0002";
        Slice = "omp-harness.slice";
        WorkingDirectory = "/var/lib/omp-harness/state";
        EnvironmentFile = "-/etc/omp-harness/env";
        ExecStart = "${cfg.nodejs}/bin/node --experimental-strip-types --disable-warning=ExperimentalWarning ${src}/omp-harness/main.ts --config /etc/omp-harness/config.json";
        Restart = "on-failure";
        RestartSec = 5;
        KillMode = "mixed";
        TimeoutStopSec = 60;
        MemoryMax = "1G";
        OOMScoreAdjust = -900;
        ManagedOOMPreference = "omit";
      };
    };

    # oomd agit avant l'OOM killer du noyau : heavy (800), puis runners (300), jamais le service.
    systemd.oomd = {
      enable = true;
      settings.OOM = { SwapUsedLimit = "90%"; DefaultMemoryPressureLimit = "60%"; DefaultMemoryPressureDurationSec = "20s"; };
    };
    zramSwap = lib.mkIf cfg.zram {
      enable = true;
      algorithm = "zstd";
      memoryMax = 8 * 1024 * 1024 * 1024;
      memoryPercent = 100;
      priority = 100;
    };
  };
}
