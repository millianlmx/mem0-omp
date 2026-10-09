// Banc de repli de modèle SANS RÉSEAU (BR-1, S-2, S-3) : exécute UN run du plugin
// par le VRAI `createSessionHost` + le VRAI `createMaillonRunner`, dans une VRAIE
// `AgentSession` d'OMP, avec un fournisseur `banc` dont les réponses sont scriptées
// (429 comprises). Rien d'autre n'est simulé : la chaîne de repli native, le
// registre des quotas, le retour au principal en milieu de boucle d'outils et le
// rattrapage du runner s'exécutent pour de bon.
//
// Usage : `bun scripts/fallback-bench.ts <sans-repli|repli|retour|epuise>`.
// Sortie : UNE ligne JSON sur stdout (la dernière) ; le journal du service va sur
// stderr. Code de sortie : 0 (mesure rendue), 2 (prérequis absent), 1 (échec du banc).
//
// Pourquoi un script Bun et pas un test node : `createAgentSession` charge l'hôte
// OMP (TypeScript Bun), que la suite `node --test` ne peut pas importer. Les tests
// node lancent ce script en sous-process et lisent sa ligne JSON.
//
// Les mêmes PIÈGES que scripts/plugin-smoke.ts s'appliquent (import absolu de
// l'hôte résolu à l'exécution, HOME factice posé AVANT le chargement), plus :
//  * le fournisseur `banc` est déclaré par une EXTENSION (`pi.registerProvider`) :
//    `createAgentSession` résout `modelPattern` APRÈS le chargement des extensions
//    (sdk.ts « resolve after extensions load »), donc `banc/principal` est
//    sélectionnable ; l'extension est écrite dans un dossier temporaire et lit ses
//    réponses sur `globalThis` (même process) ;
//  * `~/.omp/agent/config.yml` du HOME factice est AMORCÉ : son empreinte avant et
//    après le run prouve que rien n'y écrit (B-5) — un fichier absent dans les deux
//    cas ne prouverait rien.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createMaillonRunner } from "../omp-mem0-req/serviceRuns.ts";
import { createSessionHost } from "../omp-mem0-req/serviceSessions.ts";
import { markServiceProcess } from "../omp-mem0-req/serviceState.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCENARIOS = ["sans-repli", "repli", "retour", "epuise"] as const;
type Scenario = (typeof SCENARIOS)[number];

const scenario = process.argv[2] as Scenario | undefined;
if (!scenario || !SCENARIOS.includes(scenario)) {
  console.error(`usage : bun scripts/fallback-bench.ts <${SCENARIOS.join("|")}>`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 1. Hôte OMP (même cascade que plugin-smoke.ts)
// ---------------------------------------------------------------------------
const HOME_INITIAL = process.env.HOME ?? os.homedir();
const candidates = [
  ...(process.env.MEM0_OMP_HOST_MODULES ? [process.env.MEM0_OMP_HOST_MODULES] : []),
  path.join(ROOT, "node_modules"),
  path.join(process.env.BUN_INSTALL ?? path.join(HOME_INITIAL, ".bun"), "install", "global", "node_modules"),
];
const host = candidates.find(dir => fs.existsSync(path.join(dir, "@oh-my-pi", "pi-coding-agent", "src", "index.ts")));
if (!host) {
  console.error(`✗ hôte OMP introuvable (${candidates.join(", ")})`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// 2. Isolation : HOME factice, état jetable, dépôt jetable
// ---------------------------------------------------------------------------
// Bun fige `os.homedir()` au démarrage du process : poser `process.env.HOME` en
// cours de route ne change ni le dossier des plugins installés, ni celui de
// l'agent — l'hôte chargerait alors les plugins RÉELS de la machine (dont une
// version installée d'omp-mem0-req) dans la session du banc. Le banc se relance
// donc lui-même sous un HOME factice (`FALLBACK_BENCH_HOME`), et le parent ne fait
// que relayer la ligne JSON de l'enfant.
const TMP = fs.realpathSync(os.tmpdir());
const fakeHome = process.env.FALLBACK_BENCH_HOME;
if (fakeHome === undefined) {
  const created = fs.mkdtempSync(path.join(TMP, "fallback-bench-home-"));
  const child = Bun.spawnSync([process.execPath, fileURLToPath(import.meta.url), scenario], {
    env: { ...process.env, HOME: created, FALLBACK_BENCH_HOME: created, MEM0_OMP_HOST_MODULES: host },
    stdout: "pipe",
    stderr: "inherit",
  });
  fs.rmSync(created, { recursive: true, force: true });
  process.stdout.write(child.stdout);
  process.exit(child.exitCode ?? 1);
}
const temporaries: string[] = [];
const mktmp = (prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(TMP, prefix));
  temporaries.push(dir);
  return dir;
};
const cleanup = () => {
  for (const dir of temporaries) fs.rmSync(dir, { recursive: true, force: true });
};

const agentDir = path.join(fakeHome, ".omp", "agent");
const stateDir = mktmp("fallback-bench-state-");
const repo = mktmp("fallback-bench-repo-");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.MEM0_PIPELINE_STATE_DIR = stateDir;
process.env.MEM0_AUTOSETUP = "0";

// Le config.yml du HOME factice : un réglage utilisateur que RIEN ne doit toucher.
const configPath = path.join(agentDir, "config.yml");
fs.mkdirSync(agentDir, { recursive: true });
fs.writeFileSync(configPath, "modelRoles:\n  default: banc/utilisateur\nretry:\n  maxDelayMs: 123456\n", "utf8");
const hashOfConfig = (): string =>
  fs.existsSync(configPath) ? crypto.createHash("sha256").update(fs.readFileSync(configPath)).digest("hex") : "absent";

Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
fs.writeFileSync(path.join(repo, "notes.txt"), "contenu du fichier lu par l'outil read\n", "utf8");

// ---------------------------------------------------------------------------
// 3. Le fournisseur `banc` : des réponses scriptées par modèle
// ---------------------------------------------------------------------------
const hostPackage = path.join(host, "@oh-my-pi", "pi-coding-agent");
const { createMockModel } = (await import(
  path.join(host, "@oh-my-pi", "pi-ai", "src", "providers", "mock.ts")
)) as {
  createMockModel: (options: {
    id: string;
    provider: string;
    responses: Array<Record<string, unknown>>;
    handler: Record<string, unknown>;
  }) => {
    stream: (model: unknown, context: unknown, options?: unknown) => unknown;
  };
};

const tooManyRequests = (retryAfterMs: number): Record<string, unknown> => ({
  stopReason: "error",
  errorMessage: `429 Too Many Requests : rate limit exceeded retry-after-ms=${retryAfterMs}`,
});

/** Les réponses de chaque modèle, une par appel, dans l'ordre. */
const SCRIPTS: Record<Scenario, { principal: Array<Record<string, unknown>>; repli: Array<Record<string, unknown>> }> = {
  "sans-repli": {
    principal: [{ content: ["fini"] }],
    repli: [],
  },
  repli: {
    principal: [tooManyRequests(600_000)],
    repli: [{ content: ["fini sur le repli"] }],
  },
  // P tombe à 1,5 s ; R met 2 s à répondre (donc P est rouvert quand l'outil rend
  // la main) et appelle `read` : le retour au principal doit avoir lieu au milieu
  // de la boucle d'outils, pas au prompt suivant.
  retour: {
    principal: [tooManyRequests(1_500), { content: ["fini sur le principal"] }],
    repli: [{ delayMs: 2_000, content: [{ type: "toolCall", name: "read", arguments: { path: "notes.txt" } }] }],
  },
  epuise: {
    principal: [tooManyRequests(600_000), tooManyRequests(600_000)],
    repli: [tooManyRequests(600_000), tooManyRequests(600_000)],
  },
};

// Une fois son script épuisé, un modèle répond comme un vrai : un modèle dont le
// quota est tombé continue de répondre 429 (le tour de relance du service, ou tout
// autre appel, le retrouve épuisé) ; les autres répondent un texte inoffensif.
const AFTER_SCRIPT = scenario === "epuise" ? tooManyRequests(600_000) : { content: ["rien à ajouter"] };
const mocks = {
  principal: createMockModel({ id: "principal", provider: "banc", responses: SCRIPTS[scenario].principal, handler: AFTER_SCRIPT }),
  repli: createMockModel({ id: "repli", provider: "banc", responses: SCRIPTS[scenario].repli, handler: AFTER_SCRIPT }),
};
(globalThis as Record<symbol, unknown>)[Symbol.for("omp-mem0-req.bench")] = {
  stream: (model: { id: string }, context: unknown, options?: unknown) => {
    const mock = model.id === "repli" ? mocks.repli : mocks.principal;
    return mock.stream(mock, context, options);
  },
};

const benchExtension = path.join(mktmp("fallback-bench-ext-"), "banc-provider.ts");
fs.writeFileSync(
  benchExtension,
  `export default function (pi) {
  const bench = globalThis[Symbol.for("omp-mem0-req.bench")];
  const model = id => ({
    id,
    name: id,
    api: "banc-api",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 4096,
  });
  pi.registerProvider("banc", {
    baseUrl: "http://banc.invalid",
    apiKey: "banc-key",
    api: "banc-api",
    streamSimple: (model, context, options) => bench.stream(model, context, options),
    models: [model("principal"), model("repli")],
  });
}
`,
  "utf8",
);

// ---------------------------------------------------------------------------
// 4. Le vrai hôte de sessions + le vrai runner du plugin
// ---------------------------------------------------------------------------
const hostModule = (await import(path.join(hostPackage, "src", "index.ts"))) as Record<string, unknown>;

// Sans ce marqueur, l'extension chargée dans la session ne se croit pas dans le
// service : la branche « maillon » et le crochet de retour au principal restent inertes.
markServiceProcess(true);

const baseHost = createSessionHost({
  pi: { pi: hostModule } as never,
  stateDir,
  selfPath: path.join(ROOT, "omp-mem0-req", "extension.ts"),
  extraExtensionPaths: [benchExtension],
  log: (line: string) => console.error(line),
});
const sessionFiles: string[] = [];
const sessionHost = {
  ...baseHost,
  open: async (options: Parameters<typeof baseHost.open>[0]) => {
    const hosted = await baseHost.open(options);
    if (hosted.sessionFile) sessionFiles.push(hosted.sessionFile);
    return hosted;
  },
};
const runner = createMaillonRunner({ host: sessionHost, log: (line: string) => console.error(line) });

const PRINCIPAL = "banc/principal";
const REPLI = "banc/repli";
const withFallback = scenario !== "sans-repli";

const configHashBefore = hashOfConfig();
const result = await runner({
  spec: {
    lotId: "bench",
    slug: "bench",
    phase: "impl",
    stateDir,
    worktree: repo,
    prompt: "Lis notes.txt puis réponds « fini ».",
    sessionFile: null,
    model: PRINCIPAL,
    primary: PRINCIPAL,
    fallback: withFallback ? REPLI : null,
    inbox: null,
    deadline: null,
  },
  cwd: repo,
  timeout: 120_000,
  signal: AbortSignal.timeout(120_000),
});
const configHashAfter = hashOfConfig();

// ---------------------------------------------------------------------------
// 5. Lecture des .jsonl produits : la preuve est dans les fichiers de session
// ---------------------------------------------------------------------------
const assistantModels: string[] = [];
const modelChanges: Array<{ model: string; role: string }> = [];
for (const file of sessionFiles) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.type === "model_change" && typeof entry.model === "string") {
      modelChanges.push({ model: entry.model, role: typeof entry.role === "string" ? entry.role : "" });
    }
    if (entry.type !== "message") continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (message?.role === "assistant" && typeof message.provider === "string" && typeof message.model === "string") {
      assistantModels.push(`${message.provider}/${message.model}`);
    }
  }
}

const line = JSON.stringify({
  scenario,
  code: result.code,
  stderr: result.stderr,
  quota: result.quota ?? null,
  sessionFiles,
  assistantModels,
  modelChanges,
  configHashBefore,
  configHashAfter,
});
await baseHost.disposeAll();
cleanup();
process.stdout.write(`${line}\n`, () => process.exit(0));
