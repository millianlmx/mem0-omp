# Le harness sur NixOS — l'équivalent déclaratif de deploy/install.sh.
#
#   imports = [ /chemin/du/clone/omp-harness/deploy/nixos/module.nix ];
#   services.omp-harness = {
#     enable = true;
#     ompPackage = inputs.omp.packages.${pkgs.system}.omp;   # github:can1357/oh-my-pi/v18.6.0
#     settings.repos = [ { name = "mon-produit"; path = "/var/lib/omp-harness/repos/mon-produit"; … } ];
#     tailscale.serve = true;                                 # l'API (443) et la mémoire (8443) sur le tailnet
#   };
#
# Les embeddings de la mémoire sont servis sur la machine même (`embeddings`, un Ollama
# sur 127.0.0.1) : rien à installer ailleurs.
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
  merged = lib.recursiveUpdate defaults cfg.settings;
  harnessConfig = (pkgs.formats.json { }).generate "omp-harness-config.json" merged;

  # Les réglages de mem0-rs : l'Ollama local quand il est déclaré, sinon un serveur ailleurs ;
  # `mem0.environment` l'emporte toujours.
  ollamaUrl = "http://127.0.0.1:${toString cfg.embeddings.port}/v1";
  mem0Environment =
    (
      if cfg.embeddings.enable then
        {
          OMLX_BASE_URL = ollamaUrl;
          OMLX_EMBED_MODEL = cfg.embeddings.model;
          # Sans modèle de chat, l'extraction (add infer=true) n'est pas servie ; le harness et
          # le plugin mémoire écrivent sans extraction par défaut.
          OMLX_LLM_MODEL = if cfg.embeddings.llmModel != null then cfg.embeddings.llmModel else cfg.embeddings.model;
          EMBEDDING_DIMS = toString cfg.embeddings.dims;
        }
      else
        {
          OMLX_BASE_URL = "http://homelab:8000/v1";
          OMLX_LLM_MODEL = "qwen3-8b";
          OMLX_EMBED_MODEL = "bge-m3";
          EMBEDDING_DIMS = "1024";
        }
    )
    // cfg.mem0.environment;

  tailscale = config.services.tailscale.package;
  serveScript = pkgs.writeShellScript "omp-harness-tailscale-serve" ''
    set -eu
    # Le nœud doit être connecté (BackendState Running) : deux minutes au plus, puis échec et relance.
    for _ in $(seq 60); do
      if ${tailscale}/bin/tailscale status --json --peers=false 2>/dev/null | grep -q '"BackendState": *"Running"'; then break; fi
      sleep 2
    done
    ${tailscale}/bin/tailscale serve --bg --https=${toString cfg.tailscale.httpsPort} http://127.0.0.1:${toString merged.listen.port}
    ${lib.optionalString (cfg.mem0.enable && cfg.tailscale.mem0HttpsPort != null)
      "${tailscale}/bin/tailscale serve --bg --https=${toString cfg.tailscale.mem0HttpsPort} http://127.0.0.1:8321"}
  '';
  unserveScript = pkgs.writeShellScript "omp-harness-tailscale-unserve" ''
    ${tailscale}/bin/tailscale serve --https=${toString cfg.tailscale.httpsPort} off || true
    ${lib.optionalString (cfg.mem0.enable && cfg.tailscale.mem0HttpsPort != null)
      "${tailscale}/bin/tailscale serve --https=${toString cfg.tailscale.mem0HttpsPort} off || true"}
  '';

  launcherConf = ''
    # Généré par le module NixOS — lu, jamais sourcé, par le lanceur root.
    WORKTREES_ROOT=/var/lib/omp-harness/worktrees
    REPOS_ROOT=/var/lib/omp-harness/repos
    WRITABLE_ROOTS=/var/lib/omp-harness/worktrees /var/cache/omp-harness /var/lib/omp-heavy
    HEAVY_USER=omp-heavy
    RUNNER_USER=omp-runner
    WORK_GROUP=omp-work
    HEAVY_SLICE=omp-harness-heavy.slice
    RUNNER_SLICE=omp-harness-runners.slice
    OMP_BIN=${cfg.ompBin}
    RUNNER_ENV_FILE=/etc/omp-harness/runner.env
    RUNNER_ENV_DIR=/run/omp-harness-launcher
    RUNNER_HIDDEN=/var/lib/omp-harness/state /var/lib/omp-heavy /var/lib/omp-mem0 /etc/omp-harness /run/dbus /run/docker.sock /var/run/docker.sock /run/systemd/private
    PROVIDERS_ENV_FILE=/var/lib/omp-harness/state/providers.env
    PROVIDERS_MODELS_FILE=/var/lib/omp-harness/state/providers.models.yml
    HEAVY_HIDDEN=/var/lib/omp-runner /var/lib/omp-harness/state /var/lib/omp-mem0 /etc/omp-harness /run/dbus /run/docker.sock /var/run/docker.sock /run/systemd/private
    HEAVY_SHELL=${shell}
  '';

  # `sudo omp-harness-check` : l'installation vérifiée, en omp-harness, avec l'environnement du service.
  check = pkgs.writeShellScriptBin "omp-harness-check" ''
    exec /run/wrappers/bin/sudo -u omp-harness -H ${pkgs.bash}/bin/sh -c 'set -a; [ -r /etc/omp-harness/env ] && . /etc/omp-harness/env; set +a; PATH=${lib.makeBinPath [ pkgs.git pkgs.openssh pkgs.gh ]}:$PATH exec ${cfg.nodejs}/bin/node --experimental-strip-types --disable-warning=ExperimentalWarning ${src}/omp-harness/main.ts --config /etc/omp-harness/config.json --check'
  '';

  # `sudo omp-harness-client add|list|revoke|approver …` : les clients du harness, en omp-harness (auth.ts).
  client = pkgs.writeShellScriptBin "omp-harness-client" ''
    run() { /run/wrappers/bin/sudo -u omp-harness -H ${cfg.nodejs}/bin/node --experimental-strip-types --disable-warning=ExperimentalWarning ${src}/omp-harness/main.ts --config /etc/omp-harness/config.json "$@"; }
    case "''${1:-}" in
      add) [ -n "''${2:-}" ] || exit 64; run --add-client "$2" --role "''${3:-operator}" --repos "''${4:-*}" ;;
      list) run --list-clients ;;
      revoke) [ -n "''${2:-}" ] || exit 64; run --revoke-client "$2" ;;
      # (re)crée app-approbateur, le seul client qui approuve le poste : son jeton seul sur stdout.
      approver) run --revoke-client app-approbateur >/dev/null 2>&1 || true; run --add-client app-approbateur --approver ;;
      *) echo "usage : omp-harness-client add <nom> [viewer|operator|admin] [dépôt,…|*] | list | revoke <nom> | approver" >&2; exit 64 ;;
    esac
  '';

  homes = { omp-harness = "/var/lib/omp-harness"; omp-runner = "/var/lib/omp-runner"; omp-heavy = "/var/lib/omp-heavy"; };
in
{
  options.services.omp-harness = {
    enable = lib.mkEnableOption "le harness de pipelines OMP (omp-harness)";

    ompPackage = lib.mkOption {
      type = lib.types.nullOr lib.types.package;
      default = null;
      example = lib.literalExpression "inputs.omp.packages.\${pkgs.system}.omp";
      description = "Le paquet omp (flake github:can1357/oh-my-pi/v18.6.0, la version de l'app Mac) ; donne `ompBin`.";
    };

    ompBin = lib.mkOption {
      type = lib.types.str;
      default = lib.optionalString (cfg.ompPackage != null) "${cfg.ompPackage}/bin/omp";
      defaultText = lib.literalExpression "\"\${ompPackage}/bin/omp\"";
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
        default = { };
        example = { OMLX_BASE_URL = "http://homelab:8000/v1"; };
        description = ''
          Réglages non secrets de mem0-rs, par-dessus ceux du module (l'Ollama local de
          `embeddings`, sinon http://homelab:8000/v1) ; OMLX_API_TOKEN va dans /etc/omp-harness/mem0.env.
        '';
      };
    };

    embeddings = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = ''
          Un Ollama sur cette machine (127.0.0.1 seulement) qui sert les embeddings de la mémoire.
          Faux : mem0.environment.OMLX_BASE_URL désigne un serveur compatible OpenAI ailleurs.
        '';
      };
      model = lib.mkOption {
        type = lib.types.str;
        default = "bge-m3";
        description = "Le modèle d'embeddings, téléchargé par Ollama au premier démarrage.";
      };
      dims = lib.mkOption {
        type = lib.types.ints.positive;
        default = 1024;
        description = "La dimension de ses vecteurs (1024 pour bge-m3) ; une base existante garde la sienne.";
      };
      llmModel = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "qwen3:1.7b";
        description = ''
          Un modèle de chat servi par le même Ollama pour l'extraction de souvenirs (add infer=true).
          null : pas d'extraction ; le harness et le plugin mémoire n'en demandent pas par défaut.
        '';
      };
      port = lib.mkOption {
        type = lib.types.port;
        default = 11434;
        description = "Le port local d'Ollama.";
      };
    };

    tailscale = {
      serve = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Publie l'API du harness et la mémoire en HTTPS sur le tailnet (`tailscale serve`), au
          démarrage, une fois le nœud connecté. Exige services.tailscale.enable (et, pour une
          connexion sans geste, services.tailscale.authKeyFile).
        '';
      };
      httpsPort = lib.mkOption {
        type = lib.types.port;
        default = 443;
        description = "Le port HTTPS de l'API sur le tailnet : https://<machine>.<tailnet>.ts.net.";
      };
      mem0HttpsPort = lib.mkOption {
        type = lib.types.nullOr lib.types.port;
        default = 8443;
        description = "Le port HTTPS de la mémoire sur le tailnet (partagée avec le Mac) ; null : non publiée.";
      };
    };

    zram = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = "8 Go de swap zram (zstd), comme deploy/zram-generator.conf.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      { assertion = lib.hasPrefix "/" cfg.ompBin; message = "services.omp-harness : renseigne ompPackage (ou ompBin, chemin absolu)."; }
      {
        assertion = !cfg.tailscale.serve || config.services.tailscale.enable;
        message = "services.omp-harness.tailscale.serve exige services.tailscale.enable = true (et un nœud connecté : services.tailscale.authKeyFile).";
      }
    ];

    # Les embeddings de la mémoire, sur la machine : jamais exposés hors de la boucle locale.
    services.ollama = lib.mkIf cfg.embeddings.enable {
      enable = true;
      host = "127.0.0.1";
      port = cfg.embeddings.port;
      loadModels = [ cfg.embeddings.model ] ++ lib.optional (cfg.embeddings.llmModel != null) cfg.embeddings.llmModel;
    };

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
    environment.systemPackages = [ cfg.nodejs pkgs.git pkgs.util-linux check client ] ++ lib.optional (cfg.ompPackage != null) cfg.ompPackage;

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
      path = [ pkgs.coreutils pkgs.openssh pkgs.util-linux ];
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
        # La clé SSH du service : il pousse les merges sur le distant (clé de déploiement AVEC écriture).
        if [ ! -e /var/lib/omp-harness/.ssh/id_ed25519 ]; then
          install -d -m 0700 -o omp-harness -g omp-harness /var/lib/omp-harness/.ssh
          runuser -u omp-harness -- ssh-keygen -q -t ed25519 -N "" -C "omp-harness@${config.networking.hostName}" -f /var/lib/omp-harness/.ssh/id_ed25519
          # Premier contact : la clé d'hôte est retenue ; une clé qui change ensuite est refusée.
          printf 'Host *\n  StrictHostKeyChecking accept-new\n' > /var/lib/omp-harness/.ssh/config
          chown omp-harness:omp-harness /var/lib/omp-harness/.ssh/config
          chmod 0600 /var/lib/omp-harness/.ssh/config
        fi
      '';
    };

    systemd.services.omp-harness-mem0 = lib.mkIf cfg.mem0.enable {
      description = "OMP harness — oracle mem0-rs (mémoire du projet)";
      after = [ "network-online.target" "tailscaled.service" "omp-harness-secrets.service" ]
        ++ lib.optionals cfg.embeddings.enable [ "ollama.service" "ollama-model-loader.service" ];
      wants = [ "network-online.target" ] ++ lib.optionals cfg.embeddings.enable [ "ollama.service" "ollama-model-loader.service" ];
      requires = [ "omp-harness-secrets.service" ];
      before = [ "omp-harness.service" ];
      wantedBy = [ "multi-user.target" ];
      environment = mem0Environment // { MEM0_DB_PATH = "/var/lib/omp-mem0/mem0-rs.db"; };
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
      path = [ pkgs.git pkgs.openssh pkgs.gh ];
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
        # Le durcissement de deploy/omp-harness.service : espaces de montage seulement. Pas de
        # NoNewPrivileges (sudo), ni d'option à base de seccomp, qui l'imposerait sous User=.
        ProtectSystem = "full";
        ProtectHome = true;
        PrivateTmp = true;
        ProtectControlGroups = true;
      };
    };

    # `tailscale serve` déclaré : la publication suit la configuration, et s'efface avec elle.
    systemd.services.omp-harness-tailscale-serve = lib.mkIf cfg.tailscale.serve {
      description = "OMP harness — publication sur le tailnet (tailscale serve)";
      after = [ "tailscaled.service" "tailscaled-autoconnect.service" "omp-harness.service" ];
      wants = [ "tailscaled.service" ];
      wantedBy = [ "multi-user.target" ];
      restartTriggers = [ serveScript ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecStart = serveScript;
        ExecStop = unserveScript;
        Restart = "on-failure";
        RestartSec = 30;
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
