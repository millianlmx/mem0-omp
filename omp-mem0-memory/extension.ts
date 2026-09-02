// omp-mem0-memory — mémoire mem0 (Qdrant + oMLX) intégrée nativement dans OMP.
//
// Ce que ça fait, et rien de plus :
//   1. Au premier contact avec un projet : pose le brief mémoire tout seul —
//      écrit .omp/mem0-brief.md et cite ce fichier dans AGENTS.md. Idempotent,
//      une seule fois par projet, rien à installer à la main.
//   2. Recall au premier tour d'une session : cherche dans la mémoire du projet
//      courant, ancré sur ce que tu demandes vraiment, et l'injecte
//      silencieusement dans le même tour.
//   3. Retain automatique tous les N tours utilisateur (et flush en fin de
//      session) : le segment de conversation part vers mem0 avec infer=true, le
//      prompt d'extraction côté serveur ne garde que ce qui vaut le coup.
//   4. Trois tools explicites : mem0_search / mem0_add / mem0_forget.
//
// La mémoire est scopée PAR PROJET (agent_id = nom du projet), avec un scope
// "global" séparé pour les préférences transverses. Les deux sont interrogés en
// parallèle au recall.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MEM0_HTTP_URL = process.env.MEM0_HTTP_URL || "http://localhost:8321";
const MEM0_HTTP_TOKEN = process.env.MEM0_HTTP_TOKEN || "";

// Budgets par opération. `add` avec infer=true déclenche DEUX passes LLM côté
// serveur (extraction de faits + fusion avec l'existant) : sur qwen3-8b en local
// c'est couramment 10 à 60 s. Un budget global de quelques secondes ferait
// échouer silencieusement toutes les écritures.
const TIMEOUT = { search: 3_000, write: 120_000, other: 10_000 };

const RECALL_LIMIT = 8; // souvenirs projet injectés au premier tour
const RECALL_GLOBAL_LIMIT = 3; // + préférences transverses
const RETAIN_EVERY_N_TURNS = 3; // cadence d'écriture automatique
const RETAIN_MAX_CHARS = 24_000; // borne la taille d'un segment envoyé

const GLOBAL_SCOPE = "_global";

// MEM0_AUTOSETUP=0 pour ne jamais écrire dans un dépôt.
const AUTOSETUP = process.env.MEM0_AUTOSETUP !== "0";

// ---------------------------------------------------------------------------
// Le brief — source de vérité, embarquée ici pour que l'extension reste
// autonome une fois copiée dans ~/.omp/extensions/.
// ---------------------------------------------------------------------------

const BRIEF_VERSION = "v2";
const BRIEF_REF_PATH = path.join(".omp", "mem0-brief.md");
const MARKER_OPEN = `<!-- mem0:brief ${BRIEF_VERSION} -->`;
const MARKER_CLOSE = "<!-- /mem0:brief -->";
const MARKER_ANY = /<!--\s*mem0:brief(?:\s+v(\d+))?\s*-->/;

// Bloc court, collé dans AGENTS.md : il est dans le contexte à chaque tour,
// donc il reste court. Les détails vivent dans le fichier de référence.
const AGENTS_BLOCK = `${MARKER_OPEN}
## Mémoire du projet

Une mémoire persistante (mem0) est branchée sur ce projet : rappel automatique au
début de chaque session, écriture automatique toutes les quelques questions. Le tri
automatique rate ce qui est décidé en une phrase sans être répété — quand ça arrive,
appelle \`mem0_add\` toi-même, sur le moment.

**Mémorise** : stack et choix techniques, décisions d'architecture *avec leur
raison*, conventions du dépôt qui ne sont écrites nulle part, bugs résolus (symptôme
+ cause racine + correctif), exigences incontournables d'une feature, préférences de
travail exprimées par l'utilisateur.

**Ne mémorise pas** : l'état courant du code, ce qui est déjà écrit ici ou dans le
README, un raisonnement en cours, un résultat de test, du bavardage, un secret.

Un fait par appel, autoportant. Le dépôt fait toujours autorité contre un souvenir :
s'il le contredit, le souvenir est périmé — corrige-le (\`mem0_add\`) ou supprime-le
(\`mem0_forget\`), ne travaille pas dessus.

Quand la conversation part sur un sujet que le rappel de début de session ne
couvrait pas : \`mem0_search\` avant de te lancer.

Règles complètes et exemples : \`${BRIEF_REF_PATH}\` — lis-le avant ton premier
\`mem0_add\` dans ce projet.
${MARKER_CLOSE}`;

// Fichier de référence, lu à la demande par l'agent (divulgation progressive).
const BRIEF_REFERENCE = `${MARKER_OPEN}
# Brief mémoire — règles complètes

Généré par le plugin \`omp-mem0-memory\`. Tu peux éditer ce fichier : il ne sera pas
réécrit tant que le marqueur de version en tête reste \`${BRIEF_VERSION}\`.

## Ce qui mérite d'être mémorisé

- **Stack et choix techniques** — langage, framework, versions imposées, gestionnaire
  de paquets, outil de test, linter, cible de déploiement. Tout ce que tu as dû
  chercher dans le dépôt pour pouvoir travailler, et que tu chercherais encore la
  prochaine fois.
- **Décisions d'architecture** — le choix retenu *et* la raison. Une décision sans sa
  raison sera rouverte dans deux mois.
- **Conventions** — nommage, structure de dossiers, patterns imposés, ce qui est
  interdit dans ce dépôt. Surtout celles qui ne sont écrites nulle part.
- **Bugs résolus** — symptôme, cause racine, correctif. C'est la catégorie qui
  rapporte le plus : un bug qui se reproduit coûte beaucoup plus cher qu'un bug
  inédit.
- **Exigences incontournables d'une feature** — les contraintes qui doivent tenir à
  chaque itération : compatibilité descendante, limite de performance, règle métier
  non négociable, exigence d'accessibilité ou de sécurité.
- **Préférences de travail** — comment l'utilisateur veut que tu procèdes sur ce
  projet. Avec \`scope: "global"\` si c'est vrai pour tous ses projets.

## Ce qu'il ne faut pas mémoriser

L'état courant du code (il change, et le dépôt fait autorité), ce qui est déjà dans
\`AGENTS.md\` ou le README, un raisonnement intermédiaire, une tâche en cours, un
résultat de test, du bavardage. Et jamais de secret, clé, token ou donnée
personnelle — la rédaction automatique existe mais elle est approximative.

## Comment écrire un souvenir

Une idée par appel, autoportante : quelqu'un doit pouvoir la comprendre dans six mois
sans le contexte de cette conversation. Nomme les fichiers, modules et symboles.

- OUI — \`Tests : XCTest, un fichier par type, fixtures dans Tests/Support. Pas de mocks manuels, on passe par des protocoles + implémentations de test.\`
- OUI — \`Bug écran de séance figé : cause = Timer non invalidé au dismiss de la vue. Fix = .onDisappear { timer.invalidate() }. Vérifier ce pattern sur toute vue à timer.\`
- NON — \`On a corrigé le bug du timer.\` (ni symptôme, ni cause, ni fix)
- NON — \`TabataEngine.swift fait 340 lignes.\` (périmé au prochain commit)

Une méthode réutilisable en plusieurs étapes (déployer, débugger une catégorie
d'erreur, checklist avant release) → \`mem0_add\` avec \`kind: "procedure"\`.

## Quand un souvenir est faux

Le dépôt gagne toujours. Si un souvenir contredit le code réel, il est périmé :
enregistre la version à jour avec \`mem0_add\` (la fusion garde une trace de l'état
précédent), ou supprime-le avec \`mem0_forget\` s'il est simplement faux.
`;

// ---------------------------------------------------------------------------
// Identité du projet
// ---------------------------------------------------------------------------

const MANIFESTS: Array<[string, (raw: string) => string | null]> = [
  ["package.json", (raw) => { try { return JSON.parse(raw)?.name ?? null; } catch { return null; } }],
  ["pyproject.toml", (raw) => raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null],
  ["Cargo.toml", (raw) => raw.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1] ?? null],
  ["Package.swift", (raw) => raw.match(/\bname:\s*"([^"]+)"/)?.[1] ?? null],
];

type Root = { dir: string; isRepo: boolean };

// Remonte jusqu'à la racine du dépôt. `isRepo` sert de garde-fou : on n'écrit
// jamais de fichier dans un dossier qui n'est manifestement pas un projet
// (omp lancé depuis $HOME, par exemple).
function resolveRoot(cwd: string): Root {
  let dir = cwd;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return { dir, isRepo: true };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Pas de dépôt git : on accepte quand même si un AGENTS.md existe déjà.
  return { dir: cwd, isRepo: fs.existsSync(path.join(cwd, "AGENTS.md")) };
}

const rootCache = new Map<string, Root>();
function rootOf(cwd: string): Root {
  let r = rootCache.get(cwd);
  if (!r) { r = resolveRoot(cwd); rootCache.set(cwd, r); }
  return r;
}

function projectId(cwd: string): string {
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

// ---------------------------------------------------------------------------
// Provisionnement du brief
// ---------------------------------------------------------------------------

type Provision = "created" | "present" | "outdated" | "skipped" | "failed";
type BriefStatus = { root: string; ref: Provision; agents: Provision; detail?: string };

function versionOf(text: string): string | null {
  const m = text.match(MARKER_ANY);
  return m ? (m[1] ? `v${m[1]}` : "v1") : null;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Idempotent et volontairement conservateur : on n'écrase jamais un fichier ou
// un bloc existant, même périmé. Une version obsolète est signalée, pas
// remplacée — sinon une édition manuelle du brief se ferait effacer en silence.
// `force` (via /mem0-brief --update) est le seul chemin qui réécrit.
function ensureBrief(cwd: string, force = false): BriefStatus {
  const { dir, isRepo } = rootOf(cwd);
  const status: BriefStatus = { root: dir, ref: "skipped", agents: "skipped" };

  if (!AUTOSETUP && !force) { status.detail = "MEM0_AUTOSETUP=0"; return status; }
  if (!isRepo && !force) { status.detail = "pas un dépôt (ni .git ni AGENTS.md)"; return status; }

  // 1. Fichier de référence
  const refAbs = path.join(dir, BRIEF_REF_PATH);
  try {
    if (fs.existsSync(refAbs)) {
      const current = versionOf(fs.readFileSync(refAbs, "utf8"));
      if (current === BRIEF_VERSION) status.ref = "present";
      else if (force) { fs.writeFileSync(refAbs, BRIEF_REFERENCE, "utf8"); status.ref = "created"; }
      else status.ref = "outdated";
    } else {
      fs.mkdirSync(path.dirname(refAbs), { recursive: true });
      fs.writeFileSync(refAbs, BRIEF_REFERENCE, "utf8");
      status.ref = "created";
    }
  } catch (err) {
    status.ref = "failed";
    status.detail = (err as Error).message;
  }

  // 2. Bloc dans AGENTS.md
  const agentsAbs = path.join(dir, "AGENTS.md");
  try {
    if (fs.existsSync(agentsAbs)) {
      const body = fs.readFileSync(agentsAbs, "utf8");
      const current = versionOf(body);
      if (current === BRIEF_VERSION) {
        status.agents = "present";
      } else if (current) {
        if (force) {
          const block = new RegExp(`<!--\\s*mem0:brief[\\s\\S]*?${escapeRe(MARKER_CLOSE)}`);
          fs.writeFileSync(agentsAbs, body.replace(block, AGENTS_BLOCK), "utf8");
          status.agents = "created";
        } else {
          status.agents = "outdated";
        }
      } else {
        fs.appendFileSync(agentsAbs, `\n\n${AGENTS_BLOCK}\n`, "utf8");
        status.agents = "created";
      }
    } else {
      fs.writeFileSync(agentsAbs, `# AGENTS.md\n\n${AGENTS_BLOCK}\n`, "utf8");
      status.agents = "created";
    }
  } catch (err) {
    status.agents = "failed";
    status.detail = (err as Error).message;
  }

  return status;
}

// ---------------------------------------------------------------------------
// Empreinte technique — amorçage d'un projet préexistant (/mem0-init)
//
// Tout ce qui est déductible du disque est lu ici, pas demandé au modèle : c'est
// gratuit, instantané et exact. Le modèle n'est sollicité que pour ce qui demande
// du jugement (décisions d'archi, conventions réelles, pièges).
// ---------------------------------------------------------------------------

function readIf(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

function presentIn(dir: string, names: string[]): string[] {
  return names.filter((n) => fs.existsSync(path.join(dir, n)));
}

const NODE_TOOLS: Record<string, string> = {
  vitest: "tests (Vitest)", jest: "tests (Jest)", mocha: "tests (Mocha)",
  "@playwright/test": "tests e2e (Playwright)", cypress: "tests e2e (Cypress)",
  eslint: "lint (ESLint)", "@biomejs/biome": "lint+format (Biome)",
  prettier: "format (Prettier)", typescript: "typage (TypeScript)",
  vite: "build (Vite)", webpack: "build (webpack)", esbuild: "build (esbuild)",
  next: "framework (Next.js)", react: "UI (React)", vue: "UI (Vue)",
  svelte: "UI (Svelte)", express: "serveur (Express)", fastify: "serveur (Fastify)",
  "@nestjs/core": "framework (NestJS)", prisma: "ORM (Prisma)", drizzle_orm: "ORM (Drizzle)",
};

const PKG_MANAGERS: Array<[string, string]> = [
  ["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"], ["package-lock.json", "npm"],
  ["uv.lock", "uv"], ["poetry.lock", "poetry"], ["Pipfile.lock", "pipenv"],
];

// Retourne une liste de faits courts et autoportants. Un fait par idée : mélanger
// stack, layout et CI dans un seul blob les rendrait tous inatteignables au
// recall, qui classe par similarité sémantique.
function scanStack(dir: string, projectName: string): string[] {
  const facts: string[] = [];
  const add = (s: string) => { if (s.trim()) facts.push(redact(s.trim())); };

  // Détecté en premier : les commandes suggérées plus bas doivent utiliser le
  // bon gestionnaire, sinon on documente une commande que personne ne lance.
  const lock = PKG_MANAGERS.find(([f]) => fs.existsSync(path.join(dir, f)));
  const runner = lock ? (lock[1] === "npm" ? "npm run" : `${lock[1]} run`) : "npm run";

  // --- Écosystème et dépendances
  const pkgRaw = readIf(path.join(dir, "package.json"));
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw);
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const names = Object.keys(deps);
      const tools = names.map((n) => NODE_TOOLS[n]).filter(Boolean);
      add(`${projectName} : projet Node/JS. Outils détectés : ${tools.length ? tools.join(", ") : "aucun outil standard identifié"}.`);
      const runtime = Object.keys(pkg.dependencies ?? {}).slice(0, 15);
      if (runtime.length) add(`${projectName} — dépendances de production : ${runtime.join(", ")}${Object.keys(pkg.dependencies ?? {}).length > 15 ? ", …" : ""}.`);
      const scripts = Object.keys(pkg.scripts ?? {});
      if (scripts.length) {
        const notable = ["test", "lint", "typecheck", "build", "dev", "start"].filter((s) => scripts.includes(s));
        add(`${projectName} — scripts npm disponibles : ${scripts.join(", ")}.` +
          (notable.length ? ` Les commandes de vérification usuelles sont : ${notable.map((s) => `${runner} ${s}`).join(", ")}.` : ""));
      }
    } catch { /* package.json illisible */ }
  }

  const pyRaw = readIf(path.join(dir, "pyproject.toml"));
  if (pyRaw) {
    const tools = [
      /\[tool\.ruff/.test(pyRaw) && "lint+format (Ruff)",
      /\[tool\.mypy/.test(pyRaw) && "typage (mypy)",
      /\[tool\.pytest/.test(pyRaw) && "tests (pytest)",
      /\[tool\.black/.test(pyRaw) && "format (Black)",
      /\[tool\.poetry/.test(pyRaw) && "packaging (Poetry)",
    ].filter(Boolean) as string[];
    add(`${projectName} : projet Python (pyproject.toml). Outils configurés : ${tools.length ? tools.join(", ") : "aucun outil déclaré dans pyproject"}.`);
  } else if (fs.existsSync(path.join(dir, "requirements.txt"))) {
    add(`${projectName} : projet Python, dépendances gérées par requirements.txt (pas de pyproject.toml).`);
  }

  const cargoRaw = readIf(path.join(dir, "Cargo.toml"));
  if (cargoRaw) {
    const block = cargoRaw.split(/^\[dependencies\]/m)[1]?.split(/^\[/m)[0] ?? "";
    const crates = [...block.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1]).slice(0, 15);
    add(`${projectName} : projet Rust (Cargo). ${crates.length ? `Dépendances principales : ${crates.join(", ")}.` : ""}`);
  }

  const swiftRaw = readIf(path.join(dir, "Package.swift"));
  let xcode: string | undefined;
  try { xcode = fs.readdirSync(dir).find((f) => f.endsWith(".xcodeproj") || f.endsWith(".xcworkspace")); } catch { /* ignore */ }
  if (swiftRaw || xcode) {
    const platforms = swiftRaw?.match(/platforms:\s*\[([^\]]+)\]/)?.[1]?.replace(/\s+/g, " ").trim();
    const spmDeps = swiftRaw ? [...swiftRaw.matchAll(/\.package\((?:url:)?\s*"([^"]+)"/g)].map((m) => m[1].split("/").pop()?.replace(/\.git$/, "") ?? "").filter(Boolean) : [];
    add(
      `${projectName} : projet Swift${xcode ? ` (${xcode})` : " (SwiftPM)"}.` +
      (platforms ? ` Plateformes cibles : ${platforms}.` : "") +
      (spmDeps.length ? ` Dépendances SPM : ${spmDeps.join(", ")}.` : ""),
    );
  }

  const goRaw = readIf(path.join(dir, "go.mod"));
  if (goRaw) {
    const mod = goRaw.match(/^module\s+(\S+)/m)?.[1];
    const ver = goRaw.match(/^go\s+(\S+)/m)?.[1];
    add(`${projectName} : projet Go${mod ? `, module ${mod}` : ""}${ver ? `, go ${ver}` : ""}.`);
  }

  // --- Gestionnaire de paquets
  if (lock) {
    add(`${projectName} — gestionnaire de paquets : ${lock[1]} (${lock[0]} présent). N'utilise pas un autre gestionnaire, le lockfile ferait foi contre toi.`);
  }

  // --- Fichiers de config (le linter réel, pas celui supposé)
  const configs = presentIn(dir, [
    "tsconfig.json", "biome.json", "biome.jsonc", ".eslintrc.json", ".eslintrc.cjs",
    "eslint.config.js", "eslint.config.mjs", ".prettierrc", ".prettierrc.json",
    "ruff.toml", ".ruff.toml", "setup.cfg", "mypy.ini", ".swiftlint.yml",
    ".swift-format", "rustfmt.toml", "clippy.toml", ".editorconfig",
  ]);
  if (configs.length) add(`${projectName} — fichiers de configuration outillage à la racine : ${configs.join(", ")}. Respecte-les plutôt que les réglages par défaut.`);

  // --- CI et conteneurs
  try {
    const wf = fs.readdirSync(path.join(dir, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f));
    if (wf.length) add(`${projectName} — CI GitHub Actions : ${wf.join(", ")}. Ce qui casse en CI casse la PR.`);
  } catch { /* pas de workflows */ }
  const containers = presentIn(dir, ["Dockerfile", "docker-compose.yml", "compose.yaml", "docker-compose.yaml"]);
  if (containers.length) add(`${projectName} — conteneurisation : ${containers.join(", ")} à la racine.`);

  // --- Layout
  try {
    const dirs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !["node_modules", "vendor", "target", "dist", "build", "__pycache__", ".build"].includes(d.name))
      .map((d) => d.name).slice(0, 14);
    if (dirs.length) add(`${projectName} — dossiers de premier niveau : ${dirs.join(", ")}.`);
  } catch { /* ignore */ }

  // --- Documentation d'agent déjà présente
  const docs = presentIn(dir, ["README.md", "AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "ARCHITECTURE.md"]);
  if (docs.length) add(`${projectName} — documentation de référence à lire avant de coder : ${docs.join(", ")}.`);

  // --- Git
  const head = readIf(path.join(dir, ".git", "HEAD"));
  const branch = head?.match(/ref:\s*refs\/heads\/(\S+)/)?.[1];
  if (branch) add(`${projectName} — branche de travail au moment de l'amorçage : ${branch}.`);

  return facts;
}

function initPrompt(projectName: string, factCount: number): string {
  return `[mem0-init] Amorçage de la mémoire du projet "${projectName}".

L'empreinte technique du dépôt (écosystème, outillage, gestionnaire de paquets,
configs, CI, layout) vient d'être enregistrée automatiquement : ${factCount} fait(s).
Ne la refais pas, elle est déjà en mémoire.

Ta tâche maintenant, en une passe, sans écrire ni modifier de code :

1. Lis README.md, AGENTS.md, CONTRIBUTING.md, et docs/ ou adr/ s'ils existent.
2. Regarde \`git log --oneline -40\` pour repérer les chantiers récents et le style
   de commit.
3. Ouvre deux ou trois fichiers représentatifs du cœur du projet pour vérifier les
   conventions réellement appliquées — elles contredisent souvent la doc, et dans
   ce cas c'est le code qui a raison.

Puis enregistre avec \`mem0_add\`, un appel par idée, **12 souvenirs maximum** :

- l'objet du projet en une phrase : ce qu'il fait, pour qui ;
- les décisions d'architecture visibles, avec leur raison quand elle est écrite
  quelque part ;
- les conventions réelles du dépôt qui ne sont documentées nulle part (nommage,
  découpage, patterns imposés, ce qui est manifestement interdit ici) ;
- les contraintes et exigences non négociables que tu repères ;
- les pièges connus : workarounds commentés, TODO/FIXME récurrents, modules que
  les commits récents corrigent en boucle.

N'enregistre pas l'état courant du code, ni ce que l'empreinte technique couvre
déjà, ni une supposition que tu n'as pas vérifiée dans le dépôt. Dans le doute,
n'enregistre rien : un souvenir faux coûte plus cher qu'une mémoire incomplète,
parce qu'il sera rappelé avec la même autorité qu'un souvenir juste.

Termine par la liste de ce que tu as enregistré, une ligne par souvenir.`;
}

// ---------------------------------------------------------------------------
// Client HTTP
// ---------------------------------------------------------------------------

async function mem0Fetch(route: string, init: RequestInit = {}, budgetMs = TIMEOUT.other): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    const res = await fetch(`${MEM0_HTTP_URL}${route}`, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(MEM0_HTTP_TOKEN ? { "X-Mem0-Token": MEM0_HTTP_TOKEN } : {}),
        ...(init.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`mem0-http ${res.status}: ${body.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const mem0 = {
  add: (text: string, scope: string, opts: { tags?: string; infer?: boolean; procedure?: boolean } = {}) =>
    mem0Fetch(
      opts.procedure ? "/memory/add_procedure" : "/memory/add",
      {
        method: "POST",
        body: JSON.stringify(
          opts.procedure
            ? { steps: text, agent_id: scope }
            : { text, agent_id: scope, tags: opts.tags, infer: opts.infer ?? true },
        ),
      },
      TIMEOUT.write,
    ),

  search: (query: string, scope: string, limit: number) =>
    mem0Fetch(
      "/memory/search",
      { method: "POST", body: JSON.stringify({ query, agent_id: scope, limit, filters: null }) },
      TIMEOUT.search,
    ),

  getAll: (scope: string) => mem0Fetch(`/memory/all?agent_id=${encodeURIComponent(scope)}`),

  delete: (id: string) => mem0Fetch(`/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

function rows(result: any): any[] {
  return Array.isArray(result) ? result : (result?.results ?? []);
}

function memoryLine(m: any): string {
  return String(m?.memory ?? m?.text ?? JSON.stringify(m));
}

// ---------------------------------------------------------------------------
// Garde-fou secrets — best-effort avant toute écriture. Pas une garantie.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{16,}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /AKIA[0-9A-Z]{12,}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  /Bearer\s+[a-zA-Z0-9._-]{16,}/gi,
  /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[^\s"']{8,}/gi,
];

function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

// ---------------------------------------------------------------------------
// Lecture du transcript (forme défensive : elle a bougé entre versions d'OMP)
// ---------------------------------------------------------------------------

function entryText(entry: any): string | null {
  const role = entry?.role ?? entry?.type;
  if (role !== "user" && role !== "assistant") return null;
  const content = entry?.content ?? entry?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const text = content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).filter(Boolean).join("\n");
    return text || null;
  }
  return null;
}

function branchOf(ctx: ExtensionContext): any[] {
  return ctx.sessionManager?.getBranch?.() ?? [];
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

type SessionState = { turns: number; cursor: number; recalled: boolean };

export default function mem0MemoryExtension(pi: ExtensionAPI) {
  const { z } = pi.zod;
  pi.setLabel("mem0 memory");

  const states = new Map<string, SessionState>();
  const provisioned = new Map<string, BriefStatus>(); // par racine de projet

  // Clé stable par session. `ctx` peut être recréé d'un tour à l'autre selon la
  // version, donc pas de WeakSet sur l'objet ctx.
  function stateOf(ctx: any): SessionState {
    const key = String(
      ctx?.sessionManager?.sessionId ?? ctx?.sessionId ?? ctx?.session?.id ?? ctx?.cwd ?? "session",
    );
    let st = states.get(key);
    if (!st) { st = { turns: 0, cursor: 0, recalled: false }; states.set(key, st); }
    return st;
  }

  // Une vérification par racine de projet et par process. Ce sont des stat/read
  // synchrones : quelques millisecondes, rien qui justifie de l'asynchrone.
  function checkBrief(ctx: any, force = false): BriefStatus {
    const cwd = ctx?.cwd ?? process.cwd();
    const { dir } = rootOf(cwd);
    if (!force) {
      const cached = provisioned.get(dir);
      if (cached) return cached;
    }
    const status = ensureBrief(cwd, force);
    provisioned.set(dir, status);

    if (status.ref === "created" || status.agents === "created") {
      ctx?.ui?.notify?.(
        `[mem0] brief mémoire posé sur "${projectId(cwd)}" — ${BRIEF_REF_PATH} + bloc dans AGENTS.md`,
        "info",
      );
    } else if (status.ref === "outdated" || status.agents === "outdated") {
      ctx?.ui?.notify?.(
        "[mem0] brief en version ancienne sur ce projet — /mem0-brief --update pour le remplacer",
        "warning",
      );
    } else if (status.ref === "failed" || status.agents === "failed") {
      ctx?.ui?.notify?.(`[mem0] brief non posé : ${status.detail}`, "warning");
    }
    return status;
  }

  // Segment de conversation non encore retenu, borné en taille.
  function pendingSegment(ctx: ExtensionContext, st: SessionState): string | null {
    const branch = branchOf(ctx);
    if (branch.length <= st.cursor) return null;
    const slice = branch.slice(st.cursor);
    st.cursor = branch.length;
    const texts: string[] = [];
    for (const entry of slice) {
      const t = entryText(entry);
      if (t) texts.push(`${entry.role ?? entry.type}: ${t}`);
    }
    if (!texts.length) return null;
    const joined = texts.join("\n\n");
    return joined.length > RETAIN_MAX_CHARS ? joined.slice(-RETAIN_MAX_CHARS) : joined;
  }

  // Écriture en tâche de fond : ne bloque jamais un tour. Un retain lent (deux
  // passes LLM locales) ne doit pas se voir dans la latence perçue.
  function retainInBackground(ctx: ExtensionContext, st: SessionState) {
    const segment = pendingSegment(ctx, st);
    if (!segment) return;
    const scope = projectId(ctx.cwd);
    void mem0
      .add(redact(segment), scope, { infer: true, tags: "auto" })
      .catch((err) => {
        // Cursor déjà avancé : on ne réessaie pas, sinon un serveur en panne
        // ferait grossir indéfiniment le segment suivant.
        console.warn(`[mem0] retain échoué (${scope}) : ${(err as Error).message}`);
      });
  }

  // --- Vérification du brief au démarrage de session ------------------------
  // session_start couvre le cas normal ; le premier before_agent_start rattrape
  // les versions d'OMP où l'event ne remonte pas. checkBrief est mémoïsé, donc
  // le doublon ne coûte rien.
  pi.on("session_start", async (_event, ctx) => {
    try { checkBrief(ctx); } catch { /* jamais bloquant */ }
  });

  // --- Premier tour : recall. Tours suivants : retain à la cadence. ---------
  pi.on("before_agent_start", async (event, ctx) => {
    const st = stateOf(ctx);
    st.turns += 1;

    if (st.turns > 1) {
      if ((st.turns - 1) % RETAIN_EVERY_N_TURNS === 0) retainInBackground(ctx, st);
      return undefined;
    }

    try { checkBrief(ctx); } catch { /* jamais bloquant */ }

    const prompt = String((event as any).prompt ?? "").trim();
    if (!prompt || st.recalled) return undefined;
    st.recalled = true;

    const scope = projectId(ctx.cwd);
    const query =
      `Projet : ${scope}. Demande en cours : "${prompt.slice(0, 800)}". ` +
      `Stack et architecture du projet, conventions, décisions actées, bugs déjà ` +
      `rencontrés et leurs correctifs, exigences incontournables — ce qui est utile ` +
      `pour traiter cette demande.`;

    try {
      // Projet et global en parallèle : pas de latence supplémentaire.
      const [projectRes, globalRes] = await Promise.all([
        mem0.search(query, scope, RECALL_LIMIT).catch(() => null),
        mem0.search(prompt.slice(0, 400), GLOBAL_SCOPE, RECALL_GLOBAL_LIMIT).catch(() => null),
      ]);

      const projectMems = rows(projectRes);
      const globalMems = rows(globalRes);
      if (!projectMems.length && !globalMems.length) return undefined;

      const parts = [`[mem0] Mémoire du projet "${scope}" — contexte, pas vérité terrain.`];
      if (projectMems.length) {
        parts.push(projectMems.map((m) => `- ${memoryLine(m)}`).join("\n"));
      }
      if (globalMems.length) {
        parts.push("Préférences transverses :", globalMems.map((m) => `- ${memoryLine(m)}`).join("\n"));
      }
      parts.push(
        "Si un souvenir contredit l'état réel du dépôt, le dépôt gagne — le souvenir est périmé, " +
          "corrige-le avec mem0_add. Utilise mem0_search pour creuser un point précis.",
      );

      return {
        message: {
          customType: "mem0-recall",
          content: parts.join("\n\n"),
          display: false,
          attribution: "agent",
        },
      };
    } catch (err) {
      console.warn(`[mem0] recall indisponible : ${(err as Error).message}`);
      return undefined;
    }
  });

  // --- Flush en fin de session --------------------------------------------
  const flush = (ctx: ExtensionContext) => retainInBackground(ctx, stateOf(ctx));
  pi.on("session_stop", async (_event, ctx) => flush(ctx));
  pi.on("session_shutdown", async (_event, ctx) => flush(ctx));

  // --- Tools ---------------------------------------------------------------

  pi.registerTool({
    name: "mem0_search",
    label: "mem0 · search",
    description:
      "Cherche dans la mémoire du projet : stack, conventions, décisions d'archi, bugs déjà " +
      "corrigés, exigences incontournables. À appeler avant de débugger quelque chose qui " +
      "ressemble à du déjà-vu, ou avant de trancher une question d'architecture.",
    parameters: z.object({
      query: z.string().describe("Résumé du symptôme, du sujet ou de la décision recherchée"),
      scope: z.enum(["project", "global"]).optional().default("project"),
      limit: z.number().int().min(1).max(20).optional().default(6),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx: any) {
      const scope = params.scope === "global" ? GLOBAL_SCOPE : projectId(ctx?.cwd ?? process.cwd());
      const result = await mem0.search(params.query, scope, params.limit ?? 6);
      const found = rows(result);
      const text = found.length
        ? found.map((m) => `- [${m.id ?? "?"}] ${memoryLine(m)}`).join("\n")
        : "Aucun souvenir pertinent.";
      return { content: [{ type: "text", text }], details: result };
    },
  });

  pi.registerTool({
    name: "mem0_add",
    label: "mem0 · add",
    description:
      "Enregistre un point durable : stack ou choix technique du projet, convention, décision " +
      "d'architecture, bug + cause racine + correctif, exigence incontournable d'une feature, " +
      "préférence de travail. Une seule idée par appel, formulée pour être comprise dans six " +
      "mois sans le contexte de cette conversation. N'enregistre rien de trivial ni de temporaire.",
    parameters: z.object({
      text: z.string().describe("Le fait, autoportant. Ex: 'Auth : tokens de reset à usage unique, TTL 15 min (décision du 12/03).'"),
      kind: z
        .enum(["fact", "procedure"])
        .optional()
        .default("fact")
        .describe("'procedure' pour une méthode réutilisable en plusieurs étapes (déploiement, checklist), 'fact' sinon"),
      scope: z
        .enum(["project", "global"])
        .optional()
        .default("project")
        .describe("'global' uniquement pour une préférence valable sur tous tes projets"),
      tags: z.string().optional().describe("valeurs séparées par des virgules, ex: 'stack,swiftui'"),
      verbatim: z
        .boolean()
        .optional()
        .default(false)
        .describe("true pour stocker le texte exact (extrait de code, diff) sans passer par l'extraction LLM"),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx: any) {
      const scope = params.scope === "global" ? GLOBAL_SCOPE : projectId(ctx?.cwd ?? process.cwd());
      const result = await mem0.add(redact(params.text), scope, {
        tags: params.tags,
        infer: !params.verbatim,
        procedure: params.kind === "procedure",
      });
      return { content: [{ type: "text", text: `Enregistré dans "${scope}".` }], details: result };
    },
  });

  pi.registerTool({
    name: "mem0_forget",
    label: "mem0 · forget",
    description:
      "Supprime un souvenir par son id (retourné par mem0_search). À utiliser quand un souvenir " +
      "est devenu faux — pas quand il est simplement incomplet : dans ce cas, ajoute la version " +
      "à jour avec mem0_add, la fusion garde une trace de l'ancien état.",
    parameters: z.object({ memory_id: z.string() }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const result = await mem0.delete(params.memory_id);
      return { content: [{ type: "text", text: "Supprimé." }], details: result };
    },
  });

  // --- Commandes -----------------------------------------------------------

  pi.registerCommand("mem0-status", {
    description: "Connexion mem0, projet résolu, état du brief, nombre de souvenirs",
    handler: async (_args, ctx) => {
      const scope = projectId(ctx.cwd);
      const brief = provisioned.get(rootOf(ctx.cwd).dir) ?? checkBrief(ctx);
      try {
        const health = await mem0Fetch("/health");
        const [proj, glob] = await Promise.all([mem0.getAll(scope), mem0.getAll(GLOBAL_SCOPE)]);
        ctx.ui.notify(
          `[mem0] ok=${!!health.ok} · ${MEM0_HTTP_URL} · projet="${scope}" ${rows(proj).length} souvenir(s) · ` +
            `global ${rows(glob).length} · brief ref=${brief.ref} agents=${brief.agents}`,
          "info",
        );
      } catch (err) {
        ctx.ui.notify(
          `[mem0] injoignable sur ${MEM0_HTTP_URL} : ${(err as Error).message} · brief ref=${brief.ref} agents=${brief.agents}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("mem0-init", {
    description:
      "Amorce la mémoire d'un projet déjà existant : empreinte technique du dépôt + relecture guidée. " +
      "--scan-only pour l'empreinte seule, --force pour réamorcer un projet déjà en mémoire",
    handler: async (args, ctx) => {
      const argv = String(args ?? "");
      const force = argv.includes("--force");
      const scanOnly = argv.includes("--scan-only");
      const scope = projectId(ctx.cwd);
      const { dir, isRepo } = rootOf(ctx.cwd);

      if (!isRepo && !force) {
        ctx.ui.notify(
          `[mem0] ${dir} ne ressemble pas à un projet (ni .git ni AGENTS.md). --force pour amorcer quand même.`,
          "warning",
        );
        return;
      }

      // Le brief d'abord : sans lui, l'agent ne saura pas quoi enregistrer.
      checkBrief(ctx);

      // Garde anti-doublon. Réamorcer un projet déjà en mémoire crée des
      // quasi-doublons que la fusion mem0 ne rattrape pas toujours, et qui
      // diluent le recall.
      let existing = 0;
      try {
        existing = rows(await mem0.getAll(scope)).length;
      } catch (err) {
        ctx.ui.notify(`[mem0] injoignable sur ${MEM0_HTTP_URL} : ${(err as Error).message}`, "error");
        return;
      }

      if (existing > 0 && !force) {
        let go = false;
        if (ctx.hasUI) {
          try {
            go = await ctx.ui.confirm(
              `Le projet "${scope}" a déjà ${existing} souvenir(s). Réamorcer risque de créer des doublons. Continuer ?`,
            );
          } catch { go = false; }
        }
        if (!go) {
          ctx.ui.notify(`[mem0] amorçage annulé (${existing} souvenir(s) existants) — /mem0-init --force pour forcer.`, "info");
          return;
        }
      }

      // 1. Empreinte technique : lue sur disque, écrite en verbatim (infer=false).
      // Pas d'extraction LLM ici — ce sont déjà des faits, et les faire passer
      // par le modèle ne ferait que les paraphraser en perdant des détails.
      const facts = scanStack(dir, scope);
      if (!facts.length) {
        ctx.ui.notify(`[mem0] rien de détectable sur disque dans ${dir} — l'amorçage repose entièrement sur la relecture.`, "warning");
      }

      let written = 0;
      const failures: string[] = [];
      for (const fact of facts) {
        try {
          await mem0.add(fact, scope, { infer: false, tags: "stack,init" });
          written++;
        } catch (err) {
          failures.push((err as Error).message);
        }
      }
      ctx.ui.notify(
        `[mem0] empreinte de "${scope}" : ${written}/${facts.length} fait(s) enregistré(s)` +
          (failures.length ? ` · ${failures.length} échec(s) : ${failures[0]}` : ""),
        failures.length ? "warning" : "info",
      );

      if (scanOnly) return;
      if (written === 0 && facts.length > 0) {
        ctx.ui.notify("[mem0] aucune écriture n'a abouti — relecture non lancée. Vérifie /mem0-status.", "error");
        return;
      }

      // 2. Relecture guidée : la partie qui demande du jugement part au modèle,
      // en tant que message utilisateur pour que le tour démarre normalement.
      try {
        await ctx.waitForIdle?.();
        pi.sendUserMessage(initPrompt(scope, written));
      } catch (err) {
        ctx.ui.notify(`[mem0] relecture non lancée : ${(err as Error).message}`, "warning");
      }
    },
  });

  pi.registerCommand("mem0-brief", {
    description: "État du brief mémoire du projet ; --update pour réécrire la version courante",
    handler: async (args, ctx) => {
      const force = String(args ?? "").includes("--update");
      const st = checkBrief(ctx, force);
      ctx.ui.notify(
        `[mem0] brief ${BRIEF_VERSION} · ${st.root} · ${BRIEF_REF_PATH}=${st.ref} · AGENTS.md=${st.agents}` +
          (st.detail ? ` (${st.detail})` : ""),
        st.ref === "failed" || st.agents === "failed" ? "warning" : "info",
      );
    },
  });

  pi.registerCommand("mem0-save", {
    description: "Force l'écriture immédiate du segment de conversation non encore mémorisé",
    handler: async (_args, ctx) => {
      retainInBackground(ctx as any, stateOf(ctx));
      ctx.ui.notify(`[mem0] écriture lancée en tâche de fond (projet "${projectId(ctx.cwd)}")`, "info");
    },
  });
}
