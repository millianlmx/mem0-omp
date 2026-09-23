// État par session et identité de projet : sessions indexées par id, racine résolue puis cachée.
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import type { BriefStatus } from "./brief.ts";
import type { MemoryCache } from "./summary.ts";

// ---------------------------------------------------------------------------
// Identité du projet
// ---------------------------------------------------------------------------

export const MANIFESTS: Array<[string, (raw: string) => string | null]> = [
  ["package.json", (raw) => { try { return JSON.parse(raw)?.name ?? null; } catch { return null; } }],
  ["pyproject.toml", (raw) => raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null],
  ["Cargo.toml", (raw) => raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null],
  ["Package.swift", (raw) => raw.match(/\bname:\s*"([^"]+)"/)?.[1] ?? null],
];

export type Root = { dir: string; isRepo: boolean };

/**
 * Un worktree lié porte un `.git` FICHIER (« gitfile ») qui pointe vers
 * `<principal>/.git/worktrees/<nom>` : la racine de projet est alors celle du
 * dépôt principal. Sans ça, une feature menée dans un worktree ouvrirait un second
 * scope mem0 (souvenirs irretrouvables depuis le dépôt) et poserait son brief dans
 * l'arbre de la feature — qui doit rester propre pour être nettoyé après le push.
 * Un `.git` de sous-module pointe vers `…/.git/modules/<nom>` : pas un worktree.
 */
export function gitfilePrimaryRoot(contents: string): string | null {
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(contents);
  if (!m || !m[1]) return null;
  const w = /^(.*)\/\.git\/worktrees\/[^/]+$/.exec(m[1].replace(/\\/g, "/"));
  if (!w) return null;
  const primary = w[1].replace(/\/+$/, "");
  return primary || null;
}

// Remonte jusqu'à la racine du dépôt. `isRepo` sert de garde-fou : on n'écrit
// jamais de fichier dans un dossier qui n'est manifestement pas un projet
// (omp lancé depuis $HOME, par exemple). Exporté pour les tests.
export function resolveRoot(cwd: string): Root {
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    const dotGit = path.join(dir, ".git");
    if (fs.existsSync(dotGit)) {
      try {
        if (fs.statSync(dotGit).isFile()) {
          const primary = gitfilePrimaryRoot(fs.readFileSync(dotGit, "utf8"));
          if (primary) return { dir: primary, isRepo: true };
        }
      } catch {
        /* `.git` illisible : repli sur la racine locale, comportement inchangé */
      }
      return { dir, isRepo: true };
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Pas de dépôt git : on accepte quand même si un AGENTS.md existe déjà.
  return { dir: cwd, isRepo: fs.existsSync(path.join(cwd, "AGENTS.md")) };
}

export const rootCache = new Map<string, Root>();

export function rootOf(cwd: string): Root {
  let r = rootCache.get(cwd);
  if (!r) { r = resolveRoot(cwd); rootCache.set(cwd, r); }
  return r;
}

/** Exporté pour les tests : la scope mémoire est une identité de PROJET, pas de worktree. */
export function projectId(cwd: string): string {
  const override = process.env.MEM0_PROJECT_ID;
  if (override) return override;
  const { dir } = rootOf(cwd);
  for (const [file, extract] of MANIFESTS) {
    try {
      const name = extract(fs.readFileSync(path.join(dir, file), "utf8"));
      if (name) return name;
    } catch { /* absent ou illisible */ }
  }
  try {
    const xcode = fs.readdirSync(dir).find((f) => f.endsWith(".xcodeproj"));
    if (xcode) return path.basename(xcode, ".xcodeproj");
  } catch { /* ignore */ }
  return path.basename(dir);
}

export type SessionState = {
  turns: number;
  /** tours dont le prompt dépasse RECALL_MIN_PROMPT ; proxy de « la session a du fond ». */
  substantiveTurns: number;
  /** ids déjà montrés dans cette session, par rappel ou par agrafage : on ne répète pas. */
  injected: Set<string>;
  /** arguments d'outil déjà agrafés : un même chemin ou pattern n'agrafe qu'une fois. */
  pinnedQueries: Set<string>;
  /** cache local des souvenirs du projet + fréquence documentaire des tokens. */
  mem: MemoryCache | null;
  /** sommaire rendu, reconstruit en même temps que le cache. */
  index: string | null;
  /** compteurs : instrumentation (/mem0-status) et déclenchement du nudge (session_stop). */
  mutations: number; // edit/write réussis
  explorations: number; // read/grep/glob/lsp réussis
  recalls: number; // tours où au moins un souvenir a été injecté
  adds: number; // écritures mémoire réussies
  nudged: boolean;
  /** agrafages réussis sur la session, affiché par /mem0-status. */
  pinned: number;
  /** agrafages depuis le dernier bloc de rappel affiché. */
  pinnedSinceRecall: number;
  /** explorations sans écriture mem0_add ; déclenche un checkpoint au-delà du seuil. */
  explorationSinceLastWrite: number;
  /** phase active pour la session, définie par /set-phase ; null si aucune. */
  currentPhase: string | null;
  /** le trigger de fin de phase n'agit qu'une fois par session (garde anti-boucle). */
  phaseTriggered: boolean;
};

// ---------------------------------------------------------------------------
// État par session
// ---------------------------------------------------------------------------

/**
 * État vivant d'une INSTANCE d'extension : un par chargement, créé par l'entrée.
 * Le découpage l'a rendu explicite — c'était la fermeture de la fabrique avant,
 * et le poser au niveau du module aurait fait partager compteurs, cache de
 * session et mémoïsation du brief entre deux instances du même process.
 */
export type Mem0Runtime = {
  /** Une entrée par session, indexée par id de session. */
  states: Map<string, SessionState>;
  /** Statut du provisionnement du brief déjà calculé, par racine de projet. */
  provisioned: Map<string, BriefStatus>;
};

export function createRuntime(): Mem0Runtime {
  return { states: new Map(), provisioned: new Map() };
}

// Forme de `ctx` telle qu'elle a bougé entre versions d'OMP : ce que `stateOf`
// lit, et rien de plus.
type SessionCtxLike = {
  sessionManager?: { getSessionId?: () => unknown };
  sessionId?: unknown;
  session?: { id?: unknown };
  cwd?: unknown;
};

// Clé stable par session. `ctx` peut être recréé d'un tour à l'autre selon la
// version, donc pas de WeakSet sur l'objet ctx.
export function stateOf(rt: Mem0Runtime, ctx: ExtensionContext | undefined): SessionState {
  // ReadonlySessionManager expose getSessionId(), pas une propriété sessionId :
  // l'ancienne lecture retombait toujours sur cwd, et deux sessions ouvertes
  // sur le même projet partageaient compteur de tours et état de rappel. Le
  // cast est local et assumé : l'hôte ne déclare qu'une des quatre formes.
  const c = (ctx ?? {}) as unknown as SessionCtxLike;
  const key = String(
    c.sessionManager?.getSessionId?.() ?? c.sessionId ?? c.session?.id ?? c.cwd ?? "session",
  );
  let st = rt.states.get(key);
  if (!st) {
    st = {
      turns: 0,
      substantiveTurns: 0,
      injected: new Set(),
      pinnedQueries: new Set(),
      mem: null,
      index: null,
      mutations: 0,
      explorations: 0,
      recalls: 0,
      pinned: 0,
      adds: 0,
      nudged: false,
      pinnedSinceRecall: 0,
      explorationSinceLastWrite: 0,
      currentPhase: null,
      phaseTriggered: false,
    };
    rt.states.set(key, st);
  }
  return st;
}

// Après une compaction ou un changement de branche, les souvenirs déjà posés ne
// sont plus forcément dans le contexte : on autorise leur réinjection.
export function forgetInjected(rt: Mem0Runtime, ctx: ExtensionContext): void {
  stateOf(rt, ctx).injected.clear();
}
