# Preuve de AC-1 à AC-4 d'orchestrator-living-in-a-vps : un test NixOS à deux machines.
#
#   nix build .#checks.x86_64-linux.vps -L      (KVM requis)
#
# `vps` importe le module du flake. Il n'est pas joint à un vrai tailnet : une interface
# factice `tailscale0` porte 100.64.0.1/10. L'embedder est un faux serveur
# OpenAI-compatible (1024 composantes) et `embedder.useOllama = false`. Les secrets sont
# tirés AU DÉMARRAGE par une unité de test dans /run/secrets : leur contenu n'existe ni
# dans cette expression ni dans le store (sans cela, AC-2 serait faux par construction).
# `public` est sur le même réseau et tente de joindre `vps` par son adresse publique.
#
# Le script imprime une ligne `AC-<n> ok` par critère prouvé ; test/vps/orchestrator-living-in-a-vps.test.ts les lit.
{ self, pkgs }:
let
  system = pkgs.stdenv.hostPlatform.system;
  stateDir = "/var/lib/omp-orchestrator";
  tailscaleIp = "100.64.0.1";

  fakeEmbedder = pkgs.writeText "fake-embedder.py" ''
    import hashlib
    import json
    import math
    import re
    import sys
    from http.server import BaseHTTPRequestHandler, HTTPServer

    DIMS = 1024
    KEY_FILE = sys.argv[1]


    def embed(text):
        vector = [0.0] * DIMS
        tokens = [t for t in re.split(r"[\W_]+", text.lower()) if t]
        for token in tokens:
            vector[int.from_bytes(hashlib.sha256(token.encode()).digest()[:4], "big") % DIMS] += 1.0
        if not tokens:
            vector[0] = 1.0
        norm = math.sqrt(sum(c * c for c in vector))
        return [c / norm for c in vector]


    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def reply(self, status, body):
            raw = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_POST(self):
            with open(KEY_FILE) as handle:
                expected = "Bearer " + handle.read().strip()
            if self.headers.get("authorization") != expected:
                return self.reply(401, {"error": {"message": "clé refusée"}})
            body = json.loads(self.rfile.read(int(self.headers["content-length"])))
            inputs = body["input"]
            if isinstance(inputs, str):
                inputs = [inputs]
            data = [{"object": "embedding", "index": i, "embedding": embed(t)} for i, t in enumerate(inputs)]
            self.reply(200, {"object": "list", "data": data, "model": body.get("model", ""), "usage": {"prompt_tokens": 0, "total_tokens": 0}})


    HTTPServer(("127.0.0.1", 11434), Handler).serve_forever()
  '';

  # Les mêmes plugins, avec une autre version dans package.json : un autre chemin du store,
  # donc un autre lien `omp plugin link` et une autre définition d'unité (AC-3).
  pluginsUpdated = pkgs.runCommand "omp-mem0-plugins-update" { nativeBuildInputs = [ pkgs.jq ]; } ''
    cp -r ${self.packages.${system}.omp-mem0-plugins} "$out"
    chmod -R u+w "$out"
    jq '.version = "999.0.0"' "$out/omp-mem0-req/package.json" > "$TMPDIR/package.json"
    cp "$TMPDIR/package.json" "$out/omp-mem0-req/package.json"
  '';

  mem0Curl = pkgs.writeShellScriptBin "mem0-curl" ''
    token="$(cat /run/secrets/mem0-token)"
    exec curl -sf -H "x-mem0-token: $token" -H 'content-type: application/json' "$@"
  '';
in
pkgs.testers.runNixOSTest {
  name = "omp-orchestrator-vps";

  nodes.vps =
    { pkgs, ... }:
    {
      imports = [ self.nixosModules.default ];

      virtualisation.memorySize = 3072;
      virtualisation.cores = 2;
      boot.kernelModules = [ "dummy" ];
      environment.systemPackages = [
        pkgs.curl
        pkgs.jq
        pkgs.iproute2
        pkgs.gnugrep
        pkgs.gawk
        mem0Curl
      ];

      services.omp-orchestrator = {
        enable = true;
        tailscaleAddress = tailscaleIp;
        modelEnvironmentFile = "/run/secrets/model.env";
        githubTokenFile = "/run/secrets/github-token";
        mem0TokenFile = "/run/secrets/mem0-token";
        embedder.useOllama = false;
        embedder.apiKeyFile = "/run/secrets/embedder-key";
        git.userName = "OMP test";
        git.userEmail = "omp@example.org";
      };

      # Une interface `tailscale0` factice : tailscaled n'existe pas dans le test.
      systemd.services.fake-tailscale = {
        wantedBy = [ "multi-user.target" ];
        before = [ "omp-pipeline.service" ];
        path = [ pkgs.iproute2 ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          ip link add tailscale0 type dummy
          ip addr add ${tailscaleIp}/10 dev tailscale0
          ip link set tailscale0 up
        '';
      };

      # Les secrets du test : aléatoires, écrits dans /run/secrets avant les services.
      systemd.services.test-secrets = {
        wantedBy = [ "multi-user.target" ];
        before = [
          "omp-mem0.service"
          "omp-pipeline.service"
          "fake-embedder.service"
        ];
        path = [ pkgs.coreutils ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
        };
        script = ''
          umask 077
          mkdir -p /run/secrets
          rnd() { head -c 24 /dev/urandom | base64 | tr -d '=+/\n'; }
          echo "ANTHROPIC_API_KEY=sk-test-$(rnd)" > /run/secrets/model.env
          echo "OPENAI_API_KEY=sk-test-$(rnd)" >> /run/secrets/model.env
          echo "ghp_$(rnd)" > /run/secrets/github-token
          echo "mem0-$(rnd)" > /run/secrets/mem0-token
          echo "emb-$(rnd)" > /run/secrets/embedder-key
        '';
      };

      systemd.services.fake-embedder = {
        wantedBy = [ "multi-user.target" ];
        before = [ "omp-mem0.service" ];
        after = [ "test-secrets.service" ];
        requires = [ "test-secrets.service" ];
        serviceConfig = {
          ExecStart = "${pkgs.python3}/bin/python3 ${fakeEmbedder} /run/secrets/embedder-key";
          Restart = "always";
        };
      };

      systemd.services.omp-mem0 = {
        after = [ "test-secrets.service" ];
        requires = [ "test-secrets.service" ];
      };
      systemd.services.omp-pipeline = {
        after = [
          "test-secrets.service"
          "fake-tailscale.service"
        ];
        requires = [
          "test-secrets.service"
          "fake-tailscale.service"
        ];
      };

      specialisation.update.configuration = {
        services.omp-orchestrator.pluginsPackage = pluginsUpdated;
      };
    };

  nodes.public =
    { pkgs, ... }:
    {
      environment.systemPackages = [ pkgs.curl ];
    };

  testScript = ''
    import shlex

    STATE = "${stateDir}"
    PIPELINE = STATE + "/.omp/agent/pipeline"
    PLUGIN_LINK = STATE + "/.omp/plugins/node_modules/omp-mem0-req"
    SECRET_FILES = [
        "/run/secrets/model.env",
        "/run/secrets/github-token",
        "/run/secrets/mem0-token",
        "/run/secrets/embedder-key",
    ]


    def wait_until_up():
        vps.wait_for_unit("omp-mem0.service")
        vps.wait_for_unit("omp-pipeline.service")
        vps.wait_until_succeeds("curl -sf http://127.0.0.1:8321/health", timeout=300)
        # Le protocole distant : 401 (pas d'appairage) prouve que l'écouteur répond.
        vps.wait_until_succeeds(
            "test \"$(curl -s -o /dev/null -w '%{http_code}' -H 'X-Console-Protocol-Version: 3' "
            "http://${tailscaleIp}:8787/v1/store)\" = 401",
            timeout=600,
        )


    start_all()
    public.wait_for_unit("multi-user.target")
    wait_until_up()

    # --- AC-1 : unités actives, et de nouveau actives après un redémarrage du VPS ---
    vps.succeed("systemctl is-active omp-mem0.service omp-pipeline.service")
    vps.shutdown()
    vps.start()
    wait_until_up()
    vps.succeed("systemctl is-active omp-mem0.service omp-pipeline.service")
    print("AC-1 ok")

    # --- AC-4 : rien d'accessible depuis l'adresse publique ---
    public_ip = vps.succeed("ip -4 -o addr show dev eth1 | awk '{print $4}' | cut -d/ -f1").strip()
    assert public_ip and not public_ip.startswith("100."), "adresse publique introuvable : " + public_ip
    for port in (8787, 8788, 8321):
        public.fail("curl -s --max-time 5 -o /dev/null http://%s:%d/" % (public_ip, port))
    listeners = {}
    for row in vps.succeed("ss -H -ltn").splitlines():
        local = row.split()[3]
        host, _, port = local.rpartition(":")
        listeners.setdefault(port, set()).add(host)
    assert listeners.get("8787") == {"${tailscaleIp}"}, listeners
    assert listeners.get("8788") == {"127.0.0.1"}, listeners
    assert listeners.get("8321") == {"127.0.0.1"}, listeners
    print("AC-4 ok")

    # --- AC-2 : aucun contenu de secret dans le store ---
    patterns = []
    for path in SECRET_FILES:
        for line in vps.succeed("cat " + path).splitlines():
            line = line.strip()
            if line:
                patterns.append(line)
                if "=" in line:
                    patterns.append(line.split("=", 1)[1])
    assert len(patterns) >= 7, patterns
    vps.succeed("printf '%s\\n' " + " ".join(shlex.quote(p) for p in patterns) + " > /run/secret-patterns")
    # Code 1 = aucune occurrence ; 0 = trouvé ; 2 = erreur de lecture (échec aussi : pas de faux vert).
    vps.succeed("grep -rlaFs -f /run/secret-patterns /nix/store; test $? -eq 1")
    print("AC-2 ok")

    # --- AC-3 : mise à jour des plugins sans toucher à l'état ---
    souvenir = "souvenir de l'AC-3 écrit avant la mise à jour du flake"
    vps.succeed(
        "mem0-curl -X POST --data-binary @- http://127.0.0.1:8321/memory/add <<'EOF'\n"
        + '{"text": "%s", "agent_id": "vps-test", "infer": false}\n' % souvenir
        + "EOF"
    )
    vps.succeed("mkdir -p %s/lots" % PIPELINE)
    vps.succeed("echo '{\"factice\": true}' > %s/lots/factice.json && chown omp:omp %s/lots/factice.json" % (PIPELINE, PIPELINE))
    lot_before = vps.succeed("sha256sum %s/lots/factice.json" % PIPELINE)
    link_before = vps.succeed("readlink -f " + PLUGIN_LINK).strip()
    pid_before = vps.succeed("systemctl show -p MainPID --value omp-pipeline.service").strip()

    vps.succeed("/run/current-system/specialisation/update/bin/switch-to-configuration test")
    vps.wait_until_succeeds(
        "test \"$(readlink -f %s)\" != %s" % (PLUGIN_LINK, shlex.quote(link_before)), timeout=300
    )
    wait_until_up()
    link_after = vps.succeed("readlink -f " + PLUGIN_LINK).strip()
    pid_after = vps.succeed("systemctl show -p MainPID --value omp-pipeline.service").strip()
    assert link_after != link_before, (link_before, link_after)
    assert pid_after not in ("", "0", pid_before), (pid_before, pid_after)
    assert lot_before == vps.succeed("sha256sum %s/lots/factice.json" % PIPELINE)
    found = vps.succeed(
        "mem0-curl -X POST --data-binary @- http://127.0.0.1:8321/memory/search <<'EOF'\n"
        + '{"query": "%s", "agent_id": "vps-test"}\n' % souvenir
        + "EOF"
    )
    assert souvenir in found, found
    print("AC-3 ok")
  '';
}
