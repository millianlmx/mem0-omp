# Module NixOS `services.omp-orchestrator` (S-1 et S-2 d'orchestrator-living-in-a-vps).
#
# Installe omp, l'extension omp-mem0-req, mem0-rs et le service de pipelines comme
# unités systemd relancées au démarrage ; `nixos-rebuild switch` est le seul geste
# d'installation et de mise à jour. Les secrets arrivent UNIQUEMENT par des chemins de
# fichiers lus au démarrage (`LoadCredential`, `EnvironmentFile`) : aucun contenu de
# secret n'entre dans le store Nix.
#
# Piège (AC-2) : une option `types.path` recevant un littéral Nix (`./secret`) COPIE le
# fichier dans /nix/store. Les options de secret sont donc des `types.str`, et une
# assertion refuse tout chemin qui n'est pas absolu ou qui vit dans le store.
{ self, omp }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.services.omp-orchestrator;
  inherit (lib)
    mkOption
    mkEnableOption
    mkIf
    types
    ;
  system = pkgs.stdenv.hostPlatform.system;
  selfPackages = self.packages.${system};

  # Un chemin de secret : absolu, hors du store. Le message est celui de la spécification.
  secretOption =
    description:
    mkOption {
      type = types.str;
      inherit description;
      example = "/run/secrets/omp-orchestrator";
    };
  isOutsideStore = path: lib.hasPrefix "/" path && !(lib.hasPrefix "/nix/store" path);
  secretAssertion = name: value: {
    assertion = value == null || isOutsideStore value;
    message = "services.omp-orchestrator.${name} doit être un chemin absolu hors du store Nix";
  };

  # 100.64.0.0/10 : 100.64.x.x à 100.127.x.x.
  octet = "(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])";
  tailscaleRegex = "100\\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\\.${octet}\\.${octet}";
  isTailscaleAddress = address: builtins.match tailscaleRegex address != null;

  useOllama = cfg.embedder.useOllama;
  ompBin = "${cfg.ompPackage}/bin/omp";
  pluginsDir = "${cfg.pluginsPackage}";

  cliPackage = pkgs.callPackage ./orchestrator-cli.nix {
    inherit (cfg) stateDir user group;
    mem0Port = cfg.mem0Port;
    mem0TokenFile = cfg.mem0TokenFile;
  };

  # mem0-rs lit ses jetons dans l'environnement : le script les tire des credentials
  # systemd (copie en mémoire, lisible du seul utilisateur du service).
  mem0Start = pkgs.writeShellScript "omp-mem0-start" ''
    set -eu
    MEM0_HTTP_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/mem0-token")"
    export MEM0_HTTP_TOKEN
    ${lib.optionalString (cfg.embedder.apiKeyFile != null) ''
      OMLX_API_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/embedder-key")"
      export OMLX_API_TOKEN
    ''}
    exec ${cfg.mem0Package}/bin/mem0-rs --host 127.0.0.1 --port ${toString cfg.mem0Port}
  '';

  # `omp -p … "/service start"` attend la fin de l'entrée standard quand elle est un
  # tube : systemd la branche sur /dev/null (StandardInput=null par défaut).
  pipelineStart = pkgs.writeShellScript "omp-pipeline-start" ''
    set -eu
    GH_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/github-token")"
    MEM0_HTTP_TOKEN="$(cat "$CREDENTIALS_DIRECTORY/mem0-token")"
    export GH_TOKEN MEM0_HTTP_TOKEN
    exec ${ompBin} -p --no-session --pipeline-service "/service start"
  '';

  restartPolicy = {
    Restart = "always";
    RestartSec = 5;
  };
in
{
  options.services.omp-orchestrator = {
    enable = mkEnableOption "l'orchestrateur de pipelines omp (omp, omp-mem0-req, mem0-rs) sur ce VPS";

    ompPackage = mkOption {
      type = types.package;
      default = omp.packages.${system}.omp;
      defaultText = lib.literalExpression "inputs.omp.packages.\${system}.omp";
      description = "Le binaire omp (flake officiel oh-my-pi) ; son hôte Bun fournit `Bun.serve`.";
    };
    mem0Package = mkOption {
      type = types.package;
      default = selfPackages.mem0-rs;
      defaultText = lib.literalExpression "self.packages.\${system}.mem0-rs";
      description = "Le serveur mem0-rs du flake.";
    };
    pluginsPackage = mkOption {
      type = types.package;
      default = selfPackages.omp-mem0-plugins;
      defaultText = lib.literalExpression "self.packages.\${system}.omp-mem0-plugins";
      description = "Les dossiers `omp-mem0-req/` et `omp-mem0-memory/`, reliés à omp par `omp plugin link`.";
    };

    user = mkOption {
      type = types.str;
      default = "omp";
      description = "Utilisateur système des deux services ; son dossier personnel est `stateDir`.";
    };
    group = mkOption {
      type = types.str;
      default = "omp";
      description = "Groupe de cet utilisateur.";
    };
    stateDir = mkOption {
      type = types.str;
      default = "/var/lib/omp-orchestrator";
      description = "État persistant : lots, dépôts clonés, base mem0. Jamais touché par une mise à jour.";
    };
    machineName = mkOption {
      type = types.str;
      default = config.networking.hostName;
      defaultText = lib.literalExpression "config.networking.hostName";
      description = "Le nom de cette machine tel que les clients l'affichent.";
    };

    tailscaleAddress = mkOption {
      type = types.str;
      example = "100.100.1.2";
      description = "L'adresse IPv4 Tailscale du VPS (100.64.0.0/10), `tailscale ip -4` : le protocole distant n'écoute que sur elle.";
    };
    apiPort = mkOption {
      type = types.port;
      default = 8787;
      description = "Port du protocole distant, ouvert sur l'interface `tailscale0` seule.";
    };
    servicePort = mkOption {
      type = types.port;
      default = 8788;
      description = "Port de la boucle locale du service de pipelines (127.0.0.1 seulement).";
    };
    mem0Port = mkOption {
      type = types.port;
      default = 8321;
      description = "Port de mem0-rs (127.0.0.1 seulement).";
    };

    modelEnvironmentFile = secretOption "Fichier de lignes `CLE=valeur` (ANTHROPIC_API_KEY, OPENAI_API_KEY, …) lu par systemd au démarrage ; chemin absolu hors du store Nix.";
    githubTokenFile = secretOption "Fichier du jeton GitHub (portées `repo` et `workflow`) ; chemin absolu hors du store Nix.";
    mem0TokenFile = secretOption "Fichier du jeton `x-mem0-token` de mem0-rs ; chemin absolu hors du store Nix.";

    embedder = {
      useOllama = mkOption {
        type = types.bool;
        default = true;
        description = "Active `services.ollama` (127.0.0.1) et y charge le modèle d'embeddings.";
      };
      baseUrl = mkOption {
        type = types.str;
        default = "http://127.0.0.1:11434/v1";
        description = "Base OpenAI-compatible des embeddings (`OMLX_BASE_URL`).";
      };
      model = mkOption {
        type = types.str;
        default = "bge-m3";
        description = "Modèle d'embeddings (`OMLX_EMBED_MODEL`).";
      };
      dims = mkOption {
        type = types.int;
        default = 1024;
        description = "Dimension des vecteurs (`EMBEDDING_DIMS`) : mem0-rs refuse une base d'une autre dimension.";
      };
      apiKeyFile = mkOption {
        type = types.nullOr types.str;
        default = null;
        description = "Fichier de la clé de l'embedder (`OMLX_API_TOKEN`), ou null ; chemin absolu hors du store Nix.";
      };
    };
    llmModel = mkOption {
      type = types.nullOr types.str;
      default = null;
      description = "Modèle d'extraction des souvenirs (`OMLX_LLM_MODEL`) ; null : non posé (les écritures `infer` échouent).";
    };

    git = {
      userName = mkOption {
        type = types.str;
        example = "OMP VPS";
        description = "`user.name` des commits faits par les maillons.";
      };
      userEmail = mkOption {
        type = types.str;
        example = "omp@example.org";
        description = "`user.email` des commits faits par les maillons.";
      };
    };
  };

  config = mkIf cfg.enable {
    assertions = [
      (secretAssertion "modelEnvironmentFile" cfg.modelEnvironmentFile)
      (secretAssertion "githubTokenFile" cfg.githubTokenFile)
      (secretAssertion "mem0TokenFile" cfg.mem0TokenFile)
      (secretAssertion "embedder.apiKeyFile" cfg.embedder.apiKeyFile)
      {
        assertion = isOutsideStore cfg.stateDir;
        message = "services.omp-orchestrator.stateDir doit être un chemin absolu hors du store Nix";
      }
      {
        assertion = isTailscaleAddress cfg.tailscaleAddress;
        message = "services.omp-orchestrator.tailscaleAddress doit être une adresse IPv4 de 100.64.0.0/10";
      }
    ];

    users.groups.${cfg.group} = { };
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.group;
      home = cfg.stateDir;
      createHome = false;
      # Un shell : `sudo -u omp -H omp` (un /login manuel) reste possible.
      shell = pkgs.bashInteractive;
    };

    systemd.tmpfiles.rules = [
      "d ${cfg.stateDir} 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/mem0 0700 ${cfg.user} ${cfg.group} -"
      "d ${cfg.stateDir}/repos 0700 ${cfg.user} ${cfg.group} -"
    ];

    services.ollama = mkIf useOllama {
      enable = true;
      host = "127.0.0.1";
      loadModels = [ cfg.embedder.model ];
    };

    # Les commits des maillons et `git clone https://github.com/…` (jeton GH_TOKEN du service).
    programs.git = {
      enable = true;
      config = {
        user = {
          name = cfg.git.userName;
          email = cfg.git.userEmail;
        };
        credential."https://github.com".helper = "!${pkgs.gh}/bin/gh auth git-credential";
      };
    };

    # Le protocole distant est le seul port ouvert, et sur `tailscale0` seule. mem0 et le
    # service de pipelines n'écoutent que sur 127.0.0.1.
    networking.firewall.interfaces."tailscale0".allowedTCPPorts = [ cfg.apiPort ];

    environment.systemPackages = [ cliPackage ];

    systemd.services.omp-mem0 = {
      description = "mem0-rs, mémoire de l'orchestrateur omp";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ] ++ lib.optional useOllama "ollama.service";
      wants = lib.optional useOllama "ollama.service";
      path = [ pkgs.coreutils ];
      environment = {
        MEM0_DB_PATH = "${cfg.stateDir}/mem0/mem0-rs.db";
        EMBEDDING_DIMS = toString cfg.embedder.dims;
        OMLX_BASE_URL = cfg.embedder.baseUrl;
        OMLX_EMBED_MODEL = cfg.embedder.model;
      }
      // lib.optionalAttrs (cfg.llmModel != null) {
        OMLX_LLM_MODEL = cfg.llmModel;
      };
      serviceConfig = restartPolicy // {
        User = cfg.user;
        Group = cfg.group;
        LoadCredential = [
          "mem0-token:${cfg.mem0TokenFile}"
        ]
        ++ lib.optional (cfg.embedder.apiKeyFile != null) "embedder-key:${cfg.embedder.apiKeyFile}";
        ExecStart = mem0Start;
        NoNewPrivileges = true;
      };
    };

    systemd.services.omp-pipeline = {
      description = "Service de pipelines omp et protocole distant";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network-online.target"
        "tailscaled.service"
        "omp-mem0.service"
      ];
      wants = [
        "network-online.target"
        "tailscaled.service"
        "omp-mem0.service"
      ];
      path = [
        cfg.ompPackage
        pkgs.git
        pkgs.gh
        pkgs.openssh
        pkgs.coreutils
        pkgs.findutils
        pkgs.gnugrep
        pkgs.gnused
        pkgs.bash
        pkgs.jq
        pkgs.curl
      ];
      environment = {
        HOME = cfg.stateDir;
        MEM0_PIPELINE_MACHINE = "vps";
        MEM0_PIPELINE_MACHINE_NAME = cfg.machineName;
        MEM0_REMOTE_API_HOST = cfg.tailscaleAddress;
        MEM0_REMOTE_API_PORT = toString cfg.apiPort;
        MEM0_SERVICE_PORT = toString cfg.servicePort;
        MEM0_HTTP_URL = "http://127.0.0.1:${toString cfg.mem0Port}";
        MEM0_PIPELINE_REPOS_DIR = "${cfg.stateDir}/repos";
      };
      serviceConfig = restartPolicy // {
        User = cfg.user;
        Group = cfg.group;
        WorkingDirectory = cfg.stateDir;
        EnvironmentFile = cfg.modelEnvironmentFile;
        LoadCredential = [
          "github-token:${cfg.githubTokenFile}"
          "mem0-token:${cfg.mem0TokenFile}"
        ];
        # Idempotent : `omp plugin link` remplace le lien à chaque démarrage, donc une
        # mise à jour du flake (nouveau chemin du store) est reprise sans geste de plus.
        ExecStartPre = [
          "${ompBin} plugin link ${pluginsDir}/omp-mem0-req"
          "${ompBin} plugin link ${pluginsDir}/omp-mem0-memory"
        ];
        ExecStart = pipelineStart;
        NoNewPrivileges = true;
      };
    };
  };
}
