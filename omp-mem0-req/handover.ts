// La MACHINE CONDUCTRICE d'un dépôt, la bascule et le clonage (S-5, B-5) : l'identité
// d'un dépôt, les deux fichiers d'état par machine (`repos.json`, `handovers.json`)
// et les quatre gestes serveur (`handover`, `commit`, `cancel`, `adopt`). Le client
// (omp-console, iOS) orchestre la bascule en trois temps ; ce module ne parle JAMAIS
// à l'autre machine — il n'y a pas d'appel de serveur à serveur.
//
// Invariant : entre `handover` (la source gèle) et `commit` (la source retire les
// features parties), la source ne DÉMARRE rien — c'est le pilote (`lotController.ts`)
// qui lit `handovers.json` ; une feature n'est donc jamais conduite par deux machines.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitRunner } from "./git.ts";
import { realpathOr } from "./git.ts";
import { lotFeature, lotRepoKey, lotStateDir, readLot } from "./lot.ts";
import type { Lot, LotFeature } from "./lot.ts";
import type { LotController } from "./lotController.ts";
import { lastLine } from "./runs.ts";
import { badRequest, conflict, notFound, unavailable } from "./serviceApi.ts";
import type { MachineKind } from "./serviceState.ts";


// --- identité d'un dépôt ------------------------------------------------------

/**
 * `github.com/<owner>/<name>`, en minuscules, sans `.git` : la SEULE identité d'un
 * dépôt entre deux machines (leurs chemins et leurs `repoKey` diffèrent). Formes
 * admises : `git@github.com:o/n(.git)`, `https://github.com/o/n(.git)`,
 * `ssh://git@github.com/o/n(.git)` ; un `/` final est toléré. Tout autre hôte, tout
 * autre schéma, tout chemin d'une autre profondeur : `null`.
 *
 * Même règle, mêmes vecteurs (`test/fixtures/repo-identity.json`) que
 * `RepoIdentity.normalize(_:)` de ConsoleCore.
 */
export function normalizeRepoIdentity(url: string): string | null {
  const text = url.trim().replace(/\/+$/u, "");
  const match =
    /^git@github\.com:([^/:\s]+)\/([^/:\s]+)$/iu.exec(text) ??
    /^https:\/\/github\.com\/([^/:\s@]+)\/([^/:\s@]+)$/iu.exec(text) ??
    /^ssh:\/\/git@github\.com\/([^/:\s]+)\/([^/:\s]+)$/iu.exec(text);
  if (match === null) return null;
  const owner = match[1] ?? "";
  const name = (match[2] ?? "").replace(/\.git$/iu, "");
  const part = /^[A-Za-z0-9_.-]+$/u;
  const dots = (segment: string) => segment === "." || segment === "..";
  if (!part.test(owner) || !part.test(name) || dots(owner) || dots(name)) return null;
  return `github.com/${owner}/${name}`.toLowerCase();
}

/** L'identité d'un dépôt : l'URL de `git -C <root> remote get-url origin`, normalisée ; `null` sans `origin` GitHub. */
export async function repoIdentity(root: string, runGit: GitRunner): Promise<string | null> {
  const res = await runGit(["-C", root, "remote", "get-url", "origin"], root);
  return res.code === 0 ? normalizeRepoIdentity(res.stdout) : null;
}

const IDENTITY_FORM = /^github\.com\/(?!\.{1,2}\/)[a-z0-9_.-]+\/(?!\.{1,2}$)[a-z0-9_.-]+$/u;


// --- les machines -------------------------------------------------------------

/** Le nom d'une machine dans les textes affichés. */
export const MACHINE_LABELS: Record<MachineKind, string> = { mac: "Mac", vps: "VPS" };

function isMachine(value: unknown): value is MachineKind {
  return value === "mac" || value === "vps";
}

/** Le motif d'un `launch`/`add` refusé sur la machine qui a confié le dépôt à `to`. */
export function handoverRefusal(to: MachineKind): string {
  return `dépôt confié au ${MACHINE_LABELS[to]} : lancez la feature là-bas`;
}


// --- fichiers d'état ----------------------------------------------------------

export const REPOS_FILE = "repos.json";
export const HANDOVERS_FILE = "handovers.json";
const STATE_FILE_VERSION = 1;

/** Un dépôt ADOPTÉ par une bascule (cloné ici ou reconnu ici) : `repos.json`. */
export type AdoptedRepo = { identity: string; repoRoot: string; adoptedAt: number };

/** Une bascule : `frozen` entre `handover` et `commit`, `done` ensuite (le dépôt n'est plus conduit ici). */
export type HandoverEntry = { id: string; to: MachineKind; state: "frozen" | "done"; identity: string; at: number };

export function reposFilePath(stateDir: string): string {
  return path.join(stateDir, REPOS_FILE);
}

export function handoversFilePath(stateDir: string): string {
  return path.join(stateDir, HANDOVERS_FILE);
}

/** Écriture ATOMIQUE en 0600 : temporaire voisin, puis `rename`. */
function writeStateFile(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readObject(file: string): Record<string, unknown> | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    return record.version === STATE_FILE_VERSION ? record : null;
  } catch {
    return null;
  }
}

/** Les dépôts adoptés ; un fichier absent, illisible ou d'une autre version est une liste vide. */
export function readAdoptedRepos(stateDir: string): AdoptedRepo[] {
  const raw = readObject(reposFilePath(stateDir));
  if (raw === null || !Array.isArray(raw.repos)) return [];
  const repos: AdoptedRepo[] = [];
  for (const item of raw.repos as unknown[]) {
    if (item === null || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.identity !== "string" || typeof r.repoRoot !== "string" || r.repoRoot === "") continue;
    repos.push({ identity: r.identity, repoRoot: r.repoRoot, adoptedAt: typeof r.adoptedAt === "number" ? r.adoptedAt : 0 });
  }
  return repos;
}

/** Inscrit un dépôt adopté ; une même identité ou une même racine REMPLACE l'ancienne ligne. */
export function addAdoptedRepo(stateDir: string, repo: AdoptedRepo): void {
  const kept = readAdoptedRepos(stateDir).filter(r => r.identity !== repo.identity && r.repoRoot !== repo.repoRoot);
  writeStateFile(reposFilePath(stateDir), { version: STATE_FILE_VERSION, repos: [...kept, repo] });
}

/** Les bascules par `repoKey` ; un fichier absent ou illisible est « aucune bascule ». */
export function readHandovers(stateDir: string): Record<string, HandoverEntry> {
  const raw = readObject(handoversFilePath(stateDir));
  const out: Record<string, HandoverEntry> = {};
  if (raw === null || raw.repos === null || typeof raw.repos !== "object" || Array.isArray(raw.repos)) return out;
  for (const [key, item] of Object.entries(raw.repos as Record<string, unknown>)) {
    if (item === null || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    if (typeof e.id !== "string" || !isMachine(e.to) || (e.state !== "frozen" && e.state !== "done")) continue;
    out[key] = {
      id: e.id,
      to: e.to,
      state: e.state,
      identity: typeof e.identity === "string" ? e.identity : "",
      at: typeof e.at === "number" ? e.at : 0,
    };
  }
  return out;
}

function writeHandovers(stateDir: string, entries: Record<string, HandoverEntry>): void {
  writeStateFile(handoversFilePath(stateDir), { version: STATE_FILE_VERSION, repos: entries });
}

/**
 * Le motif de refus d'un `launch`/`add` sur ce dépôt, ou `null` : le dépôt a une
 * bascule (gelée ou terminée). Lu par le pilote à chaque décision — c'est ce qui
 * garde la source de démarrer une feature que la cible a reprise.
 */
export function handoverRefusalFor(stateDir: string, repoRoot: string): string | null {
  const entry = readHandovers(stateDir)[lotRepoKey(repoRoot)];
  return entry === undefined ? null : handoverRefusal(entry.to);
}


// --- dépôts connus ------------------------------------------------------------

/** `<root>/.git` existe, dossier OU fichier (un worktree lié porte un FICHIER). */
function isGitRoot(root: string): boolean {
  return root !== "" && fs.existsSync(path.join(root, ".git"));
}

function repoRootsOf(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as { repoRoot?: unknown };
      if (raw !== null && typeof raw.repoRoot === "string" && raw.repoRoot !== "") roots.push(raw.repoRoot);
    } catch {
      /* un fichier illisible n'est le dépôt de personne */
    }
  }
  return roots;
}

/**
 * Les dépôts connus d'une machine : racines des lots ∪ des projets ∪ `repos.json`,
 * `realpath`ées, filtrées par la règle « racine git », dédupliquées puis triées.
 */
export function listKnownRoots(stateDir: string): string[] {
  const roots = new Set<string>();
  for (const root of repoRootsOf(lotStateDir(stateDir))) roots.add(realpathOr(root));
  for (const root of repoRootsOf(path.join(stateDir, "projects"))) roots.add(realpathOr(root));
  for (const repo of readAdoptedRepos(stateDir)) roots.add(realpathOr(repo.repoRoot));
  return [...roots].filter(isGitRoot).sort();
}


// --- les quatre gestes serveur -----------------------------------------------

/** Budget du `git clone` d'une bascule (S-5). */
export const CLONE_TIMEOUT_MS = 10 * 60_000;

/** L'URL de clonage : `MEM0_PIPELINE_CLONE_URL_PREFIX` est une variable de TEST (défaut GitHub). */
export const DEFAULT_CLONE_URL_PREFIX = "https://github.com/";

/** Une feature en route vers l'autre machine : ce que `launch` sait recréer. */
export type HandoverFeature = {
  slug: string;
  description: string;
  deps?: string[];
  modelReqSpecs?: string;
  modelImplReview?: string;
};

export type HandoverResult = { id: string; identity: string; features: HandoverFeature[] };
export type AdoptResult = {
  repoKey: string;
  repoRoot: string;
  cloned: boolean;
  launched: string[];
  refused: Array<{ slug: string; reason: string }>;
};

export type HandoverServiceDeps = {
  stateDir: string;
  /** La machine qui exécute ce service : la source d'une bascule, la cible d'une adoption. */
  machine: MachineKind;
  controllerFor: (repoRoot: string) => LotController;
  runGit: GitRunner;
  /** git RÉSEAU (le clonage) ; absent ⇒ repli sur `runGit`. */
  runGitNet?: GitRunner;
  env?: Record<string, string | undefined>;
  now?: () => number;
};

export type HandoverService = {
  handover: (repoRoot: string, body: unknown) => Promise<HandoverResult>;
  commit: (repoRoot: string, id: string, body: unknown) => Promise<{ removed: string[] }>;
  cancel: (repoRoot: string, id: string) => { cancelled: true };
  adopt: (body: unknown) => Promise<AdoptResult>;
};

const UNKNOWN_HANDOVER = "bascule inconnue";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Une feature `pending` sans worktree : jamais démarrée, donc transférable (une `pending` avec worktree finit ici). */
function transferable(feature: LotFeature): boolean {
  return feature.state === "pending" && feature.worktree === "";
}

/** Les slugs de `slugs` dans l'ordre où `remove` les accepte : un dépendant avant ce dont il dépend. */
function removalOrder(lot: Lot | null, slugs: string[]): string[] {
  const remaining = new Set(slugs);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const next = [...remaining].find(slug =>
      ![...remaining].some(other => other !== slug && (lot === null ? false : lotFeature(lot, other)?.deps.includes(slug) === true)),
    );
    const pick = next ?? [...remaining][0] as string;
    ordered.push(pick);
    remaining.delete(pick);
  }
  return ordered;
}

export function createHandoverService(deps: HandoverServiceDeps): HandoverService {
  const { stateDir, machine } = deps;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;

  /** L'identité déjà connue d'une racine adoptée, sinon celle de son `origin`. */
  async function identityOf(root: string): Promise<string | null> {
    const adopted = readAdoptedRepos(stateDir).find(repo => realpathOr(repo.repoRoot) === root);
    return (await repoIdentity(root, deps.runGit)) ?? adopted?.identity ?? null;
  }

  async function findByIdentity(identity: string): Promise<string | null> {
    for (const root of listKnownRoots(stateDir)) {
      if ((await identityOf(root)) === identity) return root;
    }
    return null;
  }

  /** `git clone` dans `<MEM0_PIPELINE_REPOS_DIR>/<owner>/<name>` : le dossier d'arrivée, jamais un dossier à demi cloné. */
  async function clone(identity: string): Promise<{ root: string; cloned: boolean }> {
    const [, owner = "", name = ""] = identity.split("/");
    const reposDir = (env.MEM0_PIPELINE_REPOS_DIR ?? "").trim() || path.join(stateDir, "repos");
    const dest = path.resolve(reposDir, owner, name);
    // Défense en profondeur : une identité qui sort de `reposDir` n'est jamais clonée.
    if (!dest.startsWith(`${path.resolve(reposDir)}${path.sep}`)) throw badRequest("identité de dépôt invalide");
    if (isGitRoot(dest)) return { root: realpathOr(dest), cloned: false };
    if (fs.existsSync(dest) && fs.readdirSync(dest).length > 0) {
      throw unavailable(`clonage impossible : ${dest} existe et n'est pas un dépôt git`);
    }
    const existed = fs.existsSync(dest);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const prefix = (env.MEM0_PIPELINE_CLONE_URL_PREFIX ?? "").trim() || DEFAULT_CLONE_URL_PREFIX;
    const run = deps.runGitNet ?? deps.runGit;
    const res = await run(
      ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "clone", `${prefix}${owner}/${name}.git`, dest],
      path.dirname(dest),
      CLONE_TIMEOUT_MS,
    );
    if (res.code !== 0) {
      if (!existed) fs.rmSync(dest, { recursive: true, force: true });
      throw unavailable(`clonage impossible : ${lastLine(res.stderr) || `code ${res.code}`}`);
    }
    return { root: realpathOr(dest), cloned: true };
  }

  return {
    /** 1) La source gèle son dépôt et rend les features à envoyer. Aucune attente entre la lecture du lot et le gel. */
    async handover(repoRoot, body) {
      if (!isRecord(body) || typeof body.to !== "string") throw badRequest('corps attendu : {"to":"mac|vps"}');
      if (!isMachine(body.to) || body.to === machine) throw badRequest("machine cible invalide");
      const to = body.to;
      const root = realpathOr(repoRoot);
      if (!listKnownRoots(stateDir).includes(root)) throw notFound("dépôt inconnu");
      const identity = await identityOf(root);
      if (identity === null) throw conflict("dépôt sans dépôt distant GitHub");
      // Lecture, contrôles et gel SANS `await` : la passe du pilote ne s'intercale pas.
      const key = lotRepoKey(root);
      const entries = readHandovers(stateDir);
      const known = entries[key];
      if (known !== undefined) throw conflict(`dépôt déjà confié au ${MACHINE_LABELS[known.to]}`);
      const lot = readLot(stateDir, key);
      const moving = (lot?.features ?? []).filter(transferable);
      const features: HandoverFeature[] = [];
      for (const feature of moving) {
        const carried: string[] = [];
        for (const dep of feature.deps) {
          const target = lot === null ? undefined : lotFeature(lot, dep);
          if (target === undefined || target.state === "done") continue;
          if (!transferable(target)) {
            throw conflict(`la feature ${feature.slug} dépend de ${dep}, encore en cours ici : attendez sa fin`);
          }
          carried.push(dep);
        }
        features.push({
          slug: feature.slug,
          description: feature.name,
          ...(carried.length > 0 ? { deps: carried } : {}),
          ...(feature.modelReqSpecs !== undefined ? { modelReqSpecs: feature.modelReqSpecs } : {}),
          ...(feature.modelImplReview !== undefined ? { modelImplReview: feature.modelImplReview } : {}),
        });
      }
      const id = crypto.randomBytes(8).toString("hex");
      writeHandovers(stateDir, { ...entries, [key]: { id, to, state: "frozen", identity, at: now() } });
      return { id, identity, features };
    },

    /** 3) La source retire les features parties et clôt la bascule. Rejouable : un slug déjà retiré compte comme retiré. */
    async commit(repoRoot, id, body) {
      if (!isRecord(body) || !Array.isArray(body.slugs) || !body.slugs.every(item => typeof item === "string")) {
        throw badRequest('corps attendu : {"slugs":["…"]}');
      }
      const root = realpathOr(repoRoot);
      const key = lotRepoKey(root);
      const entry = readHandovers(stateDir)[key];
      if (entry === undefined || entry.id !== id) throw notFound(UNKNOWN_HANDOVER);
      const slugs = [...new Set(body.slugs as string[])];
      const controller = deps.controllerFor(root);
      controller.adopt();
      const removed: string[] = [];
      for (const slug of removalOrder(readLot(stateDir, key), slugs)) {
        const lot = readLot(stateDir, key);
        if (lot !== null && lotFeature(lot, slug) !== undefined) {
          const refusal = await controller.remove(slug);
          if (refusal !== null) throw conflict(`retrait impossible : ${refusal}`);
        }
        removed.push(slug);
      }
      writeHandovers(stateDir, { ...readHandovers(stateDir), [key]: { ...entry, state: "done" } });
      return { removed };
    },

    /** 2 en échec : la source se dégèle ; une bascule terminée ne s'annule plus. */
    cancel(repoRoot, id) {
      const key = lotRepoKey(realpathOr(repoRoot));
      const entries = readHandovers(stateDir);
      const entry = entries[key];
      if (entry === undefined || entry.id !== id) throw notFound(UNKNOWN_HANDOVER);
      if (entry.state === "done") throw conflict("bascule déjà terminée");
      delete entries[key];
      writeHandovers(stateDir, entries);
      return { cancelled: true };
    },

    /** 2) La cible reconnaît (ou clone) le dépôt, lève son éventuelle bascule et lance les features reçues. */
    async adopt(body) {
      const shape = 'corps attendu : {"identity":"github.com/<owner>/<name>","features":[…]}';
      if (!isRecord(body) || typeof body.identity !== "string" || !Array.isArray(body.features)) throw badRequest(shape);
      const identity = body.identity;
      if (!IDENTITY_FORM.test(identity)) throw badRequest("identité de dépôt invalide");
      const features: HandoverFeature[] = [];
      for (const item of body.features as unknown[]) {
        if (!isRecord(item) || typeof item.slug !== "string" || typeof item.description !== "string") throw badRequest(shape);
        const feature: HandoverFeature = { slug: item.slug, description: item.description };
        if (item.deps !== undefined) {
          if (!Array.isArray(item.deps) || !item.deps.every(dep => typeof dep === "string")) throw badRequest(shape);
          feature.deps = item.deps as string[];
        }
        for (const slot of ["modelReqSpecs", "modelImplReview"] as const) {
          const value = item[slot];
          if (value === undefined || value === null) continue;
          if (typeof value !== "string") throw badRequest(shape);
          feature[slot] = value;
        }
        features.push(feature);
      }

      let root = await findByIdentity(identity);
      let cloned = false;
      if (root === null) {
        if (machine !== "vps") throw conflict("dépôt absent de ce Mac");
        const made = await clone(identity);
        root = made.root;
        cloned = made.cloned;
      }
      const registered = readAdoptedRepos(stateDir).some(repo => realpathOr(repo.repoRoot) === root);
      if (cloned || (!registered && (await repoIdentity(root, deps.runGit)) !== identity)) {
        addAdoptedRepo(stateDir, { identity, repoRoot: root, adoptedAt: now() });
      }
      const key = lotRepoKey(root);
      const entries = readHandovers(stateDir);
      if (entries[key] !== undefined) {
        delete entries[key];
        writeHandovers(stateDir, entries);
      }

      const controller = deps.controllerFor(root);
      controller.adopt();
      const launched: string[] = [];
      const refused: Array<{ slug: string; reason: string }> = [];
      for (const feature of features) {
        const at = now();
        const ack = await controller.acceptCommand({
          version: 1,
          id: `adopt-${Math.trunc(at).toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
          sentAt: at,
          repo: root,
          kind: "launch",
          title: feature.slug,
          description: feature.description,
          ...(feature.deps !== undefined ? { deps: feature.deps } : {}),
          ...(feature.modelReqSpecs !== undefined ? { modelReqSpecs: feature.modelReqSpecs } : {}),
          ...(feature.modelImplReview !== undefined ? { modelImplReview: feature.modelImplReview } : {}),
        });
        if (ack.state === "taken") launched.push(feature.slug);
        else refused.push({ slug: feature.slug, reason: ack.reason ?? "refusée" });
      }
      return { repoKey: key, repoRoot: root, cloned, launched, refused };
    },
  };
}
