// PREUVE DE PARITÉ du protocole distant du VPS (orchestrator-living-in-a-vps, S-3, AC-12) :
// le serveur TypeScript (`createRemoteRoutes` + `createRemoteRequestHandler`) rejoue, sur une
// copie de la fixture partagée, la liste ordonnée `test/fixtures/api-distante/requests.json` et
// rend EXACTEMENT les golden que le test du Mac (ApiDistanteGoldenTests, sur `RemoteStack`)
// écrit avec `MEM0_OMP_WRITE_GOLDEN=1`. Le Mac est la source de vérité : un golden ne se corrige
// jamais à la main ici, c'est le serveur TypeScript qui s'aligne.
//
// ── LA FIXTURE `test/fixtures/api-distante/` ─────────────────────────────────────────────────
//   state/         le magasin `<stateDir>` complet (lots, running, history, projects + PROJECT.md,
//                  journal, audits, audit, inbox, remote/memory-links.json)
//   repos/         les dépôts (`alpha`, `beta`, `gamma`, `plain` sans `.git`) — le marqueur `.git`
//                  est créé à la copie (git refuse d'indexer un `.git` imbriqué)
//   worktrees/     les worktrees des features, `.omp/pipeline/contract.md` compris
//   sessions/      les fichiers de session `.jsonl`
//   bin/           les doublures `gh` et `omp` (sh, sans PATH) ; `bin/omp.mode` = `fail` fait échouer `omp`
//   mem0/          ce que sert le mem0 factice (`routes.json` + réponses)
//   service.json   le SERVICE du poste scripté : une table de règles HTTP (méthode, chemin à jokers
//                  `*` = un segment, `when` = champs égaux du corps, première règle gagnante, flux
//                  SSE par session). Le Mac la sert par un transport scripté ; ici un `ServiceApi`
//                  rejoue la même table.
//   requests.json  la liste ordonnée des requêtes (format ci-dessous)
//   golden/        `<n sur 3 chiffres>-<name>.json` = `{status, body}` (le corps JSON PARSÉ), et
//                  `effects.json` = ce que la séquence a fait au monde (commandes postées au contrôleur,
//                  demandes d'audit faites au service, livraisons écrites dans les boîtes inbox)
//
// ── FORMAT DE `requests.json` ────────────────────────────────────────────────────────────────
//   { n, name, method, path, body?, rawBody?, headers?, token?, protocol?, before?, golden?,
//     expect?, why?, stream?, await? }
//   n         numéro d'ordre (1…), nom du golden ; name = la route en mots-clés
//   path      chemin + requête ; body = JSON (ou rawBody = texte brut, corps illisible)
//   token     absent = le jeton de l'appareil appairé ; "none" = aucun ; "unknown" = un jeton inconnu
//   protocol  absent = 3 ; "omit" = sans l'en-tête de version ; un entier = cette version
//   before    gestes sur la copie AVANT la requête : {op:"write",path,text} | {op:"remove",path} |
//             {op:"rename",path,to} | {op:"mkdir",path} | {op:"chmod",path,mode}
//   golden    false = aucun golden (requête non déterministe : `why` dit pourquoi) ; `expect`
//             ({status, code?}) est alors vérifié à la place
//   stream    true = la requête ouvre `/v1/stream` : on lit les 7 trames d'OUVERTURE (hello, store,
//             conduite, devices, components, journal, pull-request-states), `body` du golden = la
//             liste `[{event, data}]`, puis on ferme
//   await     condition asynchrone que le Mac attend avant d'envoyer (le TypeScript, synchrone, l'ignore)
//   Gabarits (chemin, corps, en-têtes, `before`) : `$ROOT` (racine de la copie, realpath),
//   `$KEY(<chemin relatif>)` (repoKey = sha1 du realpath, 16 hexadécimaux), `$ENC(x)` (encodage
//   pourcent de tout sauf `A-Za-z0-9-._~`). Dans les NOMS de fichiers de `state/`, `$KEY(a+b)`
//   (`+` tient lieu de `/`) ; dans les contenus (hors bin/), `$ROOT` et `$KEY(rel)`.
//
// ── NORMALISATION (identique au Mac) avant comparaison ──────────────────────────────────────
//   • toute valeur d'une clé `machine`, `homeDirectory` ou `ompPath` → "$MACHINE" ;
//   • dans toute chaîne : chaque repoKey d'un dépôt de `repos/` → `$KEY(repos/<nom>)`, la racine de
//     la copie → `$ROOT`, l'origine du mem0 factice → `$MEM0`, tout UUID → `$UUID`, un identifiant
//     de commande ou d'entrée de journal (`<16 chiffres>-<4 hex>`, `<sorte>-<ms>-<4 hex>` comme
//     `resume-1700000000000-ab12`) → `$CMDID`, un nom de livraison `<16 chiffres>-<sel>[-n].json` → `…-$SALT[-n].json` ;
//   • la comparaison porte sur le JSON PARSÉ (clés triées, nombres par valeur), jamais sur les octets.
//   Horloge figée à 1 700 000 000 000 ms ; aucun pid de la fixture n'est vivant ; les repoKey
//   dérivent du chemin de la copie : la racine est choisie (`r0`, `r1`…) pour que l'ordre des clés
//   de alpha, beta, gamma soit celui des noms — tout tri par repoKey égale alors le tri par chemin.
import test from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { REMOTE_PROTOCOL_HEADER, createRemoteRequestHandler, sortedJson } from "../../omp-mem0-req/remoteApi.ts";
import { DeviceRegistry, devicesFilePath } from "../../omp-mem0-req/remoteDevices.ts";
import { createRemoteRoutes } from "../../omp-mem0-req/remoteRoutes.ts";
import type { RemoteRoutes } from "../../omp-mem0-req/remoteRoutes.ts";
import { ServiceError } from "../../omp-mem0-req/serviceApi.ts";
import type {
  DialogRequest,
  ServiceApi,
  ServiceErrorCode,
  ServiceFrame,
  SessionDescription,
  SessionSubscription,
  SessionView,
} from "../../omp-mem0-req/serviceApi.ts";
import { ROOT } from "../support/repo.ts";

const FIXTURE = path.join(ROOT, "test", "fixtures", "api-distante");
const NOW = 1_700_000_000_000;
const MACHINE = { kind: "vps" as const, name: "vps-parite" };
const PAIRED_NAME = "Téléphone";
const MEM0_TOKEN = "jeton-mem0";
const PEER = "100.64.0.9";
const ORDERED_REPOS = ["alpha", "beta", "gamma"];
const COPIED = ["state", "repos", "worktrees", "sessions", "bin"];
const WITHOUT_GIT = new Set(["plain"]);
const STREAM_OPENING = ["hello", "store", "conduite", "devices", "components", "journal", "pull-request-states"];

// ── la copie de la fixture, les gabarits, la normalisation ─────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Fixture = {
  /** Le dossier jetable qui contient la racine. */
  container: string;
  /** Le realpath de la racine de la copie (`$ROOT`). */
  root: string;
  /** `repos/alpha` → repoKey. */
  keys: Map<string, string>;
  /** Le HOME du VPS de test : un dossier RÉEL (cwd de `gh`), jamais un préfixe de la racine (le Mac abrège `~` pour SON dossier personnel). */
  home: string;
  mem0Origin: string | null;
};

const repoKeyOf = (realPath: string): string => crypto.createHash("sha1").update(realPath).digest("hex").slice(0, 16);

function copyFixture(): Fixture {
  const container = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "api-distante-parite-")));
  let chosen: string | null = null;
  for (let attempt = 0; attempt < 1000 && chosen === null; attempt++) {
    const candidate = `${container}/r${attempt}`;
    const keys = ORDERED_REPOS.map(name => repoKeyOf(`${candidate}/repos/${name}`));
    if (keys.every((key, index) => index === 0 || keys[index - 1]! < key)) chosen = candidate;
  }
  assert.notEqual(chosen, null, "aucune racine ne donne des repoKey ordonnés");
  const root = chosen as string;
  fs.mkdirSync(root, { recursive: true });
  for (const name of COPIED) fs.cpSync(path.join(FIXTURE, name), path.join(root, name), { recursive: true });
  const keys = new Map<string, string>();
  for (const entry of fs.readdirSync(path.join(root, "repos"), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(root, "repos", entry.name);
    if (!WITHOUT_GIT.has(entry.name)) {
      fs.mkdirSync(path.join(directory, ".git"));
      fs.writeFileSync(path.join(directory, ".git", "HEAD"), "ref: refs/heads/main\n");
    }
    keys.set(`repos/${entry.name}`, repoKeyOf(directory));
  }
  const home = path.join(container, "home");
  fs.mkdirSync(home);
  const fixture: Fixture = { container, root, home, keys, mem0Origin: null };
  substituteTree(fixture);
  return fixture;
}

/** `$KEY(rel)` puis `$ROOT`. `plusIsSlash` : dans un NOM de fichier, `+` tient lieu de `/`. */
function template(fixture: Fixture, text: string, plusIsSlash = false): string {
  let out = text;
  for (const [relative, key] of fixture.keys) {
    out = out.replaceAll(`$KEY(${plusIsSlash ? relative.replaceAll("/", "+") : relative})`, key);
  }
  return out.replaceAll("$ROOT", fixture.root);
}

function encodeUnreserved(text: string): string {
  return [...Buffer.from(text, "utf8")]
    .map(byte => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9\-._~]/u.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    })
    .join("");
}

/** Gabarits de requête : `template`, puis `$ENC(x)`. */
function resolve(fixture: Fixture, text: string): string {
  return template(fixture, text).replace(/\$ENC\(([^)]*)\)/gu, (_, inner: string) => encodeUnreserved(inner));
}

function resolveJson(fixture: Fixture, value: Json): Json {
  if (typeof value === "string") return resolve(fixture, value);
  if (Array.isArray(value)) return value.map(item => resolveJson(fixture, item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolveJson(fixture, inner)]));
  }
  return value;
}

function substituteTree(fixture: Fixture): void {
  const files: string[] = [];
  const names: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.name.includes("$KEY(")) names.push(full);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
    }
  };
  walk(fixture.root);
  for (const file of files) {
    if (path.relative(fixture.root, file).startsWith(`bin${path.sep}`)) continue;
    const text = fs.readFileSync(file, "utf8");
    const resolved = template(fixture, text);
    if (resolved !== text) fs.writeFileSync(file, resolved);
  }
  // Du plus profond au plus haut : renommer un parent invaliderait le chemin de ses enfants.
  for (const full of names.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)) {
    const renamed = path.join(path.dirname(full), template(fixture, path.basename(full), true));
    if (renamed !== full) fs.renameSync(full, renamed);
  }
}

const MACHINE_KEYS = new Set(["machine", "homeDirectory", "ompPath"]);

function normalizeText(fixture: Fixture, text: string): string {
  let out = text;
  for (const [relative, key] of fixture.keys) out = out.replaceAll(key, `$KEY(${relative})`);
  out = out.replaceAll(fixture.root, "$ROOT");
  if (fixture.mem0Origin !== null) out = out.replaceAll(fixture.mem0Origin, "$MEM0");
  out = out.replace(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/gu, "$UUID");
  out = out.replace(/^([a-z]+-\d+|\d{16})-[0-9a-f]{4}$/u, "$CMDID");
  out = out.replace(/(\d{16})-[0-9a-f]{4}(-\d+)?\.json/gu, (_, stamp: string, suffix: string | undefined) => `${stamp}-$SALT${suffix ?? ""}.json`);
  return out;
}

function normalize(fixture: Fixture, value: unknown): Json {
  if (typeof value === "string") return normalizeText(fixture, value);
  if (Array.isArray(value)) return value.map(item => normalize(fixture, item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, MACHINE_KEYS.has(key) ? "$MACHINE" : normalize(fixture, inner)]),
    );
  }
  return value as Json;
}

/** Le JSON canonique : clés triées à tous les niveaux, indenté — l'égalité ET le diff. */
function canonical(value: unknown): string {
  const sorted = (inner: unknown): unknown => {
    if (Array.isArray(inner)) return inner.map(sorted);
    if (inner !== null && typeof inner === "object") {
      return Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sorted(v)]));
    }
    return inner;
  };
  return JSON.stringify(sorted(value), null, 2);
}

/** Les lignes qui diffèrent, `-` attendu / `+` obtenu. */
function lineDiff(expected: string, actual: string): string {
  const left = expected.split("\n");
  const right = actual.split("\n");
  const out: string[] = [];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if (left[index] === right[index]) continue;
    if (left[index] !== undefined) out.push(`- ${left[index]}`);
    if (right[index] !== undefined) out.push(`+ ${right[index]}`);
    if (out.length >= 40) {
      out.push("… (diff tronqué)");
      break;
    }
  }
  return out.join("\n");
}

// ── le service du poste, scripté par `service.json` ─────────────────────────────────────────

type RuleFrame = { event: string; data: unknown };
type Rule = {
  method?: string;
  path?: string;
  when?: Record<string, unknown>;
  status?: number;
  json?: unknown;
  stream?: string;
  frames?: RuleFrame[];
  /** Des trames poussées sur le flux OUVERT d'une session à la réception de la requête. */
  emit?: { stream: string; frames: RuleFrame[] };
};
type ServiceCall = { method: string; path: string; body: unknown };
type SessionEntry = {
  description: SessionDescription;
  dialogs: DialogRequest[];
  listeners: Set<(frame: ServiceFrame) => void>;
};
type RuleFailure = { error?: unknown; reason?: unknown };

const wildcard = (pattern: string): RegExp => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]+")}$`, "u");

/** `{error:"conflict", reason}` : le code que le corps déclare, sinon celui du statut. */
const ERROR_CODES: Record<string, ServiceErrorCode> = {
  bad_request: "bad_request",
  not_found: "not_found",
  conflict: "conflict",
  unauthorized: "unauthorized",
  unavailable: "unavailable",
  stopping: "stopping",
  internal: "internal",
};
const STATUS_CODES: Record<number, ServiceErrorCode> = { 400: "bad_request", 401: "unauthorized", 404: "not_found", 409: "conflict", 503: "unavailable" };

/**
 * Le `ServiceApi` qui rejoue la table de règles : chaque méthode compose la requête HTTP que le client du Mac
 * enverrait (`ServiceClient`), la confronte aux règles et rend la charge utile ou lève la `ServiceError`.
 * Les sessions créées sont tenues avec leurs dialogues en vol, comme le service les tiendrait.
 */
class RuleService implements ServiceApi {
  readonly calls: ServiceCall[] = [];
  private readonly rules: Rule[];
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly conduiteByRepo = new Map<string, string>();

  constructor(rules: Rule[]) {
    this.rules = rules;
  }

  private request(method: string, segments: string[], body?: unknown): unknown {
    const encoded = `/v1/${segments.map(encodeUnreserved).join("/")}`;
    if (method !== "GET") this.calls.push({ method, path: `/v1/${segments.join("/")}`, body: body ?? null });
    const fields: Record<string, unknown> = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
    for (const rule of this.rules) {
      if (rule.stream !== undefined || (rule.method ?? "GET").toUpperCase() !== method || !wildcard(rule.path ?? "").test(encoded)) continue;
      if (!Object.entries(rule.when ?? {}).every(([key, expected]) => JSON.stringify(fields[key]) === JSON.stringify(expected))) continue;
      const status = rule.status ?? 200;
      const json = rule.json ?? {};
      if (status >= 400) {
        const failure: RuleFailure = json !== null && typeof json === "object" ? json : {};
        const declared = typeof failure.error === "string" && failure.error in ERROR_CODES ? ERROR_CODES[failure.error] : undefined;
        throw new ServiceError(status, declared ?? STATUS_CODES[status] ?? "internal", String(failure.reason ?? ""));
      }
      if (rule.emit !== undefined) this.emit(rule.emit);
      return json;
    }
    throw new ServiceError(404, "not_found", "route non scriptée");
  }

  /** Les trames d'une règle `emit` : poussées sur la session que désigne son flux, aux abonnés présents. */
  private emit(spec: NonNullable<Rule["emit"]>): void {
    const id = /^\/v1\/sessions\/([^/]+)\/events$/u.exec(spec.stream)?.[1];
    const entry = id === undefined ? undefined : this.sessions.get(id);
    if (entry === undefined) return;
    for (const frame of spec.frames) {
      const data = frame.data as DialogRequest;
      if (frame.event === "dialog") entry.dialogs.push(data);
      for (const listener of entry.listeners) listener({ event: "dialog", data });
    }
  }

  private dialogsOf(id: string): DialogRequest[] {
    const stream = this.rules.find(rule => rule.stream !== undefined && wildcard(rule.stream).test(`/v1/sessions/${encodeUnreserved(id)}/events`));
    return (stream?.frames ?? []).filter(frame => frame.event === "dialog").map(frame => frame.data as DialogRequest);
  }

  private register(id: string): SessionDescription {
    const description = this.request("GET", ["sessions", id]) as SessionDescription;
    this.sessions.set(id, { description, dialogs: this.dialogsOf(id), listeners: new Set() });
    return description;
  }

  health = () => {
    throw new ServiceError(404, "not_found", "route non scriptée");
  };

  pilot = async (repo: string) => this.request("POST", ["repos", repo, "pilot"]) as { repoKey: string; lotId: string | null; state: "piloting" };

  lot = (): never => {
    throw new ServiceError(404, "not_found", "route non scriptée");
  };

  command = async (repo: string, body: unknown) => {
    const answer = this.request("POST", ["repos", repo, "commands"], body) as { ack: never };
    return { command: body as never, ack: answer.ack };
  };

  listSessions = () => [...this.sessions.values()].map(entry => entry.description);

  createSession = async (body: unknown) => {
    const created = this.request("POST", ["sessions"], body) as SessionDescription;
    return this.register(created.id);
  };

  getSession = (id: string): SessionView | null => {
    const entry = this.sessions.get(id);
    return entry === undefined ? null : { ...entry.description, dialogs: [...entry.dialogs] };
  };

  promptSession = async (id: string, body: unknown) => this.request("POST", ["sessions", id, "prompt"], body) as { accepted: true; state: "idle" | "running" };

  abortSession = async (id: string) => this.request("POST", ["sessions", id, "abort"]) as { state: "idle" | "running" };

  answerDialog = async (id: string, dialogId: string, body: unknown): Promise<void> => {
    this.request("POST", ["sessions", id, "dialogs", dialogId], body);
    const entry = this.sessions.get(id);
    if (entry !== undefined) entry.dialogs = entry.dialogs.filter(dialog => dialog.id !== dialogId);
  };

  closeSession = async (id: string): Promise<void> => {
    this.request("DELETE", ["sessions", id]);
    this.sessions.delete(id);
  };

  startConduite = async (repo: string, body: unknown) => {
    const started = this.request("POST", ["projects", repo, "conduite"], body) as { sessionId: string; state: "idle" | "running" };
    this.register(started.sessionId);
    this.conduiteByRepo.set(repo, started.sessionId);
    return started;
  };

  stopConduite = async (repo: string): Promise<void> => {
    this.request("DELETE", ["projects", repo, "conduite"]);
    const id = this.conduiteByRepo.get(repo);
    if (id !== undefined) this.sessions.delete(id);
    this.conduiteByRepo.delete(repo);
  };

  subscribeSession = (id: string): SessionSubscription | null => {
    const entry = this.sessions.get(id);
    if (entry === undefined) return null;
    const snapshot: ServiceFrame[] = entry.dialogs.map(dialog => ({ event: "dialog", data: dialog }));
    return {
      snapshot,
      subscribe: listener => {
        entry.listeners.add(listener);
        return () => void entry.listeners.delete(listener);
      },
    };
  };

  startAudit = async (body: unknown) => this.request("POST", ["audits"], body) as { id: string; status: "analysing" };

  launchAudit = async (id: string, body: unknown) => this.request("POST", ["audits", id, "launch"], body) as { launches: never[] };

  answerAudit = async (id: string, body: unknown) => this.request("POST", ["audits", id, "escalations"], body) as { accepted: true };

  stopAudit = async (id: string) => this.request("DELETE", ["audits", id]) as { cancelled: string[]; kept: string[]; refused: Array<{ slug: string; reason: string }> };

  setSessionModel = async (id: string, body: unknown) => {
    const description = this.request("POST", ["sessions", id, "model"], body) as SessionDescription;
    const entry = this.sessions.get(id);
    if (entry !== undefined) entry.description = description;
    return description;
  };

  projectModel = async (repo: string) => this.request("GET", ["projects", repo, "model"]) as never;

  setProjectModel = async (repo: string, body: unknown) => this.request("POST", ["projects", repo, "model"], body) as never;

  handover = async (repo: string, body: unknown) => this.request("POST", ["repos", repo, "handover"], body) as never;

  commitHandover = async (repo: string, id: string, body: unknown) => this.request("POST", ["repos", repo, "handover", id, "commit"], body) as never;

  cancelHandover = async (repo: string, id: string) => this.request("DELETE", ["repos", repo, "handover", id]) as never;

  adoptRepo = async (body: unknown) => this.request("POST", ["repos", "adopt"], body) as never;
}

// ── le mem0 factice (sert `mem0/`) ─────────────────────────────────────────────────────────

type Mem0Entry = { file?: string; status?: number; text?: string; drop?: boolean };

async function startFakeMem0(): Promise<{ origin: string; close: () => Promise<void> }> {
  const routes = JSON.parse(fs.readFileSync(path.join(FIXTURE, "mem0", "routes.json"), "utf8")) as {
    token: string;
    all: Record<string, Mem0Entry>;
    search: Record<string, Mem0Entry>;
    graph: Mem0Entry[];
  };
  let graphCursor = 0;
  const reply = (res: http.ServerResponse, entry: Mem0Entry | undefined): void => {
    if (entry === undefined) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not Found");
    } else if (entry.drop === true) {
      res.socket?.destroy();
    } else if (entry.file !== undefined) {
      res.writeHead(200, { "content-type": "application/json" }).end(fs.readFileSync(path.join(FIXTURE, "mem0", entry.file)));
    } else {
      res.writeHead(entry.status ?? 500, { "content-type": "text/plain; charset=utf-8" }).end(entry.text ?? "");
    }
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => chunks.push(chunk as Buffer));
    req.on("end", () => {
      if (req.headers["x-mem0-token"] !== routes.token) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }).end("jeton refusé");
        return;
      }
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/memory/all") {
        reply(res, routes.all[url.searchParams.get("agent_id") ?? ""]);
      } else if (req.method === "POST" && url.pathname === "/memory/search") {
        let query = "";
        try {
          query = String((JSON.parse(Buffer.concat(chunks).toString("utf8")) as { query?: unknown }).query ?? "");
        } catch {
          query = "";
        }
        reply(res, routes.search[query]);
      } else if (req.method === "GET" && url.pathname === "/memory/graph") {
        const entry = routes.graph.length === 0 ? undefined : routes.graph[Math.min(graphCursor, routes.graph.length - 1)];
        graphCursor += 1;
        reply(res, entry);
      } else {
        reply(res, undefined);
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const { port } = server.address() as { port: number };
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
}

// ── le monde de la preuve : copie, mem0, service, serveur, appareil appairé ──────────────────

type Handler = (req: Request, source: string | null) => Promise<Response>;

type World = {
  fixture: Fixture;
  service: RuleService;
  routes: RemoteRoutes;
  devices: DeviceRegistry;
  handler: Handler;
  token: string;
  close: () => Promise<void>;
};

async function buildWorld(): Promise<World> {
  const fixture = copyFixture();
  const mem0 = await startFakeMem0();
  fixture.mem0Origin = mem0.origin;
  const stateDir = path.join(fixture.root, "state");
  const table = resolveJson(fixture, JSON.parse(fs.readFileSync(path.join(FIXTURE, "service.json"), "utf8")) as Json) as { rules: Rule[] };
  const service = new RuleService(table.rules);
  const devices = new DeviceRegistry({ file: devicesFilePath(path.join(fixture.root, "device-registry")), now: () => NOW });
  devices.load();
  const env: Record<string, string | undefined> = {
    PATH: path.join(fixture.root, "bin"),
    HOME: fixture.home,
    OMP_CONSOLE_GH_BINARY: path.join(fixture.root, "bin", "gh"),
    MEM0_HTTP_URL: mem0.origin,
    MEM0_HTTP_TOKEN: MEM0_TOKEN,
  };
  const routes = createRemoteRoutes({ api: service, stateDir, machine: MACHINE, devices, env, now: () => NOW, pidAlive: () => false });
  const handler = createRemoteRequestHandler({ devices, machine: MACHINE, routes: routes.routes });
  const { code } = devices.generateCode();
  const token = devices.pair(code, PAIRED_NAME, undefined).token;
  return {
    fixture,
    service,
    routes,
    devices,
    handler,
    token,
    close: async () => {
      routes.close();
      await mem0.close();
      for (const file of fs.readdirSync(path.join(fixture.root, "sessions"))) fs.chmodSync(path.join(fixture.root, "sessions", file), 0o644);
      fs.rmSync(fixture.container, { recursive: true, force: true });
    },
  };
}

// ── l'exécution d'une requête ──────────────────────────────────────────────────────────────

type RequestSpec = {
  n: number;
  name: string;
  method: string;
  path: string;
  body?: Json;
  rawBody?: string;
  headers?: Record<string, string>;
  token?: string;
  protocol?: string | number;
  before?: Array<{ op: string; path: string; to?: string; text?: string; mode?: number }>;
  golden?: boolean;
  expect?: { status: number; code?: string };
  why?: string;
  stream?: boolean;
  await?: string;
};

const requests = JSON.parse(fs.readFileSync(path.join(FIXTURE, "requests.json"), "utf8")) as RequestSpec[];
const goldenFile = (spec: RequestSpec): string => path.join(FIXTURE, "golden", `${String(spec.n).padStart(3, "0")}-${spec.name}.json`);

function applyBefore(world: World, operations: NonNullable<RequestSpec["before"]>): void {
  for (const operation of operations) {
    const target = path.join(world.fixture.root, template(world.fixture, operation.path));
    switch (operation.op) {
      case "write":
        fs.writeFileSync(target, template(world.fixture, operation.text ?? ""));
        break;
      case "remove":
        fs.rmSync(target, { recursive: true, force: true });
        break;
      case "rename":
        fs.renameSync(target, path.join(world.fixture.root, template(world.fixture, operation.to ?? "")));
        break;
      case "mkdir":
        fs.mkdirSync(target, { recursive: true });
        break;
      case "chmod":
        fs.chmodSync(target, operation.mode ?? 0o644);
        break;
      default:
        assert.fail(`opération « before » inconnue : ${operation.op}`);
    }
  }
}

function toRequest(world: World, spec: RequestSpec, pathname: string): Request {
  const headers: Record<string, string> = {};
  if (spec.protocol !== "omit") headers[REMOTE_PROTOCOL_HEADER] = String(spec.protocol ?? 3);
  if (spec.token === "none") {
    /* aucun jeton */
  } else if (spec.token === "unknown") {
    headers.Authorization = `Bearer jeton-inconnu-${"x".repeat(20)}`;
  } else {
    headers.Authorization = `Bearer ${world.token}`;
  }
  for (const [name, value] of Object.entries(spec.headers ?? {})) headers[name] = resolve(world.fixture, value);
  let body: string | undefined;
  if (spec.rawBody !== undefined) {
    body = spec.rawBody;
  } else if (spec.body !== undefined) {
    body = JSON.stringify(resolveJson(world.fixture, spec.body));
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new Request(`http://100.64.0.1:8787${pathname}`, { method: spec.method, headers, body });
}

type Frame = { event: string; data: Json };

/** Lit `count` trames d'une réponse SSE, puis ferme la lecture (le serveur voit l'appareil se déconnecter). */
async function readFrames(response: Response, count: number, until?: (frames: Frame[]) => boolean, timeoutMs = 10_000): Promise<Frame[]> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && (until === undefined ? frames.length < count : !until(frames))) {
      const next = await Promise.race([reader.read(), pause(Math.max(1, deadline - Date.now())).then(() => null)]);
      if (next === null || next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event = "";
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data = line.slice(6);
        }
        if (event !== "") frames.push({ event, data: JSON.parse(data) as Json });
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return frames;
}

/** Une attente d'ÉVÈNEMENT externe (flux SSE, serveur http réel) : aucune horloge de test à piloter ici, c'est le temps du système. */
function pause(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function untilDisconnected(world: World): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && world.devices.list().some(device => device.connected)) await pause(10);
}

async function perform(world: World, spec: RequestSpec): Promise<{ status: number; body: Json }> {
  applyBefore(world, spec.before ?? []);
  const pathname = resolve(world.fixture, spec.path);
  const response = await world.handler(toRequest(world, spec, pathname), PEER);
  if (spec.stream === true && response.status === 200) {
    const frames = await readFrames(response, STREAM_OPENING.length);
    await untilDisconnected(world);
    return { status: response.status, body: normalize(world.fixture, frames) };
  }
  const text = await response.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body: normalize(world.fixture, body) };
}

/** Les faits de PR d'une trame `pull-request-states` (null si la trame n'en est pas une). */
function pullRequestFacts(frame: Frame): { facts: unknown[]; refreshing: boolean } | null {
  const data = frame.data;
  if (frame.event !== "pull-request-states" || data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const { facts, refreshing } = data;
  return Array.isArray(facts) && typeof refreshing === "boolean" ? { facts, refreshing } : null;
}

/** Comme le Mac, qui lit les faits de PR au démarrage : on attend ici qu'ils soient lus avant la première requête. */
async function primePullRequestFacts(world: World): Promise<void> {
  const response = await world.handler(
    new Request("http://100.64.0.1:8787/v1/stream", { headers: { [REMOTE_PROTOCOL_HEADER]: "3", Authorization: `Bearer ${world.token}` } }),
    PEER,
  );
  assert.equal(response.status, 200);
  const frames = await readFrames(response, 0, seen => seen.some(frame => {
    const state = pullRequestFacts(frame);
    return state !== null && !state.refreshing && state.facts.length === 4;
  }));
  await untilDisconnected(world);
  const last = frames.map(pullRequestFacts).filter(state => state !== null).at(-1);
  assert.equal(last?.facts.length, 4, `les faits de PR doivent être lus (dernière trame : ${JSON.stringify(last)})`);
}

// ── les preuves ──────────────────────────────────────────────────────────────────────────

let replayed: World | null = null;
test.after(async () => {
  await replayed?.close();
});

test("orchestrator-living-in-a-vps/AC-12 : les requêtes de requests.json rejouées sur le serveur TypeScript rendent exactement les golden du Mac", async t => {
  const world = await buildWorld();
  replayed = world;
  await primePullRequestFacts(world);
  assert.ok(requests.length > 0, "requests.json ne doit pas être vide");
  for (const spec of requests) {
    await t.test(`#${String(spec.n).padStart(3, "0")} ${spec.name} — ${spec.method} ${spec.path}`, async () => {
      const outcome = await perform(world, spec);
      if (spec.expect !== undefined) {
        assert.equal(outcome.status, spec.expect.status, `#${spec.n} ${spec.name} : statut (${spec.why ?? "hors golden"})`);
        if (spec.expect.code !== undefined) {
          const error = (outcome.body as { error?: { code?: string } } | null)?.error;
          assert.equal(error?.code, spec.expect.code, `#${spec.n} ${spec.name} : code d'erreur`);
        }
      }
      if (spec.golden === false) return;
      const file = goldenFile(spec);
      assert.ok(fs.existsSync(file), `#${spec.n} ${spec.name} : golden absent (${path.relative(ROOT, file)}) — le produire avec MEM0_OMP_WRITE_GOLDEN=1 côté Mac`);
      const expected = canonical(JSON.parse(fs.readFileSync(file, "utf8")));
      const actual = canonical(outcome);
      if (expected !== actual) assert.fail(`#${spec.n} ${spec.name} ${spec.method} ${resolve(world.fixture, spec.path)}\n${lineDiff(expected, actual)}`);
    });
  }
  // Les golden orphelins disent une requête supprimée : le dossier dit exactement ce qui est comparé.
  const expectedFiles = new Set(requests.filter(spec => spec.golden !== false).map(spec => path.basename(goldenFile(spec))).concat("effects.json"));
  const present = fs.readdirSync(path.join(FIXTURE, "golden"));
  assert.deepEqual(present.filter(name => !expectedFiles.has(name)), [], "golden orphelins : aucune requête de requests.json ne les produit");
});

/** La clé de tri des livraisons : instant, sorte, texte — identique côté Mac. */
function deliveryKey(delivery: unknown): string {
  const d = delivery as { sentAt?: number; kind?: string; text?: string; selected?: string; custom?: string };
  return `${String(d.sentAt ?? 0).padStart(20, "0")}\u0000${d.kind ?? ""}\u0000${d.text ?? d.selected ?? d.custom ?? ""}`;
}

test("api-distante-parite : les effets de la séquence (commandes au contrôleur, audits au service, livraisons inbox) égalent le golden du Mac", () => {
  const world = replayed;
  assert.notEqual(world, null, "la séquence de requêtes doit avoir été rejouée avant les effets");
  const { fixture, service } = world as World;
  const commands = service.calls
    .filter(call => call.path.endsWith("/commands"))
    .map(call => ({ path: normalizeText(fixture, call.path), body: normalize(fixture, call.body) }));
  const audits = service.calls
    .filter(call => call.path.startsWith("/v1/audits"))
    .map(call => ({ method: call.method, path: call.path, body: normalize(fixture, call.body ?? {}) }));
  const inbox: Record<string, unknown[]> = {};
  const inboxRoot = path.join(fixture.root, "state", "inbox");
  for (const entry of fs.readdirSync(inboxRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const box = normalizeText(fixture, path.relative(inboxRoot, entry.parentPath));
    (inbox[box] ??= []).push(normalize(fixture, JSON.parse(fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8"))));
  }
  for (const deliveries of Object.values(inbox)) deliveries.sort((a, b) => (deliveryKey(a) < deliveryKey(b) ? -1 : deliveryKey(a) > deliveryKey(b) ? 1 : 0));
  const expected = canonical(JSON.parse(fs.readFileSync(path.join(FIXTURE, "golden", "effects.json"), "utf8")));
  const actual = canonical({ commands, audits, inbox });
  if (expected !== actual) assert.fail(`effets (commandes, audits, inbox)\n${lineDiff(expected, actual)}`);
});

test("api-distante-parite : GET /v1/store avec le jeton d'un appareil appairé rend 200 et l'instantané du magasin (le test du socle prouvait le 200 par /v1/version), sans jeton 401", async t => {
  const world = await buildWorld();
  t.after(() => world.close());
  const withToken = await world.handler(toRequest(world, { n: 0, name: "store", method: "GET", path: "/v1/store" }, "/v1/store"), PEER);
  assert.equal(withToken.status, 200);
  assert.equal(withToken.headers.get(REMOTE_PROTOCOL_HEADER), "3");
  const text = await withToken.text();
  const payload = JSON.parse(text) as { snapshot: { lots: { lots: unknown[] }; running: { entries: unknown[] } } };
  assert.equal(payload.snapshot.lots.lots.length, 2, "les deux lots de la fixture");
  assert.equal(payload.snapshot.running.entries.length, 3, "les trois runs de la fixture");
  assert.equal(text, sortedJson(payload), "formes JSON : clés triées à tous les niveaux");
  const without = await world.handler(toRequest(world, { n: 0, name: "store", method: "GET", path: "/v1/store", token: "none" }, "/v1/store"), PEER);
  assert.equal(without.status, 401);
  assert.deepEqual(await without.json(), { error: { code: "unauthorized" } });
});

test("api-distante-parite : ce que la normalisation efface reste exact — machine du VPS, HOME et binaire omp du poste, version de protocole sur toute réponse", async t => {
  const world = await buildWorld();
  t.after(() => world.close());
  const ask = async (spec: Pick<RequestSpec, "method" | "path">) => world.handler(toRequest(world, { n: 0, name: "x", ...spec }, spec.path), PEER);
  const version = await ask({ method: "GET", path: "/v1/version" });
  assert.deepEqual(await version.json(), { machine: MACHINE, protocolVersion: 3 });
  const components = await ask({ method: "GET", path: "/v1/components" });
  assert.deepEqual(await components.json(), {
    homeDirectory: world.fixture.home,
    ompInstalled: true,
    ompPath: path.join(world.fixture.root, "bin", "omp"),
  });
  for (const pathname of ["/v1/store", "/v1/inexistante", `/v1/cards/feature:ffffffffffffffff:rien/contract`]) {
    const response = await ask({ method: "GET", path: pathname });
    assert.equal(response.headers.get(REMOTE_PROTOCOL_HEADER), "3", `${pathname} : l'en-tête de version est sur TOUTE réponse`);
  }
});
