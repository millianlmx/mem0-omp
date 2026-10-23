// Feature harness-portainer : le serveur de pipelines déployé sans terminal — l'URL
// du dépôt dans Portainer (ou `docker compose up -d` à la racine), et la pile se
// monte seule. `setup` rejoue ce que `harness.sh up` fait en interactif, `repos`
// déclare les dépôts et réessaie tant que la clé de déploiement manque, `pairing`
// écrit le code d'appairage dans ses journaux. Les scripts tournent ici pour de vrai,
// sur des dossiers jetables ; seuls node (--add-repo) et tailscale sont doublés.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../omp-harness/config.ts";
import { decodePairing } from "../../omp-mem0-req/harness.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const BOX = path.join(ROOT, "omp-harness", "deploy", "container");
const SETUP = path.join(BOX, "stack-setup");
const PAIRING = path.join(BOX, "stack-pairing");
const TEMPLATE = path.join(BOX, "config.container.json");
const compose = fs.readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");

/** Le bloc d'un service du compose racine, de sa ligne `  <nom>:` à la suivante. */
function service(name: string): string {
  const lines = compose.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `service ${name} absent de docker-compose.yml`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}\S/.test(line) || /^\S/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

type Run = { status: number | null; stdout: string; stderr: string };

function run(script: string, args: string[], env: Record<string, string>): Run {
  const result = spawnSync("sh", [script, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Une racine et des secrets jetables, comme les chemins d'hôte de la pile, et une
 * doublure de ssh-keygen (l'image a le vrai) : une clé neuve à chaque appel.
 */
function stack() {
  const dir = tmpdir("harness-portainer-");
  const root = path.join(dir, "root");
  const secrets = path.join(dir, "secrets");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "ssh-keygen"),
    `#!/bin/sh
while [ $# -gt 1 ]; do [ "$1" = -f ] && file="$2"; shift; done
echo "PRIVATE" > "$file"
echo "ssh-ed25519 AAAA$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n') omp-harness" > "$file.pub"
`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    OMP_HARNESS_ROOT: root,
    OMP_HARNESS_SECRETS: secrets,
    OMP_HARNESS_TEMPLATE: TEMPLATE,
  };
  return { dir, root, secrets, env };
}

const read = (file: string) => fs.readFileSync(file, "utf8");
const mode = (file: string) => fs.statSync(file).mode & 0o777;

test("harness-portainer/AC-1 : la pile racine se monte seule — chaque image se construit ou se tire, rien n'est lu avant `setup`, les clés LLM restent hors du service", () => {
  // Les images locales que le service lance ou que la pile démarre déclarent leur build.
  for (const [name, image] of [
    ["harness", "omp-harness:local"],
    ["setup", "omp-harness:local"],
    ["repos", "omp-harness:local"],
    ["runner-image", "omp-harness-runner:local"],
    ["mem0", "mem0-rs:local"],
    ["tailscale", "omp-harness-tailscale:local"],
    ["pairing", "omp-harness-tailscale:local"],
  ]) {
    const block = service(name);
    const anchor = /<<: \*(\S+)/.exec(block)?.[1];
    const source = anchor ? compose.slice(compose.indexOf(`&${anchor}`)).split("\n\n")[0] : block;
    assert.match(source, /build:/, `${name} : aucun build`);
    assert.ok(source.includes(`image: ${image}`), `${name} : image ${image} attendue`);
  }
  // L'image des runners est celle que nomme la configuration du conteneur.
  assert.equal(JSON.parse(read(TEMPLATE)).container.runnerImage, "omp-harness-runner:local");
  assert.match(service("test-image"), new RegExp(`image: ${JSON.parse(read(TEMPLATE)).container.testImage}`));

  // Rien n'est lu à l'analyse du compose : les secrets n'existent qu'après `setup`.
  assert.doesNotMatch(compose, /env_file:/);
  for (const name of ["harness", "mem0"])
    assert.match(service(name), /setup: \{ condition: service_completed_successfully \}/, `${name} n'attend pas setup`);

  // La racine au même chemin (les frères montent un worktree par son chemin d'hôte), le socket, le réseau.
  const rootMount = "- ${OMP_HARNESS_ROOT:-/var/lib/omp-harness}:${OMP_HARNESS_ROOT:-/var/lib/omp-harness}\n";
  assert.ok(service("harness").includes(rootMount.trim()), "la racine au même chemin");
  assert.match(service("harness"), /:\/var\/run\/docker\.sock/);
  assert.match(compose, /networks:\n {2}default:\n(.*\n)*? {4}name: omp-harness\n/);
  assert.equal(JSON.parse(read(TEMPLATE)).container.network, "omp-harness");

  // Les clés LLM n'entrent que dans `setup`, qui les écrit pour les runners.
  for (const name of ["harness", "repos", "mem0", "tailscale", "pairing"]) {
    assert.doesNotMatch(service(name), /API_KEY|runner\.env/, `${name} voit les clés LLM`);
  }
  assert.match(service("setup"), /ANTHROPIC_API_KEY: \$\{ANTHROPIC_API_KEY:-\}/);
  // Le service ne reçoit que le dossier de son jeton, la mémoire que le sien.
  assert.match(service("harness"), /\/harness:\/run\/secrets\/omp-harness:ro/);
  assert.match(service("mem0"), /\/mem0:\/run\/secrets\/mem0:ro/);

  // Aucun port public : la boucle locale, et le tailnet par le conteneur Tailscale.
  const published = [...compose.matchAll(/^ {4}ports:\n((?: {6}(?:#.*|- .*)\n)+)/gm)].flatMap((m) =>
    m[1].split("\n").filter((line) => line.trim().startsWith("- ")),
  );
  assert.equal(published.length, 2, "le harness et la mémoire, et eux seuls");
  for (const line of published)
    assert.match(line, /- "127\.0\.0\.1:/, `port hors de la boucle locale : ${line.trim()}`);
});

test("harness-portainer/AC-2 : `setup` crée tout au premier démarrage, puis ne garde que ce qui doit l'être — jeton, clé SSH, config.json", () => {
  const { root, secrets, env } = stack();
  const first = run(SETUP, ["init"], { ...env, ANTHROPIC_API_KEY: "sk-ant-test_1" });
  assert.equal(first.status, 0, first.stderr);

  const token = /^MEM0_HTTP_TOKEN=([0-9a-f]{64})$/m.exec(read(path.join(secrets, "mem0", "mem0.env")))?.[1];
  assert.ok(token, "jeton de la mémoire absent");
  assert.equal(
    read(path.join(secrets, "harness", "harness.env")),
    `MEM0_HTTP_TOKEN=${token}\n`,
    "le service n'a que le jeton",
  );
  assert.equal(read(path.join(secrets, "runner.env")), `MEM0_HTTP_TOKEN=${token}\nANTHROPIC_API_KEY=sk-ant-test_1\n`);
  assert.match(read(path.join(secrets, "mem0", "mem0.env")), /^OMLX_BASE_URL=http:\/\/embeddings:11434\/v1$/m);
  for (const file of ["runner.env", "harness/harness.env", "mem0/mem0.env"])
    assert.equal(mode(path.join(secrets, file)), 0o600, `${file} lisible par d'autres`);
  for (const dir of [root, secrets, path.join(root, "home", ".ssh")]) assert.equal(mode(dir), 0o700, dir);

  // La configuration est valide en isolation container, avec les chemins de la pile.
  const config = loadConfig(path.join(root, "config.json"));
  assert.equal(config.runner.isolation, "container");
  assert.equal(config.container.runnerEnvFile, path.join(secrets, "runner.env"));
  assert.equal(config.dataDir, path.join(root, "state"));
  assert.equal(config.oracle?.url, "http://mem0:8321");
  const key = read(path.join(root, "home", ".ssh", "id_ed25519.pub"));
  assert.ok(first.stdout.includes(key.trim()), "la clé de déploiement s'affiche dans les journaux");

  // Redéploiement : la clé du modèle et le serveur d'embeddings suivent les variables ;
  // le jeton, la clé SSH et une config.json éditée restent.
  fs.appendFileSync(path.join(root, "config.json"), "\n");
  const edited = read(path.join(root, "config.json"));
  const again = run(SETUP, ["init"], {
    ...env,
    OPENROUTER_API_KEY: "sk-or-2",
    OMLX_BASE_URL: "http://10.0.0.2:8000/v1",
  });
  assert.equal(again.status, 0, again.stderr);
  assert.equal(read(path.join(secrets, "runner.env")), `MEM0_HTTP_TOKEN=${token}\nOPENROUTER_API_KEY=sk-or-2\n`);
  assert.match(read(path.join(secrets, "mem0", "mem0.env")), new RegExp(`^MEM0_HTTP_TOKEN=${token}$`, "m"));
  assert.match(read(path.join(secrets, "mem0", "mem0.env")), /^OMLX_BASE_URL=http:\/\/10\.0\.0\.2:8000\/v1$/m);
  assert.equal(read(path.join(root, "home", ".ssh", "id_ed25519.pub")), key);
  assert.equal(read(path.join(root, "config.json")), edited);

  const keyless = run(SETUP, ["init"], env);
  assert.equal(keyless.status, 0, keyless.stderr);
  assert.match(keyless.stdout, /Aucune clé de modèle : pose ANTHROPIC_API_KEY/);
});

test("harness-portainer/AC-3 : une variable qui porterait du shell dans un .env sourcé est refusée, et rien n'est écrit", () => {
  const { secrets, env } = stack();
  for (const value of ["a b", "x$(id)", 'k"ey', "k;ey"]) {
    const refused = run(SETUP, ["init"], { ...env, ANTHROPIC_API_KEY: value });
    assert.notEqual(refused.status, 0, `« ${value} » accepté`);
    assert.match(refused.stderr, /ANTHROPIC_API_KEY porte un caractère refusé/);
  }
  assert.equal(fs.existsSync(path.join(secrets, "runner.env")), false);
});

test("harness-portainer/AC-4 : `repos` déclare chaque dépôt, guide la clé de déploiement et réessaie jusqu'à ce qu'elle soit posée", () => {
  const { dir, root, env } = stack();
  assert.equal(run(SETUP, ["init"], env).status, 0);

  // Doublure de `main.ts --add-repo` : écriture refusée (4) au premier essai, puis acceptée.
  const calls = path.join(dir, "calls");
  const main = path.join(dir, "fake-main.mjs");
  fs.writeFileSync(
    main,
    `import fs from "node:fs";
const url = process.argv[process.argv.indexOf("--add-repo") + 1];
fs.appendFileSync(${JSON.stringify(calls)}, url + "\\n");
const seen = fs.readFileSync(${JSON.stringify(calls)}, "utf8").split("\\n").filter((l) => l === url).length;
process.exit(url.includes("verrou") && seen === 1 ? 4 : 0);
`,
  );
  const repos = run(SETUP, ["repos"], {
    ...env,
    OMP_HARNESS_MAIN: main,
    OMP_HARNESS_REPOS_RETRY: "0",
    OMP_HARNESS_REPOS: "https://github.com/toi/verrou, git@github.com:toi/libre.git",
  });
  assert.equal(repos.status, 0, repos.stderr);
  assert.deepEqual(read(calls).trim().split("\n"), [
    "git@github.com:toi/verrou.git",
    "git@github.com:toi/libre.git",
    "git@github.com:toi/verrou.git",
  ]);
  assert.ok(repos.stdout.includes("https://github.com/toi/verrou/settings/keys/new"), repos.stdout);
  assert.ok(repos.stdout.includes(read(path.join(root, "home", ".ssh", "id_ed25519.pub")).trim()));
  assert.match(repos.stdout, /✓ dépôts déclarés/);

  const none = run(SETUP, ["repos"], { ...env, OMP_HARNESS_MAIN: main });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /Aucun dépôt dans OMP_HARNESS_REPOS/);
});

test("harness-portainer/AC-5 : `pairing` attend Tailscale, montre le lien de connexion, puis écrit le code que /pair et l'app lisent", () => {
  const dir = tmpdir("harness-portainer-pair-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  // Doublure de `tailscale status --json` : non connecté au premier appel, connecté ensuite.
  fs.writeFileSync(
    path.join(bin, "tailscale"),
    `#!/bin/sh
n=$(cat "${dir}/n" 2>/dev/null || echo 0); echo $((n + 1)) > "${dir}/n"
if [ "$n" = 0 ]; then
  printf '{\\n  "BackendState": "NeedsLogin",\\n  "AuthURL": "https://login.tailscale.com/a/abc123",\\n  "Self": {\\n    "DNSName": ""\\n  }\\n}\\n'
else
  printf '{\\n  "BackendState": "Running",\\n  "Self": {\\n    "DNSName": "omp-harness.tail1234.ts.net."\\n  },\\n  "Peer": {\\n    "x": { "DNSName": "mac.tail1234.ts.net." }\\n  }\\n}\\n'
fi
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, "token"), "harness-token\n");
  fs.writeFileSync(
    path.join(dir, "mem0.env"),
    "MEM0_HTTP_TOKEN=mem0-token\nOMLX_BASE_URL=http://embeddings:11434/v1\n",
  );
  const pairing = run(PAIRING, [], {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    OMP_HARNESS_TOKEN_FILE: path.join(dir, "token"),
    OMP_HARNESS_MEM0_ENV: path.join(dir, "mem0.env"),
    OMP_HARNESS_PAIRING_POLL: "0",
  });
  assert.equal(pairing.status, 0, pairing.stderr);
  assert.match(pairing.stdout, /https:\/\/login\.tailscale\.com\/a\/abc123/);
  const code = /omp1:\S+/.exec(pairing.stdout)?.[0];
  assert.ok(code, pairing.stdout);
  assert.deepEqual(decodePairing(code), {
    url: "https://omp-harness.tail1234.ts.net",
    token: "harness-token",
    mem0Url: "https://omp-harness.tail1234.ts.net:8443",
    mem0Token: "mem0-token",
  });
});

test("harness-portainer/AC-6 : Tailscale publie le harness sur 443 et la mémoire sur 8443 ; le service lit son jeton dans le fichier monté", () => {
  const serve = JSON.parse(read(path.join(BOX, "tailscale-serve.json")));
  assert.deepEqual(Object.keys(serve.TCP).sort(), ["443", "8443"]);
  assert.equal(serve.Web["${TS_CERT_DOMAIN}:443"].Handlers["/"].Proxy, "http://harness:8790");
  assert.equal(serve.Web["${TS_CERT_DOMAIN}:8443"].Handlers["/"].Proxy, "http://mem0:8321");
  const dockerfile = read(path.join(BOX, "Dockerfile.tailscale"));
  assert.match(dockerfile, /tailscale\/tailscale:v\d+\.\d+\.\d+/, "Tailscale épinglé");
  for (const env of ["TS_SERVE_CONFIG=", "TS_AUTH_ONCE=true", "TS_STATE_DIR=/var/lib/tailscale"])
    assert.ok(dockerfile.includes(env), `${env} absent`);
  assert.match(
    read(path.join(BOX, "Dockerfile.harness")),
    /COPY omp-harness\/deploy\/container\/stack-setup \/usr\/local\/bin\/omp-harness-stack/,
  );

  const dir = tmpdir("harness-portainer-entry-");
  fs.writeFileSync(path.join(dir, "harness.env"), "MEM0_HTTP_TOKEN=depuis-le-fichier\n");
  const entry = spawnSync("sh", [path.join(BOX, "harness-entrypoint"), "sh", "-c", 'printf %s "$MEM0_HTTP_TOKEN"'], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, OMP_HARNESS_ENV_FILE: path.join(dir, "harness.env") },
  });
  assert.equal(entry.status, 0, entry.stderr);
  assert.equal(entry.stdout, "depuis-le-fichier");
});
