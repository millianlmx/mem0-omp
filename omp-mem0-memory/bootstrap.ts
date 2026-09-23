// Empreinte technique d'un projet préexistant : ce qui est lisible sur le disque, et la consigne de relecture.
import * as fs from "node:fs";
import * as path from "node:path";
import { redact } from "./write.ts";

// ---------------------------------------------------------------------------
// Empreinte technique — amorçage d'un projet préexistant (/mem0-init)
//
// Tout ce qui est déductible du disque est lu ici, pas demandé au modèle : c'est
// gratuit, instantané et exact. Le modèle n'est sollicité que pour ce qui demande
// du jugement (décisions d'archi, conventions réelles, pièges).
// ---------------------------------------------------------------------------

export function readIf(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

export function presentIn(dir: string, names: string[]): string[] {
  return names.filter((n) => fs.existsSync(path.join(dir, n)));
}

export const NODE_TOOLS: Record<string, string> = {
  vitest: "tests (Vitest)", jest: "tests (Jest)", mocha: "tests (Mocha)",
  "@playwright/test": "tests e2e (Playwright)", cypress: "tests e2e (Cypress)",
  eslint: "lint (ESLint)", "@biomejs/biome": "lint+format (Biome)",
  prettier: "format (Prettier)", typescript: "typage (TypeScript)",
  vite: "build (Vite)", webpack: "build (webpack)", esbuild: "build (esbuild)",
  next: "framework (Next.js)", react: "UI (React)", vue: "UI (Vue)",
  svelte: "UI (Svelte)", express: "serveur (Express)", fastify: "serveur (Fastify)",
  "@nestjs/core": "framework (NestJS)", prisma: "ORM (Prisma)", drizzle_orm: "ORM (Drizzle)",
};

export const PKG_MANAGERS: Array<[string, string]> = [
  ["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"], ["package-lock.json", "npm"],
  ["uv.lock", "uv"], ["poetry.lock", "poetry"], ["Pipfile.lock", "pipenv"],
];

// Retourne une liste de faits courts et autoportants. Un fait par idée : mélanger
// stack, layout et CI dans un seul blob les rendrait tous inatteignables au
// recall, qui classe par similarité sémantique.
export function scanStack(dir: string, projectName: string): string[] {
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

export function initPrompt(projectName: string, factCount: number): string {
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
