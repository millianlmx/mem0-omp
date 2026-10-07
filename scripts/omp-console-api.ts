// Sonde CLI de l'API distante d'OMP Console (S-15 / BR-10).
//
// Pourquoi un script plutôt qu'un test : c'est la sonde MANUELLE durable qui
// parle à la coque réelle (vrai serveur, vrai trousseau, vrai flux SSE). Les
// tests canoniques vivent dans omp-console/Tests (gated), pas ici.
//
// Contrat de sortie (S-15) :
//  * 0 succès, 1 refus/échec (code d'erreur partagé + message du serveur tels
//    quels), 2 prérequis absent (security introuvable, URL injoignable) —
//    jamais un succès trompeur.
//  * Le jeton n'est JAMAIS affiché ni écrit dans un fichier ordinaire : il vit
//    au trousseau (service com.omp.console.remote-api.cli, compte hôte:port).
//  * Sans article de trousseau, la requête part SANS en-tête Authorization et
//    le refus du serveur est rapporté (AC-21) : aucun jeton inventé, aucun
//    appel omis.
//
// PIÈGES MESURÉS (2026-10-06, Bun 1.4.0, macOS 27.2) :
//  * `security find-generic-password -w` rend le mot de passe sur stdout avec un
//    saut de ligne final ; il faut le rogner avant de lire le JSON.
//  * un `fetch` vers un port fermé rejette (TypeError) au lieu de rendre une
//    réponse : c'est le seul signal d'injoignabilité, à traduire en sortie 2.
//  * `for await (const chunk of response.body)` itère les octets du flux SSE :
//    il faut reconstituer les lignes et ne pas confondre les lignes `: ping`
//    (cœur du flux) avec un événement.
import * as fs from "node:fs";
import * as os from "node:os";

/** Protocole et en-tête figés par le contrat (ConsoleAPI.protocolVersion). */
const PROTOCOL_VERSION = 1;
const PROTOCOL_HEADER = "X-Console-Protocol-Version";
const DEFAULT_URL = "http://127.0.0.1:8787";
/** `security(1)` vit ici sur macOS ; ailleurs, prérequis absent (sortie 2). */
const SECURITY = "/usr/bin/security";
const KEYCHAIN_SERVICE = "com.omp.console.remote-api.cli";

interface Pairing {
  deviceId: string;
  token: string;
}

// ---------------------------------------------------------------------------
// 1. Arguments : `--url` partout, `--flag valeur`, le reste positionnel
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const flags: Record<string, string | true> = {};
const positionals: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith("--")) {
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  } else {
    positionals.push(arg);
  }
}

const flag = (name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);

function usage(): void {
  console.log(`usage : bun scripts/omp-console-api.ts <commande> [options]

commandes :
  pair --code <code> [--name <nom>]                s'appairer et ranger le jeton au trousseau
  status                                           protocole et état d'appairage
  snapshot                                         compteurs du magasin et runs vivants
  sessions [<id>]                                  liste des runs ou détail d'une session
  docs <repoKey>                                   documents d'un projet
  stats [--project <repoKey>]                       statistiques du projet
  memory [--query <q>] [--scope <s>] [--graph]     mémoire du projet
  watch [--seconds <n>]                            suit le flux (store, sessions, hosted, devices)
  answer <cardId> (--option <libellé>|--text <texte>)
  reply <cardId> --text <t>
  steer <cardId> --text <t>
  verdict <cardId> (--specs|--review)
  resume <cardId>
  stop <cardId>
  launch --repo <chemin> --title <t> --description <d> [--model-req-specs <m>] [--model-impl-review <m>]
  conduite <repoKey> --name <n>
  close-conduite <repoKey>
  prompt <message>
  session
  prs <repoKey>
  merge <repoKey> <slug> --confirm <headOid>
  repos                                            dépôts connus de la coque
  conduite-state                                   état réduit de la conduite
  answer-dialog <id> (--value <v>|--confirm|--decline|--cancel)
  forget                                           supprime l'appairage du trousseau

options :
  --url <http://hôte:port>                         défaut ${DEFAULT_URL}`);
}

// ---------------------------------------------------------------------------
// 2. URL de base : toute valeur non `http(s)://hôte[:port]` est refusée
// ---------------------------------------------------------------------------
interface Base {
  origin: string;
  account: string;
}

function parseBase(raw: string): Base | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return { origin: url.origin, account: `${url.hostname}:${port}` };
}

// ---------------------------------------------------------------------------
// 3. Trousseau : `security` est le seul dépositaire du jeton
// ---------------------------------------------------------------------------
/** Refus/échec : code partagé puis message du serveur, tels quels, sortie 1. */
function refuse(code: string, message?: string): never {
  console.log(`refusé : ${code}`);
  if (message) console.log(message);
  process.exit(1);
}

function unreadable(body: string): never {
  console.log(`réponse illisible : ${body.slice(0, 200)}`);
  process.exit(1);
}

function readToken(account: string): Pairing | null {
  const result = Bun.spawnSync([SECURITY, "find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) return null;
  const raw = result.stdout.toString().trim();
  try {
    const parsed = JSON.parse(raw) as Partial<Pairing>;
    if (typeof parsed.token !== "string" || parsed.token === "") return null;
    return { deviceId: parsed.deviceId ?? "", token: parsed.token };
  } catch {
    return null;
  }
}

function writeToken(account: string, pairing: Pairing): void {
  const result = Bun.spawnSync(
    [SECURITY, "add-generic-password", "-U", "-a", account, "-s", KEYCHAIN_SERVICE, "-w", JSON.stringify(pairing)],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) {
    console.log(`trousseau : écriture refusée (${result.stderr.toString().trim()})`);
    process.exit(1);
  }
}

function deleteToken(account: string): boolean {
  const result = Bun.spawnSync([SECURITY, "delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return result.exitCode === 0;
}

// ---------------------------------------------------------------------------
// 4. Transport : en-têtes, appel JSON, flux SSE
// ---------------------------------------------------------------------------
let base: Base;

function authHeaders(pairing: Pairing | null): Record<string, string> {
  const headers: Record<string, string> = { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) };
  // Sans jeton, on n'ajoute RIEN : l'appel part quand même (AC-21).
  if (pairing) headers["Authorization"] = `Bearer ${pairing.token}`;
  return headers;
}

interface CallOptions {
  pairing?: Pairing | null;
  body?: unknown;
}

async function callJson(method: string, routePath: string, options: CallOptions = {}): Promise<unknown> {
  const hasBody = options.body !== undefined;
  const headers: Record<string, string> = {
    ...authHeaders(options.pairing ?? null),
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
  let response: Response;
  try {
    response = await fetch(`${base.origin}${routePath}`, {
      method,
      headers,
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    console.log(`OMP Console ne répond pas sur ${base.origin}`);
    process.exit(2);
  }
  const text = await response.text();
  if (!response.ok) {
    let code = "";
    let message: string | undefined;
    try {
      const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
      if (typeof parsed?.error?.code === "string") code = parsed.error.code;
      if (typeof parsed?.error?.message === "string") message = parsed.error.message;
    } catch {
      unreadable(text);
    }
    if (!code) unreadable(text);
    refuse(code, message);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    unreadable(text);
  }
}

// ---------------------------------------------------------------------------
// 5. Rendu : une ligne par information, en français
// ---------------------------------------------------------------------------
const STORE_LABELS: Record<string, string> = {
  running: "exécutions",
  history: "historique",
  lots: "lots",
  projects: "projets",
  inbox: "boîte de réception",
  audit: "relais",
};
const ENTRY_KEYS: Record<string, string> = {
  running: "entries",
  history: "entries",
  lots: "lots",
  projects: "projects",
  inbox: "boxes",
  audit: "relays",
};
const STORES = ["running", "history", "lots", "projects", "inbox", "audit"] as const;

type Dict = Record<string, unknown>;

function asRecord(value: unknown): Dict {
  return typeof value === "object" && value !== null ? (value as Dict) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function countOf(value: unknown): number {
  return asArray(value).length;
}

/** Résumé d'une entrée inconnue : un champ parlant sinon le JSON borné. */
function describe(value: unknown): string {
  const record = asRecord(value);
  for (const key of ["label", "name", "title", "sessionFile", "file", "id", "slug", "number"]) {
    const field = record[key];
    if (typeof field === "string" || typeof field === "number") return String(field);
  }
  const json = JSON.stringify(value);
  return json.length > 160 ? `${json.slice(0, 160)}…` : json;
}

function printSnapshot(data: unknown): void {
  const snapshot = asRecord(asRecord(data)["snapshot"]);
  console.log(`racine : ${typeof snapshot["root"] === "string" ? snapshot["root"] : "inconnu"}`);
  for (const key of STORES) {
    const store = asRecord(snapshot[key]);
    if (Object.keys(store).length === 0) continue;
    const items = countOf(store[ENTRY_KEYS[key]]);
    const discarded = countOf(store["discardedEntries"]);
    console.log(`${STORE_LABELS[key]} : ${String(store["availability"] ?? "inconnu")} — ${items} élément(s), ${discarded} écarté(s)`);
  }
  for (const run of asArray(asRecord(snapshot["running"])["entries"])) {
    console.log(`run vivant : ${describe(run)}`);
  }
}

function printMemoryRows(rows: unknown[]): void {
  for (const row of rows) {
    const record = asRecord(row);
    console.log(`souvenir : ${typeof record["id"] === "string" ? record["id"] : "?"} — ${String(record["text"] ?? describe(row))}`);
  }
}

// ---------------------------------------------------------------------------
// 6. Commandes
// ---------------------------------------------------------------------------
async function cmdPair(account: string): Promise<void> {
  const code = flag("code");
  if (!code) {
    console.log("--code manquant");
    process.exit(2);
  }
  const name = flag("name") ?? os.hostname();
  const data = asRecord(await callJson("POST", "/v1/pair", { pairing: null, body: { code, name, protocolVersion: PROTOCOL_VERSION } }));
  const token = typeof data["token"] === "string" ? data["token"] : "";
  const deviceId = typeof data["deviceId"] === "string" ? data["deviceId"] : "";
  if (!token) unreadable(JSON.stringify(data));
  writeToken(account, { deviceId, token });
  console.log(`appairé : ${deviceId || "appareil inconnu"}`);
}

async function cmdStatus(pairing: Pairing | null): Promise<void> {
  const data = asRecord(await callJson("GET", "/v1/version", { pairing }));
  console.log(`protocole : ${data["protocolVersion"] ?? "?"}`);
  console.log(`appairé : ${pairing ? "oui" : "non"}`);
}

async function cmdSnapshot(pairing: Pairing | null): Promise<void> {
  printSnapshot(await callJson("GET", "/v1/store", { pairing }));
}

async function cmdSessions(pairing: Pairing | null, rest: string[]): Promise<void> {
  const id = rest[0];
  if (id) {
    const data = asRecord(await callJson("GET", `/v1/sessions/${encodeURIComponent(id)}`, { pairing }));
    const entries = asArray(data["entries"]).length;
    const skipped = asArray(data["skipped"]).length;
    console.log(`session : ${data["kind"] ?? "?"} — ${entries} entrée(s), ${skipped} ignorée(s)${data["truncated"] ? " (tronquée)" : ""}`);
    return;
  }
  const data = asRecord(await callJson("GET", "/v1/sessions", { pairing }));
  for (const run of asArray(data["runs"])) {
    const record = asRecord(run);
    const etat = record["live"] ? "vivant" : String(record["finalState"] ?? "arrêté");
    console.log(`run : ${record["label"] ?? record["sessionFile"] ?? "?"} — ${record["phase"] ?? "?"} — ${etat}`);
  }
}

async function cmdDocs(pairing: Pairing | null, rest: string[]): Promise<void> {
  const repoKey = rest[0];
  if (!repoKey) {
    console.log("repoKey manquant");
    process.exit(2);
  }
  const data = asRecord(await callJson("GET", `/v1/projects/${encodeURIComponent(repoKey)}/documents`, { pairing }));
  for (const doc of asArray(data["documents"])) {
    const record = asRecord(doc);
    console.log(`${record["name"] ?? "?"} : ${record["state"] ?? "?"}${record["reason"] ? ` — ${record["reason"]}` : ""}`);
    if (record["state"] === "text" && typeof record["content"] === "string") console.log(record["content"]);
  }
}

async function cmdStats(pairing: Pairing | null): Promise<void> {
  const project = flag("project");
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  const data = asRecord(await callJson("GET", `/v1/stats${query}`, { pairing }));
  console.log(`projet : ${data["project"] || "(aucun)"} — clé : ${data["projectKey"] ?? "(aucune)"}`);
  console.log(`projets : ${countOf(data["projects"])}`);
  console.log(`features listées : ${countOf(data["features"])} — masquées : ${data["hiddenPlanFeatures"] ?? "?"}`);
  for (const feature of asArray(data["features"])) {
    const row = asRecord(feature);
    console.log(
      `feature : ${row["slug"] ?? "?"} — entrée : ${row["input"] ?? "?"} — sortie : ${row["output"] ?? "?"}` +
        ` — tours : ${row["turns"] ?? "?"} — durée : ${row["durationMs"] ?? "?"} ms` +
        ` — runs vivants : ${row["liveRuns"] ?? "?"} — modèle : ${row["model"] ?? "—"}`,
    );
  }
}

async function cmdMemory(pairing: Pairing | null): Promise<void> {
  const scope = flag("scope");
  const query = flag("query");
  if (flags["graph"] === true) {
    const params = new URLSearchParams();
    if (scope) params.set("scope", scope);
    const queryString = params.toString();
    const data = asRecord(await callJson("GET", `/v1/memory/graph${queryString ? `?${queryString}` : ""}`, { pairing }));
    console.log(`graphe : ${countOf(data["nodes"])} nœud(s), ${countOf(data["links"])} lien(s), total ${data["total"] ?? "?"}`);
    for (const node of asArray(data["nodes"])) console.log(`nœud : ${describe(node)}`);
    for (const link of asArray(data["links"])) console.log(`lien : ${describe(link)}`);
    return;
  }
  if (query) {
    const params = new URLSearchParams({ q: query });
    if (scope) params.set("scope", scope);
    const data = asRecord(await callJson("GET", `/v1/memory/search?${params.toString()}`, { pairing }));
    console.log(`recherche : ${countOf(data["rows"])} résultat(s) sur ${data["candidates"] ?? "?"} candidat(s) (${data["scored"] ?? "?"} notés)`);
    printMemoryRows(asArray(data["rows"]));
    return;
  }
  const params = new URLSearchParams();
  if (scope) params.set("scope", scope);
  const queryString = params.toString();
  const data = asRecord(await callJson("GET", `/v1/memory${queryString ? `?${queryString}` : ""}`, { pairing }));
  console.log(`mémoire : ${data["total"] ?? "?"} souvenir(s)`);
  printMemoryRows(asArray(data["rows"]));
}

function printStreamEvent(name: string, data: unknown): void {
  if (name === "hello") {
    console.log(`protocole : ${asRecord(data)["protocolVersion"] ?? "?"}`);
    return;
  }
  if (name === "store") {
    printSnapshot({ snapshot: data });
    return;
  }
  if (name === "sessions") {
    const record = asRecord(data);
    const file = String(record["file"] ?? "?");
    if (record["issue"]) {
      console.log(`session : ${file} — ${record["issue"]}`);
      return;
    }
    console.log(`session : ${file} — ${countOf(record["added"])} nouvelle(s) entrée(s)`);
    return;
  }
  if (name === "hosted") {
    const record = asRecord(data);
    console.log(
      `coque : ${record["state"] ?? "?"} — ${countOf(record["dialogs"])} dialogue(s) — ${countOf(record["added"])} ajout(s)`,
    );
    return;
  }
  if (name === "devices") {
    console.log(`appareils : ${countOf(asRecord(data)["devices"])}`);
    return;
  }
  console.log(`${name || "événement"} : reçu`);
}

async function cmdWatch(pairing: Pairing | null): Promise<void> {
  const seconds = Number(flag("seconds"));
  const duration = Number.isFinite(seconds) && seconds > 0 ? seconds : 10;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), duration * 1000);
  const onInterrupt = () => controller.abort();
  process.on("SIGINT", onInterrupt);
  let response: Response;
  try {
    response = await fetch(`${base.origin}/v1/stream`, { headers: authHeaders(pairing), signal: controller.signal });
  } catch {
    clearTimeout(timer);
    console.log(`OMP Console ne répond pas sur ${base.origin}`);
    process.exit(2);
  }
  if (!response.ok) {
    clearTimeout(timer);
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
      refuse(parsed?.error?.code ?? "server", parsed?.error?.message);
    } catch {
      unreadable(text);
    }
  }
  if (!response.body) {
    clearTimeout(timer);
    unreadable("(corps vide)");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "";
  const dataLines: string[] = [];
  const flush = () => {
    if (eventName === "" && dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    let parsed: unknown = null;
    if (raw !== "") {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        parsed = raw;
      }
    }
    printStreamEvent(eventName, parsed);
    eventName = "";
    dataLines.length = 0;
  };
  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          flush();
        } else if (line.startsWith(":")) {
          // battement de cœur : ignoré
        } else if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        newline = buffer.indexOf("\n");
      }
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    if (!aborted) {
      clearTimeout(timer);
      console.log(`flux interrompu : ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
  clearTimeout(timer);
  process.removeListener("SIGINT", onInterrupt);
}

async function cmdCard(pairing: Pairing | null, cardId: string, action: string, body: unknown, method = "POST"): Promise<void> {
  await callJson(method, `/v1/cards/${encodeURIComponent(cardId)}/${action}`, { pairing, body });
  console.log("accepté");
}

async function cmdLaunch(pairing: Pairing | null): Promise<void> {
  const repoRoot = flag("repo");
  const title = flag("title");
  const description = flag("description");
  if (!repoRoot || !title || !description) {
    console.log("--repo, --title et --description sont requis");
    process.exit(2);
  }
  await callJson("POST", "/v1/features", {
    pairing,
    body: {
      repoRoot,
      title,
      description,
      modelReqSpecs: flag("model-req-specs") ?? null,
      modelImplReview: flag("model-impl-review") ?? null,
    },
  });
  console.log("demande acceptée");
}

async function cmdConduite(pairing: Pairing | null, rest: string[], close: boolean): Promise<void> {
  const repoKey = rest[0];
  if (!repoKey) {
    console.log("repoKey manquant");
    process.exit(2);
  }
  const routePath = `/v1/projects/${encodeURIComponent(repoKey)}/conduite`;
  const data = asRecord(
    close
      ? await callJson("DELETE", routePath, { pairing })
      : await callJson("POST", routePath, { pairing, body: { name: flag("name") ?? "" } }),
  );
  console.log(`conduite : ${data["state"] ?? "?"}`);
}

async function cmdPrompt(pairing: Pairing | null, rest: string[]): Promise<void> {
  const message = rest.join(" ");
  if (!message) {
    console.log("message manquant");
    process.exit(2);
  }
  await callJson("POST", "/v1/session/prompt", { pairing, body: { message } });
  console.log("prompt envoyé");
}

async function cmdSession(pairing: Pairing | null): Promise<void> {
  const data = asRecord(await callJson("GET", "/v1/session", { pairing }));
  console.log(`état : ${data["state"] ?? "?"} (${data["stateLabel"] ?? "?"})`);
  if (typeof data["sessionId"] === "string") console.log(`session : ${data["sessionId"]}`);
  if (typeof data["sessionFile"] === "string") console.log(`fichier : ${data["sessionFile"]}`);
  if (data["protocolVersion"] !== null && data["protocolVersion"] !== undefined) {
    console.log(`protocole : ${data["protocolVersion"]}`);
  }
  console.log(`dialogues : ${countOf(data["dialogs"])} — transcription : ${countOf(data["transcript"])}${data["truncated"] ? " (tronquée)" : ""}`);
}

async function cmdPrs(pairing: Pairing | null, rest: string[]): Promise<void> {
  const repoKey = rest[0];
  if (!repoKey) {
    console.log("repoKey manquant");
    process.exit(2);
  }
  const data = asRecord(await callJson("GET", `/v1/projects/${encodeURIComponent(repoKey)}/pull-requests`, { pairing }));
  if (typeof data["failure"] === "string" && data["failure"]) console.log(`échec : ${data["failure"]}`);
  console.log(`PR : ${countOf(data["rows"])}${data["stale"] ? " (périmées)" : ""}`);
  for (const row of asArray(data["rows"])) console.log(`  ${describe(row)}`);
}

async function cmdMerge(pairing: Pairing | null, rest: string[]): Promise<void> {
  const repoKey = rest[0];
  const slug = rest[1];
  const headOid = flag("confirm");
  if (!repoKey || !slug || !headOid) {
    console.log("repoKey, slug et --confirm <headOid> sont requis");
    process.exit(2);
  }
  const data = asRecord(
    await callJson("POST", `/v1/projects/${encodeURIComponent(repoKey)}/pull-requests/${encodeURIComponent(slug)}/merge`, {
      pairing,
      body: { headOid },
    }),
  );
  console.log(`fusionnée : #${data["number"] ?? "?"} ${data["url"] ?? ""}`.trim());
}

async function cmdRepos(pairing: Pairing | null): Promise<void> {
  const data = asRecord(await callJson("GET", "/v1/repos", { pairing }));
  const rows = asArray(data["rows"]);
  console.log(`dépôts : ${rows.length}`);
  for (const row of rows) {
    const repo = asRecord(row);
    console.log(`  ${repo["name"] ?? "?"} — ${repo["repoRoot"] ?? "?"} (${repo["repoKey"] ?? "?"})`);
  }
}

async function cmdConduiteState(pairing: Pairing | null): Promise<void> {
  const data = asRecord(await callJson("GET", "/v1/conduite", { pairing }));
  const status = asRecord(data["status"]);
  const pill = typeof status["text"] === "string" ? ` (${status["text"]})` : "";
  console.log(`conduite : ${data["state"] ?? "?"}${pill}`);
  if (typeof data["name"] === "string") console.log(`projet : ${data["name"]}`);
  if (typeof data["repoRoot"] === "string") console.log(`dépôt : ${data["repoRoot"]}`);
  console.log(`escalades : ${countOf(data["dialogs"])}`);
}

async function cmdAnswerDialog(pairing: Pairing | null, rest: string[]): Promise<void> {
  const id = rest[0];
  if (!id) {
    console.log("id de l'escalade manquant");
    process.exit(2);
  }
  const value = flag("value");
  let body: Record<string, unknown>;
  if (value !== undefined) body = { kind: "value", value };
  else if (flags["confirm"] === true) body = { kind: "confirmed", confirmed: true };
  else if (flags["decline"] === true) body = { kind: "confirmed", confirmed: false };
  else if (flags["cancel"] === true) body = { kind: "cancelled" };
  else {
    console.log("--value, --confirm, --decline ou --cancel est requis");
    process.exit(2);
  }
  await callJson("POST", `/v1/conduite/dialogs/${encodeURIComponent(id)}`, { pairing, body });
  console.log("accepté");
}

// ---------------------------------------------------------------------------
// 7. Aiguillage
// ---------------------------------------------------------------------------
const command = positionals[0];
if (!command) {
  usage();
  process.exit(2);
}
const rawUrl = flag("url") ?? DEFAULT_URL;
const parsedBase = parseBase(rawUrl);
if (!parsedBase) {
  console.log(`URL invalide : ${rawUrl}`);
  process.exit(2);
}
base = parsedBase;
if (!fs.existsSync(SECURITY)) {
  console.log(`${SECURITY} introuvable`);
  process.exit(2);
}
const rest = positionals.slice(1);
const pairing = command === "pair" || command === "forget" ? null : readToken(base.account);

switch (command) {
  case "pair":
    await cmdPair(base.account);
    break;
  case "status":
    await cmdStatus(pairing);
    break;
  case "snapshot":
    await cmdSnapshot(pairing);
    break;
  case "sessions":
    await cmdSessions(pairing, rest);
    break;
  case "docs":
    await cmdDocs(pairing, rest);
    break;
  case "stats":
    await cmdStats(pairing);
    break;
  case "memory":
    await cmdMemory(pairing);
    break;
  case "watch":
    await cmdWatch(pairing);
    break;
  case "answer": {
    const cardId = rest[0];
    if (!cardId) {
      console.log("cardId manquant");
      process.exit(2);
    }
    const option = flag("option");
    const text = flag("text");
    if (option !== undefined) await cmdCard(pairing, cardId, "answer", { kind: "selected", label: option });
    else if (text !== undefined) await cmdCard(pairing, cardId, "answer", { kind: "custom", text });
    else {
      console.log("--option ou --text est requis");
      process.exit(2);
    }
    break;
  }
  case "reply":
  case "steer": {
    const cardId = rest[0];
    const text = flag("text");
    if (!cardId || text === undefined) {
      console.log("cardId et --text sont requis");
      process.exit(2);
    }
    await cmdCard(pairing, cardId, command === "reply" ? "reply" : "text", { text });
    break;
  }
  case "verdict": {
    const cardId = rest[0];
    if (!cardId) {
      console.log("cardId manquant");
      process.exit(2);
    }
    const verdict = flags["specs"] === true ? "specs" : flags["review"] === true ? "review" : null;
    if (!verdict) {
      console.log("--specs ou --review est requis");
      process.exit(2);
    }
    await cmdCard(pairing, cardId, "verdict", { verdict });
    break;
  }
  case "resume":
  case "stop": {
    const cardId = rest[0];
    if (!cardId) {
      console.log("cardId manquant");
      process.exit(2);
    }
    await cmdCard(pairing, cardId, command, undefined);
    break;
  }
  case "launch":
    await cmdLaunch(pairing);
    break;
  case "conduite":
  case "close-conduite":
    await cmdConduite(pairing, rest, command === "close-conduite");
    break;
  case "prompt":
    await cmdPrompt(pairing, rest);
    break;
  case "session":
    await cmdSession(pairing);
    break;
  case "prs":
    await cmdPrs(pairing, rest);
    break;
  case "merge":
    await cmdMerge(pairing, rest);
    break;
  case "repos":
    await cmdRepos(pairing);
    break;
  case "conduite-state":
    await cmdConduiteState(pairing);
    break;
  case "answer-dialog":
    await cmdAnswerDialog(pairing, rest);
    break;
  case "forget":
    if (deleteToken(base.account)) console.log("appairage supprimé");
    else console.log("aucun appairage à supprimer");
    break;
  default:
    console.log(`commande inconnue : ${command}`);
    usage();
    process.exit(2);
}
process.exit(0);
