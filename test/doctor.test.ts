// Tests de mem0-stack/doctor.sh, le diagnostic de la stack.
//
// Le script est lancé TEL QUEL (`bash doctor.sh`) : c'est son ENVIRONNEMENT qui est
// truqué, jamais le script lui-même (une copie modifiée ne prouverait plus rien).
// Deux pièces montent ce décor :
//
//   - un faux `podman` placé en tête de PATH, qui annonce la stack voulue — « aucun
//     conteneur » (toute sous-commande échoue, comme sur un nom inexistant) ou
//     « stack saine » (inspect/exec/run répondent sur les formats utilisés par le
//     script, et reflètent le .env du dépôt quand il existe, puisque c'est lui que
//     compose applique) ;
//   - un serveur HTTP local (node:http) qui joue l'API mem0 vue de l'hôte, sur un
//     port éphémère, avec ou sans exigence de token — `MEM0_HTTP_URL` pointe dessus.
//
// Aucun conteneur n'est démarré, aucun test n'approche la vraie stack : ce que l'on
// éprouve ici, ce sont les décisions du script (code de sortie, absence nommée,
// en-tête de token), pas la santé de la machine.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stack = path.join(here, "..", "mem0-stack");
const script = path.join(stack, "doctor.sh");
const envFile = path.join(stack, ".env");

const tmpDirs: string[] = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Faux moteur de conteneurs
// ---------------------------------------------------------------------------

/** Shim POSIX : ne répond qu'aux sous-commandes que doctor.sh utilise. */
const SHIM = `#!/bin/sh
# Faux moteur de conteneurs (tests de doctor.sh) : la stack décrite par SHIM_MODE.
set -u

if [ "\${SHIM_MODE:-}" = "absent" ]; then
  # Aucun conteneur : inspect, exec, run et logs échouent tous, comme podman sur
  # un nom inexistant.
  exit 1
fi

# Valeur d'une variable du conteneur : celle du .env du dépôt quand il existe,
# sinon celle du scénario (seul le token a une valeur de scénario).
env_value() {
  val=""
  if [ -n "\${SHIM_ENV:-}" ] && [ -f "$SHIM_ENV" ]; then
    val=$(sed -n "s/^$1=//p" "$SHIM_ENV" | head -1)
  fi
  if [ -z "$val" ] && [ "$1" = "MEM0_HTTP_TOKEN" ]; then
    val="\${SHIM_TOKEN:-}"
  fi
  printf '%s' "$val"
}

# Ce que le script demande à \`python\` : memory_config.py, test_api.py, ou \`-c <code>\`.
python_case() {
  for arg in "$@"; do
    case "$arg" in
      memory_config.py) echo "  (shim) configuration effective lue du conteneur"; return ;;
      test_api.py) echo "Conforme."; return ;;
    esac
  done
  # \`python -c <sonde>\` : seule la sonde oMLX attend une réponse (« OK <modèles> »).
  # La sonde Qdrant, elle, ne dit rien et réussit (exit 0).
  for arg in "$@"; do
    case "$arg" in
      *OMLX_BASE_URL*) echo "OK $(env_value OMLX_LLM_MODEL) $(env_value OMLX_EMBED_MODEL)"; return ;;
    esac
  done
}

cmd=\${1:-}
shift || true
case "$cmd" in
  inspect) # inspect -f <format> <conteneur>
    case "\${2:-}" in
      *State.Status*) echo running ;;
      *State.Running*) echo true ;;
      *State.Health*) echo healthy ;;
      *RestartCount*) echo 0 ;;
      *Image*) echo shim/mem0-http:latest ;;
      *) exit 1 ;;
    esac
    ;;
  run) # run --rm <image> python <…>
    python_case "$@"
    ;;
  exec) # exec <conteneur> python|printenv <…>
    case "\${2:-}" in
      python) python_case "$@" ;;
      printenv) env_value "\${3:-}" ;;
      *) exit 1 ;;
    esac
    ;;
  logs|ps)
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
`;

function writeShim(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "podman"), SHIM, { mode: 0o755 });
  return bin;
}

// ---------------------------------------------------------------------------
// API mem0 vue de l'hôte
// ---------------------------------------------------------------------------

type Call = { url: string; token: string | null; body: string };
type Stub = { url: string; calls: Call[]; close: () => Promise<void> };

/**
 * `GET /health` répond sans token (elle ne passe pas par `check_token` dans
 * http_server.py) ; les routes `/memory/*` la rejettent par 401 dès qu'un token est
 * exigé. `search` renvoie le texte réellement écrit : l'aller-retour est vérifié sur
 * le contenu, pas sur un statut.
 */
async function startApi(options: { token?: string } = {}): Promise<Stub> {
  const calls: Call[] = [];
  let written = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      const url = req.url ?? "";
      const header = req.headers["x-mem0-token"];
      calls.push({ url, token: typeof header === "string" ? header : null, body });
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url === "/health") return json(200, { status: "ok" });
      if (options.token !== undefined && header !== options.token) {
        return json(401, { detail: "invalid token" });
      }
      if (url === "/memory/add") {
        const parsed: unknown = JSON.parse(body);
        written = typeof parsed === "object" && parsed !== null && "text" in parsed ? String(parsed.text) : "";
        return json(200, { results: [] });
      }
      if (url === "/memory/search") return json(200, { results: [{ id: "doctor-1", memory: written }] });
      return json(404, { detail: "unknown route" });
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const address = server.address();
  assert.ok(address !== null && typeof address === "object", "le serveur de test doit écouter");
  return {
    url: `http://127.0.0.1:${address.port}`,
    calls,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

// ---------------------------------------------------------------------------
// Lancement de doctor.sh
// ---------------------------------------------------------------------------

function doctorEnv(shimDir: string, mode: "absent" | "healthy", extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`;
  env.SHIM_MODE = mode;
  env.SHIM_ENV = envFile;
  return { ...env, ...extra };
}

/**
 * Lance doctor.sh en enfant ASYNCHRONE : `spawnSync` gèlerait la boucle d'événements
 * du processus de test, donc le serveur HTTP monté ici ne pourrait jamais répondre
 * au `curl` du script — interblocage jusqu'au `-m 120` de la section 5.
 */
function runDoctor(env: Record<string, string>): Promise<{ status: number | null; output: string }> {
  const done = Promise.withResolvers<{ status: number | null; output: string }>();
  const child = spawn("bash", [script], { env });
  let output = "";
  const collect = (chunk: Buffer): void => {
    output += chunk.toString("utf8");
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("error", done.reject);
  child.on("close", (status) => done.resolve({ status, output }));
  return done.promise;
}

/** Le token que le shim annoncera : celui du .env local, sinon celui du scénario. */
function containerToken(): string {
  const fallback = "jeton-de-test";
  let text: string;
  try {
    text = fs.readFileSync(envFile, "utf8");
  } catch {
    return fallback;
  }
  for (const line of text.split("\n")) {
    const found = /^MEM0_HTTP_TOKEN=(.*)$/.exec(line.trim());
    if (found && found[1] !== "") return found[1];
  }
  return fallback;
}

// ---------------------------------------------------------------------------

test("doctor/AC-7 : une vérification en échec rend un code de sortie non nul", async () => {
  const shimDir = writeShim(tmpDir("doctor-ac7-"));

  // Aucun conteneur : le diagnostic doit le dire, et surtout ne pas rendre 0.
  const broken = await runDoctor(doctorEnv(shimDir, "absent"));
  assert.notEqual(broken.status, 0, `doctor.sh a rendu 0 sur une stack absente :\n${broken.output}`);

  // Stack saine : conteneurs annoncés par le shim, API mem0 servie par le test.
  const api = await startApi();
  try {
    const healthy = await runDoctor(doctorEnv(shimDir, "healthy", { MEM0_HTTP_URL: api.url }));
    assert.equal(healthy.status, 0, `doctor.sh a rendu ${healthy.status} sur une stack saine :\n${healthy.output}`);
    assert.match(healthy.output, /écriture et relecture fonctionnelles/);
  } finally {
    await api.close();
  }
});

test("doctor/AC-8 : l'absence de conteneur est nommée, sans panne inventée", async () => {
  const shimDir = writeShim(tmpDir("doctor-ac8-"));

  const { status, output } = await runDoctor(doctorEnv(shimDir, "absent"));

  assert.notEqual(status, 0, `doctor.sh a rendu 0 alors qu'il n'y a aucun conteneur :\n${output}`);
  assert.match(output, /absent/, `l'absence du conteneur n'est pas nommée :\n${output}`);
  assert.match(output, /compose up -d/, `le remède compose up -d n'est pas donné :\n${output}`);
  assert.doesNotMatch(output, /rupture d'API mem0/, `panne d'API inventée :\n${output}`);
  assert.doesNotMatch(output, /memory_config\.py ne se charge pas/, `panne de config inventée :\n${output}`);
  assert.doesNotMatch(output, /\/tmp\/mem0-api\.log/, `le log d'un run antérieur est cité :\n${output}`);
});

test("doctor/AC-9 : le token du conteneur est envoyé dans l'aller-retour écriture/relecture", async () => {
  const token = containerToken();
  const api = await startApi({ token });
  try {
    const shimDir = writeShim(tmpDir("doctor-ac9-"));
    const { status, output } = await runDoctor(
      doctorEnv(shimDir, "healthy", { MEM0_HTTP_URL: api.url, SHIM_TOKEN: token }),
    );

    assert.equal(status, 0, `doctor.sh a rendu ${status} avec un token défini dans le conteneur :\n${output}`);
    assert.match(output, /écriture et relecture fonctionnelles/);
    // Le remède de l'embedding ne doit pas apparaître : l'échec, s'il y en avait un,
    // vient d'un 401 et non de la dimension d'embedding.
    assert.doesNotMatch(output, /EMBEDDING_DIMS/);

    // Les DEUX appels de la section 5 ont porté l'en-tête exigé par le serveur :
    // sans lui, le stub aurait répondu 401 et le test serait déjà rouge au-dessus.
    assert.deepEqual(
      api.calls.filter((call) => call.url.startsWith("/memory/")).map((call) => [call.url, call.token]),
      [
        ["/memory/add", token],
        ["/memory/search", token],
      ],
    );
  } finally {
    await api.close();
  }
});
