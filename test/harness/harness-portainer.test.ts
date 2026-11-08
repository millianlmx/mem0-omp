// Feature harness-portainer : le serveur de pipelines déployé sans terminal — l'URL
// du dépôt dans Portainer (ou `docker compose up -d` à la racine), et la pile se
// monte seule. `setup` rejoue ce que `harness.sh up` fait en interactif, `repos`
// déclare les dépôts et réessaie tant que la clé de déploiement manque, `pairing`
// publie la pile par le Tailscale de l'hôte (son socket monté, aucun démon dans la
// pile) et écrit le code d'appairage dans ses journaux. Les scripts tournent ici pour
// de vrai, sur des dossiers jetables ; seuls node (--add-repo), ssh-keygen et la CLI
// tailscale sont doublés.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { loadConfig } from "../../omp-harness/config.ts";
import { APPROVER_CODE_REFUSAL, decodePairing } from "../../omp-mem0-req/harness.ts";
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
    ["pairing", "omp-harness-pairing:local"],
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
  for (const name of ["harness", "repos", "mem0", "pairing"]) {
    assert.doesNotMatch(service(name), /API_KEY|runner\.env/, `${name} voit les clés LLM`);
  }
  assert.match(service("setup"), /ANTHROPIC_API_KEY: \$\{ANTHROPIC_API_KEY:-\}/);
  // Le service ne reçoit que le dossier de son jeton, la mémoire que le sien.
  assert.match(service("harness"), /\/harness:\/run\/secrets\/omp-harness:ro/);
  assert.match(service("mem0"), /\/mem0:\/run\/secrets\/mem0:ro/);

  // Aucun port public : la boucle locale, que le Tailscale de l'hôte ouvre au tailnet.
  const published = [...compose.matchAll(/^ {4}ports:\n((?: {6}(?:#.*|- .*)\n)+)/gm)].flatMap((m) =>
    m[1].split("\n").filter((line) => line.trim().startsWith("- ")),
  );
  // Grafana n'existe que dans le profil `monitoring`, coupé par défaut.
  assert.equal(
    published.filter((line) => !line.includes("OMP_HARNESS_GRAFANA_PORT")).length,
    2,
    "le harness et la mémoire, et eux seuls",
  );
  assert.match(service("grafana"), /profiles: \["monitoring"\]/);
  assert.match(service("prometheus"), /profiles: \["monitoring"\]/);
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
  // L'Ollama intégré ne sert que les embeddings : le chat de la mémoire est coupé.
  assert.match(read(path.join(secrets, "mem0", "mem0.env")), /^OMLX_CHAT_BASE_URL=off$/m);
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
  // Un serveur à soi : le chat le suit (aucune ligne, mem0-rs reprend OMLX_BASE_URL).
  assert.doesNotMatch(read(path.join(secrets, "mem0", "mem0.env")), /^OMLX_CHAT_/m);
  const chat = run(SETUP, ["init"], {
    ...env,
    OMLX_CHAT_BASE_URL: "http://10.0.0.3:8000/v1",
    OMLX_CHAT_API_TOKEN: "cle-chat",
  });
  assert.equal(chat.status, 0, chat.stderr);
  const withChat = read(path.join(secrets, "mem0", "mem0.env"));
  assert.match(withChat, /^OMLX_BASE_URL=http:\/\/embeddings:11434\/v1$/m);
  assert.match(withChat, /^OMLX_CHAT_BASE_URL=http:\/\/10\.0\.0\.3:8000\/v1$/m);
  assert.match(withChat, /^OMLX_CHAT_API_TOKEN=cle-chat$/m);
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

  // Doublure de `main.ts --add-repo` : crée la clé du dépôt, écriture refusée (4) au premier essai, puis acceptée.
  const calls = path.join(dir, "calls");
  const main = path.join(dir, "fake-main.mjs");
  const keys = path.join(root, "home", ".ssh", "repos");
  fs.writeFileSync(
    main,
    `import fs from "node:fs";
const url = process.argv[process.argv.indexOf("--add-repo") + 1];
const name = url.split(/[/:]/).pop().replace(/\\.git$/, "");
fs.mkdirSync(${JSON.stringify(keys)}, { recursive: true });
fs.writeFileSync(${JSON.stringify(keys)} + "/" + name + ".pub", "ssh-ed25519 AAAA omp-harness:" + name + "\\n");
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
  assert.ok(repos.stdout.includes("ssh-ed25519 AAAA omp-harness:verrou"), "la clé du dépôt, pas celle du service");
  assert.match(repos.stdout, /✓ dépôts déclarés/);

  const none = run(SETUP, ["repos"], { ...env, OMP_HARNESS_MAIN: main });
  assert.equal(none.status, 0);
  assert.match(none.stdout, /Aucun dépôt dans OMP_HARNESS_REPOS/);
});

/**
 * Un socket et une doublure de la CLI tailscale : `status --json` rend tour à tour
 * les états de `states` (le dernier reste), `serve` est journalisé, écrit une ligne sur
 * sa sortie et rend `serveCode`.
 */
async function fakeTailscale(states: string[], serveCode = 0) {
  const dir = tmpdir("harness-portainer-pair-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const socket = path.join(dir, "tailscaled.sock");
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  for (const [i, state] of states.entries()) fs.writeFileSync(path.join(dir, `state${i}`), state);
  fs.writeFileSync(
    path.join(bin, "tailscale"),
    `#!/bin/sh
[ "$1" = "--socket=${socket}" ] || { echo "socket attendu" >&2; exit 2; }
shift
if [ "$1" = serve ]; then echo "$*" >> "${dir}/serve.log"; echo "sortie de serve : $*"; exit ${serveCode}; fi
n=$(cat "${dir}/n" 2>/dev/null || echo 0)
[ "$n" -ge ${states.length - 1} ] || echo $((n + 1)) > "${dir}/n"
cat "${dir}/state$n"
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, "token"), "harness-token\n");
  fs.writeFileSync(
    path.join(dir, "mem0.env"),
    "MEM0_HTTP_TOKEN=mem0-token\nOMLX_BASE_URL=http://embeddings:11434/v1\n",
  );
  const env = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    TS_SOCKET: socket,
    OMP_HARNESS_TOKEN_FILE: path.join(dir, "token"),
    OMP_HARNESS_MEM0_ENV: path.join(dir, "mem0.env"),
    OMP_HARNESS_PUBLISHED: path.join(dir, "published.env"),
    OMP_HARNESS_PAIRING_POLL: "0",
    OMP_HARNESS_PORT: "8790",
    OMP_HARNESS_MEM0_PORT: "8321",
  };
  const serveLog = () => (fs.existsSync(path.join(dir, "serve.log")) ? read(path.join(dir, "serve.log")) : "");
  return { dir, env, serveLog, close: () => server.close() };
}

const LOGGED_OUT = `{
  "BackendState": "NeedsLogin",
  "Self": {
    "DNSName": ""
  }
}`;
const RUNNING = `{
  "BackendState": "Running",
  "Self": {
    "DNSName": "vps.tail1234.ts.net."
  },
  "Peer": {
    "x": { "DNSName": "mac.tail1234.ts.net." }
  }
}`;

test("harness-portainer/AC-5 : `pairing` attend le Tailscale de l'hôte, publie le harness sur 443 et la mémoire sur 8443, puis écrit le code que /pair et l'app lisent", async () => {
  const ts = await fakeTailscale([LOGGED_OUT, RUNNING]);
  try {
    const pairing = run(PAIRING, [], ts.env);
    assert.equal(pairing.status, 0, pairing.stderr);
    assert.match(pairing.stdout, /Le Tailscale de l'hôte n'est pas connecté : « tailscale up »/);
    assert.equal(
      ts.serveLog(),
      "serve --bg --https=443 http://127.0.0.1:8790\nserve --bg --https=8443 http://127.0.0.1:8321\n",
      "le harness et la mémoire, par les ports de la boucle locale de l'hôte",
    );
    const code = /omp1:[A-Za-z0-9_-]+/.exec(pairing.stdout)?.[0];
    assert.ok(code, pairing.stdout);
    assert.deepEqual(decodePairing(code), {
      url: "https://vps.tail1234.ts.net",
      token: "harness-token",
      mem0Url: "https://vps.tail1234.ts.net:8443",
      mem0Token: "mem0-token",
    });
    assert.equal(
      read(ts.env.OMP_HARNESS_PUBLISHED),
      "URL=https://vps.tail1234.ts.net\nMEM0_URL=https://vps.tail1234.ts.net:8443\n",
      "les adresses du code, pour `omp-harness-stack approver`",
    );

    // OMP_HARNESS_TAILSCALE_SERVE=0 : le `tailscale serve` de l'hôte n'est pas touché.
    fs.rmSync(path.join(ts.dir, "serve.log"));
    const untouched = run(PAIRING, [], { ...ts.env, OMP_HARNESS_TAILSCALE_SERVE: "0" });
    assert.equal(untouched.status, 0, untouched.stderr);
    assert.equal(ts.serveLog(), "");
    assert.match(untouched.stdout, /omp1:/);
  } finally {
    ts.close();
  }
});

test("harness-portainer/AC-6 : sans Tailscale sur l'hôte, `pairing` le dit et attend ; un `serve` refusé échoue en nommant HTTPS", async () => {
  // Socket absent : le message, puis l'attente (le service ne sort pas).
  const dir = tmpdir("harness-portainer-nots-");
  const child = spawn("sh", [PAIRING], {
    env: { PATH: process.env.PATH, TS_SOCKET: path.join(dir, "absent.sock"), OMP_HARNESS_PAIRING_POLL: "0.1" },
  });
  let out = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(child.exitCode, null, "le service attend Tailscale");
  child.kill();
  await exited;
  assert.match(out, /Pas de Tailscale sur l'hôte \(.*absent\.sock absent\)/);
  assert.equal(out.split("\n").filter(Boolean).length, 1, "le message n'est pas répété");

  const ts = await fakeTailscale([RUNNING], 1);
  try {
    const refused = run(PAIRING, [], ts.env);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /active HTTPS et MagicDNS/);
    assert.doesNotMatch(refused.stdout, /omp1:/);
  } finally {
    ts.close();
  }
});

/**
 * Lance `harness-entrypoint` avec le fichier secret de `dir`. Un `getent` doublé connaît
 * l'uid : sans lui (macOS n'en a pas), le script ajouterait une ligne à /etc/passwd,
 * ce qui sur un poste de développement échoue ou bloque, au lieu d'éprouver la lecture
 * du fichier secret que ces critères prouvent.
 */
function entrypoint(dir: string, command: string) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "getent"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return spawnSync("sh", [path.join(BOX, "harness-entrypoint"), "sh", "-c", command], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      HOME: dir,
      OMP_HARNESS_ENV_FILE: path.join(dir, "harness.env"),
    },
  });
}

test("harness-portainer/AC-7 : aucun démon Tailscale dans la pile — `pairing` n'a que la CLI et le dossier du socket de l'hôte ; le service lit son jeton dans le fichier monté", () => {
  assert.doesNotMatch(compose, /TS_AUTHKEY|TS_STATE_DIR|^ {2}tailscale:/m);
  assert.equal(fs.existsSync(path.join(BOX, "Dockerfile.tailscale")), false);
  const dockerfile = read(path.join(BOX, "Dockerfile.pairing"));
  assert.match(dockerfile, /tailscale\/tailscale:v\d+\.\d+\.\d+/, "la CLI Tailscale épinglée");
  assert.match(dockerfile, /CMD \["\/usr\/local\/bin\/omp-harness-pairing"\]/, "le script, jamais tailscaled");
  // Le dossier du socket, pas le socket : un fichier absent deviendrait un dossier sur l'hôte.
  assert.match(service("pairing"), /- \$\{OMP_HARNESS_TAILSCALE_RUN:-\/var\/run\/tailscale\}:\/var\/run\/tailscale\n/);
  for (const variable of [
    "OMP_HARNESS_PORT",
    "OMP_HARNESS_MEM0_PORT",
    "OMP_HARNESS_TAILNET_PORT",
    "OMP_HARNESS_TAILNET_MEM0_PORT",
  ])
    assert.ok(service("pairing").includes(`${variable}: \${${variable}:-`), `${variable} absent de pairing`);
  assert.match(
    read(path.join(BOX, "Dockerfile.harness")),
    /COPY omp-harness\/deploy\/container\/stack-setup \/usr\/local\/bin\/omp-harness-stack/,
  );

  const dir = tmpdir("harness-portainer-entry-");
  fs.writeFileSync(path.join(dir, "harness.env"), "MEM0_HTTP_TOKEN=depuis-le-fichier\n");
  const entry = entrypoint(dir, 'printf %s "$MEM0_HTTP_TOKEN"');
  assert.equal(entry.status, 0, entry.stderr);
  assert.equal(entry.stdout, "depuis-le-fichier");
});

test("harness-portainer/AC-8 : les ports du tailnet se choisissent — `pairing` y publie le harness et la mémoire, le code les porte, la sortie de `serve` reste dans les journaux", async () => {
  const ts = await fakeTailscale([RUNNING]);
  try {
    const env = { ...ts.env, OMP_HARNESS_TAILNET_PORT: "444", OMP_HARNESS_TAILNET_MEM0_PORT: "8444" };
    const pairing = run(PAIRING, [], env);
    assert.equal(pairing.status, 0, pairing.stderr);
    assert.equal(
      ts.serveLog(),
      "serve --bg --https=444 http://127.0.0.1:8790\nserve --bg --https=8444 http://127.0.0.1:8321\n",
    );
    // Le lien d'activation HTTPS que `serve` écrit sur sa sortie n'est pas avalé.
    assert.match(pairing.stdout, /sortie de serve : serve --bg --https=444 /);
    const code = /omp1:[A-Za-z0-9_-]+/.exec(pairing.stdout)?.[0];
    assert.ok(code, pairing.stdout);
    assert.deepEqual(decodePairing(code), {
      url: "https://vps.tail1234.ts.net:444",
      token: "harness-token",
      mem0Url: "https://vps.tail1234.ts.net:8444",
      mem0Token: "mem0-token",
    });

    // OMP_HARNESS_TAILSCALE_SERVE=0 : rien n'est publié, mais le code garde les ports choisis.
    fs.rmSync(path.join(ts.dir, "serve.log"));
    const untouched = run(PAIRING, [], { ...env, OMP_HARNESS_TAILSCALE_SERVE: "0" });
    assert.equal(untouched.status, 0, untouched.stderr);
    assert.equal(ts.serveLog(), "");
    const kept = /omp1:[A-Za-z0-9_-]+/.exec(untouched.stdout)?.[0];
    assert.deepEqual(decodePairing(kept ?? ""), {
      url: "https://vps.tail1234.ts.net:444",
      token: "harness-token",
      mem0Url: "https://vps.tail1234.ts.net:8444",
      mem0Token: "mem0-token",
    });
  } finally {
    ts.close();
  }
});

test("harness-portainer/AC-31 : `GH_TOKEN: ${GH_TOKEN:-}` n'est référencé que par `setup` : le jeton n'entre pas dans l'environnement du conteneur harness", () => {
  assert.match(service("setup"), /^ {6}GH_TOKEN: \$\{GH_TOKEN:-\}$/m);
  const references = compose
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#") && line.includes("GH_TOKEN"));
  assert.deepEqual(references, ["      GH_TOKEN: ${GH_TOKEN:-}"], "une seule référence, celle de `setup`");
  assert.doesNotMatch(service("harness"), /GH_TOKEN/);
});

test("harness-portainer/AC-32 : `init` écrit GH_TOKEN dans harness.env (0600) à chaque démarrage, jamais ailleurs ; sans jeton, harness.env est celui d'avant ; un jeton à caractère refusé fait échouer `init`", () => {
  const { secrets, env } = stack();
  const harnessEnv = path.join(secrets, "harness", "harness.env");
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = run(SETUP, ["init"], { ...env, GH_TOKEN: "ghp_Ab1-x_2", ANTHROPIC_API_KEY: "sk-ant-test_1" });
    assert.equal(result.status, 0, result.stderr);
    const token = /^MEM0_HTTP_TOKEN=([0-9a-f]{64})$/m.exec(read(path.join(secrets, "mem0", "mem0.env")))?.[1];
    assert.ok(token);
    assert.equal(read(harnessEnv), `MEM0_HTTP_TOKEN=${token}\nGH_TOKEN=ghp_Ab1-x_2\n`);
    assert.equal(mode(harnessEnv), 0o600);
    for (const file of ["runner.env", "mem0/mem0.env"])
      assert.doesNotMatch(read(path.join(secrets, file)), /GH_TOKEN|ghp_/, file);
  }
  for (const empty of [{}, { GH_TOKEN: "" }] as Record<string, string>[]) {
    const result = run(SETUP, ["init"], { ...env, ...empty });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      read(harnessEnv),
      /^MEM0_HTTP_TOKEN=[0-9a-f]{64}\n$/,
      "la ligne disparaît avec la variable, sans ligne vide",
    );
  }
  const refused = run(SETUP, ["init"], { ...env, GH_TOKEN: "gh p$(id)" });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /GH_TOKEN porte un caractère refusé/);
  assert.doesNotMatch(read(harnessEnv), /GH_TOKEN/, "rien n'est écrit par un init refusé");
});

test("harness-portainer/AC-33 : `harness-entrypoint` exporte le GH_TOKEN du fichier secret vers la commande lancée ; sans la ligne, il est absent", () => {
  const dir = tmpdir("harness-portainer-gh-");
  const launch = (content: string) => {
    fs.writeFileSync(path.join(dir, "harness.env"), content);
    const entry = entrypoint(dir, 'printf %s "${GH_TOKEN-absent}"');
    assert.equal(entry.status, 0, entry.stderr);
    return entry.stdout;
  };
  assert.equal(launch("MEM0_HTTP_TOKEN=m\nGH_TOKEN=ghp_depuis-le-fichier\n"), "ghp_depuis-le-fichier");
  assert.equal(launch("MEM0_HTTP_TOKEN=m\n"), "absent");
});

test("harness-portainer/AC-34 : `approver`, dans le conteneur harness, (re)crée l'approbateur et imprime le code des apps — le code de `pairing` plus son jeton ; sans adresses publiées, il le dit et ne crée rien", () => {
  const { root, secrets, env } = stack();
  assert.equal(run(SETUP, ["init"], env).status, 0);
  assert.match(service("pairing"), /- \$\{OMP_HARNESS_ROOT:-\/var\/lib\/omp-harness\}\/published:\/published\n/);
  fs.writeFileSync(path.join(root, "state", "token"), "harness-token\n");
  const approverEnv = {
    ...env,
    OMP_HARNESS_MAIN: path.join(ROOT, "omp-harness", "main.ts"),
    OMP_HARNESS_ENV_FILE: path.join(secrets, "harness", "harness.env"),
  };
  const clients = new ClientRegistry(loadConfig(path.join(root, "config.json")).clientsFile);

  const unpublished = run(SETUP, ["approver"], approverEnv);
  assert.notEqual(unpublished.status, 0);
  assert.match(unpublished.stderr, /adresses du tailnet inconnues : attends que le service pairing affiche son code/);
  assert.deepEqual(clients.list(), [], "rien n'est créé tant que le code ne peut pas être composé");

  fs.writeFileSync(
    path.join(root, "published", "published.env"),
    "URL=https://vps.tail1234.ts.net:7443\nMEM0_URL=https://vps.tail1234.ts.net:8443\n",
  );
  const mem0Token = /^MEM0_HTTP_TOKEN=(.+)$/m.exec(read(path.join(secrets, "harness", "harness.env")))?.[1];
  const lines = () => {
    const result = run(SETUP, ["approver"], approverEnv);
    assert.equal(result.status, 0, result.stderr);
    const code = /omp1:[A-Za-z0-9_-]+/.exec(result.stdout)?.[0];
    assert.ok(code, result.stdout);
    assert.deepEqual(decodePairing(code), { refusal: APPROVER_CODE_REFUSAL }, "omp /pair refuse le code des apps");
    return Buffer.from(code.slice("omp1:".length), "base64url").toString("utf8").split("\n");
  };
  const first = lines();
  assert.deepEqual(first.slice(0, 4), [
    "https://vps.tail1234.ts.net:7443",
    "harness-token",
    "https://vps.tail1234.ts.net:8443",
    mem0Token,
  ]);
  assert.equal(clients.authenticate(first[4])?.approver, true);

  const second = lines();
  assert.equal(clients.authenticate(second[4])?.approver, true);
  assert.equal(clients.authenticate(first[4]), null, "le code précédent cesse de valoir");
  assert.deepEqual(
    clients.list().map((client) => client.name),
    ["app-approbateur"],
  );
});
