// Banc de mem0-stack/doctor.sh, partagé par test/doctor.test.ts (doctor/AC-*) et
// test/mem0-stack-bascule-rust.test.ts (AC-8, AC-9) : un id de critère qualifié ne
// vit que dans le fichier de son slug (test/criteria.test.ts), le banc est donc ici.
//
// Le script est lancé TEL QUEL (`bash doctor.sh`) : c'est son ENVIRONNEMENT qui est
// truqué, jamais le script lui-même (une copie modifiée ne prouverait plus rien).
// Deux pièces montent ce décor :
//
//   - un faux `podman` placé en tête de PATH, qui annonce la stack voulue — « aucun
//     conteneur » (toute sous-commande échoue, comme sur un nom inexistant) ou
//     « stack saine » (inspect/exec répondent sur les formats utilisés par le
//     script, et reflètent le .env du dépôt quand il existe, puisque c'est lui que
//     compose applique) ; les conteneurs de l'ancienne pile (mem0-qdrant,
//     mem0-http) n'existent que sous `SHIM_ANCIENNE=1` ;
//   - un serveur HTTP local (node:http) qui joue l'API mem0 vue de l'hôte, sur un
//     port éphémère, avec ou sans exigence de token — `MEM0_HTTP_URL` pointe dessus.
//
// Aucun conteneur n'est démarré, aucun test n'approche la vraie stack.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stack = path.join(here, "..", "mem0-stack");
const script = path.join(stack, "doctor.sh");
const envFile = path.join(stack, ".env");

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

cmd=\${1:-}
shift || true
# Le conteneur visé est le dernier argument d'inspect.
for last in "$@"; do :; done
case "$cmd" in
  inspect) # inspect -f <format> <conteneur>
    case "\${last:-}" in
      mem0-qdrant|mem0-http)
        # L'ancienne pile : absente, sauf si le scénario la veut présente (arrêtée).
        [ "\${SHIM_ANCIENNE:-}" = "1" ] || exit 1
        case "\${2:-}" in
          *State.Status*) echo exited ;;
          *State.Running*) echo false ;;
          *) exit 1 ;;
        esac
        exit 0
        ;;
    esac
    case "\${2:-}" in
      *State.Status*) echo running ;;
      *State.Running*) echo true ;;
      *State.Health*) echo healthy ;;
      *RestartCount*) echo 0 ;;
      *) exit 1 ;;
    esac
    ;;
  exec) # exec <conteneur> printenv <VAR> | exec <conteneur> sh -c <sonde oMLX>
    case "\${2:-}" in
      printenv) env_value "\${3:-}" ;;
      sh)
        # Sonde oMLX : le corps de /models, puis le code HTTP en dernière ligne.
        printf '{"data":[{"id":"%s"},{"id":"%s"}]}\\n200\\n' "$(env_value OMLX_LLM_MODEL)" "$(env_value OMLX_EMBED_MODEL)"
        ;;
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

export function writeShim(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "podman"), SHIM, { mode: 0o755 });
  return bin;
}

// ---------------------------------------------------------------------------
// API mem0 vue de l'hôte
// ---------------------------------------------------------------------------

export type Call = { url: string; token: string | null; body: string };
export type Stub = { url: string; calls: Call[]; close: () => Promise<void> };

/**
 * `GET /health` répond sans token ; les routes `/memory/*` la rejettent par 401 dès
 * qu'un token est exigé. `search` renvoie le texte réellement écrit : l'aller-retour
 * est vérifié sur le contenu, pas sur un statut. `GET /memory/all` compte comme
 * mem0-rs : `options.total` souvenirs hors du scope `_doctor`, plus ceux que
 * l'aller-retour du script a écrits dans `_doctor` (seuls comptés sous
 * `?agent_id=_doctor`).
 */
export async function startApi(options: { token?: string; total?: number } = {}): Promise<Stub> {
  const calls: Call[] = [];
  let written = "";
  let doctorWrites = 0;
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
        if (typeof parsed === "object" && parsed !== null && "agent_id" in parsed && parsed.agent_id === "_doctor") {
          doctorWrites += 1;
        }
        return json(200, { results: [] });
      }
      if (url === "/memory/search") return json(200, { results: [{ id: "doctor-1", memory: written }] });
      if (url === "/memory/all?agent_id=_doctor") return json(200, { results: [], total: doctorWrites });
      if (url === "/memory/all") return json(200, { results: [], total: (options.total ?? 0) + doctorWrites });
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

export function doctorEnv(shimDir: string, mode: "absent" | "healthy", extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.PATH = `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`;
  env.SHIM_MODE = mode;
  env.SHIM_ENV = envFile;
  // Un vrai mem0-stack/qdrant_storage éventuel ne doit pas influer sur le scénario.
  env.MEM0_ANCIEN_STOCKAGE_QDRANT = path.join(path.dirname(shimDir), "absent");
  return { ...env, ...extra };
}

/**
 * Lance doctor.sh en enfant ASYNCHRONE : `spawnSync` gèlerait la boucle d'événements
 * du processus de test, donc le serveur HTTP monté ici ne pourrait jamais répondre
 * au `curl` du script — interblocage jusqu'au `-m 120` de la section 5.
 */
export function runDoctor(env: Record<string, string>): Promise<{ status: number | null; output: string }> {
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
export function containerToken(): string {
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
