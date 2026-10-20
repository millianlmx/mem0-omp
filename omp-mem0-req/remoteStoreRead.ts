// La LECTURE du magasin `<stateDir>` en forme filaire : le portage de
// `StoreReader.swift` (`omp-console/Sources/OMPConsole/Store/`) et des validateurs
// de `ConsoleCore/Store/StoreModels.swift`, `ConsoleCore/Audit/AuditModels.swift`,
// `ConsoleCore/Store/ArbiterDecisions.swift`.
//
// Pourquoi un décodeur propre plutôt que `asLot`/`asProject` de `lot.ts`/`project.ts` :
// le Swift est la référence de la forme filaire, et il lit des champs que les
// lecteurs TS laissent tomber (`model` legacy d'une feature de projet, `quota`
// réduit à un booléen, `ownerPid` non entier lu absent) ou lit autrement (un
// `waitKind` absent rejette le lot, un `prUrl` vide est conservé). Chaque règle
// ci-dessous reproduit celle de la fonction Swift citée.
//
// Lecteur seulement : aucune écriture, jamais (S-10) — les propriétaires morts ne
// sont ni déplacés vers `history/` ni retirés.
import * as fs from "node:fs";
import * as path from "node:path";
import { HISTORY_READ_LIMIT, RUNNING_READ_LIMIT } from "./store.ts";
import { LOT_OWNER_STALE_MS } from "./lot.ts";
import type {
  WireArbiterDecision,
  WireArbitration,
  WireCi,
  WireAuditDecision,
  WireAuditEnvelope,
  WireAuditLaunch,
  WireAuditProposalElement,
  WireAuditRecord,
  WireAuditRelay,
  WireAuditsEnvelope,
  WireAvailability,
  WireDelivery,
  WireDiscardedEntry,
  WireEscalation,
  WireHeldLaunch,
  WireHistoryEntry,
  WireInboxBox,
  WireInboxEnvelope,
  WireInboxDelivery,
  WireLot,
  WireLotEnvelope,
  WireLotFeature,
  WirePendingAsk,
  WireProject,
  WireProjectEnvelope,
  WireProjectFeature,
  WireProjectSegment,
  WireRunningEntry,
  WireStoreSnapshot,
  WireAskOption,
} from "./remoteWire.ts";

export type StoreReadOptions = {
  stateDir: string;
  now: () => number;
  pidAlive: (pid: number) => boolean;
};

type Obj = Record<string, unknown>;

// --- accès typés au JSON (`asString`, `asNumber`… de StoreModels.swift) -----------

const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);

/** `typeof === "string"` : la chaîne VIDE passe. */
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** `asStringOrNull` : une chaîne non vide seulement. */
const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const isBlank = (text: string): boolean => text.trim() === "";

/** Une chaîne non blanche (`asNonBlankString`). */
const nonBlank = (value: unknown): string | undefined =>
  typeof value === "string" && !isBlank(value) ? value : undefined;

const integer = (value: unknown): number | undefined => {
  const n = num(value);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
};

const count = (value: unknown): number => Math.max(0, Math.trunc(num(value) ?? 0));

const isVersion1 = (value: unknown): boolean => num(value) === 1;

/** Retire les clés `undefined` : un optionnel nil de Swift n'a pas de clé. */
function defined<T extends Obj>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

const PHASES = ["req", "specs", "impl", "review", "release"] as const;
const FEATURE_STATES = ["pending", "running", "waiting", "blocked", "failed", "done", "cancelled"] as const;

/** La valeur d'un vocabulaire fermé, ou `undefined` (hors vocabulaire). */
function oneOf<T extends string>(value: unknown, vocabulary: readonly T[]): T | undefined {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value) ? (value as T) : undefined;
}

const isLowerHex = (text: string): boolean => /^[0-9a-f]+$/u.test(text);
const isSlug = (text: string): boolean => /^[a-z0-9][a-z0-9-]*$/u.test(text);
const isAuditId = (text: string): boolean => /^[0-9a-f]{16}$/u.test(text);

/** `asLotBaseSha` : 40 ou 64 hexadécimaux minuscules. */
function baseSha(value: unknown): string | undefined {
  return typeof value === "string" && (value.length === 40 || value.length === 64) && isLowerHex(value)
    ? value
    : undefined;
}

/** Une liste de chaînes, tout ou rien. */
function allStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    out.push(item);
  }
  return out;
}

/** `joinPath` : le séparateur n'est jamais doublé, jamais absent (pas de normalisation). */
function joinPath(base: string, name: string): string {
  if (base === "") return name;
  return base.endsWith("/") ? base + name : `${base}/${name}`;
}

const first = (value: string, limit: number): string => [...value].slice(0, limit).join("");

// --- péremption (S-7) -------------------------------------------------------------

/** `pidAlive` Swift : un pid ≤ 0 est mort, un pid hors de `pid_t` est vivant (jamais piégé). */
function alive(pid: number, options: StoreReadOptions): boolean {
  if (pid <= 0) return false;
  if (pid > 2147483647) return true;
  return options.pidAlive(pid);
}

// --- le balayage commun des stores plats ------------------------------------------

/** `.absent` quand le répertoire n'existe pas ou n'est pas un répertoire. */
function directoryAvailability(dir: string): WireAvailability {
  try {
    return fs.statSync(dir).isDirectory() ? "present" : "absent";
  } catch {
    return "absent";
  }
}

/** Les noms d'un répertoire, triés ; absent ou illisible ⇒ `[]`. */
function fileNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  } catch {
    return [];
  }
}

/** `STORE_FILE` : `^[0-9a-f]{16}\.json$`, le seul nom qu'un store plat lit. */
const isStoreEntryName = (name: string): boolean => /^[0-9a-f]{16}\.json$/u.test(name);

/** `^[0-9a-f]{16}-[0-9]+$` : un nom de boîte produit par `panelInboxDirFor`. */
const isInboxBoxName = (name: string): boolean => /^[0-9a-f]{16}-[0-9]+$/u.test(name);

/** Le fichier lu et parsé : `undefined` quand le contenu n'est pas du JSON (ou illisible). */
function readJson(file: string): { value: unknown } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

type Scan<T> = { availability: WireAvailability; entries: T[]; discardedEntries: WireDiscardedEntry[] };

/**
 * `StoreReader.scan` : noms conformes triés, un fichier illisible ou au schéma invalide
 * est ÉCARTÉ et NOMMÉ (`<store>/<nom>`) ; tout autre nom est ignoré sans être compté.
 */
function scan<T>(
  stateDir: string,
  store: string,
  decode: (name: string, json: unknown) => T | undefined,
): Scan<T> {
  const dir = joinPath(stateDir, store);
  const entries: T[] = [];
  const discardedEntries: WireDiscardedEntry[] = [];
  for (const name of fileNames(dir)) {
    if (!isStoreEntryName(name)) continue;
    const cited = `${store}/${name}`;
    const parsed = readJson(joinPath(dir, name));
    if (parsed === undefined) {
      discardedEntries.push({ file: cited, reason: "unparsable" });
      continue;
    }
    const entry = decode(name, parsed.value);
    if (entry === undefined) discardedEntries.push({ file: cited, reason: "schema" });
    else entries.push(entry);
  }
  return { availability: directoryAvailability(dir), entries, discardedEntries };
}

// --- running/ et history/ ---------------------------------------------------------

/** `asPendingAskDecode` : `null` = absent, `"invalid"` = mal typé (rejette l'entrée). */
function decodePendingAsk(raw: unknown): WirePendingAsk | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw)) return "invalid";
  const toolCallId = nonEmpty(raw.toolCallId);
  const id = str(raw.id);
  const question = str(raw.question);
  if (toolCallId === undefined || id === undefined || question === undefined) return "invalid";
  if (!Array.isArray(raw.options)) return "invalid";
  const options: WireAskOption[] = [];
  for (const rawOption of raw.options) {
    if (!isObject(rawOption)) return "invalid";
    const label = nonEmpty(rawOption.label);
    if (label === undefined) return "invalid";
    if ("description" in rawOption) {
      // Présente et non textuelle (`null` compris) ⇒ rejet ; vide ⇒ non rendue.
      const description = str(rawOption.description);
      if (description === undefined) return "invalid";
      options.push(defined({ label, description: description === "" ? undefined : description }));
    } else {
      options.push({ label });
    }
  }
  if (options.length === 0) return "invalid";
  return { toolCallId, id, question, options };
}

/** `RunningEntry.init?(json:nowMs:)`. */
function decodeRunning(json: unknown, options: StoreReadOptions): WireRunningEntry | undefined {
  if (!isObject(json) || !isVersion1(json.version)) return undefined;
  const { id, cwd, label } = { id: str(json.id), cwd: str(json.cwd), label: str(json.label) };
  if (id === undefined || cwd === undefined || label === undefined) return undefined;
  const phase = oneOf(json.phase, PHASES);
  const state = oneOf(json.state, ["running", "waiting"] as const);
  if (phase === undefined || state === undefined) return undefined;
  const phaseStartedAt = num(json.phaseStartedAt);
  const updatedAt = num(json.updatedAt);
  if (phaseStartedAt === undefined || updatedAt === undefined) return undefined;
  if (!isObject(json.owner) || num(json.owner.pid) === undefined) return undefined;
  const pendingAsk = decodePendingAsk(json.pendingAsk);
  if (pendingAsk === "invalid") return undefined;
  // `inbox` : absent ou nul ⇒ nil ; TOUT AUTRE TYPE que chaîne ⇒ rejet.
  if (json.inbox !== undefined && json.inbox !== null && typeof json.inbox !== "string") return undefined;
  const ownerPid = integer(json.owner.pid);
  const isStale =
    ownerPid === undefined || !alive(ownerPid, options) || options.now() - updatedAt > LOT_OWNER_STALE_MS;
  return defined({
    id,
    cwd,
    label,
    phase,
    state,
    phaseStartedAt,
    updatedAt,
    sessionFile: nonEmpty(json.sessionFile),
    sessionId: nonEmpty(json.sessionId),
    ownerPid,
    inbox: nonEmpty(json.inbox),
    pendingAsk: pendingAsk ?? undefined,
    isStale,
  });
}

/** `HistoryEntry.init?(json:)`. */
function decodeHistory(json: unknown): WireHistoryEntry | undefined {
  if (!isObject(json) || !isVersion1(json.version)) return undefined;
  const id = str(json.id);
  const cwd = str(json.cwd);
  const label = str(json.label);
  if (id === undefined || cwd === undefined || label === undefined) return undefined;
  const phase = oneOf(json.phase, PHASES);
  const finalState = oneOf(json.finalState, ["done", "failed"] as const);
  if (phase === undefined || finalState === undefined) return undefined;
  const phaseStartedAt = num(json.phaseStartedAt);
  const endedAt = num(json.endedAt);
  if (phaseStartedAt === undefined || endedAt === undefined) return undefined;
  return defined({
    id,
    cwd,
    label,
    phase,
    finalState,
    sessionFile: nonEmpty(json.sessionFile),
    sessionId: nonEmpty(json.sessionId),
    phaseStartedAt,
    endedAt,
  });
}

// --- lots/ ------------------------------------------------------------------------

/** `asHeldLaunch` : tolérant, absent ou incomplet vaut « absent ». */
function decodeHeld(raw: unknown): WireHeldLaunch | undefined {
  if (!isObject(raw)) return undefined;
  const phase = oneOf(raw.phase, PHASES);
  const kind = oneOf(raw.kind, ["collecte", "phase", "relaunch", "answer"] as const);
  if (phase === undefined || kind === undefined) return undefined;
  if (typeof raw.fix !== "boolean" || typeof raw.resume !== "boolean") return undefined;
  let text: string | undefined;
  if ("text" in raw) {
    const value = str(raw.text);
    if (value === undefined) return undefined;
    text = first(value, LOT_EDITOR_MAX);
  }
  return defined({ phase, fix: raw.fix, kind, resume: raw.resume, text });
}

/** `asFeatureEscalation` : relue COMPLÈTE ou absente. */
function decodeEscalation(raw: unknown): WireEscalation | undefined {
  if (!isObject(raw)) return undefined;
  const key = nonEmpty(raw.key);
  const kind = oneOf(raw.kind, ["question", "jalon", "plafond", "echec"] as const);
  const phase = oneOf(raw.phase, PHASES);
  const question = str(raw.question);
  const reason = str(raw.reason);
  const options = allStrings(raw.options);
  const at = num(raw.at);
  if (
    key === undefined ||
    kind === undefined ||
    phase === undefined ||
    question === undefined ||
    reason === undefined ||
    options === undefined ||
    at === undefined
  ) {
    return undefined;
  }
  return { key, kind, phase, question, options, reason, at };
}

/** `asFeatureArbitration` : clé et départ exigés ; étape absente ou inconnue ⇒ `queued`. */
function decodeArbitration(raw: unknown): WireArbitration | undefined {
  if (!isObject(raw)) return undefined;
  const key = nonEmpty(raw.key);
  const startedAt = num(raw.startedAt);
  if (key === undefined || startedAt === undefined) return undefined;
  return defined({
    key,
    startedAt,
    status: oneOf(raw.status, ["queued", "deciding"] as const) ?? "queued",
    decidingAt: num(raw.decidingAt),
  });
}

/** `asFeatureCi` (S-9) : sha, arbre, heure et état exigés ; une charge incomplète est lue comme absente. */
function decodeCi(raw: unknown): WireCi | undefined {
  if (!isObject(raw)) return undefined;
  const sha = nonEmpty(raw.sha);
  const tree = nonEmpty(raw.tree);
  const pushedAt = num(raw.pushedAt);
  const state = oneOf(raw.state, ["pending", "green", "red"] as const);
  if (sha === undefined || tree === undefined || pushedAt === undefined || state === undefined) return undefined;
  const failures = Array.isArray(raw.failures)
    ? raw.failures.flatMap((entry): Array<{ name: string; url: string }> =>
        isObject(entry) && typeof entry.name === "string" && typeof entry.url === "string" ? [{ name: entry.name, url: entry.url }] : [],
      )
    : [];
  return { sha, tree, pushedAt, state, checkedAt: num(raw.checkedAt) ?? null, failures };
}

const LOT_EDITOR_MAX = 4000;
const LOT_PENDING_MAX = 9;
const SLOTS_DEFAULT = 4;
const SLOTS_MAX = 32;

/** `LotFeature.init?(json:)`. */
function decodeFeature(json: unknown): WireLotFeature | undefined {
  if (!isObject(json)) return undefined;
  const slug = str(json.slug);
  if (slug === undefined || !isSlug(slug)) return undefined;
  const name = str(json.name);
  const branch = str(json.branch);
  const worktree = str(json.worktree);
  if (name === undefined || branch === undefined || worktree === undefined) return undefined;
  const state = oneOf(json.state, FEATURE_STATES);
  const phase = oneOf(json.phase, PHASES);
  const origin = oneOf(json.origin, ["session", "panneau"] as const);
  if (state === undefined || phase === undefined || origin === undefined) return undefined;
  // `waitKind` : la CLÉ doit être là ; `null` est valide ; hors vocabulaire ⇒ rejet.
  if (!("waitKind" in json)) return undefined;
  let waitKind: WireLotFeature["waitKind"];
  if (json.waitKind !== null) {
    waitKind = oneOf(json.waitKind, ["answer", "specs", "review", "ci"] as const);
    if (waitKind === undefined) return undefined;
  }
  const deps = Array.isArray(json.deps) ? json.deps.filter((d): d is string => typeof d === "string") : [];
  // Les textes vides tombent, l'ordre est conservé, puis la borne et le rognage.
  const pendingTexts = Array.isArray(json.pendingTexts)
    ? json.pendingTexts
        .filter((t): t is string => typeof t === "string" && !isBlank(t))
        .slice(0, LOT_PENDING_MAX)
        .map(t => first(t, LOT_EDITOR_MAX))
    : [];
  return defined({
    slug,
    name,
    branch,
    worktree,
    deps,
    origin,
    state,
    phase,
    waitKind,
    waitPrompt: nonEmpty(json.waitPrompt),
    sessionFile: nonEmpty(json.sessionFile),
    pendingTexts,
    prUrl: nonEmpty(json.prUrl),
    stopReason: nonEmpty(json.stopReason),
    fixes: count(json.fixes),
    reviewRuns: count(json.reviewRuns),
    unreadableRuns: count(json.unreadableRuns),
    autoResumes: count(json.autoResumes) > 0 ? count(json.autoResumes) : undefined,
    reviewHash: nonEmpty(json.reviewHash),
    // Un verdict hors vocabulaire est lu comme ABSENT.
    lastVerdict: oneOf(json.lastVerdict, ["blockers", "clean", "unreadable"] as const),
    lastBlockers: count(json.lastBlockers),
    lastRunSessionFile: nonEmpty(json.lastRunSessionFile),
    launched: json.launched === false ? (false as const) : undefined,
    auditSession: typeof json.auditSession === "string" && path.isAbsolute(json.auditSession) ? json.auditSession : undefined,
    relayKind: json.relayKind === "project" ? ("project" as const) : undefined,
    base: baseSha(json.base),
    model: nonBlank(json.model),
    modelReqSpecs: nonBlank(json.modelReqSpecs),
    modelImplReview: nonBlank(json.modelImplReview),
    held: decodeHeld(json.held),
    contractHash: nonEmpty(json.contractHash),
    addedAt: num(json.addedAt) ?? 0,
    sinceAt: num(json.sinceAt) ?? 0,
    updatedAt: num(json.updatedAt) ?? 0,
    endedAt: num(json.endedAt),
    escalation: decodeEscalation(json.escalation),
    arbitration: decodeArbitration(json.arbitration),
    ci: decodeCi(json.ci),
    quotaBlocked: isObject(json.quota) ? (true as const) : undefined,
  });
}

/** `Lot.init?(json:nowMs:)`. */
function decodeLot(json: unknown, options: StoreReadOptions): WireLot | undefined {
  if (!isObject(json) || !isVersion1(json.version)) return undefined;
  const id = nonEmpty(json.id);
  const repoRoot = nonEmpty(json.repoRoot);
  const status = oneOf(json.status, ["draft", "running"] as const);
  if (id === undefined || repoRoot === undefined || status === undefined) return undefined;
  if (!Array.isArray(json.features)) return undefined;
  // Une feature invalide fait rejeter le lot ENTIER.
  const features: WireLotFeature[] = [];
  for (const rawFeature of json.features) {
    const feature = decodeFeature(rawFeature);
    if (feature === undefined) return undefined;
    features.push(feature);
  }
  if (!isObject(json.owner) || num(json.owner.pid) === undefined) return undefined;
  const reviewCapRaw = num(json.reviewCap);
  const slotCapRaw = num(json.slotCap);
  const pid = integer(json.owner.pid);
  const heartbeatAt = num(json.owner.heartbeatAt);
  // `lotIsStale` : un lot SANS battement garde le pid pour seule autorité.
  const isStale =
    pid === undefined || !alive(pid, options)
      ? true
      : heartbeatAt === undefined
        ? false
        : options.now() - heartbeatAt > LOT_OWNER_STALE_MS;
  return defined({
    id,
    repoRoot,
    status,
    reviewCap: reviewCapRaw === undefined ? 1 : Math.max(1, Math.trunc(reviewCapRaw)),
    slotCap: slotCapRaw === undefined ? SLOTS_DEFAULT : Math.min(SLOTS_MAX, Math.max(1, Math.trunc(slotCapRaw))),
    recapAt: num(json.recapAt),
    owner: defined({
      pid,
      sessionFile: nonEmpty(json.owner.sessionFile),
      sessionId: nonEmpty(json.owner.sessionId),
      heartbeatAt,
    }),
    createdAt: num(json.createdAt) ?? 0,
    launchedAt: num(json.launchedAt),
    features,
    isStale,
    arbiter: json.arbiter === true ? (true as const) : undefined,
  });
}

// --- projects/ --------------------------------------------------------------------

/** `ProjectFeature.init?(json:)`. */
function decodeProjectFeature(json: unknown): WireProjectFeature | undefined {
  if (!isObject(json)) return undefined;
  const slug = str(json.slug);
  if (slug === undefined || !isSlug(slug)) return undefined;
  const intention = str(json.intention);
  const status = oneOf(json.status, ["planned", "launched", "pr", "merged", "failed", "removed"] as const);
  if (intention === undefined || status === undefined) return undefined;
  // `prUrl` : la CLÉ doit être présente et valoir `null` ou une chaîne (vide comprise).
  if (!("prUrl" in json) || (json.prUrl !== null && typeof json.prUrl !== "string")) return undefined;
  if (!("failure" in json)) return undefined;
  let failure: WireProjectFeature["failure"];
  if (json.failure !== null) {
    if (!isObject(json.failure)) return undefined;
    const kind = oneOf(json.failure.kind, ["lot", "launch", "pr"] as const);
    const reason = str(json.failure.reason);
    const at = num(json.failure.at);
    if (kind === undefined || reason === undefined || at === undefined) return undefined;
    failure = { kind, reason, at };
  }
  if (!("removedReason" in json) || (json.removedReason !== null && typeof json.removedReason !== "string")) {
    return undefined;
  }
  const updatedAt = num(json.updatedAt);
  if (updatedAt === undefined) return undefined;
  const removedReason = str(json.removedReason);
  // Les invariants du modèle : un échec sans motif, ou un motif sans échec, se lit comme absent.
  if ((status === "failed") !== (failure !== undefined)) return undefined;
  if ((status === "removed") !== (removedReason !== undefined)) return undefined;
  return defined({
    slug,
    intention,
    model: nonBlank(json.model),
    modelReqSpecs: nonBlank(json.modelReqSpecs),
    modelImplReview: nonBlank(json.modelImplReview),
    status,
    prUrl: str(json.prUrl),
    failure,
    removedReason,
    updatedAt,
  });
}

/** `Project.init?(json:)`. */
function decodeProject(json: unknown): WireProject | undefined {
  if (!isObject(json) || !isVersion1(json.version)) return undefined;
  const repoKey = nonEmpty(json.repoKey);
  const repoRoot = nonEmpty(json.repoRoot);
  // `relayKey` est une CLÉ de relais : le dépôt la veut ABSOLUE.
  const relayKey = str(json.relayKey);
  if (repoKey === undefined || repoRoot === undefined || relayKey === undefined || !relayKey.startsWith("/")) {
    return undefined;
  }
  const purpose = str(json.purpose);
  const fn = str(json.function);
  const status = oneOf(json.status, ["running", "stopped", "done"] as const);
  if (purpose === undefined || fn === undefined || status === undefined) return undefined;
  // Un projet à zéro segment est REJETÉ.
  if (!Array.isArray(json.segments) || json.segments.length === 0) return undefined;
  const segments: WireProjectSegment[] = [];
  for (const rawSegment of json.segments) {
    if (!isObject(rawSegment)) return undefined;
    const name = str(rawSegment.name);
    if (name === undefined || !Array.isArray(rawSegment.features)) return undefined;
    const features: WireProjectFeature[] = [];
    for (const rawFeature of rawSegment.features) {
      const feature = decodeProjectFeature(rawFeature);
      if (feature === undefined) return undefined;
      features.push(feature);
    }
    segments.push({ name, features });
  }
  const current = integer(json.current);
  if (current === undefined || current < 0 || current >= segments.length) return undefined;
  // `base` : la clé doit être présente et valoir `null` ou un objet complet.
  if (!("base" in json)) return undefined;
  let base: WireProject["base"];
  if (json.base !== null) {
    if (!isObject(json.base)) return undefined;
    const segment = integer(json.base.segment);
    const sha = baseSha(json.base.sha);
    if (segment === undefined || sha === undefined) return undefined;
    base = { segment, sha };
  }
  if (!("hostSession" in json) || (json.hostSession !== null && typeof json.hostSession !== "string")) {
    return undefined;
  }
  const createdAt = num(json.createdAt);
  const updatedAt = num(json.updatedAt);
  if (createdAt === undefined || updatedAt === undefined) return undefined;
  return defined({
    repoKey,
    repoRoot,
    relayKey,
    purpose,
    function: fn,
    status,
    segments,
    current,
    base,
    hostSession: str(json.hostSession),
    createdAt,
    updatedAt,
  });
}

// --- inbox/ -----------------------------------------------------------------------

/** `asDelivery` : `undefined` = fichier illisible ou de forme inconnue (conservé, sans charge). */
function decodeDelivery(raw: unknown): WireDelivery | undefined {
  if (!isObject(raw) || !isVersion1(raw.version)) return undefined;
  if (raw.kind === "text") {
    const text = str(raw.text);
    return text === undefined || text === "" ? undefined : { text };
  }
  if (raw.kind !== "ask") return undefined;
  const toolCallId = nonEmpty(raw.toolCallId);
  if (toolCallId === undefined) return undefined;
  const selected = nonEmpty(raw.selected);
  const custom = nonEmpty(raw.custom);
  // Exactement l'un des deux : sinon forme inconnue, jamais devinée.
  if (selected !== undefined && custom === undefined) return { askAnswer: { toolCallId, answer: { selected } } };
  if (selected === undefined && custom !== undefined) return { askAnswer: { toolCallId, answer: { custom } } };
  return undefined;
}

function readInbox(options: StoreReadOptions): WireInboxEnvelope {
  const dir = joinPath(options.stateDir, "inbox");
  const boxes: WireInboxBox[] = [];
  for (const name of fileNames(dir)) {
    if (!isInboxBoxName(name)) continue;
    const boxPath = joinPath(dir, name);
    const deliveries: WireInboxDelivery[] = [];
    // L'ordre chronologique est l'ordre lexicographique du nom de fichier.
    for (const file of fileNames(boxPath)) {
      if (!file.endsWith(".json")) continue;
      const filePath = joinPath(boxPath, file);
      const parsed = readJson(filePath);
      const payload = parsed === undefined ? undefined : decodeDelivery(parsed.value);
      deliveries.push(defined({ file: filePath, payload }));
    }
    boxes.push({ name, path: boxPath, deliveries });
  }
  return { availability: directoryAvailability(dir), boxes, discardedEntries: [] };
}

// --- audit/ -----------------------------------------------------------------------

/** `AuditRelay.init?(json:id:nowMs:)`. */
function decodeRelay(json: unknown, id: string, options: StoreReadOptions): WireAuditRelay | undefined {
  if (!isObject(json) || !isVersion1(json.version)) return undefined;
  const sessionFile = nonEmpty(json.sessionFile);
  const pid = integer(json.pid);
  const heartbeatAt = num(json.heartbeatAt);
  if (sessionFile === undefined || pid === undefined || pid <= 0 || heartbeatAt === undefined) return undefined;
  const isStale = !alive(pid, options) || options.now() - heartbeatAt > LOT_OWNER_STALE_MS;
  return { id, sessionFile, pid, heartbeatAt, isStale };
}

// --- audits/ et journal/ ----------------------------------------------------------

/** Un champ PRÉSENT qui vaut `null` (⇒ `{value: undefined}`) ou une valeur décodable ; sinon rejet (`undefined`). */
function nullable<T>(raw: unknown, present: boolean, decode: (value: unknown) => T | undefined): { value: T | undefined } | undefined {
  if (!present) return undefined;
  if (raw === null) return { value: undefined };
  const decoded = decode(raw);
  return decoded === undefined ? undefined : { value: decoded };
}

/** `AuditProposalElement.init?(json:)`. */
function decodeProposalElement(raw: unknown): WireAuditProposalElement | undefined {
  if (!isObject(raw)) return undefined;
  const kind = oneOf(raw.kind, ["weakness", "feature"] as const);
  const slug = nonEmpty(raw.slug);
  const intention = str(raw.intention);
  const deps = allStrings(raw.deps);
  if (kind === undefined || slug === undefined || intention === undefined || deps === undefined) return undefined;
  return { kind, slug, intention, deps };
}

/** `AuditLaunchOutcome.init?(json:)` : chaque champ facultatif doit être PRÉSENT. */
function decodeLaunch(raw: unknown): WireAuditLaunch | undefined {
  if (!isObject(raw)) return undefined;
  const slug = nonEmpty(raw.slug);
  if (slug === undefined || typeof raw.launched !== "boolean") return undefined;
  const reason = nullable(raw.reason, "reason" in raw, str);
  const prUrl = nullable(raw.prUrl, "prUrl" in raw, str);
  const state = nullable(raw.state, "state" in raw, v => oneOf(v, FEATURE_STATES));
  const phase = nullable(raw.phase, "phase" in raw, v => oneOf(v, PHASES));
  if (reason === undefined || prUrl === undefined || state === undefined || phase === undefined) return undefined;
  return defined({
    slug,
    launched: raw.launched,
    reason: reason.value,
    state: state.value,
    phase: phase.value,
    prUrl: prUrl.value,
  });
}

/** `AuditRecord.init?(json:)` : une proposition ou une issue invalide rejette l'audit entier. */
function decodeAuditRecord(json: unknown): WireAuditRecord | undefined {
  if (!isObject(json) || !isVersion1(json.version)) return undefined;
  const id = str(json.id);
  if (id === undefined || !isAuditId(id)) return undefined;
  const repoRoot = nonEmpty(json.repoRoot);
  const repoKey = nonEmpty(json.repoKey);
  const key = typeof json.key === "string" && json.key.startsWith("/") ? json.key : undefined;
  const orientation = str(json.orientation);
  const status = oneOf(json.status, ["analysing", "proposed", "launched", "stopped", "failed"] as const);
  const createdAt = num(json.createdAt);
  const updatedAt = num(json.updatedAt);
  if (
    repoRoot === undefined ||
    repoKey === undefined ||
    key === undefined ||
    orientation === undefined ||
    status === undefined ||
    createdAt === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }
  let proposal: WireAuditRecord["proposal"];
  if (json.proposal !== null) {
    if (!isObject(json.proposal) || !Array.isArray(json.proposal.elements)) return undefined;
    const briefDraft = str(json.proposal.briefDraft);
    if (briefDraft === undefined) return undefined;
    const elements: WireAuditProposalElement[] = [];
    for (const rawElement of json.proposal.elements) {
      const element = decodeProposalElement(rawElement);
      if (element === undefined) return undefined;
      elements.push(element);
    }
    proposal = { elements, briefDraft };
  }
  if (!Array.isArray(json.launches)) return undefined;
  const launches: WireAuditLaunch[] = [];
  for (const rawLaunch of json.launches) {
    const launch = decodeLaunch(rawLaunch);
    if (launch === undefined) return undefined;
    launches.push(launch);
  }
  const failure = nullable(json.failure, "failure" in json, str);
  if (failure === undefined) return undefined;
  return defined({
    id,
    repoRoot,
    repoKey,
    key,
    orientation,
    status,
    createdAt,
    updatedAt,
    proposal,
    launches,
    failure: failure.value,
  });
}

/** `AuditDecision.init?(journalLine:auditIdByKey:)`. */
function decodeAuditDecision(json: unknown, auditIdByKey: Map<string, string>): WireAuditDecision | undefined {
  if (!isObject(json) || !isVersion1(json.version)) return undefined;
  const at = num(json.at);
  const slug = str(json.slug);
  const phase = oneOf(json.phase, PHASES);
  const kind = oneOf(json.kind, ["question", "jalon", "quota"] as const);
  const question = str(json.question);
  const answer = str(json.answer);
  const source = oneOf(json.source, ["contexte", "arbitrage"] as const);
  const context = str(json.context);
  if (
    at === undefined ||
    slug === undefined ||
    phase === undefined ||
    kind === undefined ||
    question === undefined ||
    answer === undefined ||
    source === undefined ||
    context === undefined
  ) {
    return undefined;
  }
  const auditId = auditIdByKey.get(context);
  if (auditId === undefined) return undefined;
  return { auditId, slug, phase, kind, question, answer, source, at };
}

const DECISION_KINDS = ["question", "jalon", "quota", "contexte", "plafond", "echec", "arbitrage", "avance"] as const;

/** `ArbiterDecision.init?(journalLine:repoKey:offset:)`. */
function decodeArbiterDecision(json: unknown, repoKey: string, offset: number): WireArbiterDecision | undefined {
  if (!isObject(json) || !isVersion1(json.version)) return undefined;
  const at = num(json.at);
  const slug = str(json.slug);
  const phase = str(json.phase);
  const kind = oneOf(json.kind, DECISION_KINDS);
  const question = str(json.question);
  const answer = str(json.answer);
  const source = oneOf(json.source, ["contexte", "arbitrage", "utilisateur"] as const);
  if (
    at === undefined ||
    slug === undefined ||
    phase === undefined ||
    kind === undefined ||
    question === undefined ||
    answer === undefined ||
    source === undefined
  ) {
    return undefined;
  }
  const reason = isObject(json.justification) ? str(json.justification.reason) : undefined;
  return defined({
    repoKey,
    offset,
    slug,
    phase,
    kind,
    question,
    answer,
    source,
    reason: reason !== undefined && !isBlank(reason) ? reason : undefined,
    at,
  });
}

/** `ArbiterDecisionFeed.limit`. */
const FEED_LIMIT = 50;
/** `StoreReader.journalTailBytes`. */
const JOURNAL_TAIL_BYTES = 256 * 1024;

/** Les lignes d'un tampon (`split` sans sous-séquences vides) avec leur offset d'octet dans le tampon. */
function bufferLines(data: Buffer): Array<{ start: number; text: string }> {
  const lines: Array<{ start: number; text: string }> = [];
  let start = 0;
  while (start < data.length) {
    let end = data.indexOf(0x0a, start);
    if (end < 0) end = data.length;
    if (end > start) lines.push({ start, text: data.toString("utf8", start, end) });
    start = end + 1;
  }
  return lines;
}

function parseLine(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Le fil des décisions de tous les `journal/<repoKey>.jsonl` : la queue lue de chaque journal, le plus récent d'abord. */
function readDecisionFeed(journalDir: string): WireArbiterDecision[] {
  const journals: WireArbiterDecision[][] = [];
  for (const name of fileNames(journalDir)) {
    if (!name.endsWith(".jsonl")) continue;
    const repoKey = name.slice(0, -".jsonl".length);
    if (!isAuditId(repoKey)) continue;
    let handle: number;
    try {
      handle = fs.openSync(joinPath(journalDir, name), "r");
    } catch {
      continue;
    }
    try {
      const size = fs.fstatSync(handle).size;
      const offset = size > JOURNAL_TAIL_BYTES ? size - JOURNAL_TAIL_BYTES : 0;
      let data = Buffer.alloc(size - offset);
      let read = 0;
      while (read < data.length) {
        const n = fs.readSync(handle, data, read, data.length - read, offset + read);
        if (n === 0) break;
        read += n;
      }
      data = data.subarray(0, read);
      let firstByte = offset;
      // Une queue commence au milieu d'une ligne : la ligne coupée tombe.
      if (offset > 0) {
        const newline = data.indexOf(0x0a);
        if (newline >= 0) {
          firstByte += newline + 1;
          data = data.subarray(newline + 1);
        }
      }
      const out: WireArbiterDecision[] = [];
      for (const line of bufferLines(data).reverse()) {
        if (out.length >= FEED_LIMIT) break;
        const json = parseLine(line.text);
        if (json === undefined) continue;
        const decision = decodeArbiterDecision(json, repoKey, firstByte + line.start);
        // Une DÉCISION, pas une note : la sorte `contexte` n'a rien tranché.
        if (decision !== undefined && decision.kind !== "contexte") out.push(decision);
      }
      journals.push(out);
    } catch {
      /* journal illisible : ignoré */
    } finally {
      fs.closeSync(handle);
    }
  }
  // La plus récente d'abord ; à égalité, l'identité `<repoKey>:<offset>` en ordre d'octets.
  const all = journals.flat().sort((a, b) => {
    if (a.at !== b.at) return b.at - a.at;
    const left = `${a.repoKey}:${a.offset}`;
    const right = `${b.repoKey}:${b.offset}`;
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
  });
  return all.slice(0, FEED_LIMIT);
}

function readAudits(options: StoreReadOptions): WireAuditsEnvelope {
  const { availability, entries: records, discardedEntries } = scan(options.stateDir, "audits", (_, json) =>
    decodeAuditRecord(json),
  );
  const auditIdByKey = new Map<string, string>();
  for (const record of records) {
    if (!auditIdByKey.has(record.key)) auditIdByKey.set(record.key, record.id);
  }
  const decisions: WireAuditDecision[] = [];
  const seen = new Set<string>();
  const journalDir = joinPath(options.stateDir, "journal");
  for (const record of records) {
    if (!isAuditId(record.repoKey) || seen.has(record.repoKey)) continue;
    seen.add(record.repoKey);
    let text: string;
    try {
      text = fs.readFileSync(joinPath(journalDir, `${record.repoKey}.jsonl`), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const json = parseLine(line);
      const decision = json === undefined ? undefined : decodeAuditDecision(json, auditIdByKey);
      if (decision !== undefined) decisions.push(decision);
    }
  }
  return { availability, records, decisions, discardedEntries, feed: readDecisionFeed(journalDir) };
}

// --- l'instantané -----------------------------------------------------------------

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `StoreReader.readAll` : une passe de lecture complète. */
export function readStoreSnapshot(options: StoreReadOptions): WireStoreSnapshot {
  const { stateDir } = options;
  const running = scan(stateDir, "running", (_, json) => decodeRunning(json, options));
  // Le plus ancien maillon d'abord — puis la borne, qui garde les premiers arrivés.
  running.entries.sort((a, b) => a.phaseStartedAt - b.phaseStartedAt || byText(a.cwd, b.cwd));
  const history = scan(stateDir, "history", (_, json) => decodeHistory(json));
  // Le plus récent d'abord — puis la borne, qui garde les plus récents.
  history.entries.sort((a, b) => b.endedAt - a.endedAt || byText(a.cwd, b.cwd));
  const lots = scan(stateDir, "lots", (_, json) => decodeLot(json, options));
  const projects = scan(stateDir, "projects", (_, json) => decodeProject(json));
  const audit = scan(stateDir, "audit", (name, json) => decodeRelay(json, name.slice(0, -".json".length), options));
  return {
    // La RACINE est évaluée à chaque passe : un magasin créé pendant la session cesse d'être « absent ».
    root: directoryAvailability(stateDir),
    running: {
      availability: running.availability,
      entries: running.entries.slice(0, RUNNING_READ_LIMIT),
      discardedEntries: running.discardedEntries,
    },
    history: {
      availability: history.availability,
      entries: history.entries.slice(0, HISTORY_READ_LIMIT),
      discardedEntries: history.discardedEntries,
    },
    lots: { availability: lots.availability, lots: lots.entries, discardedEntries: lots.discardedEntries },
    projects: {
      availability: projects.availability,
      projects: projects.entries,
      discardedEntries: projects.discardedEntries,
    },
    inbox: readInbox(options),
    audit: {
      availability: audit.availability,
      relays: audit.entries,
      discardedEntries: audit.discardedEntries,
    } satisfies WireAuditEnvelope,
    audits: readAudits(options),
  };
}
