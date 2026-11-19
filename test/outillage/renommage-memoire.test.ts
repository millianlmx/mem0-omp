// Feature renommage-memoire : le dépôt cesse de nommer « mem0 » (dossiers, plugins, outils, commandes, variables,
// fichiers, textes) et les installations d'avant continuent de marcher, parce que les anciens noms restent LUS
// pendant une version de transition. Ce fichier porte la garde du mot (AC-301) et la preuve de chaque critère
// de comportement (AC-302 à AC-313). Les critères de revue (AC-314, AC-315) n'ont pas de test.
//
// Ce fichier et test/support/renommage-memoire/ nomment mem0 partout : ils sont les deux exceptions de FICHIER
// ENTIER de la garde du mot. Les noms d'environnement planté y sont assemblés (« MEM0 » + « _… ») pour ne pas
// entrer dans le relevé de la table des noms qu'ils éprouvent.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { setTimeout as attendre } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { DEFAULT_LAUNCHER, loadConfig } from "../../omp-harness/config/config.ts";
import { renamedEnv as renamedEnvHarness } from "../../omp-harness/config/env.ts";
import { PolicyRefusal, policySecretVars, repoMemoryToken } from "../../omp-harness/config/policy.ts";
import { HttpOracle } from "../../omp-harness/memory/oracle.ts";
import { memoryStatusOf } from "../../omp-harness/operations/observability.ts";
import {
  MEMORY_EXTENSION,
  NO_GLOBAL_ENV,
  memoryExtension,
  runnerArgv,
  runnerEnv,
  runnerExtensions,
  runnerMemoryEnv,
} from "../../omp-harness/runners/runner.ts";
import reqExtension from "../../omp-memory-req/extension.ts";
import { writePairing } from "../../omp-memory-req/harness.ts";
import { renamedEnv as renamedEnvMemory } from "../../omp-memory/env.ts";
import { renamedEnv as renamedEnvReq } from "../../omp-memory-req/env.ts";
import { demarrerFauxOpenAI } from "../../scripts/memory-http-contrat/faux-openai.ts";
import type { FauxOpenAI } from "../../scripts/memory-http-contrat/faux-openai.ts";
import { fakeSchema } from "../support/fake-zod.ts";
import { testConfig } from "../support/harness-fixtures.ts";
import { prerequisAbsent } from "../support/prerequis.ts";
import { ROOT, excludedFromCopy, tmpdir } from "../support/repo.ts";
import { ancienEnsureBrief } from "../support/renommage-memoire/ancien-brief.ts";

const FIXTURES = path.join(ROOT, "test", "support", "renommage-memoire");
const CE_TEST = "test/outillage/renommage-memoire.test.ts";

// HOME jetable posé AVANT l'import du plugin mémoire (son registre de phases global et ses réglages se lisent au
// chargement) ; le service qui répond au plugin est un serveur local doublé (AC-304, AC-307).
const HOME_TEST = tmpdir("renommage-memoire-home-");
process.env.HOME = HOME_TEST;
delete process.env.MEMORY_AUTOSETUP;
delete process.env.MEM0_AUTOSETUP;
delete process.env.MEMORY_MODE;
delete process.env.MEM0_MODE;
delete process.env.MEMORY_PROJECT_ID;
delete process.env.MEM0_PROJECT_ID;
delete process.env.MEMORY_NO_GLOBAL;
delete process.env.MEM0_NO_GLOBAL;

/** Un service mémoire doublé : il note chaque requête (route, en-têtes, corps) et répond comme memory-rs. */
type Requete = { methode: string; route: string; entetes: http.IncomingHttpHeaders; corps: string };
type ServiceDouble = { url: string; requetes: Requete[]; fermer: () => Promise<void> };

async function serviceDouble(
  repondre: (requete: Requete) => unknown = () => ({ results: [] }),
): Promise<ServiceDouble> {
  const requetes: Requete[] = [];
  const serveur = http.createServer((req, res) => {
    const morceaux: Buffer[] = [];
    req.on("data", (morceau: Buffer) => morceaux.push(morceau));
    req.on("end", () => {
      const requete: Requete = {
        methode: req.method ?? "GET",
        route: req.url ?? "/",
        entetes: req.headers,
        corps: Buffer.concat(morceaux).toString("utf8"),
      };
      requetes.push(requete);
      const texte = JSON.stringify(repondre(requete));
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(texte) });
      res.end(texte);
    });
  });
  const ecoute = Promise.withResolvers<void>();
  serveur.listen(0, "127.0.0.1", () => ecoute.resolve());
  await ecoute.promise;
  const port = (serveur.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requetes,
    fermer: () => {
      const ferme = Promise.withResolvers<void>();
      serveur.close(() => ferme.resolve());
      return ferme.promise;
    },
  };
}

const SERVICE_PLUGIN = await serviceDouble((requete) => {
  if (requete.route.startsWith("/memory/add")) return { results: [{ id: "m-1", memory: "noté", event: "ADD" }] };
  if (requete.route.startsWith("/memory/search")) {
    const ligne = { id: "m-7", memory: "Le dépôt cible bash 3.2", score: 0.9, score_details: { semantic_score: 0.95 } };
    return { results: [ligne] };
  }
  return { results: [], ok: true };
});
process.env.MEMORY_HTTP_URL = SERVICE_PLUGIN.url;
process.env.MEMORY_HTTP_TOKEN = "jeton-plugin";
delete process.env.MEM0_HTTP_URL;
delete process.env.MEM0_HTTP_TOKEN;
test.after(async () => {
  await SERVICE_PLUGIN.fermer();
});

// Imports dynamiques : HOME, l'adresse du service et le jeton se lisent au chargement du plugin, donc se posent avant.
const { default: memoryPluginExtension } = await import("../../omp-memory/extension.ts");
const brief = await import("../../omp-memory/brief.ts");
const { memoryFetch } = await import("../../omp-memory/memoryClient.ts");
const { resolveMemoryTarget } = await import("../../omp-memory/config.ts");

const MARQUE_EXTENSION = Symbol.for("omp-memory.extension");
const MARQUE_REQ = Symbol.for("omp-memory-req.extension");

function oublierMarques(): void {
  delete (globalThis as Record<symbol, unknown>)[MARQUE_EXTENSION];
  delete (globalThis as Record<symbol, unknown>)[MARQUE_REQ];
}

/** Ce qu'une extension enregistre sur un `pi` doublé : outils, commandes, hooks, libellé. */
type Outil = { name: string; label?: string; description?: string; execute: (...args: never[]) => Promise<unknown> };
type Commande = { description?: string; handler: (args: string, ctx: never) => Promise<unknown> };
type Enregistrement = {
  outils: Map<string, Outil>;
  commandes: Map<string, Commande>;
  hooks: Map<string, (event: never, ctx: never) => Promise<unknown>>;
  libelles: string[];
  appelsOutil: string[];
  appelsCommande: string[];
  messages: unknown[];
};

function piDouble(): { pi: Parameters<typeof memoryPluginExtension>[0]; enregistre: Enregistrement } {
  const enregistre: Enregistrement = {
    outils: new Map(),
    commandes: new Map(),
    hooks: new Map(),
    libelles: [],
    appelsOutil: [],
    appelsCommande: [],
    messages: [],
  };
  const pi = {
    zod: { z: fakeSchema() },
    setLabel: (libelle: string) => enregistre.libelles.push(libelle),
    registerMessageRenderer: () => {},
    on: (nom: string, handler: (event: never, ctx: never) => Promise<unknown>) => enregistre.hooks.set(nom, handler),
    registerTool: (outil: Outil) => {
      enregistre.appelsOutil.push(outil.name);
      enregistre.outils.set(outil.name, outil);
    },
    registerCommand: (nom: string, commande: Commande) => {
      enregistre.appelsCommande.push(nom);
      enregistre.commandes.set(nom, commande);
    },
    sendMessage: (message: unknown) => enregistre.messages.push(message),
    sendUserMessage: (message: unknown) => enregistre.messages.push(message),
  };
  return { pi: pi as unknown as Parameters<typeof memoryPluginExtension>[0], enregistre };
}

/** Une session mémoire neuve : le plugin chargé sur un `pi` doublé, sans marque de process héritée. */
function chargerPlugin(): Enregistrement {
  oublierMarques();
  const { pi, enregistre } = piDouble();
  memoryPluginExtension(pi);
  return enregistre;
}

/** Les fichiers du dépôt, par `git ls-files` (suivis ET nouveaux non ignorés) ; sans git (copie jetable), un parcours. */
function fichiersDuDepot(): string[] {
  let liste: string[];
  try {
    liste = execFileSync("git", ["ls-files", "-z", "-c", "-o", "--exclude-standard"], {
      cwd: ROOT,
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    liste = [];
    const parcourir = (dossier: string): void => {
      for (const entree of fs.readdirSync(path.join(ROOT, dossier), { withFileTypes: true })) {
        const relatif = dossier === "" ? entree.name : `${dossier}/${entree.name}`;
        if (excludedFromCopy(relatif)) continue;
        if (entree.isDirectory()) parcourir(relatif);
        else liste.push(relatif);
      }
    };
    parcourir("");
  }
  return [...new Set(liste)].filter((relatif) => {
    try {
      return fs.lstatSync(path.join(ROOT, relatif)).isFile();
    } catch {
      return false;
    }
  });
}

/** Le texte d'un fichier suivi, `null` s'il est binaire. */
function texteDe(relatif: string): string | null {
  const octets = fs.readFileSync(path.join(ROOT, relatif));
  return octets.includes(0) ? null : octets.toString("utf8");
}

const lire = (relatif: string): string => fs.readFileSync(path.join(ROOT, relatif), "utf8");

/** Le texte d'un fichier lu sous `ROOT`, jusqu'à la prochaine ligne qui ouvre une section de même niveau. */
function sectionDe(markdown: string, titre: string): string {
  const lignes = markdown.split("\n");
  const debut = lignes.indexOf(titre);
  assert.ok(debut >= 0, `section « ${titre} » introuvable`);
  const niveau = /^#+/.exec(titre)![0].length;
  let fin = lignes.length;
  for (let i = debut + 1; i < lignes.length; i += 1) {
    const ouverture = /^(#+) /.exec(lignes[i]!);
    if (ouverture && ouverture[1]!.length <= niveau) {
      fin = i;
      break;
    }
  }
  return lignes.slice(debut, fin).join("\n");
}

// ── La table des noms d'environnement (S-4) : 108 noms `*MEM0_*` relevés à la base, classés ──────────────
// Classe V : variables lues, couple (ancien, nouveau) avec repli (84).
const NOMS_V = [
  "MEM0_AC_FILES",
  "MEM0_AC_IDS",
  "MEM0_AC_TAP",
  "MEM0_AGENT_RECIPE",
  "MEM0_ANCIEN_STOCKAGE_QDRANT",
  "MEM0_AUTOSETUP",
  "MEM0_BACKUP_INTERVAL_HOURS",
  "MEM0_BACKUP_KEEP",
  "MEM0_BACKUP_REMOTE_CMD",
  "MEM0_BACKUP_REMOTE_TIMEOUT_SECONDS",
  "MEM0_BASCULE_CONTENEUR",
  "MEM0_BASCULE_HISTORY_DB",
  "MEM0_BASCULE_REEL",
  "MEM0_CHECK_DEPTH",
  "MEM0_COMPONENTS_RECIPE",
  "MEM0_CONSOLE_HOOK_ALL_WORKTREES",
  "MEM0_CONTRAT_EXTERNE",
  "MEM0_CONTRAT_GRPC_PORT",
  "MEM0_CONTRAT_HOST",
  "MEM0_CONTRAT_INFER",
  "MEM0_CONTRAT_MOTEUR",
  "MEM0_CONTRAT_OPENAI_HOTE",
  "MEM0_CONTRAT_OPENAI_PORT",
  "MEM0_CONTRAT_PORT",
  "MEM0_CONTRAT_QDRANT",
  "MEM0_CONTRAT_RANG_FIXTURE",
  "MEM0_CONTRAT_START",
  "MEM0_CONTRAT_TOKEN",
  "MEM0_CONTRAT_URL",
  "MEM0_CONTRAT_WORKDIR",
  "MEM0_DB_PATH",
  "MEM0_DREAM_FORGET_DAYS",
  "MEM0_DREAM_INTERVAL_MINUTES",
  "MEM0_DREAM_PAIRS",
  "MEM0_DREAM_QUIET_MINUTES",
  "MEM0_HTTP_TOKEN",
  "MEM0_HTTP_TOKENS",
  "MEM0_HTTP_TOKENS_FILE",
  "MEM0_HTTP_URL",
  "MEM0_LOG_DIR",
  "MEM0_LOG_RETENTION_DAYS",
  "MEM0_MEMORY_RECIPE",
  "MEM0_MEMORY_RECIPE_PROJECT",
  "MEM0_MIGRATION_RECIPE",
  "MEM0_MODE",
  "MEM0_NO_GLOBAL",
  "MEM0_NUDGE",
  "MEM0_OMP_HOST_MODULES",
  "MEM0_OMP_HOST_TYPES",
  "MEM0_OMP_LINT_DIR",
  "MEM0_OMP_MAC_SHOTS",
  "MEM0_OMP_REQUIRE_IOS",
  "MEM0_OMP_REQUIRE_RUST",
  "MEM0_OMP_REQUIRE_SMOKE",
  "MEM0_OMP_SKIP_IOS",
  "MEM0_OMP_SKIP_RUST",
  "MEM0_OMP_SKIP_SWIFT_APP",
  "MEM0_OMP_TSC_ARGS",
  "MEM0_PROJECT_ID",
  "MEM0_QUIET",
  "MEM0_RRF_K",
  "MEM0_RS_BIN",
  "MEM0_RS_CONTAINER",
  "MEM0_RS_DATA_DIR",
  "MEM0_RS_MIGRATION_HISTORY_DB",
  "MEM0_RS_MIGRATION_HTTP_URL",
  "MEM0_RS_MIGRATION_QDRANT_URL",
  "MEM0_RS_MIGRATION_REEL",
  "MEM0_RS_PORT",
  "MEM0_RS_TARGET",
  "MEM0_SANS_PODMAN_REEL",
  "MEM0_SEARCH_FUSION",
  "MEM0_SESSION_COMPONENT_RECIPE",
  "MEM0_STACK_RECIPE",
  "MEM0_TEST_CHANGED",
  "MEM0_TEST_CHANGED_STATUS",
  "MEM0_TEST_MACOS_ONLY",
  "MEM0_TEST_SCOPE",
  "MEM0_TEST_WITH_OUTILLAGE",
  "MEM0_UNION_RECIPE",
  "OMP_CONSOLE_MEM0_PORT",
  "OMP_HARNESS_MEM0_ENV",
  "OMP_HARNESS_MEM0_PORT",
  "OMP_HARNESS_TAILNET_MEM0_PORT",
];
// Classe F : la famille désignée par une configuration (`memory.tokenEnv`), et ses exemples de doc et de tests.
const NOMS_F = ["MEM0_TOKEN_", "MEM0_TOKEN_CLIENT_CORPO", "MEM0_TOKEN_PERSO"];
// Classe E : variable émise pour un programme tiers (doublée) ; clé du plist de l'app (règle seule, sans doublon).
const NOMS_E = ["MEM0_BACKUP_FILE", "OMP_CONSOLE_MEM0_RS_SHA256"];
// Classe K : clé d'un fichier persistant (`published.env`) lue avec repli.
const NOMS_K = ["MEM0_URL"];
// Classe N : noms internes renommés sans repli (variables locales de script, préfixes de famille, données de test).
const NOMS_N = [
  "MEM0_ENV",
  "MEM0_PORT",
  "TS_MEM0_PORT",
  "MEM0_TOKEN",
  "MEM0_",
  "MEM0_CONTRAT_",
  "MEM0_DREAM_",
  "MEM0_OMP_HOST_",
  "MEM0_OMP_REQUIRE_",
  "MEM0_OMP_SKIP_",
  "MEM0_RS_",
  "ABSENT_MEM0_TOKEN",
  "ACME_MEM0_TOKEN",
  "CORPO_MEM0_TOKEN",
];
// Classe P : l'ancienne pile Python (exceptions, laissées telles quelles).
const NOMS_P = [
  "MEM0_HTTP_PYTHON",
  "MEM0_HTTP_VENV",
  "MEM0_OMP_REQUIRE_HTTP_API",
  "MEM0_OMP_SKIP_HTTP_CONTRAT",
];
const TABLE_S4 = new Set([...NOMS_V, ...NOMS_F, ...NOMS_E, ...NOMS_K, ...NOMS_N, ...NOMS_P]);

/** La règle de nom (S-3) : MEM0 → MEMORY, puis un doublon exact du mot se replie en un seul. */
function nouveauNom(ancien: string): string {
  return ancien.replaceAll("MEM0", "MEMORY").replaceAll("MEMORY_MEMORY", "MEMORY");
}

// ── AC-301 : la garde du mot ───────────────────────────────────────────────────────────────────────────
type Fichier = { path: string; text: string };
type Exceptions = {
  /** Fichiers entiers (un chemin exact) ou dossiers entiers (chemin qui finit par « / »). */
  whole: string[];
  /** Sections de documentation exemptées : du titre à la prochaine ligne qui ouvre un `## `. */
  sections: Array<{ path: string; title: string }>;
  /** Chemins permis (un chemin qui nomme mem0 est une mention). */
  paths: string[];
  /** Fichier → motifs d'anciens noms exacts : chaque occurrence d'une ligne doit tomber dans une correspondance. */
  patterns: Record<string, RegExp[]>;
};

const MOT = /mem0/i;

function globale(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

/**
 * Toutes les occurrences de /mem0/i d'un contenu ou d'un chemin qu'aucune exception ne couvre, en
 * `fichier:ligne : extrait` (ou `fichier : le chemin nomme mem0`), plus les exceptions qui ne couvrent plus rien.
 */
function scanMentions(files: Fichier[], exceptions: Exceptions): string[] {
  const problemes: string[] = [];
  const presents = new Set(files.map((f) => f.path));
  const entier = (p: string): boolean => exceptions.whole.some((w) => (w.endsWith("/") ? p.startsWith(w) : p === w));
  for (const chemin of exceptions.paths) {
    if (!presents.has(chemin)) problemes.push(`${chemin} : chemin permis mais absent`);
  }
  for (const chemin of Object.keys(exceptions.patterns)) {
    if (!presents.has(chemin)) problemes.push(`${chemin} : exception de motif sans fichier`);
  }
  for (const file of files) {
    if (entier(file.path)) continue;
    if (MOT.test(file.path) && !exceptions.paths.includes(file.path)) problemes.push(
      `${file.path} : le chemin nomme mem0`,
    );
    const motifs = (exceptions.patterns[file.path] ?? []).map(globale);
    const servis = motifs.map(() => false);
    const section = exceptions.sections.find((s) => s.path === file.path);
    const lignes = file.text.split("\n");
    let dans = false;
    let sectionVue = false;
    lignes.forEach((ligne, i) => {
      if (section) {
        if (ligne === section.title) {
          dans = true;
          sectionVue = true;
        } else if (dans && ligne.startsWith("## ")) dans = false;
        if (dans) return;
      }
      const occurrences = [...ligne.matchAll(/mem0/gi)];
      if (occurrences.length === 0) return;
      const couvertures = motifs.flatMap((re, k) =>
        [...ligne.matchAll(re)].map((m) => ({ k, debut: m.index ?? 0, fin: (m.index ?? 0) + m[0].length })),
      );
      let nonCouverte = false;
      for (const occurrence of occurrences) {
        const place = occurrence.index ?? 0;
        const couvrantes = couvertures.filter((c) => place >= c.debut && place < c.fin);
        if (couvrantes.length === 0) nonCouverte = true;
        for (const c of couvrantes) servis[c.k] = true;
      }
      if (nonCouverte) problemes.push(`${file.path}:${i + 1} : ${ligne.trim().slice(0, 140)}`);
    });
    if (section && !sectionVue) problemes.push(`${file.path} : section « ${section.title} » introuvable`);
    motifs.forEach((re, k) => {
      if (!servis[k]) problemes.push(`${file.path} : le motif ${re.source.slice(0, 80)} ne couvre plus rien`);
    });
  }
  return problemes;
}

type Motif = { re: RegExp; why: string };

/** Les anciens noms permis (S-5), chacun avec sa raison. Un motif n'accepte que des noms exacts. */
const MOTIFS = {
  ENV_V: {
    re: new RegExp(
      `\\b(?:${[...NOMS_V, "MEM0_TOKEN_[A-Z0-9_]*", "MEM0_BACKUP_FILE", "MEM0_URL", "OMP_CONSOLE_MEM0_RS_SHA256"].join("|")})\\b|\\bOMP_HARNESS_REBUILD_MEM0\\b`,
      "g",
    ),
    why:
      "variable d'environnement renommée, lue sous son ancien nom quand le nouveau manque (B-3, liste fermée de S-4)",
  },
  ENV_PY: {
    re: /\b(?:MEM0_HTTP_PYTHON|MEM0_HTTP_VENV|MEM0_OMP_REQUIRE_HTTP_API|MEM0_OMP_SKIP_HTTP_CONTRAT)\b/g,
    why: "variable de l'ancienne pile Python, que la garde d'absence nomme (B-2)",
  },
  ENV_PREFIX: {
    re: /\bMEM0_(?:OMP_REQUIRE_(?=[$<])|(?![A-Z0-9_]))/g,
    why: "préfixe de famille lu en repli (`required()` de check.sh) ou cité en bloc pour une garde",
  },
  ENV_REWRITE: {
    re: /\bMEM0\b/g,
    why: "calcul du nom de repli (nouveau nom → ancien) d'une variable, dans le code qui le fait",
  },
  HEADER: {
    re: /\bx-mem0-token\b/gi,
    why: "ancien en-tête d'authentification, lu et émis pendant la transition (B-4)",
  },
  JSON_FILE: {
    re: /mem0\.json(?:\.prev)?/g,
    why: "ancien fichier de réglages partagé, lu et écrit là où il existe (B-5)",
  },
  BRIEF: {
    re: /mem0:brief/g,
    why: "ancien marqueur du brief : paire inerte du nouveau bloc et reconnaissance des blocs publiés (B-6)",
  },
  BRIEF_FILE: {
    re: /\.omp\/mem0-brief\.md/g,
    why: "ancien fichier de référence du brief, jamais lu ni supprimé, seulement ignoré (décision #7)",
  },
  SYSUSER: {
    re: /omp-mem0(?![\w-])/g,
    why: "utilisateur, groupe et dossier système gardés pendant la transition (B-10)",
  },
  OLD_DB: {
    re: /mem0-rs(?:\.db(?:-shm|-wal|\.lock)?|-\d{8}T\d{6}Z\.db|\.log)/g,
    why: "base, verrou, instantanés et journal de l'ancien nom, lus sur place (B-5)",
  },
  OLD_HOME: { re: /\.mem0(?=\/|\b)/g, why: "ancien dossier de la base par défaut `~/.mem0/`, lu sur place (B-5)" },
  APP_LABEL: {
    re: /com\.omp\.console\.mem0-rs/g,
    why: "ancien agent launchd de l'app, déchargé à la mise à niveau (B-10)",
  },
  OLD_NAME_RS: {
    re: /mem0-rs\b(?!\.)/g,
    why:
      "ancien nom du binaire, du dossier de l'app et du conteneur de la pile manuelle de repli (B-5, B-10, décision #14)",
  },
  TOOL: { re: /\bmem0_(?:search|add|update|link|forget)\b/g, why: "alias d'outil de l'ancien nom (décision #3)" },
  CMD: {
    re: /mem0-(?:status|init|brief|dedupe|purge-procedures|save|dream)\b|mem0-\*/g,
    why: "alias de commande de l'ancien nom (décision #3)",
  },
  PLUGIN: {
    re: /omp-mem0-(?:memory|req)\b/g,
    why:
      "anciennes entrées du catalogue, tags existants, table des plugins renommés et ancien chemin d'extension (B-2, B-8, B-13)",
  },
  CATALOG: {
    re: /(?<![\w/])mem0-omp\b|@mem0-omp\b|mem0-omp(?=___)/g,
    why: "nom du catalogue de plugins, gardé pendant la transition (décision de l'humain du 2026-11-19)",
  },
  REPO: {
    re: /\/mem0-omp\b/g,
    why: "dépôt GitHub `millianlmx/mem0-omp` et ses dérivés (clone, runner de la CI) : geste de l'humain",
  },
  PY: {
    re:
      /mem0-http(?:-venv|-test\.sh)?|omp-console-mem0-http|mem0-qdrant(?:-repetition)?|\/home\/mem0\/\.mem0\/history\.db|mem0ai|mem0-local-qdrant-key|\.mem0\/history\.db/g,
    why:
      "noms de l'ancienne pile Python (conteneurs, chemins, clé, bibliothèque) que l'import et la détection adressent (B-2)",
  },
  STACK_DIR: {
    re: /mem0-stack\b|mem0-rs-data|mem0-rs:local/g,
    why: "dossier, données et image de la pile manuelle d'avant, que le compose de repli lit (décision #14)",
  },
  COMPOSE_SVC: {
    re: /`mem0`|\[mem0\]|^\s*(?:- )?mem0:(?=\s|$)|\bmem0: \{|\b(?:stop|start) mem0\b|\bmem0:8321|\bmv mem0 memory/g,
    why: "clé de service compose `mem0` et son adresse `mem0:8321`, gardées pendant la transition (décision #19)",
  },
  DATA_DIR: {
    re:
      /(?:\$ROOT|\$1|\$SECRETS|\$\{OMP_HARNESS_(?:ROOT|SECRETS)\}|\$OMP_HARNESS_(?:ROOT|SECRETS))\/mem0(?:\.env)?|(?<![\w-])mem0\.env\b|\bln -s mem0\b/g,
    why: "dossiers de données et fichiers de secrets sous l'ancien nom, lus sur place (décision #20)",
  },
  TOKEN_FILE: {
    re: /\bmem0\.token\b/g,
    why: "fichier de jeton de la supervision, gardé pendant la transition (décision #17)",
  },
  NIX: {
    re: /\bmem0(?=\s*=\s*\{)|\bmem0HttpsPort|\bcfg\.mem0|services\.omp-harness\.(?:tailscale\.)?mem0/g,
    why: "anciennes options NixOS acceptées pendant la transition (B-10)",
  },
  UNIT: {
    re: /omp-harness-mem0\.service/g,
    why: "ancienne unité systemd, arrêtée et désactivée par install.sh (B-10)",
  },
  JOURNAL: {
    re: /mem0-(?:AAAA-MM-JJ|\d{4}-\d{2}-\d{2})\.jsonl|"mem0-"/g,
    why: "anciens fichiers de journal `mem0-*.jsonl`, purgés par la rétention (B-9)",
  },
  METRICS: {
    re: /\bmem0_(?!search|add|update|link|forget)[\w<>*]+/g,
    why: "métriques doublées sous l'ancien préfixe (B-9)",
  },
  HEALTH_KEY: {
    re: /"mem0"|\bmem0: S\b|body\?\.mem0|corps\["mem0"\]|\(\?:memory\|mem0\)|`memory` et `mem0`|`mem0`/g,
    why: "ancienne clé `mem0` du corps de `GET /health`, doublée et lue par les composants d'avant (B-9)",
  },
  GUARD: { re: /\/mem0\/i|nomme mem0/g, why: "test de garde du mot existant : sa regex et le texte de son message" },
} satisfies Record<string, Motif>;

type NomMotif = keyof typeof MOTIFS;

/** Fichier (ou famille de fichiers) → motifs : seuls les fichiers que le renommage désigne pour ce motif. */
const MOTIFS_PAR_FICHIER: Record<string, NomMotif[]> = {
  ".claude-plugin/marketplace.json": ["CMD", "PLUGIN", "CATALOG", "REPO"],
  ".github/dependabot.yml": ["STACK_DIR"],
  ".gitignore": ["BRIEF_FILE", "OLD_NAME_RS", "STACK_DIR"],
  ".omp-plugin/marketplace.json": ["CMD", "PLUGIN", "CATALOG", "REPO"],
  "AGENTS.md": ["BRIEF"],
  "DEVELOPPEMENT.md": ["CATALOG", "REPO", "PY"],
  "PUBLISHING.md": ["PLUGIN", "CATALOG", "REPO"],
  "README.md": ["CATALOG", "REPO", "PY"],
  "docker-compose.yml": ["ENV_V", "REPO", "COMPOSE_SVC"],
  "mem0-stack/docker-compose.yml": ["ENV_V", "HEADER", "OLD_NAME_RS", "STACK_DIR"],
  "memory-stack/README.md": ["PY"],
  "memory-stack/docker-compose.yml": ["ENV_V", "PY", "STACK_DIR"],
  "memory-stack/doctor.sh": ["ENV_REWRITE", "PY", "STACK_DIR"],
  "memory-stack/memory-rs/README.md": [
    "ENV_V",
    "ENV_PREFIX",
    "HEADER",
    "OLD_DB",
    "OLD_HOME",
    "PY",
    "COMPOSE_SVC",
    "JOURNAL",
    "METRICS",
  ],
  "memory-stack/memory-rs/src/api/http.rs": ["HEADER", "HEALTH_KEY"],
  "memory-stack/memory-rs/src/config.rs": ["ENV_V", "OLD_DB", "OLD_HOME"],
  "memory-stack/memory-rs/src/exploitation/journal.rs": ["JOURNAL"],
  "memory-stack/memory-rs/src/exploitation/metriques.rs": ["HEADER", "METRICS", "HEALTH_KEY"],
  "memory-stack/memory-rs/src/exploitation/sauvegarde.rs": ["ENV_V", "OLD_DB"],
  "memory-stack/memory-rs/src/main.rs": ["PY"],
  "memory-stack/memory-rs/src/reprise/import.rs": ["PY"],
  "memory-stack/memory-rs/src/stockage/verrou.rs": ["OLD_DB"],
  "memory-stack/memory-rs/tests/common/mod.rs": ["ENV_V"],
  "memory-stack/memory-rs/tests/http.rs": ["ENV_V", "HEADER", "OLD_DB", "OLD_HOME", "METRICS", "HEALTH_KEY"],
  "omp-console/README.md": ["ENV_V", "HEADER", "JSON_FILE", "OLD_NAME_RS", "PY"],
  "omp-console/Sources/ConsoleClient/Memory/MemoryReader.swift": ["HEADER"],
  "omp-console/Sources/ConsoleClient/Pairing/HarnessPairing.swift": ["JSON_FILE"],
  "omp-console/Sources/OMPConsole/Memory/MemoryScope.swift": ["ENV_V"],
  "omp-console/Sources/OMPConsole/Memory/MemoryService.swift": ["ENV_V", "HEADER", "JSON_FILE"],
  "omp-console/Sources/OMPConsole/Setup/AppPaths.swift": ["OLD_DB", "OLD_NAME_RS", "PY"],
  "omp-console/Sources/OMPConsole/Setup/SetupText.swift": ["PY"],
  "omp-console/Sources/OMPConsole/Stack/InstallationToken.swift": ["PY"],
  "omp-console/Sources/OMPConsole/Stack/MemoryAgent.swift": ["ENV_V", "OLD_NAME_RS"],
  "omp-console/Sources/OMPConsole/Stack/PodmanCommand.swift": ["PY"],
  "omp-console/Sources/OMPConsole/Stack/PodmanLegacy.swift": ["PY"],
  "omp-console/Sources/OMPConsole/Stack/StackConfig.swift": ["ENV_V", "PY"],
  "omp-console/Tests/ConsoleClientTests/MemoryReaderTests.swift": ["HEADER"],
  "omp-console/Tests/OMPConsoleTests/ComponentInstallerRecipeTests.swift": ["ENV_V"],
  "omp-console/Tests/OMPConsoleTests/DiagnosticCopyTests.swift": ["PY"],
  "omp-console/Tests/OMPConsoleTests/MemoryAgentRecipeTests.swift": ["ENV_V"],
  "omp-console/Tests/OMPConsoleTests/MemoryClientTests.swift": ["HEADER"],
  "omp-console/Tests/OMPConsoleTests/MemoryRecipeTests.swift": ["ENV_V", "PY"],
  "omp-console/Tests/OMPConsoleTests/MemorySharedTests.swift": ["HEADER"],
  "omp-console/Tests/OMPConsoleTests/PodmanCommandTests.swift": ["PY"],
  "omp-console/Tests/OMPConsoleTests/PodmanLegacyTests.swift": ["PY"],
  "omp-console/Tests/OMPConsoleTests/RenommageMemoireTests.swift": [
    "ENV_V",
    "ENV_PREFIX",
    "JSON_FILE",
    "OLD_DB",
    "OLD_HOME",
    "OLD_NAME_RS",
    "HEALTH_KEY",
  ],
  "omp-console/Tests/OMPConsoleTests/SessionComponentRecipeTests.swift": ["ENV_V"],
  "omp-console/Tests/OMPConsoleTests/SetupModelTests.swift": ["PY"],
  "omp-console/Tests/OMPConsoleTests/StackConfigTests.swift": ["PY"],
  "omp-console/ios/OMPConsoleIOSTests/IOSMemoryGraphTests.swift": ["PY"],
  "omp-harness/README.md": ["JSON_FILE", "SYSUSER", "OLD_DB", "CATALOG", "REPO", "COMPOSE_SVC", "TOKEN_FILE"],
  "omp-harness/config/policy.ts": ["ENV_REWRITE"],
  "omp-harness/deploy/container/compose.yaml": ["COMPOSE_SVC"],
  "omp-harness/deploy/container/harness.sh": ["ENV_V", "JSON_FILE", "DATA_DIR"],
  "omp-harness/deploy/container/runner-entrypoint": ["ENV_V"],
  "omp-harness/deploy/container/stack-pairing": ["ENV_V"],
  "omp-harness/deploy/container/stack-setup": ["ENV_V", "DATA_DIR"],
  "omp-harness/deploy/install.sh": ["ENV_V", "SYSUSER", "DATA_DIR", "UNIT"],
  "omp-harness/deploy/launcher.conf": ["SYSUSER"],
  "omp-harness/deploy/memory.env.example": ["SYSUSER", "OLD_DB"],
  "omp-harness/deploy/monitoring/prometheus.yml": ["COMPOSE_SVC", "TOKEN_FILE"],
  "omp-harness/deploy/nixos/module.nix": ["SYSUSER", "OLD_DB", "DATA_DIR", "NIX"],
  "omp-harness/deploy/omp-harness-memory.service": ["SYSUSER", "DATA_DIR"],
  "omp-harness/deploy/omp-harness-systemd-run": ["ENV_V", "SYSUSER"],
  "omp-harness/deploy/sysusers.conf": ["SYSUSER"],
  "omp-harness/deploy/tmpfiles.conf": ["SYSUSER"],
  "omp-harness/main.ts": ["ENV_V"],
  "omp-harness/memory/oracle.ts": ["HEADER"],
  "omp-harness/operations/observability.ts": ["HEALTH_KEY"],
  "omp-harness/runners/runner.ts": ["ENV_V", "PLUGIN"],
  "omp-harness/sessions/local-sessions.ts": ["CATALOG", "REPO"],
  "omp-harness/vigie/main.ts": ["ENV_V"],
  "omp-harness/vigie/triage.ts": ["ENV_V"],
  "omp-memory-req/harness.ts": ["JSON_FILE"],
  "omp-memory-req/local-session.ts": ["ENV_V"],
  "omp-memory/brief.ts": ["BRIEF", "BRIEF_FILE"],
  "omp-memory/commands.ts": ["CMD"],
  "omp-memory/config.ts": ["ENV_V", "JSON_FILE"],
  "omp-memory/install.sh": ["CATALOG", "REPO"],
  "omp-memory/memoryClient.ts": ["HEADER"],
  "omp-memory/package.json": ["REPO"],
  "omp-memory/state.ts": ["ENV_V"],
  "omp-memory/tools.ts": ["TOOL"],
  "scripts/check.sh": ["ENV_V", "ENV_PREFIX"],
  "scripts/lint.sh": ["ENV_V"],
  "scripts/memory-http-contrat.sh": ["ENV_V"],
  "scripts/memory-http-contrat/cas.ts": ["PY", "COMPOSE_SVC"],
  "scripts/memory-http-contrat/contrat.ts": ["HEADER"],
  "scripts/memory-http-contrat/rang.json": ["PY"],
  "scripts/plugin-smoke.ts": ["ENV_V"],
  "scripts/recette/sans-podman-bascule-recette.sh": ["ENV_V", "PY"],
  "scripts/recette/smoke-pile.sh": ["ENV_V"],
  "scripts/release-simulation.sh": ["ENV_V"],
  "scripts/release.ts": ["PLUGIN"],
  "scripts/run-console.sh": ["ENV_V"],
  "scripts/typecheck.sh": ["ENV_V"],
  "test/console/console-core.test.ts": ["ENV_V"],
  "test/console/coque-ios.test.ts": ["ENV_V"],
  "test/console/omp-console-sans-podman.test.ts": ["PY"],
  "test/console/onglet-preuves.test.ts": ["ENV_V"],
  "test/console/reorganisation-ranger-l-app-swift-en-dos.test.ts": ["GUARD"],
  "test/console/typographie-et-glossaire-francais.test.ts": ["PY"],
  "test/harness/api/decoupage-serveur-http.test.ts": ["GUARD"],
  "test/harness/config/harness-politique.test.ts": ["ENV_V"],
  "test/harness/memory/harness-memory.test.ts": ["SYSUSER", "DATA_DIR"],
  "test/harness/intake/demande.test.ts": ["ENV_V"],
  "test/harness/reorganisation-de-la-base-de-code.test.ts": ["GUARD"],
  "test/harness/reorganisation-ranger-les-tests-du-serve.test.ts": ["GUARD"],
  "test/harness/runners/harness-runner.test.ts": ["ENV_V"],
  "test/harness/vigie/vigie.test.ts": ["ENV_V"],
  "test/outillage/anti-slop.test.ts": ["ENV_V"],
  "test/outillage/check.test.ts": ["ENV_V"],
  "test/outillage/ci-macos-jobs-paralleles.test.ts": ["ENV_V", "ENV_PY", "PY"],
  "test/outillage/ci-par-diff.test.ts": ["ENV_V"],
  "test/outillage/docs.test.ts": ["CATALOG", "REPO"],
  "test/outillage/no-ts-lint-formatter.test.ts": ["ENV_V"],
  "test/outillage/omp-host-epingle.test.ts": ["ENV_V"],
  "test/outillage/readme-installation-podman-contradiction.test.ts": ["CATALOG", "REPO", "PY"],
  "test/outillage/release-simulation.test.ts": ["ENV_V"],
  "test/outillage/release.test.ts": ["ENV_V", "CATALOG", "REPO"],
  "test/outillage/silent-prerequisite-skips.test.ts": ["ENV_V"],
  "test/outillage/smoke.test.ts": ["ENV_V"],
  "test/outillage/types-ratchet.test.ts": ["REPO"],
  "test/outillage/upgrade-procedure-gaps-in-publishing.test.ts": ["CATALOG"],
  "test/req/session-locale.test.ts": ["ENV_V"],
  "test/stack/memoire-liee.test.ts": ["ENV_V"],
  "test/stack/memory-http-contrat-boite-noire.test.ts": ["ENV_V"],
  "test/stack/memory-rs-extraction-llm.test.ts": ["ENV_V"],
  "test/stack/memory-rs-migration.test.ts": ["ENV_V", "PY"],
  "test/stack/memory-rs-noyau.test.ts": ["ENV_V"],
  "test/stack/memory-stack-bascule-rust.test.ts": ["ENV_V", "ENV_PY", "PY", "STACK_DIR"],
  "test/stack/recherche-hybride-rrf.test.ts": ["ENV_V"],
  "test/stack/reorganisation-ranger-le-crate-du-servic.test.ts": ["GUARD"],
  "test/support/doctor-banc.ts": ["PY"],
  "test/support/prerequis.ts": ["ENV_V"],
  "test/support/repo.ts": ["ENV_V"],
};

const EXCEPTIONS: Exceptions = {
  whole: [
    "CHANGELOG.md", // historique : jamais réécrit
    "THIRD_PARTY_NOTICES.md", // attribution de la bibliothèque d'origine (décision #13)
    CE_TEST, // la garde du mot et son relevé d'anciens noms
    "test/support/renommage-memoire/", // ses fixtures d'anciens noms
  ],
  sections: [{ path: "README.md", title: "## Passer aux noms memory (mise à niveau)" }],
  paths: ["mem0-stack/docker-compose.yml"], // le compose de repli de la pile manuelle (décision #14)
  patterns: Object.fromEntries(
    Object.entries(MOTIFS_PAR_FICHIER).map(([fichier, noms]) => [fichier, noms.map((nom) => MOTIFS[nom].re)]),
  ),
};

test("renommage-memoire/AC-301 : chaque occurrence de mem0, dans un contenu ou un chemin, est couverte par une exception nommée de la liste fermée ; les cas plantés sont signalés", () => {
  // Les exceptions sont nommées avec leur raison, et la table fichier → motifs ne désigne que des motifs connus.
  for (const [nom, motif] of Object.entries(MOTIFS)) assert.ok(motif.why.length > 20, `${nom} : raison attendue`);
  for (const [fichier, noms] of Object.entries(MOTIFS_PAR_FICHIER)) {
    for (const nom of noms) assert.ok(MOTIFS[nom], `${fichier} : motif ${nom} inconnu`);
  }

  // Cas plantés, sur des listes fabriquées : aucune écriture dans le dépôt.
  const depart = ['x="$', "{MEMORY_HTTP_TOKEN:-$", '{MEM0_HTTP_TOKEN:-}}"'].join("");
  const fabrique: Exceptions = {
    whole: [],
    sections: [],
    paths: [],
    patterns: { "repli.sh": [MOTIFS.ENV_V.re] },
  };
  assert.deepEqual(scanMentions([{ path: "repli.sh", text: `${depart}\n` }], fabrique), [], "le repli seul est permis");
  const identifiant = scanMentions([{ path: "repli.sh", text: `${depart} # ${"Mem0"}X\n` }], fabrique);
  assert.equal(identifiant.length, 1, `un identifiant Mem0X sur la ligne de repli est signalé : ${identifiant}`);
  assert.match(identifiant[0]!, /^repli\.sh:1 : /);
  const commentaire = scanMentions([{ path: "repli.sh", text: `ok\n${depart} # le ${"mem"}0 d'avant\n` }], fabrique);
  assert.equal(commentaire.length, 1, `un commentaire « mem0 » sur la ligne de repli est signalé : ${commentaire}`);
  assert.match(commentaire[0]!, /^repli\.sh:2 : /);
  assert.equal(
    scanMentions([{ path: "repli.sh", text: `${depart} ${depart.replace("MEMORY", "MEM0")} ${"Mem0"}\n` }], fabrique).length,
    1,
    "chaque occurrence d'une ligne doit tomber dans un motif, pas seulement la ligne",
  );
  const sansOccurrence = scanMentions([{ path: "repli.sh", text: "echo bonjour\n" }], fabrique);
  assert.match(sansOccurrence.join("\n"), /repli\.sh : le motif .* ne couvre plus rien/);
  const motifInutile = scanMentions([{ path: "repli.sh", text: `${depart}\n` }], {
    ...fabrique,
    patterns: { "repli.sh": [MOTIFS.ENV_V.re, MOTIFS.HEADER.re] },
  });
  assert.equal(motifInutile.length, 1, "un seul motif devenu inutile suffit à faire échouer");
  assert.match(
    scanMentions([], { ...fabrique, patterns: { "absent.sh": [MOTIFS.ENV_V.re] } }).join("\n"),
    /absent\.sh : exception de motif sans fichier/,
  );
  assert.match(
    scanMentions([{ path: `docs/${"mem"}0-notes.md`, text: "rien\n" }], { ...fabrique, patterns: {} }).join("\n"),
    /docs\/.*-notes\.md : le chemin nomme mem0/,
    "un chemin qui nomme mem0 est signalé",
  );
  const cheminPermis = scanMentions([{ path: "mem0-stack/docker-compose.yml", text: "rien\n" }], {
    ...fabrique,
    patterns: {},
    paths: ["mem0-stack/docker-compose.yml"],
  });
  assert.deepEqual(cheminPermis, [], "le chemin de l'unique exception de chemin est permis");
  const sections: Exceptions = {
    whole: [],
    sections: [{ path: "README.md", title: "## Passer" }],
    paths: [],
    patterns: {},
  };
  const readme = `# t\n## Avant\n${"mem"}0 ici\n## Passer\n${"mem"}0 là\n### sous-titre\n${"mem"}0 aussi\n## Après\n${"mem"}0 dehors\n`;
  const dehors = scanMentions([{ path: "README.md", text: readme }], sections);
  assert.deepEqual(
    dehors.map((p) => p.split(" : ")[0]),
    ["README.md:3", "README.md:9"],
    "la section est bornée par son titre et par le `## ` suivant",
  );
  assert.match(
    scanMentions([{ path: "README.md", text: "# t\n" }], sections).join("\n"),
    /section « ## Passer » introuvable/,
  );
  const dossierEntier = { ...sections, sections: [], whole: [`${"mem"}0-x/`] };
  assert.deepEqual(
    scanMentions([{ path: `${"mem"}0-x/a.md`, text: `${"mem"}0\n` }], dossierEntier),
    [],
    "un dossier entier",
  );

  // Les mêmes plantes sur un vrai fichier d'exception de la table : une ligne de repli du dépôt.
  for (const fichier of ["omp-harness/deploy/container/stack-pairing", "omp-memory/config.ts"]) {
    const vrai = EXCEPTIONS.patterns[fichier];
    assert.ok(vrai, `${fichier} est un fichier d'exception de la table`);
    const lignes = lire(fichier).split("\n");
    const i = lignes.findIndex((ligne) => [...ligne.matchAll(MOTIFS.ENV_V.re)].length > 0);
    assert.ok(i >= 0, `${fichier} : aucune ligne de repli`);
    const seul = { ...EXCEPTIONS, whole: [], sections: [], paths: [], patterns: { [fichier]: vrai } };
    assert.deepEqual(scanMentions([{ path: fichier, text: lignes.join("\n") }], seul), [], `${fichier} tient seul`);
    for (const ajout of [` ${"Mem0"}X`, ` // le ${"mem"}0 d'avant`]) {
      const plante = [...lignes];
      plante[i] += ajout;
      const trouve = scanMentions([{ path: fichier, text: plante.join("\n") }], seul);
      assert.equal(trouve.length, 1, `${fichier}:${i + 1} + « ${ajout.trim()} » : ${trouve}`);
      assert.ok(trouve[0]!.startsWith(`${fichier}:${i + 1} : `), trouve[0]);
    }
  }

  // Le dépôt réel : chaque fichier (contenu) et chaque chemin, sur l'arbre qui est sur le disque.
  const fichiers: Fichier[] = fichiersDuDepot().flatMap((relatif) => {
    const text = texteDe(relatif);
    return [{ path: relatif, text: text ?? "" }];
  });
  assert.ok(fichiers.length > 500, "le scan voit le dépôt entier");
  assert.ok(
    fichiers.some((f) => f.path === "mem0-stack/docker-compose.yml"),
    "le compose de repli est le seul fichier sous l'ancien dossier",
  );
  assert.deepEqual(
    fichiers.filter((f) => f.path.startsWith("mem0-stack/")).map((f) => f.path),
    ["mem0-stack/docker-compose.yml"],
  );
  const reste = scanMentions(fichiers, EXCEPTIONS);
  assert.deepEqual(reste, [], `occurrences de mem0 sans exception :\n  ${reste.join("\n  ")}`);
});

// ── AC-302 : les chemins et les noms publics ───────────────────────────────────────────────────────────
const OUTILS_ATTENDUS = ["memory_search", "memory_add", "memory_update", "memory_link", "memory_forget"];
const ALIAS_OUTILS = ["mem0_search", "mem0_add", "mem0_update", "mem0_link", "mem0_forget"];
const COMMANDES_ATTENDUES = [
  "memory-status",
  "memory-init",
  "memory-brief",
  "memory-dedupe",
  "memory-purge-procedures",
  "memory-save",
  "memory-dream",
];
const ALIAS_COMMANDES = COMMANDES_ATTENDUES.map((nom) => nom.replace("memory", "mem0"));
const COMMANDES_DE_PHASE = ["add-phase", "set-phase", "remove-phase"];

test("renommage-memoire/AC-302 : chaque dossier et fichier renommé existe sous son nouveau nom et plus sous l'ancien ; les noms publics sont ceux que le code déclare", async () => {
  const suivis = fichiersDuDepot();
  const existe = (relatif: string): boolean => suivis.some((f) => f === relatif || f.startsWith(`${relatif}/`));

  const nouveaux = [
    "omp-memory",
    "omp-memory/memoryClient.ts",
    "omp-memory/env.ts",
    "omp-memory-req",
    "omp-memory-req/env.ts",
    "omp-harness/config/env.ts",
    "omp-console/Sources/ConsoleCore/Support/RenamedEnvironment.swift",
    "memory-stack",
    "memory-stack/memory-rs",
    "memory-stack/memory-rs/Cargo.toml",
    "memory-stack/memory-rs/Cargo.lock",
    "memory-stack/memory-rs/src/main.rs",
    "memory-stack/.env.example",
    "memory-stack/README.md",
    "memory-stack/docker-compose.yml",
    "memory-stack/doctor.sh",
    "omp-harness/deploy/omp-harness-memory.service",
    "omp-harness/deploy/memory.env.example",
    ".omp/memory-brief.md",
    "scripts/memory-http-contrat.sh",
    "scripts/memory-http-contrat",
    "test/stack/memory-stack-bascule-rust.test.ts",
    "test/stack/memory-rs-migration.test.ts",
    "test/stack/memory-rs-noyau.test.ts",
    "test/stack/memory-rs-extraction-llm.test.ts",
    "test/stack/memory-http-contrat-boite-noire.test.ts",
    "test/stack/image-memory-rs-couche-dependances.test.ts",
    "THIRD_PARTY_NOTICES.md",
    CE_TEST,
    "test/support/renommage-memoire",
  ];
  for (const relatif of nouveaux) assert.ok(existe(relatif), `${relatif} (nouveau nom) est absent`);

  const anciens = [
    "omp-mem0-memory",
    "omp-mem0-req",
    "omp-memory/mem0Client.ts",
    "mem0-stack/mem0-rs",
    "mem0-stack/.env.example",
    "mem0-stack/README.md",
    "mem0-stack/doctor.sh",
    "omp-harness/deploy/omp-harness-mem0.service",
    "omp-harness/deploy/mem0.env.example",
    ".omp/mem0-brief.md",
    "scripts/mem0-http-contrat.sh",
    "scripts/mem0-http-contrat",
    "test/stack/image-mem0-rs-couche-dependances.test.ts",
  ];
  for (const relatif of anciens) assert.equal(existe(relatif), false, `${relatif} (ancien nom) existe encore`);
  assert.deepEqual(
    suivis.filter((f) => f.startsWith("mem0-stack/")),
    ["mem0-stack/docker-compose.yml"],
    "le compose de repli est le seul fichier sous l'ancien dossier de la pile manuelle",
  );
  assert.deepEqual(
    suivis.filter((f) => f.startsWith("test/") && MOT.test(f)),
    [],
    "aucun chemin de test ne nomme mem0",
  );

  // Le crate et le binaire s'appellent memory-rs, Cargo.lock compris (sans quoi `cargo build --locked` échoue).
  const crate = "memory-stack/memory-rs";
  assert.match(lire(`${crate}/Cargo.toml`), /^name = "memory-rs"$/m);
  assert.match(lire(`${crate}/Cargo.lock`), /^name = "memory-rs"$/m);
  assert.doesNotMatch(lire(`${crate}/Cargo.lock`), /mem0/i);
  assert.match(lire(`${crate}/Dockerfile`), /\/usr\/local\/bin\/memory-rs/);

  // Les plugins : `name` des package.json.
  assert.equal(JSON.parse(lire("omp-memory/package.json")).name, "omp-memory");
  assert.equal(JSON.parse(lire("omp-memory-req/package.json")).name, "omp-memory-req");

  // Les outils et les commandes enregistrés par `memoryPluginExtension` sur un `pi` doublé, puis le libellé.
  const session = chargerPlugin();
  assert.deepEqual([...session.outils.keys()].sort(), [...OUTILS_ATTENDUS, ...ALIAS_OUTILS].sort());
  assert.deepEqual(
    [...session.commandes.keys()].sort(),
    [...COMMANDES_ATTENDUES, ...COMMANDES_DE_PHASE, ...ALIAS_COMMANDES].sort(),
    "les 17 commandes : sept nouvelles, trois de phase, sept alias",
  );
  assert.deepEqual(session.libelles, ["memory"]);
  for (const nom of OUTILS_ATTENDUS) assert.equal(
    session.outils.get(nom)?.label,
    `memory · ${nom.slice("memory_".length)}`,
  );

  // Les marqueurs du brief et son fichier de référence.
  assert.equal(brief.MARKER_OPEN, "<!-- memory:brief v7 -->");
  assert.equal(brief.MARKER_CLOSE, "<!-- /memory:brief -->");
  assert.equal(brief.BRIEF_REF_PATH, path.join(".omp", "memory-brief.md"));

  // L'en-tête envoyé, et le fichier de réglages lu : `~/.omp/memory.json`.
  SERVICE_PLUGIN.requetes.length = 0;
  await memoryFetch("/health");
  const envoye = SERVICE_PLUGIN.requetes.at(-1)!.entetes;
  assert.equal(envoye["x-memory-token"], "jeton-plugin", "le nouvel en-tête porte le jeton");
  const home = tmpdir("renommage-memoire-reglages-");
  fs.mkdirSync(path.join(home, ".omp"));
  fs.writeFileSync(
    path.join(home, ".omp", "memory.json"),
    JSON.stringify({ url: "http://memoire.exemple:8321/", token: "t-fichier" }),
  );
  assert.deepEqual(resolveMemoryTarget({}, home), { url: "http://memoire.exemple:8321", token: "t-fichier" });

  // La base par défaut `~/.memory/memory-rs.db`, lue dans le source du service.
  const config = lire(`${crate}/src/config.rs`);
  assert.match(config, /const BASE_PAR_DEFAUT: &str = "memory-rs\.db";/);
  assert.match(config, /\.join\("\.memory"\)\.join\(BASE_PAR_DEFAUT\)/);

  // L'unité systemd, le label launchd de l'app et les options NixOS.
  assert.match(lire("omp-harness/deploy/omp-harness-memory.service"), /^ExecStart=\/usr\/local\/bin\/memory-rs /m);
  assert.match(
    lire("omp-console/Sources/OMPConsole/Stack/MemoryAgent.swift"),
    /defaultLabel = "com\.omp\.console\.memory-rs"/,
  );
  const module = lire("omp-harness/deploy/nixos/module.nix");
  assert.match(module, /^\s{4}memory = \{$/m, "services.omp-harness.memory.*");
  assert.match(module, /memoryHttpsPort = lib\.mkOption/);
  assert.match(module, /systemd\.services\.omp-harness-memory = /);
});

// ── AC-303 : l'ancien nom est lu quand le nouveau manque, le nouveau l'emporte ─────────────────────────
type Lecteur = (env: Record<string, string | undefined>, name: string, legacy: string) => string | undefined;

/** Les sept cas de S-6 sur un couple (nouveau, ancien) : la valeur lue, ou `undefined`. */
function cas(lire: Lecteur, nouveau: string, ancien: string): Array<[string, string | undefined]> {
  return [
    ["ancien seul", lire({ [ancien]: "A" }, nouveau, ancien)],
    ["nouveau seul", lire({ [nouveau]: "B" }, nouveau, ancien)],
    ["les deux, distincts", lire({ [nouveau]: "B", [ancien]: "A" }, nouveau, ancien)],
    ["nouveau vide, ancien posé", lire({ [nouveau]: "", [ancien]: "A" }, nouveau, ancien)],
    ["les deux vides", lire({ [nouveau]: "", [ancien]: "" }, nouveau, ancien)],
    ["ancien seul, vide", lire({ [ancien]: "" }, nouveau, ancien)],
    ["aucun", lire({}, nouveau, ancien)],
  ];
}

const ATTENDU_LECTURE: Array<string | undefined> = ["A", "B", "B", "A", undefined, undefined, undefined];

/** Les lectures `MEMORY_X` d'un contenu, avec le nom lu et la ligne : les formes de S-7 qui lisent un réglage. */
const LECTURE_CODE =
  /(?:process\.env\.|\benv\.|\benv\[["']|\benvironment\[["']|\bvalues\[["']|env::var\(["']|\blire\(["'])([A-Z0-9_]*MEMORY_[A-Z0-9_]+)(?:["']\])?/g;
const LECTURE_AIDE =
  /(?:renamedEnv\w*|lire_renomme|env_renomme_ou|entier_env|RenamedEnvironment\.value)\([^"']*["']([A-Z0-9_]*MEMORY_[A-Z0-9_]+)/g;
const LECTURE_SHELL = /\$\{([A-Z0-9_]*MEMORY_[A-Z0-9_]+)|\bsetting_renamed ([A-Z0-9_]*MEMORY_[A-Z0-9_]+)/g;
const AIDES = /renamedEnv|lire_renomme|RenamedEnvironment\.value|setting_renamed|env_renomme_ou|entier_env/;

const NOUVEAUX_V = new Map(NOMS_V.map((ancien) => [nouveauNom(ancien), ancien]));
/** Les noms `MEMORY_*` que le dépôt peut lire : la table renommée, et ce qui existait déjà ou naît du renommage. */
const NOMS_MEMORY_CONNUS = new Set<string>([
  ...[...NOMS_V, ...NOMS_F, ...NOMS_E, ...NOMS_K, ...NOMS_N].map(nouveauNom),
  "OMP_HARNESS_MEMORY_TOKENS",
  "MEMORY_TOKENS_DIR",
  "OMP_HARNESS_MEMORY_DATA",
]);

/**
 * Les lectures du compose du conteneur : les variables sont celles que `write_compose_env` de harness.sh écrit dans
 * `compose.env` ; le choix de l'ancien nom s'y fait (S-22), pas dans le compose.
 */
const LECTURES_SANS_REPLI: Record<string, string[]> = {
  "omp-harness/deploy/container/compose.yaml": ["OMP_HARNESS_MEMORY_ENV", "OMP_HARNESS_MEMORY_PORT"],
};

/**
 * Les anomalies de lecture d'un jeu de fichiers : un `MEM0_*` hors de la table S-4, un `MEMORY_X` de classe V lu sans
 * l'aide de son langage ni son repli d'ancien nom sur la même ligne ou la suivante, un `MEMORY_*` lu hors de la table.
 */
function scanLectures(files: Fichier[]): string[] {
  const problemes: string[] = [];
  for (const file of files) {
    if (file.path === "CHANGELOG.md") continue;
    const lignes = file.text.split("\n");
    lignes.forEach((ligne, i) => {
      for (const m of ligne.matchAll(/\b[A-Z0-9_]*MEM0_[A-Z0-9_]*/g)) {
        if (!TABLE_S4.has(m[0])) problemes.push(`${file.path}:${i + 1} : ${m[0]} n'est pas dans la table des noms`);
      }
    });
    if (file.path === CE_TEST || file.path.startsWith("test/support/renommage-memoire/")) continue;
    const code = /\.(ts|tsx|rs|swift)$/.test(file.path);
    const test = /^test\/|\/Tests\//.test(file.path);
    lignes.forEach((ligne, i) => {
      const lus: string[] = [];
      for (const m of ligne.matchAll(LECTURE_CODE)) {
        const index = m.index ?? 0;
        if (/delete\s+[\w.]*$/.test(ligne.slice(0, index))) continue;
        if (/^\s*(?:=[^=]|\?\?=)/.test(ligne.slice(index + m[0].length))) continue;
        if (test && !m[0].startsWith("process.env.")) continue; // un test lit les sorties du code : seule `process.env` est un réglage
        lus.push(m[1]!);
      }
      for (const m of ligne.matchAll(LECTURE_AIDE)) lus.push(m[1]!);
      if (!code) for (const m of ligne.matchAll(LECTURE_SHELL)) lus.push((m[1] ?? m[2])!);
      for (const nom of lus) {
        const ancien = NOUVEAUX_V.get(nom);
        if (ancien === undefined) {
          if (!NOMS_MEMORY_CONNUS.has(nom)) problemes.push(
            `${file.path}:${i + 1} : ${nom} lu hors de la table des noms`,
          );
          continue;
        }
        const replie = AIDES.test(ligne) || ligne.includes(ancien) || (lignes[i + 1] ?? "").includes(ancien);
        if (!replie && !LECTURES_SANS_REPLI[file.path]?.includes(nom)) {
          problemes.push(`${file.path}:${i + 1} : ${nom} lu sans l'aide ni le repli ${ancien}`);
        }
      }
    });
  }
  return problemes;
}

/** Un dossier de pile jetable pour `stack-setup init` : racine, secrets, doublure de ssh-keygen (comme harness-portainer). */
function pileJetable(): { dir: string; root: string; secrets: string; env: Record<string, string> } {
  const dir = tmpdir("renommage-memoire-pile-");
  const root = path.join(dir, "root");
  const secrets = path.join(dir, "secrets");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "ssh-keygen"),
    `#!/bin/sh
while [ $# -gt 1 ]; do [ "$1" = -f ] && file="$2"; shift; done
echo "PRIVATE" > "$file"
echo "ssh-ed25519 AAAA$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n') omp-harness" > "$file.pub"
`,
    { mode: 0o755 },
  );
  const env = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    OMP_HARNESS_ROOT: root,
    OMP_HARNESS_SECRETS: secrets,
    OMP_HARNESS_TEMPLATE: path.join(ROOT, "omp-harness", "deploy", "container", "config.container.json"),
  };
  return { dir, root, secrets, env };
}

const STACK_SETUP = path.join(ROOT, "omp-harness", "deploy", "container", "stack-setup");

function init(env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("sh", [STACK_SETUP, "init"], { encoding: "utf8", env, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const lireFichier = (...segments: string[]): string => fs.readFileSync(path.join(...segments), "utf8");

test("renommage-memoire/AC-303 : l'ancien nom est lu quand le nouveau manque, le nouveau l'emporte quand les deux sont posés — aide de chaque langage, stack-setup, garde statique, jeton par dépôt", () => {
  // (a) renamedEnv : trois copies identiques, mêmes sept cas sur un couple de la table.
  const ancienCouple = "MEM0_QUIET";
  const nouveauCouple = nouveauNom(ancienCouple);
  for (const [copie, lire] of [
    ["omp-memory", renamedEnvMemory],
    ["omp-memory-req", renamedEnvReq],
    ["omp-harness", renamedEnvHarness],
  ] as const) {
    assert.deepEqual(
      cas(lire, nouveauCouple, ancienCouple).map(([, valeur]) => valeur),
      ATTENDU_LECTURE,
      `renamedEnv de ${copie}`,
    );
  }
  const sources = ["omp-memory/env.ts", "omp-memory-req/env.ts", "omp-harness/config/env.ts"].map(lire);
  assert.equal(sources[1], sources[0], "omp-memory-req/env.ts est la copie de omp-memory/env.ts");
  assert.equal(sources[2], sources[0], "omp-harness/config/env.ts est la copie de omp-memory/env.ts");
  // Les lecteurs principaux des plugins passent par l'aide : l'ancien nom seul suffit pour l'adresse et le jeton.
  const home = tmpdir("renommage-memoire-env-");
  assert.deepEqual(resolveMemoryTarget({ MEM0_HTTP_URL: "http://a:1", MEM0_HTTP_TOKEN: "ta" }, home), {
    url: "http://a:1",
    token: "ta",
  });
  assert.deepEqual(
    resolveMemoryTarget(
      { MEM0_HTTP_URL: "http://a:1", MEM0_HTTP_TOKEN: "ta", MEMORY_HTTP_URL: "http://b:2", MEMORY_HTTP_TOKEN: "tb" },
      home,
    ),
    { url: "http://b:2", token: "tb" },
    "le nouveau l'emporte",
  );

  // (b) shell : `stack-setup init`, la clé du fichier de secrets lue avec repli.
  for (const [nom, contenu, jeton] of [
    ["ancien seul", lire("test/support/renommage-memoire/secrets-ancien.env"), "jeton-ancien-T"],
    ["nouveau seul", lire("test/support/renommage-memoire/secrets-nouveau.env"), "jeton-nouveau-B"],
    [
      "les deux, valeurs distinctes",
      `${lire("test/support/renommage-memoire/secrets-ancien.env")}${lire("test/support/renommage-memoire/secrets-nouveau.env")}`,
      "jeton-nouveau-B",
    ],
  ] as const) {
    const pile = pileJetable();
    fs.mkdirSync(path.join(pile.secrets, "memory"), { recursive: true });
    fs.writeFileSync(path.join(pile.secrets, "memory", "memory.env"), contenu);
    const r = init(pile.env);
    assert.equal(r.status, 0, `${nom} : ${r.stderr}`);
    assert.match(
      lireFichier(pile.secrets, "harness", "harness.env"),
      new RegExp(`^MEMORY_HTTP_TOKEN=${jeton}$`, "m"),
      nom,
    );
    assert.match(lireFichier(pile.secrets, "runner.env"), new RegExp(`^MEMORY_HTTP_TOKEN=${jeton}$`, "m"), nom);
    assert.match(
      lireFichier(pile.secrets, "memory", "memory.env"),
      new RegExp(`^MEMORY_HTTP_TOKEN=${jeton}$`, "m"),
      nom,
    );
  }
  // Un nouveau vide et un ancien posé : l'ancien (S-6, cas limite).
  const vide = pileJetable();
  fs.mkdirSync(path.join(vide.secrets, "memory"), { recursive: true });
  fs.writeFileSync(
    path.join(vide.secrets, "memory", "memory.env"),
    "MEMORY_HTTP_TOKEN=\nMEM0_HTTP_TOKEN=jeton-ancien-T\n",
  );
  assert.equal(init(vide.env).status, 0);
  assert.match(lireFichier(vide.secrets, "runner.env"), /^MEMORY_HTTP_TOKEN=jeton-ancien-T$/m);

  // (c) garde statique : la table S-4 et les lectures du dépôt.
  assert.equal(TABLE_S4.size, 108, "la table S-4 porte 108 noms distincts");
  assert.equal(NOMS_V.length, 84);
  assert.deepEqual(
    [NOMS_V.length, NOMS_F.length, NOMS_E.length, NOMS_K.length, NOMS_N.length, NOMS_P.length],
    [84, 3, 2, 1, 14, 4],
  );
  const dedans = fichiersDuDepot().map((relatif) => ({ path: relatif, text: texteDe(relatif) ?? "" }));
  const lectures = scanLectures(dedans);
  assert.deepEqual(lectures, [], `lectures sans repli ou hors table :\n  ${lectures.join("\n  ")}`);
  // Cas plantés : une lecture sans repli, un nom hors de la table, un nom `MEM0_*` hors de la table.
  const plantees = (path0: string, text: string): string[] => scanLectures([{ path: path0, text }]);
  assert.equal(plantees("src/a.ts", "const t = process.env.MEMORY_HTTP_TOKEN;\n").length, 1, "lecture TS sans repli");
  assert.deepEqual(
    plantees("src/a.ts", 'const t = renamedEnv(process.env, "MEMORY_HTTP_TOKEN", "MEM0_HTTP_TOKEN");\n'),
    [],
    "l'aide suffit",
  );
  assert.deepEqual(
    plantees("src/a.ts", "const t = process.env.MEMORY_HTTP_TOKEN ??\n  process.env.MEM0_HTTP_TOKEN;\n"),
    [],
    "le repli sur la ligne suivante suffit",
  );
  assert.equal(plantees("src/a.ts", 'env["MEMORY_DB_PATH"]\n').length, 1, "env[…] sans repli");
  assert.equal(plantees("src/a.rs", 'let x = std::env::var("MEMORY_DB_PATH");\n').length, 1, "env::var sans repli");
  assert.equal(plantees("src/a.rs", 'let x = lire("MEMORY_DB_PATH");\n').length, 1, "lire(…) sans repli");
  assert.equal(
    plantees("src/A.swift", 'let x = environment["OMP_CONSOLE_MEMORY_PORT"]\n').length,
    1,
    "Swift sans repli",
  );
  assert.equal(plantees("src/A.swift", 'let x = values["MEMORY_HTTP_TOKEN"]\n').length, 1, "values[…] sans repli");
  assert.equal(plantees("src/x.sh", 'echo "${MEMORY_DB_PATH:-/d}"\n').length, 1, "${…} sans repli");
  assert.deepEqual(plantees("src/x.sh", 'echo "${MEMORY_DB_PATH:-${MEM0_DB_PATH:-/d}}"\n'), [], "${…} avec repli");
  assert.deepEqual(plantees("src/x.sh", 'x="$(setting_renamed MEMORY_URL MEM0_URL f)"\n'), [], "setting_renamed");
  assert.deepEqual(
    plantees("src/a.ts", "process.env.MEMORY_HTTP_TOKEN = 'x';\ndelete process.env.MEMORY_MODE;\n"),
    [],
    "écrire n'est pas lire",
  );
  const horsTable = `MEMORY_${"PLANTE"}`;
  assert.equal(plantees("src/a.ts", `const t = process.env.${horsTable};\n`).length, 1, "nom MEMORY_ hors de la table");
  assert.equal(plantees("src/x.sh", `echo "\${${horsTable}:-x}"\n`).length, 1, "nom MEMORY_ hors de la table (shell)");
  assert.equal(plantees("src/a.ts", `// ${"MEM0"}_${"PLANTE"}\n`).length, 1, "nom MEM0_ hors de la table");
  assert.deepEqual(
    plantees(
      "src/a.ts",
      "// MEMORY_TOKENS_DIR et OMP_HARNESS_MEMORY_TOKENS existent déjà\nprocess.env.MEMORY_TOKENS_DIR;\n",
    ),
    [],
  );

  // (d) `repoMemoryToken` : `tokenEnv` d'un nom d'avant ou d'un nom à jour, avec l'un, l'autre, ou les deux posés.
  const jetonA = "jeton-memoire-ancien-0123456789";
  const jetonB = "jeton-memoire-nouveau-0123456789";
  for (const declare of ["MEM0_TOKEN_PERSO", "MEMORY_TOKEN_PERSO"]) {
    const repo = { name: "client", memory: { tokenEnv: declare } } as unknown as Parameters<typeof repoMemoryToken>[0];
    assert.equal(repoMemoryToken(repo, { ["MEM0_TOKEN_PERSO"]: jetonA }), jetonA, `${declare} : l'ancien seul`);
    assert.equal(repoMemoryToken(repo, { MEMORY_TOKEN_PERSO: jetonB }), jetonB, `${declare} : le nouveau seul`);
    assert.equal(
      repoMemoryToken(repo, { ["MEM0_TOKEN_PERSO"]: jetonA, MEMORY_TOKEN_PERSO: jetonB }),
      jetonB,
      `${declare} : les deux, distincts → MEMORY_TOKEN_PERSO`,
    );
    assert.throws(() => repoMemoryToken(repo, {}), PolicyRefusal, `${declare} : aucun des deux`);
    const config = { repos: [repo] } as unknown as Parameters<typeof policySecretVars>[0];
    assert.deepEqual(
      [...policySecretVars(config)].sort(),
      ["MEM0_TOKEN_PERSO", "MEMORY_TOKEN_PERSO"],
      `${declare} : aucun runner ne voit ni l'un ni l'autre`,
    );
  }
});

// ── Le binaire memory-rs : convention de memoire-liee (MEMORY_RS_BIN, saut annoncé, échec sous MEMORY_OMP_REQUIRE_RUST=1) ──
const BINAIRE =
  renamedEnvHarness(process.env, "MEMORY_RS_BIN", "MEM0_RS_BIN") ??
  path.join(ROOT, "memory-stack", "memory-rs", "target", "debug", "memory-rs");
const EXIGE_RUST = renamedEnvHarness(process.env, "MEMORY_OMP_REQUIRE_RUST", "MEM0_OMP_REQUIRE_RUST") === "1";

/** Le binaire est-il là ? Sinon le sous-test est sauté (annoncé), ou échoue sous MEMORY_OMP_REQUIRE_RUST=1. */
function binairePret(t: { skip(message: string): void }): boolean {
  if (fs.existsSync(BINAIRE)) return true;
  prerequisAbsent(
    t,
    `binaire memory-rs (${BINAIRE})`,
    "service mémoire non lancé",
    EXIGE_RUST ? "MEMORY_OMP_REQUIRE_RUST=1" : null,
  );
  return false;
}

type ServiceRs = {
  url: string;
  journal: () => string;
  arreter: () => Promise<number | null>;
};

/** Lance memory-rs sur un port libre, environnement vide : seules les variables passées existent (HOME compris). */
async function lancerService(env: Record<string, string>, faux: FauxOpenAI): Promise<ServiceRs> {
  for (let essai = 0; essai < 5; essai += 1) {
    const sonde = http.createServer();
    const ouverte = Promise.withResolvers<void>();
    sonde.listen(0, "127.0.0.1", () => ouverte.resolve());
    await ouverte.promise;
    const port = (sonde.address() as AddressInfo).port;
    const fermee = Promise.withResolvers<void>();
    sonde.close(() => fermee.resolve());
    await fermee.promise;
    const enfant: ChildProcess = spawn(BINAIRE, ["--host", "127.0.0.1", "--port", String(port)], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        OMLX_BASE_URL: faux.url,
        OMLX_API_TOKEN: "faux-openai",
        OMLX_LLM_MODEL: "faux-chat",
        OMLX_EMBED_MODEL: "faux-embed",
        OMLX_CHAT_BASE_URL: "off",
        EMBEDDING_DIMS: "1024",
        OMP_INSTALLATION_TOKEN: "",
        ...env,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let journal = "";
    enfant.stderr?.setEncoding("utf8").on("data", (morceau: string) => {
      journal += morceau;
    });
    const termine = Promise.withResolvers<number | null>();
    enfant.once("close", (code) => termine.resolve(code));
    const fin = termine.promise;
    const url = `http://127.0.0.1:${port}`;
    const debut = Date.now();
    let pret = false;
    while (!pret && Date.now() - debut < 20_000 && enfant.exitCode === null) {
      try {
        pret = (await fetch(`${url}/health`)).ok;
      } catch {
        await attendre(100);
      }
    }
    if (pret) {
      return {
        url,
        journal: () => journal,
        arreter: async () => {
          enfant.kill("SIGTERM");
          return fin;
        },
      };
    }
    enfant.kill("SIGKILL");
    await fin;
    if (!journal.includes("écoute impossible")) assert.fail(`memory-rs n'a pas démarré : ${journal}`);
  }
  assert.fail("memory-rs : aucun port libre après 5 essais");
}

// ── AC-304 : l'en-tête d'authentification ──────────────────────────────────────────────────────────────
test("renommage-memoire/AC-304 : le service juge X-Memory-Token, sinon X-Mem0-Token ; les clients à jour envoient les deux en-têtes", async (t) => {
  // Les clients à jour : memoryClient.ts (plugin) et oracle.ts (serveur de pipelines) portent les deux, même valeur.
  SERVICE_PLUGIN.requetes.length = 0;
  await memoryFetch("/health");
  const plugin = SERVICE_PLUGIN.requetes.at(-1)!.entetes;
  assert.equal(plugin["x-memory-token"], "jeton-plugin");
  assert.equal(plugin["x-mem0-token"], "jeton-plugin");

  const recus: Array<Record<string, string>> = [];
  const oracle = new HttpOracle(
    { url: "http://oracle.test:8321/", token: "jeton-oracle" },
    {
      fetch: async (_url, init) => {
        recus.push(init.headers);
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      },
    },
  );
  await oracle.dreamDossier("projet");
  assert.equal(recus.length, 1);
  assert.equal(recus[0]!["X-Memory-Token"], "jeton-oracle");
  assert.equal(recus[0]!["X-Mem0-Token"], "jeton-oracle");
  const sansJeton: Array<Record<string, string>> = [];
  await new HttpOracle(
    { url: "http://oracle.test:8321", token: null },
    {
      fetch: async (_url, init) => {
        sansJeton.push(init.headers);
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" };
      },
    },
  ).dreamDossier("projet");
  assert.equal(
    Object.keys(sansJeton[0]!).some((nom) => /token/i.test(nom)),
    false,
    "sans jeton, aucun des deux en-têtes",
  );

  await t.test("memory-rs avec un jeton : l'un, l'autre, les deux (bon nouveau + mauvais ancien → 200, mauvais nouveau + bon ancien → 401)", async (st) => {
    if (!binairePret(st)) return;
    const faux = await demarrerFauxOpenAI();
    const home = tmpdir("renommage-memoire-http-");
    const service = await lancerService({ HOME: home, MEMORY_HTTP_TOKEN: "bon" }, faux);
    try {
      const statut = async (entetes: Record<string, string>): Promise<{ statut: number; corps: string }> => {
        const reponse = await fetch(`${service.url}/memory/all`, { headers: entetes });
        return { statut: reponse.status, corps: await reponse.text() };
      };
      assert.equal((await statut({ "X-Mem0-Token": "bon" })).statut, 200, "ancien en-tête seul");
      assert.equal((await statut({ "X-Memory-Token": "bon" })).statut, 200, "nouvel en-tête seul");
      assert.equal(
        (await statut({ "X-Memory-Token": "bon", "X-Mem0-Token": "faux" })).statut,
        200,
        "les deux : seul le nouveau est jugé",
      );
      const refus = await statut({ "X-Memory-Token": "faux", "X-Mem0-Token": "bon" });
      assert.equal(refus.statut, 401, "les deux, nouveau faux : refusé");
      assert.match(refus.corps, /X-Memory-Token/);
      assert.equal((await statut({})).statut, 401, "sans en-tête");
    } finally {
      await service.arreter();
      await faux.fermer();
    }
  });
});

// ── AC-305 : les réglages et les données d'une installation existante sont retrouvés sans être déplacés ──
const FICHIER_PARTAGE = (home: string, nom: string): string => path.join(home, ".omp", nom);

/** `harness.sh connect` d'avant le renommage : copie en .prev puis écrit `mem0.json` (et jamais `memory.json`). */
function ancienConnect(home: string, memoire: { url: string; token: string }): void {
  const fichier = FICHIER_PARTAGE(home, "mem0.json");
  fs.mkdirSync(path.dirname(fichier), { recursive: true });
  if (fs.existsSync(fichier) && !fs.existsSync(`${fichier}.prev`)) fs.copyFileSync(fichier, `${fichier}.prev`);
  fs.writeFileSync(fichier, `${JSON.stringify(memoire, null, 2)}\n`);
}

/** `harness.sh disconnect` d'avant : rétablit le `.prev`, sinon retire le fichier. */
function ancienDisconnect(home: string): void {
  const fichier = FICHIER_PARTAGE(home, "mem0.json");
  if (fs.existsSync(`${fichier}.prev`)) fs.renameSync(`${fichier}.prev`, fichier);
  else fs.rmSync(fichier, { force: true });
}

/** Une doublure du moteur de conteneurs : `run … node -e <script>` exécute le script avec le dossier ~/.omp de l'hôte. */
function moteurDouble(dir: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, "docker"),
    `#!/bin/sh
# Doublure du moteur : le script node du conteneur tourne ici, sur le dossier monté en /omp.
[ "$1" = run ] || exit 0
omp=""
while [ $# -gt 0 ]; do
  case "$1" in
    -v) omp="\${2%%:*}"; shift 2 ;;
    -e) export "$2"; shift 2 ;;
    node) shift; break ;;
    *) shift ;;
  esac
done
script="$(printf '%s' "$2" | sed "s#/omp/#$omp/#g")"
exec ${JSON.stringify(process.execPath)} -e "$script"
`,
    { mode: 0o755 },
  );
  return bin;
}

const HARNESS_SH = path.join(ROOT, "omp-harness", "deploy", "container", "harness.sh");

function harnessSh(commande: string, env: Record<string, string>): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("bash", [HARNESS_SH, commande], { encoding: "utf8", env, timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const json = (...segments: string[]): { url?: string; token?: string } =>
  JSON.parse(fs.readFileSync(path.join(...segments), "utf8"));

test("renommage-memoire/AC-305 : les anciens réglages et la base d'avant sont lus sans être déplacés, le nouveau l'emporte ; chaque écrivain écrit là où le fichier existe", async (t) => {
  // Le plugin : `mem0.json` seul, puis les deux, puis un `memory.json` illisible.
  const home = tmpdir("renommage-memoire-reglages-");
  const ecrire = (nom: string, contenu: string): void => {
    fs.mkdirSync(path.join(home, ".omp"), { recursive: true });
    fs.writeFileSync(FICHIER_PARTAGE(home, nom), contenu);
  };
  ecrire("mem0.json", JSON.stringify({ url: "http://ancien:8321/", token: "t-ancien" }));
  assert.deepEqual(resolveMemoryTarget({}, home), { url: "http://ancien:8321", token: "t-ancien" }, "mem0.json seul");
  ecrire("memory.json", JSON.stringify({ url: "http://nouveau:8321", token: "t-nouveau" }));
  assert.deepEqual(resolveMemoryTarget({}, home), { url: "http://nouveau:8321", token: "t-nouveau" }, "les deux");
  ecrire("memory.json", "{ pas du json");
  assert.deepEqual(
    resolveMemoryTarget({}, home),
    { url: "http://localhost:8321", token: "" },
    "memory.json illisible : service local, aucun repli vers mem0.json",
  );
  assert.ok(fs.existsSync(FICHIER_PARTAGE(home, "mem0.json")), "rien n'est déplacé");

  // L'appairage à jour : sans memory.json il écrit mem0.json et ne crée pas memory.json ; avec, il écrit memory.json.
  const pairing = { url: "http://h:8790", token: "th", memoryUrl: "http://m-a:8321", memoryToken: "ma" };
  const ancienne = tmpdir("renommage-memoire-appairage-");
  const ecrits = writePairing(pairing, ancienne);
  assert.deepEqual(
    ecrits.map((f) => path.basename(f)),
    ["harness.json", "mem0.json"],
  );
  assert.equal(fs.existsSync(FICHIER_PARTAGE(ancienne, "memory.json")), false, "memory.json n'est jamais créé");
  const neuve = tmpdir("renommage-memoire-appairage-");
  fs.mkdirSync(path.join(neuve, ".omp"));
  fs.writeFileSync(FICHIER_PARTAGE(neuve, "memory.json"), "{}\n");
  fs.writeFileSync(FICHIER_PARTAGE(neuve, "mem0.json"), '{"url":"http://intact:1","token":"i"}\n');
  assert.deepEqual(
    writePairing(pairing, neuve).map((f) => path.basename(f)),
    ["harness.json", "memory.json"],
  );
  assert.deepEqual(json(neuve, ".omp", "memory.json"), { url: "http://m-a:8321", token: "ma" });
  assert.deepEqual(
    json(neuve, ".omp", "mem0.json"),
    { url: "http://intact:1", token: "i" },
    "mem0.json n'est pas touché",
  );

  // La séquence : un écrivain à jour (A), un écrivain d'avant (B), un `disconnect` d'avant. Le lecteur à jour suit.
  const sequence = tmpdir("renommage-memoire-sequence-");
  writePairing(pairing, sequence);
  assert.deepEqual(resolveMemoryTarget({}, sequence), { url: "http://m-a:8321", token: "ma" }, "après A");
  ancienConnect(sequence, { url: "http://m-b:8321", token: "mb" });
  assert.deepEqual(resolveMemoryTarget({}, sequence), { url: "http://m-b:8321", token: "mb" }, "après B");
  ancienDisconnect(sequence);
  assert.deepEqual(
    resolveMemoryTarget({}, sequence),
    { url: "http://m-a:8321", token: "ma" },
    "après le disconnect d'avant",
  );

  // `harness.sh connect` / `disconnect`, avec une doublure du moteur qui exécute le script node du conteneur.
  const pile = (avant: Record<string, string>) => {
    const dir = tmpdir("renommage-memoire-connect-");
    const root = path.join(dir, "root");
    const secrets = path.join(dir, "secrets");
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.mkdirSync(secrets, { recursive: true });
    fs.writeFileSync(path.join(root, "state", "token"), "jeton-harness\n");
    fs.writeFileSync(path.join(root, "compose.env"), "OMP_HARNESS_PORT=8790\nOMP_HARNESS_MEMORY_PORT=8321\n");
    fs.writeFileSync(path.join(secrets, "mem0.env"), "MEM0_HTTP_TOKEN=jeton-pile\n");
    for (const [nom, contenu] of Object.entries(avant)) {
      fs.mkdirSync(path.join(dir, ".omp"), { recursive: true });
      fs.writeFileSync(path.join(dir, ".omp", nom), contenu);
    }
    const env = {
      PATH: `${moteurDouble(dir)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: dir,
      OMP_HARNESS_ENGINE: "docker",
      OMP_HARNESS_ROOT: root,
      OMP_HARNESS_SECRETS: secrets,
    };
    return { dir, env };
  };
  const avantAncien = '{"url":"http://avant-ancien:1","token":"o"}\n';
  const avantNouveau = '{"url":"http://avant-nouveau:1","token":"n"}\n';
  // Sans memory.json : connect écrit mem0.json (et son .prev), ne crée pas memory.json ; disconnect rétablit.
  const sans = pile({ "mem0.json": avantAncien });
  const connecte = harnessSh("connect", sans.env);
  assert.equal(connecte.status, 0, connecte.stderr);
  assert.deepEqual(json(sans.dir, ".omp", "mem0.json"), { url: "http://127.0.0.1:8321", token: "jeton-pile" });
  assert.equal(fs.readFileSync(path.join(sans.dir, ".omp", "mem0.json.prev"), "utf8"), avantAncien);
  assert.equal(fs.existsSync(path.join(sans.dir, ".omp", "memory.json")), false, "connect ne crée pas memory.json");
  assert.deepEqual(json(sans.dir, ".omp", "harness.json"), { url: "http://127.0.0.1:8790", token: "jeton-harness" });
  assert.deepEqual(resolveMemoryTarget({}, sans.dir), { url: "http://127.0.0.1:8321", token: "jeton-pile" });
  assert.equal(harnessSh("disconnect", sans.env).status, 0);
  assert.equal(
    fs.readFileSync(path.join(sans.dir, ".omp", "mem0.json"), "utf8"),
    avantAncien,
    "disconnect rétablit le .prev",
  );
  assert.equal(fs.existsSync(path.join(sans.dir, ".omp", "mem0.json.prev")), false);
  assert.equal(
    fs.existsSync(path.join(sans.dir, ".omp", "harness.json")),
    false,
    "pas de .prev : le fichier est retiré",
  );
  // Avec memory.json : connect l'écrit (son .prev), mem0.json n'est pas touché.
  const avec = pile({ "mem0.json": avantAncien, "memory.json": avantNouveau });
  assert.equal(harnessSh("connect", avec.env).status, 0);
  assert.deepEqual(json(avec.dir, ".omp", "memory.json"), { url: "http://127.0.0.1:8321", token: "jeton-pile" });
  assert.equal(fs.readFileSync(path.join(avec.dir, ".omp", "memory.json.prev"), "utf8"), avantNouveau);
  assert.equal(
    fs.readFileSync(path.join(avec.dir, ".omp", "mem0.json"), "utf8"),
    avantAncien,
    "mem0.json n'est pas touché",
  );
  assert.equal(harnessSh("disconnect", avec.env).status, 0);
  assert.equal(fs.readFileSync(path.join(avec.dir, ".omp", "memory.json"), "utf8"), avantNouveau);
  assert.equal(fs.readFileSync(path.join(avec.dir, ".omp", "mem0.json"), "utf8"), avantAncien);

  await t.test("memory-rs : la base d'avant `~/.mem0/mem0-rs.db` est lue sur place, sans variable, et rien n'est créé sous `~/.memory/`", async (st) => {
    if (!binairePret(st)) return;
    const faux = await demarrerFauxOpenAI();
    const maison = tmpdir("renommage-memoire-base-");
    const ancienne = path.join(maison, ".mem0", "mem0-rs.db");
    fs.mkdirSync(path.dirname(ancienne), { recursive: true });
    const requete = async (service: ServiceRs, route: string, corps?: unknown): Promise<{ results?: Array<{ memory?: string }> }> => {
      const reponse = await fetch(`${service.url}${route}`, {
        method: corps === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(corps === undefined ? {} : { body: JSON.stringify(corps) }),
      });
      assert.equal(reponse.status, 200, `${route} : ${await reponse.clone().text()}`);
      return (await reponse.json()) as { results?: Array<{ memory?: string }> };
    };
    try {
      // Un premier démarrage sous l'ancienne variable crée l'ancienne base, et y range un souvenir.
      const avant = await lancerService({ HOME: maison, [`${"MEM0"}_DB_PATH`]: ancienne }, faux);
      await requete(avant, "/memory/add", { text: "souvenir d'avant le renommage", agent_id: "projet", infer: false });
      assert.equal(await avant.arreter(), 0);
      assert.ok(fs.existsSync(ancienne));
      // Un second, sans variable : le même souvenir, aucune base sous ~/.memory/.
      const apres = await lancerService({ HOME: maison }, faux);
      try {
        const tous = await requete(apres, "/memory/all?agent_id=projet");
        assert.deepEqual(
          (tous.results ?? []).map((ligne) => ligne.memory),
          ["souvenir d'avant le renommage"],
        );
        assert.ok(apres.journal().includes(ancienne), "le service dit quelle base il lit");
      } finally {
        await apres.arreter();
      }
      assert.equal(
        fs.existsSync(path.join(maison, ".memory")),
        false,
        "la nouvelle base n'est pas créée tant que l'ancienne existe",
      );
      assert.ok(fs.existsSync(ancienne), "l'ancienne base n'est pas déplacée");
    } finally {
      await faux.fermer();
    }
  });
});

// ── AC-306 : le brief ──────────────────────────────────────────────────────────────────────────────────
const BLOC_V6 = lire("test/support/renommage-memoire/bloc-publie-v6.md");
const BLOC_V5 = lire("test/support/renommage-memoire/bloc-publie-v5.md");
const AGENTS_DEPART = lire("test/support/renommage-memoire/agents-depart.md");
const sha256 = (texte: string): string => crypto.createHash("sha256").update(texte, "utf8").digest("hex");
const PAIRE_INERTE = "<!-- mem0:brief v6 --><!-- /mem0:brief -->";
const ANCIEN_BRIEF = "Ancien fichier de référence du brief : jamais lu, jamais écrit, jamais supprimé.\n";

/** Un dépôt jetable avec son AGENTS.md et un ancien `.omp/mem0-brief.md` que rien ne doit toucher. */
function projetBrief(agents: string | null): { dir: string; agents: string; ancienRef: string } {
  const dir = tmpdir("renommage-memoire-brief-");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.mkdirSync(path.join(dir, ".omp"));
  fs.writeFileSync(path.join(dir, ".omp", "mem0-brief.md"), ANCIEN_BRIEF);
  if (agents !== null) fs.writeFileSync(path.join(dir, "AGENTS.md"), agents);
  return { dir, agents: path.join(dir, "AGENTS.md"), ancienRef: path.join(dir, ".omp", "mem0-brief.md") };
}

const compte = (texte: string, motif: RegExp): number => [...texte.matchAll(motif)].length;

/** `status` après un passage : un seul bloc `memory:brief`, et pour tout `mem0:brief` la seule paire inerte. */
function verifierUnSeulBloc(contenu: string, attendu: string): void {
  assert.equal(contenu, attendu, "AGENTS.md : le bloc est remplacé à sa place, le texte autour est intact");
  assert.equal(compte(contenu, /<!--\s*memory:brief\s+v\d+\s*-->/g), 1, "un seul bloc memory:brief");
  assert.equal(compte(contenu, /<!--\s*\/memory:brief\s*-->/g), 1);
  assert.equal(
    compte(contenu, /<!--\s*mem0:brief/g),
    1,
    "un seul marqueur mem0:brief : la paire inerte du nouveau bloc",
  );
  assert.equal(contenu.includes(PAIRE_INERTE), true);
  assert.equal(contenu.includes(BLOC_V6), false, "plus aucun bloc mem0:brief complet");
}

test("renommage-memoire/AC-306 : un ancien bloc publié est remplacé à sa place, un bloc édité signalé puis remplacé sur commande, l'autosetup coupé n'écrit rien, un ancien plugin ne double pas le nouveau bloc", async () => {
  // Les empreintes de S-16 : les fixtures sont le texte exact des blocs publiés.
  assert.equal(sha256(BLOC_V6), "f6e1439f01186b0a20e00046527b7389e05fd523ea07ff998f0ea99466aa2cef");
  assert.equal(sha256(BLOC_V5), "02df648bf05d1a62e86f56c3a20b7e3e00069ac742aaee6d1816f08556ae42a8");
  const publies = new Map(brief.PUBLISHED_LEGACY_BLOCKS.map((b) => [b.sha256, b.marker]));
  assert.equal(publies.get(sha256(BLOC_V6)), "v6");
  assert.equal(publies.get(sha256(BLOC_V5)), "v5");
  assert.equal(brief.PUBLISHED_LEGACY_BLOCKS.length, 6, "les six blocs publiés sont reconnus par leur empreinte");
  assert.ok(BLOC_V6.startsWith("<!-- mem0:brief v6 -->") && BLOC_V6.endsWith("<!-- /mem0:brief -->"));
  assert.ok(BLOC_V5.startsWith("<!-- mem0:brief v5 -->") && BLOC_V5.endsWith("<!-- /mem0:brief -->"));

  // Un bloc publié (v6, puis v5) entre deux textes de l'utilisateur : remplacé par l'autosetup.
  for (const [nom, bloc] of [
    ["v6", BLOC_V6],
    ["v5", BLOC_V5],
  ] as const) {
    const projet = projetBrief(AGENTS_DEPART.replace("@BLOC@", bloc));
    const status = brief.ensureBrief(projet.dir);
    assert.equal(status.agents, "created", nom);
    verifierUnSeulBloc(lireChemin(projet.agents), AGENTS_DEPART.replace("@BLOC@", brief.AGENTS_BLOCK));
    assert.ok(fs.existsSync(path.join(projet.dir, ".omp", "memory-brief.md")), `${nom} : .omp/memory-brief.md existe`);
    assert.equal(fs.readFileSync(projet.ancienRef, "utf8"), ANCIEN_BRIEF, `${nom} : .omp/mem0-brief.md est inchangé`);
  }

  // Un bloc v6 modifié d'un seul caractère : signalé périmé, rien d'écrit, puis remplacé par `/memory-brief --update`.
  const edite = BLOC_V6.replace("Mémoire du projet", "Mémoire du projeT");
  assert.notEqual(edite, BLOC_V6);
  assert.equal(edite.length, BLOC_V6.length);
  const projetEdite = projetBrief(AGENTS_DEPART.replace("@BLOC@", edite));
  const avantEdite = lireChemin(projetEdite.agents);
  const statusEdite = brief.ensureBrief(projetEdite.dir);
  assert.equal(statusEdite.agents, "outdated");
  assert.equal(lireChemin(projetEdite.agents), avantEdite, "bloc édité : AGENTS.md inchangé octet pour octet");
  assert.equal(compte(lireChemin(projetEdite.agents), /memory:brief/g), 0, "aucun second bloc n'est ajouté");
  const notifications: string[] = [];
  const commandes = chargerPlugin().commandes;
  await commandes.get("memory-brief")!.handler("--update", {
    cwd: projetEdite.dir,
    ui: { notify: (message: string) => notifications.push(message) },
    sessionManager: { getSessionId: () => "s-brief" },
  } as never);
  verifierUnSeulBloc(lireChemin(projetEdite.agents), AGENTS_DEPART.replace("@BLOC@", brief.AGENTS_BLOCK));
  assert.ok(notifications.some((n) => n.includes("[memory] brief mémoire posé")), notifications.join("\n"));
  assert.equal(fs.readFileSync(projetEdite.ancienRef, "utf8"), ANCIEN_BRIEF);

  // L'autosetup coupé (comme les runners), sous le nouveau nom puis sous l'ancien : rien n'est lu ni écrit.
  const scriptEnfant = path.join(tmpdir("renommage-memoire-enfant-"), "brief.ts");
  fs.writeFileSync(
    scriptEnfant,
    `import { ensureBrief } from ${JSON.stringify(path.join(ROOT, "omp-memory", "brief.ts"))};\n` +
      "console.log(JSON.stringify(ensureBrief(process.argv[2])));\n",
  );
  for (const variable of ["MEMORY_AUTOSETUP", "MEM0_AUTOSETUP"]) {
    const projet = projetBrief(AGENTS_DEPART.replace("@BLOC@", BLOC_V6));
    const avant = lireChemin(projet.agents);
    const enfant = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", scriptEnfant, projet.dir],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir("renommage-memoire-enfant-home-"), [variable]: "0" },
        timeout: 60_000,
      },
    );
    assert.equal(enfant.status, 0, enfant.stderr);
    assert.equal(JSON.parse(enfant.stdout).agents, "skipped", variable);
    assert.equal(lireChemin(projet.agents), avant, `${variable}=0 : AGENTS.md inchangé`);
    assert.equal(
      fs.existsSync(path.join(projet.dir, ".omp", "memory-brief.md")),
      false,
      `${variable}=0 : aucun fichier posé`,
    );
  }

  // Un AGENTS.md qui n'a que le nouveau bloc, passé à la logique d'avant (v6, puis v5) : inchangé octet pour octet.
  const sansBloc = projetBrief("# Projet\n\nTexte de l'utilisateur.\n");
  assert.equal(brief.ensureBrief(sansBloc.dir).agents, "created");
  assert.equal(lireChemin(sansBloc.agents), `# Projet\n\nTexte de l'utilisateur.\n\n\n${brief.AGENTS_BLOCK}\n`);
  assert.equal(compte(lireChemin(sansBloc.agents), /<!--\s*memory:brief\s+v\d+\s*-->/g), 1, "un seul bloc neuf");
  const nouveauBloc = lireChemin(sansBloc.agents);
  const pose = fs.statSync(sansBloc.agents);
  assert.equal(brief.ensureBrief(sansBloc.dir).agents, "present", "second passage : le bloc est présent");
  const encore = fs.statSync(sansBloc.agents);
  assert.equal(lireChemin(sansBloc.agents), nouveauBloc, "second passage : contenu inchangé");
  assert.deepEqual([encore.ino, encore.mtimeMs], [pose.ino, pose.mtimeMs], "second passage : aucune écriture");
  for (const version of ["v6", "v5"] as const) {
    const ancien = ancienEnsureBrief(sansBloc.dir, { version });
    assert.notEqual(ancien.agents, "failed", version);
    assert.equal(
      lireChemin(sansBloc.agents),
      nouveauBloc,
      `l'ancien plugin (${version}) ne double pas le nouveau bloc`,
    );
    assert.equal(Buffer.compare(fs.readFileSync(sansBloc.agents), Buffer.from(nouveauBloc, "utf8")), 0);
  }
  assert.equal(
    ancienEnsureBrief(sansBloc.dir, { version: "v6" }).agents,
    "present",
    "la paire inerte lui dit « à jour »",
  );
});

/** Un fichier lu par son chemin complet (`lire` lit sous ROOT). */
function lireChemin(chemin: string): string {
  return fs.readFileSync(chemin, "utf8");
}

// ── AC-307 : les anciens noms d'outils et de commandes ont le même effet que les nouveaux ───────────────
/** Une session : un dépôt jetable et un `ctx` qui note ce que la commande affiche. */
function sessionMemoire(id: string): { ctx: Record<string, unknown>; notifications: string[] } {
  const repo = tmpdir("renommage-memoire-session-");
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "projet-renommage" }));
  const notifications: string[] = [];
  const ctx = {
    cwd: repo,
    hasUI: false,
    ui: { notify: (message: string) => notifications.push(message), input: async () => "", confirm: async () => false },
    sessionManager: { getSessionId: () => id },
    waitForIdle: async () => {},
  };
  return { ctx, notifications };
}

async function executer(outil: Outil | undefined, params: unknown, ctx: unknown): Promise<unknown> {
  assert.ok(outil, "outil absent");
  return (outil.execute as unknown as (...args: unknown[]) => Promise<unknown>)(
    "appel",
    params,
    undefined,
    undefined,
    ctx,
  );
}

/** `n` lectures par grep : le message de checkpoint posé en tête du résultat qui franchit le seuil, sinon rien. */
async function explorer(session: Enregistrement, ctx: unknown, n: number): Promise<number> {
  let checkpoints = 0;
  for (let i = 0; i < n; i += 1) {
    const rendu = (await session.hooks.get("tool_result")!(
      { toolName: "grep", input: { pattern: "renommage" }, content: [{ type: "text", text: "x" }], isError: false } as never,
      ctx as never,
    )) as { content?: Array<{ text?: string }> } | undefined;
    if (rendu?.content?.some((partie) => partie.text?.startsWith("[memory checkpoint]"))) checkpoints += 1;
  }
  return checkpoints;
}

test("renommage-memoire/AC-307 : mem0_add et memory_add, /mem0-status et /memory-status ont le même effet et la même réponse ; l'un et l'autre remettent à zéro le compteur du checkpoint ; le brief et les prompts ne citent que memory_*", async () => {
  const session = chargerPlugin();
  const { ctx } = sessionMemoire("s-outils");

  // Même effet sur le service doublé : même requête, même réponse rendue à l'agent.
  SERVICE_PLUGIN.requetes.length = 0;
  const ajout = { text: "Le dépôt cible bash 3.2", dedupe: false, scope: "project" };
  const viaAncien = await executer(session.outils.get("mem0_add"), ajout, ctx);
  const viaNouveau = await executer(session.outils.get("memory_add"), ajout, ctx);
  const ecritures = SERVICE_PLUGIN.requetes.filter((r) => r.route.startsWith("/memory/add"));
  assert.equal(ecritures.length, 2, "une écriture par appel");
  assert.equal(ecritures[0]!.corps, ecritures[1]!.corps, "même corps de requête");
  assert.equal(ecritures[0]!.route, ecritures[1]!.route);
  assert.deepEqual(viaAncien, viaNouveau, "même réponse");
  const recherche = { query: "bash", scope: "project", limit: 6 };
  const chercheNouveau = await executer(session.outils.get("memory_search"), recherche, ctx);
  const chercheAncien = await executer(session.outils.get("mem0_search"), recherche, ctx);
  assert.deepEqual(chercheAncien, chercheNouveau, "mem0_search et memory_search rendent la même chose");
  assert.match(JSON.stringify(chercheNouveau), /Le dépôt cible bash 3\.2/);
  // L'alias garde la définition du nouvel outil et l'annonce dans sa description.
  for (const [alias, courant] of ALIAS_OUTILS.map((nom, i) => [nom, OUTILS_ATTENDUS[i]!] as const)) {
    const ancien = session.outils.get(alias)!;
    const nouveau = session.outils.get(courant)!;
    assert.equal(ancien.label, nouveau.label, `${alias} garde le libellé de ${courant}`);
    assert.ok(
      ancien.description?.startsWith(`Ancien nom de \`${courant}\`, gardé pendant la transition : `),
      `${alias} : description de l'alias`,
    );
    assert.ok(ancien.description?.endsWith(nouveau.description ?? "\0"), `${alias} : la description du nouveau suit`);
  }

  // Les commandes : même réponse.
  const ancienne = sessionMemoire("s-commandes");
  await session.commandes.get("mem0-status")!.handler("", ancienne.ctx as never);
  const courante = sessionMemoire("s-commandes");
  await session.commandes.get("memory-status")!.handler("", courante.ctx as never);
  const sortie = (notifications: string[]): string[] => notifications.map(
    (n) => n.replace(/\/[^ ·)]*renommage-memoire-session-\w+/g, "<repo>"),
  );
  assert.ok(ancienne.notifications.length >= 2, ancienne.notifications.join("\n"));
  assert.deepEqual(sortie(ancienne.notifications), sortie(courante.notifications), "même sortie");
  assert.match(courante.notifications.join("\n"), /^\[memory\] ok=true/m);
  for (const [alias, courant] of ALIAS_COMMANDES.map((nom, i) => [nom, COMMANDES_ATTENDUES[i]!] as const)) {
    assert.equal(
      session.commandes.get(alias)!.handler,
      session.commandes.get(courant)!.handler,
      `${alias} : même gestionnaire`,
    );
    assert.equal(session.commandes.get(alias)!.description, `Ancien nom de /${courant}, gardé pendant la transition.`);
  }

  // Le compteur du checkpoint : sans écriture, 20 explorations tirent un checkpoint ; une écriture par l'un ou
  // l'autre nom le remet à zéro.
  const temoin = sessionMemoire("s-temoin");
  assert.ok((await explorer(session, temoin.ctx, 20)) >= 1, "sans écriture, le checkpoint tire");
  for (const [session_, nom] of [
    ["s-ancien-nom", "mem0_add"],
    ["s-nouveau-nom", "memory_add"],
  ] as const) {
    const s = sessionMemoire(session_);
    assert.equal(await explorer(session, s.ctx, 10), 0, `${nom} : 10 explorations, pas de checkpoint`);
    await executer(session.outils.get(nom), { text: `fait de ${session_}`, dedupe: false }, s.ctx);
    assert.equal(
      await explorer(session, s.ctx, 10),
      0,
      `${nom} remet le compteur à zéro : 10 de plus, pas de checkpoint`,
    );
  }

  // Le brief et les prompts du serveur ne citent que `memory_*` : ni `mem0_` ni `/mem0-` hors de la paire inerte.
  const textes = Object.entries(brief)
    .filter(([nom, valeur]) => typeof valeur === "string" && !nom.startsWith("LEGACY_"))
    .map(([nom, valeur]) => [nom, (valeur as string).replace(brief.LEGACY_INERT_PAIR, "")] as const);
  assert.ok(textes.some(([nom]) => nom === "AGENTS_BLOCK") && textes.some(([nom]) => nom === "BRIEF_REFERENCE"));
  for (const [nom, texte] of textes) assert.doesNotMatch(texte, /mem0_|\/mem0-|mem0/i, `${nom} cite l'ancien nom`);
  assert.match(brief.AGENTS_BLOCK, /memory_search/);
  assert.match(brief.AGENTS_BLOCK, /memory checkpoint/);
  for (const fichier of ["omp-harness/runs/prompts.ts", "omp-harness/workstation/workstation-agent.ts"]) {
    const prompts = lire(fichier);
    assert.doesNotMatch(prompts, /mem0_|\/mem0-/, `${fichier} cite un ancien nom`);
  }
  assert.match(lire("omp-harness/runs/prompts.ts"), /memory_add/);
});

// ── AC-308 : les catalogues et le double chargement ─────────────────────────────────────────────────────
type Entree = { name: string; source: string; version: string; commands?: string[] };
type Catalogue = { name: string; plugins: Entree[] };

const COUPLES_DE_PLUGINS = [
  ["omp-mem0-memory", "omp-memory"],
  ["omp-mem0-req", "omp-memory-req"],
] as const;

/** Les écarts d'un catalogue : nom, entrées, versions, sources, plugin livré, commandes. */
function verifierCatalogue(
  fichier: string,
  catalogue: Catalogue,
  sourceExiste: (source: string) => boolean,
  nomDuPlugin: (source: string) => string | null,
  commandesDe: (source: string) => string[] | null,
): string[] {
  const ecarts: string[] = [];
  if (catalogue.name !== "mem0-omp") ecarts.push(
    `${fichier} : le catalogue s'appelle « ${catalogue.name} », pas « mem0-omp »`,
  );
  const entree = (nom: string): Entree | undefined => catalogue.plugins.find((p) => p.name === nom);
  for (const [ancien, nouveau] of COUPLES_DE_PLUGINS) {
    const a = entree(ancien);
    const n = entree(nouveau);
    if (!n) ecarts.push(`${fichier} : l'entrée ${nouveau} est absente`);
    if (!a) ecarts.push(`${fichier} : l'entrée ${ancien} est absente`);
    if (!a || !n) continue;
    if (a.version !== n.version) ecarts.push(`${fichier} : ${ancien} ${a.version} ≠ ${nouveau} ${n.version}`);
    for (const e of [a, n]) {
      if (!sourceExiste(e.source)) ecarts.push(`${fichier} : la source ${e.source} de ${e.name} n'existe pas`);
      else if (nomDuPlugin(e.source) !== nouveau) {
        ecarts.push(`${fichier} : la source de ${e.name} livre ${nomDuPlugin(e.source)}, pas ${nouveau}`);
      }
    }
    if (a.source !== n.source) ecarts.push(
      `${fichier} : ${ancien} (${a.source}) ne livre pas la source de ${nouveau} (${n.source})`,
    );
    if (JSON.stringify(a.commands ?? null) !== JSON.stringify(n.commands ?? null)) {
      ecarts.push(`${fichier} : ${ancien} et ${nouveau} n'ont pas les mêmes commandes`);
    }
    const litterales = commandesDe(n.source);
    if (n.commands && litterales && JSON.stringify([...n.commands].sort()) !== JSON.stringify([...litterales].sort())) {
      ecarts.push(`${fichier} : les commandes de ${nouveau} ne sont pas les registerCommand de ${n.source}`);
    }
  }
  return ecarts;
}

test("renommage-memoire/AC-308 : les catalogues gardent le nom mem0-omp et portent les quatre entrées ; la doc installe les nouvelles ; deux copies du plugin n'enregistrent qu'une fois chaque outil et chaque commande", async () => {
  const sourceExiste = (source: string): boolean => fs.existsSync(path.join(ROOT, source, "package.json"));
  const nomDuPlugin = (source: string): string | null => JSON.parse(lire(`${source.replace(/^\.\//, "")}/package.json`)).name ?? null;
  const commandesDe = (source: string): string[] | null => {
    const dossier = path.join(ROOT, source);
    if (!fs.existsSync(dossier)) return null;
    return fs
      .readdirSync(dossier)
      .filter((f) => f.endsWith(".ts"))
      .flatMap(
        (f) => [...fs.readFileSync(path.join(dossier, f), "utf8").matchAll(/registerCommand\("([^"]+)"/g)].map(
          (m) => m[1]!,
        ),
      );
  };
  const catalogues: Record<string, Catalogue> = {
    ".omp-plugin/marketplace.json": JSON.parse(lire(".omp-plugin/marketplace.json")),
    ".claude-plugin/marketplace.json": JSON.parse(lire(".claude-plugin/marketplace.json")),
  };
  assert.equal(
    lire(".omp-plugin/marketplace.json"),
    lire(".claude-plugin/marketplace.json"),
    "les deux catalogues sont identiques",
  );
  for (const [fichier, catalogue] of Object.entries(catalogues)) {
    assert.deepEqual(
      verifierCatalogue(fichier, catalogue, sourceExiste, nomDuPlugin, commandesDe),
      [],
      `${fichier} : écarts`,
    );
    assert.deepEqual(
      catalogue.plugins.map((p) => p.name),
      ["omp-memory", "omp-memory-req", "omp-mem0-memory", "omp-mem0-req"],
      "les quatre entrées, dans cet ordre",
    );
  }
  assert.equal(commandesDe("./omp-memory")!.length, 17, "les 17 commandes sont écrites en littéraux");

  // Cas plantés : catalogue renommé, ancienne entrée absente, versions différentes — chacun est nommé.
  const vrai = catalogues[".omp-plugin/marketplace.json"]!;
  const plante = (patch: (c: Catalogue) => void): string => {
    const copie = JSON.parse(JSON.stringify(vrai)) as Catalogue;
    patch(copie);
    return verifierCatalogue("c.json", copie, sourceExiste, nomDuPlugin, commandesDe).join("\n");
  };
  assert.match(plante((c) => (c.name = "memory-omp")), /s'appelle « memory-omp »/);
  assert.match(
    plante((c) => (c.plugins = c.plugins.filter((p) => p.name !== "omp-mem0-req"))),
    /omp-mem0-req est absente/,
  );
  assert.match(plante((c) => (c.plugins[2]!.version = "0.0.1")), /omp-mem0-memory 0\.0\.1 ≠ omp-memory 4\./);
  assert.match(plante((c) => (c.plugins[3]!.source = "./absent")), /source \.\/absent de omp-mem0-req n'existe pas/);

  // La documentation installe les nouvelles entrées, pas les anciennes.
  for (const doc of ["README.md", "PUBLISHING.md"]) {
    const texte = lire(doc);
    for (const nouveau of ["omp-memory", "omp-memory-req"]) {
      assert.ok(texte.includes(`install ${nouveau}@mem0-omp`), `${doc} : « install ${nouveau}@mem0-omp » absent`);
    }
  }
  const installation = sectionDe(lire("README.md"), "## Installation");
  assert.doesNotMatch(installation, /install omp-mem0-/, "une installation neuve n'installe pas les anciennes entrées");

  // Le double chargement : deux copies (deux adresses de module, comme deux dossiers d'installation) dans un même
  // process, la seconde ne fait rien ; la même copie rappelée (rechargement) se réactive.
  const copieDe = async (fichier: string): Promise<(pi: never) => void> => {
    const url = new URL(fichier, import.meta.url);
    url.search = "?copie=2";
    return (await import(url.href)).default;
  };
  oublierMarques();
  const premiere = piDouble();
  const seconde = piDouble();
  const rechargee = piDouble();
  memoryPluginExtension(premiere.pi);
  (await copieDe("../../omp-memory/extension.ts"))(seconde.pi as never);
  memoryPluginExtension(rechargee.pi);
  const unique = (noms: string[]): void => assert.equal(
    new Set(noms).size,
    noms.length,
    `enregistrements en double : ${noms}`,
  );
  unique(premiere.enregistre.appelsOutil);
  unique(premiere.enregistre.appelsCommande);
  assert.equal(premiere.enregistre.appelsOutil.length, 10, "cinq outils et cinq alias");
  assert.equal(premiere.enregistre.appelsCommande.length, 17);
  assert.deepEqual(
    [seconde.enregistre.appelsOutil, seconde.enregistre.appelsCommande, [...seconde.enregistre.hooks.keys()], seconde.enregistre.libelles],
    [[], [], [], []],
    "la seconde copie ne fait rien : ni outil, ni commande, ni hook, ni libellé",
  );
  assert.ok(premiere.enregistre.hooks.size > 0 && premiere.enregistre.libelles.length === 1);
  // Même garde pour le plugin client du harness : deux copies, une seule activation.
  oublierMarques();
  const requete = { outils: [] as string[], commandes: [] as string[] };
  const piReq = (): Parameters<typeof reqExtension>[0] =>
    ({
      zod: { z: fakeSchema() },
      registerCommand: (nom: string) => requete.commandes.push(nom),
      registerTool: (outil: { name: string }) => requete.outils.push(outil.name),
      sendUserMessage: () => undefined,
      sendMessage: () => undefined,
      on: () => undefined,
      setLabel: () => undefined,
      registerMessageRenderer: () => undefined,
    }) as never;
  reqExtension(piReq());
  const apresPremiere = [requete.outils.length, requete.commandes.length];
  assert.ok(apresPremiere[0]! > 0 && apresPremiere[1]! > 0);
  (await copieDe("../../omp-memory-req/extension.ts"))(piReq() as never);
  assert.deepEqual(
    [requete.outils.length, requete.commandes.length],
    apresPremiere,
    "la seconde copie du plugin req ne fait rien",
  );
  unique(requete.outils);
  unique(requete.commandes);
  oublierMarques();
});

// ── AC-309 : ce que le service émet ─────────────────────────────────────────────────────────────────────
test("renommage-memoire/AC-309 : /health porte memory et mem0, /metrics chaque famille sous les deux préfixes, le journal src memory ; l'observabilité lit l'une ou l'autre clé", async (t) => {
  const version = (corps: Record<string, unknown>): string | null => memoryStatusOf(true, corps, 0).version;
  assert.equal(version({ ok: true, mem0: "memory-rs 1.4.2" }), "1.4.2", "un service qui n'émet que l'ancienne clé");
  assert.equal(version({ ok: true, memory: "memory-rs 1.4.2" }), "1.4.2", "un service qui n'émet que la nouvelle");
  assert.equal(version({ ok: true, mem0: "mem0-rs 1.4.2" }), "1.4.2", "l'ancienne bannière `mem0-rs <version>`");
  assert.equal(memoryStatusOf(true, { ok: true, mem0: "memory-rs 1.4.2" }, 0).ok, true);
  assert.equal(version({ ok: true, memory: "memory-rs 2.0.0", mem0: "memory-rs 2.0.0" }), "2.0.0", "les deux clés");
  assert.equal(memoryStatusOf(true, null, 0).ok, false);
  // Le journal du serveur et sa source : `memory`.
  assert.match(lire("omp-harness/operations/logger.ts"), /type LogSource = "harness" \| "memory" \| "vigie"/);

  await t.test("memory-rs démarré : le corps de /health, les familles de /metrics et le journal du jour", async (st) => {
    if (!binairePret(st)) return;
    const faux = await demarrerFauxOpenAI();
    const donnees = tmpdir("renommage-memoire-emission-");
    const service = await lancerService(
      { HOME: donnees, MEMORY_DB_PATH: path.join(donnees, "memory-rs.db"), MEMORY_HTTP_TOKEN: "bon" },
      faux,
    );
    try {
      const sante = (await (await fetch(`${service.url}/health`)).json()) as Record<string, unknown>;
      assert.match(String(sante.memory), /^memory-rs \d/, "clé memory");
      assert.equal(sante.mem0, sante.memory, "clé mem0 : même valeur");
      assert.equal(sante.ok, true);
      const metriques = await (await fetch(`${service.url}/metrics`, { headers: { "X-Memory-Token": "bon" } })).text();
      const familles = (prefixe: string): string[] =>
        [...metriques.matchAll(new RegExp(`^# TYPE ${prefixe}_(\\w+) `, "gm"))].map((m) => m[1]!).sort();
      const courantes = familles("memory");
      assert.ok(courantes.length >= 6, `familles memory_* : ${courantes}`);
      assert.deepEqual(familles("mem0"), courantes, "chaque famille existe sous memory_* et mem0_*");
      for (const nom of ["info", "uptime_seconds", "memories", "db_bytes", "http_requests_total"]) {
        assert.ok(courantes.includes(nom), `famille ${nom}`);
        assert.match(metriques, new RegExp(`^memory_${nom}(?:\\{| )`, "m"));
        assert.match(metriques, new RegExp(`^mem0_${nom}(?:\\{| )`, "m"));
      }
      const jour = path.join(donnees, "logs");
      const fichiers = fs.readdirSync(jour);
      assert.ok(fichiers.some((f) => /^memory-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)), `journal du jour : ${fichiers}`);
      assert.deepEqual(fichiers.filter((f) => f.startsWith("mem0-")), [], "aucun journal sous l'ancien nom");
      const lignes = fichiers
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) => fs.readFileSync(path.join(jour, f), "utf8").split("\n").filter(Boolean));
      assert.ok(lignes.length > 0, "le journal n'est pas vide");
      for (const ligne of lignes) assert.equal(JSON.parse(ligne).src, "memory", ligne);
    } finally {
      await service.arreter();
      await faux.fermer();
    }
  });
});

// ── AC-310 : les mises à niveau des installations existantes ────────────────────────────────────────────
const BOX = path.join(ROOT, "omp-harness", "deploy", "container");
const DEPLOY = path.join(ROOT, "omp-harness", "deploy");

/** Le bloc d'un service d'un fichier compose, de sa ligne `  <nom>:` à la suivante de même niveau. */
function blocService(compose: string, nom: string): string {
  const lignes = compose.split("\n");
  const debut = lignes.findIndex((ligne) => ligne === `  ${nom}:`);
  assert.notEqual(debut, -1, `service ${nom} absent`);
  const suite = lignes.slice(debut + 1);
  const fin = suite.findIndex((ligne) => /^ {2}\S/.test(ligne) || /^\S/.test(ligne));
  return (fin === -1 ? suite : suite.slice(0, fin)).join("\n");
}

/** Les écarts de l'unité Debian avec ce que `sysusers.conf` et `tmpfiles.conf` déclarent propriétaire des données. */
function verifierUnite(unite: string, sysusers: string, tmpfiles: string): string[] {
  const ecarts: string[] = [];
  const dossier = /^d \/var\/lib\/omp-mem0 +(\d+) +(\S+) +(\S+) /m.exec(tmpfiles);
  if (!dossier) return ["tmpfiles.conf : /var/lib/omp-mem0 n'est pas déclaré"];
  const [, mode, proprietaire, groupe] = dossier;
  if (mode !== "0700") ecarts.push(`tmpfiles.conf : /var/lib/omp-mem0 est en ${mode}, pas 0700`);
  if (!new RegExp(`^u ${proprietaire} `, "m").test(sysusers)) ecarts.push(
    `sysusers.conf : ${proprietaire} n'est pas déclaré`,
  );
  const directive = (cle: string): string[] => [...unite.matchAll(new RegExp(`^${cle}=(.*)$`, "gm"))].map(
    (m) => m[1]!.trim(),
  );
  if (directive("User")[0] !== proprietaire) ecarts.push(
    `l'unité tourne sous ${directive("User")[0]}, pas sous ${proprietaire}`,
  );
  if (directive("Group")[0] !== groupe) ecarts.push(
    `l'unité tourne sous le groupe ${directive("Group")[0]}, pas ${groupe}`,
  );
  const ecriture = (directive("ReadWritePaths")[0] ?? "").split(/\s+/);
  if (!ecriture.includes("/var/lib/omp-mem0")) ecarts.push("ReadWritePaths ne contient pas /var/lib/omp-mem0");
  if (!ecriture.includes("-/var/lib/omp-memory")) ecarts.push("ReadWritePaths ne contient pas -/var/lib/omp-memory");
  const fichiers = directive("EnvironmentFile");
  if (fichiers.join(" ") !== "-/etc/omp-harness/mem0.env -/etc/omp-harness/memory.env") {
    ecarts.push(`EnvironmentFile : ${fichiers.join(" ")} (l'ancien, puis le nouveau)`);
  }
  return ecarts;
}

/** Le shell d'un faux `/` pour install.sh : tous les chemins système sous `faux`, les commandes de root doublées. */
function installerDebian(
  faux: string,
  options: { bin: string; journal: string; env?: Record<string, string> },
): { status: number | null; stdout: string; stderr: string } {
  const source = lire("omp-harness/deploy/install.sh");
  const reecrit = source
    .replace(/^HERE=.*$/m, `HERE=${JSON.stringify(DEPLOY)}`)
    .replace(/^REPO=.*$/m, `REPO=${JSON.stringify(path.join(faux, "depot"))}`)
    .replace(/(?<![\w$}/])\/(etc|opt|var\/lib|usr\/local|usr\/lib)\//g, "$FAUX/$1/");
  const script = path.join(faux, "install-reecrit.sh");
  fs.writeFileSync(script, reecrit);
  const r = spawnSync("bash", [script], {
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: `${options.bin}:/usr/bin:/bin`,
      FAUX: faux,
      JOURNAL: options.journal,
      ...options.env,
    },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Des commandes de root doublées : elles notent leurs arguments et réussissent. */
function doublures(dir: string, journal: string): string {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const ecrire = (nom: string, corps: string): void => {
    fs.writeFileSync(path.join(bin, nom), `#!/bin/sh\n${corps}\n`, { mode: 0o755 });
  };
  for (const nom of [
    "systemctl",
    "systemd-sysusers",
    "systemd-tmpfiles",
    "systemd-run",
    "visudo",
    "sudo",
    "chown",
    "ssh-keygen",
    "git",
    "cargo",
    "curl",
    "sha256sum",
  ]) {
    ecrire(nom, `echo "${nom} $*" >> "$JOURNAL"\nexit 0`);
  }
  ecrire("id", 'if [ "$1" = "-u" ]; then echo 0; else echo "uid=0(root)"; fi');
  ecrire("hostname", "echo faux-hote");
  ecrire("getent", 'echo "$2:x:1:1::$FAUX/home/$2:/bin/sh"');
  ecrire(
    "install",
    `# install(1) sans les propriétaires (-o, -g) : le test ne tourne pas en root.
n=$#; i=0
while [ $i -lt $n ]; do
  a="$1"; shift; i=$((i+1))
  case "$a" in -o|-g) shift; i=$((i+1)) ;; *) set -- "$@" "$a" ;; esac
done
echo "install $*" >> "$JOURNAL"
for d in /usr/bin /bin; do [ -x "$d/install" ] && exec "$d/install" "$@"; done
exit 1`,
  );
  fs.symlinkSync(process.execPath, path.join(bin, "node"));
  return bin;
}

/** Un faux `/` d'une installation Debian : les dossiers que le script suppose, l'ancienne unité et ses secrets. */
function fauxRoot(avant: { memoryEnv: boolean; ancienne: boolean; ancienEnv: boolean }): { faux: string; bin: string; journal: string } {
  const faux = tmpdir("renommage-memoire-debian-");
  for (const dossier of [
    "etc/sysusers.d",
    "etc/tmpfiles.d",
    "etc/sudoers.d",
    "etc/systemd/system",
    "etc/omp-harness",
    "usr/local/bin",
    "usr/local/libexec",
    "var/lib/omp-harness",
    "var/lib/omp-mem0",
    "home",
    "opt",
  ]) {
    fs.mkdirSync(path.join(faux, dossier), { recursive: true });
  }
  const journal = path.join(faux, "appels.log");
  fs.writeFileSync(journal, "");
  // Le dépôt cloné : des liens vers les dossiers réels (le script les copie sans les parcourir).
  fs.mkdirSync(path.join(faux, "depot", "memory-stack"), { recursive: true });
  for (const dossier of ["omp-harness", "omp-memory"]) fs.symlinkSync(
    path.join(ROOT, dossier),
    path.join(faux, "depot", dossier),
  );
  // omp et memory-rs déjà posés : ni téléchargement, ni compilation.
  const version = /^OMP_VERSION=(\S+)$/m.exec(lire("omp-harness/deploy/install.sh"))![1];
  fs.writeFileSync(path.join(faux, "usr/local/bin/omp"), `#!/bin/sh\necho omp/${version}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(faux, "usr/local/bin/memory-rs"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(faux, "var/lib/omp-mem0", "mem0-rs.db"), "souvenirs d'avant");
  fs.writeFileSync(path.join(faux, "etc/omp-harness/config.json"), '{ "repos": [ "mon-produit" ] }\n');
  if (avant.ancienne) {
    fs.writeFileSync(path.join(faux, "etc/systemd/system/omp-harness-mem0.service"), "[Service]\nUser=omp-mem0\n");
  }
  if (avant.ancienEnv) fs.writeFileSync(
    path.join(faux, "etc/omp-harness/mem0.env"),
    lire("test/support/renommage-memoire/secrets-ancien.env"),
  );
  if (avant.memoryEnv) fs.writeFileSync(
    path.join(faux, "etc/omp-harness/memory.env"),
    lire("test/support/renommage-memoire/secrets-nouveau.env"),
  );
  return { faux, bin: doublures(faux, journal), journal };
}

test("renommage-memoire/AC-310 : chaque installation existante se met à niveau sur ses anciennes données, avec son jeton, sans rien créer sous le nouveau nom — Portainer, harness.sh, Debian, NixOS, pile manuelle, supervision", async (t) => {
  // ── Portainer : `stack-setup init` sur un état d'avant (deux fois), puis sur un état où les deux existent. ──
  const avant = pileJetable();
  fs.mkdirSync(path.join(avant.root, "mem0"), { recursive: true });
  fs.mkdirSync(path.join(avant.secrets, "mem0"), { recursive: true });
  fs.writeFileSync(path.join(avant.root, "mem0", "mem0-rs.db"), "souvenirs d'avant");
  fs.writeFileSync(path.join(avant.secrets, "mem0", "mem0.env"), "MEM0_HTTP_TOKEN=T\n");
  for (const passage of ["première fois", "seconde fois"]) {
    const r = init({ ...avant.env, ANTHROPIC_API_KEY: "sk-ant-test_1" });
    assert.equal(r.status, 0, `${passage} : ${r.stderr}`);
    for (const dossier of [avant.root, avant.secrets]) {
      const nouveau = path.join(dossier, "memory");
      assert.ok(
        fs.lstatSync(nouveau).isSymbolicLink(),
        `${passage} : ${nouveau} est un lien vers l'ancien dossier, pas un dossier vide`,
      );
      assert.equal(fs.readlinkSync(nouveau), "mem0");
    }
    assert.equal(lireFichier(avant.root, "memory", "mem0-rs.db"), "souvenirs d'avant", `${passage} : la même base`);
    assert.equal(
      lireFichier(avant.secrets, "mem0", "mem0.env"),
      "MEM0_HTTP_TOKEN=T\n",
      `${passage} : mem0.env inchangé`,
    );
    for (const [fichier, cle] of [
      [path.join(avant.secrets, "harness", "harness.env"), "MEMORY_HTTP_TOKEN"],
      [path.join(avant.secrets, "runner.env"), "MEMORY_HTTP_TOKEN"],
      [path.join(avant.secrets, "memory", "memory.env"), "MEMORY_HTTP_TOKEN"],
    ] as const) {
      assert.match(
        fs.readFileSync(fichier, "utf8"),
        new RegExp(`^${cle}=T$`, "m"),
        `${passage} : ${fichier} porte le même jeton`,
      );
    }
    assert.equal(
      fs.existsSync(path.join(avant.secrets, "mem0", "memory.env")),
      true,
      "le nouveau fichier est écrit dans le dossier lié",
    );
  }
  // L'ancien et le nouveau ensemble, contenus distincts : le nouveau jeton, le nouveau dossier.
  const deux = pileJetable();
  for (const [nom, jeton] of [
    ["mem0", "OLD"],
    ["memory", "NEW"],
  ] as const) {
    fs.mkdirSync(path.join(deux.root, nom), { recursive: true });
    fs.mkdirSync(path.join(deux.secrets, nom), { recursive: true });
    fs.writeFileSync(path.join(deux.root, nom, "contenu"), nom);
    fs.writeFileSync(
      path.join(deux.secrets, nom, nom === "mem0" ? "mem0.env" : "memory.env"),
      `${nom === "mem0" ? "MEM0" : "MEMORY"}_HTTP_TOKEN=${jeton}\n`,
    );
  }
  assert.equal(init(deux.env).status, 0);
  assert.equal(
    fs.lstatSync(path.join(deux.root, "memory")).isSymbolicLink(),
    false,
    "le nouveau dossier réel est gardé",
  );
  assert.match(lireFichier(deux.secrets, "harness", "harness.env"), /^MEMORY_HTTP_TOKEN=NEW$/m);
  assert.equal(lireFichier(deux.secrets, "mem0", "mem0.env"), "MEM0_HTTP_TOKEN=OLD\n");
  // Une installation neuve crée le nouveau dossier (réel), jamais l'ancien.
  const neuve = pileJetable();
  assert.equal(init(neuve.env).status, 0);
  assert.equal(fs.lstatSync(path.join(neuve.root, "memory")).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(neuve.root, "mem0")) || fs.existsSync(path.join(neuve.secrets, "mem0")), false);

  // Le compose racine : la clé `mem0` porte l'alias `memory`, les montages et l'entrée suivent `memory`, un seul port 8321.
  const racine = lire("docker-compose.yml");
  const memoire = blocService(racine, "mem0");
  assert.match(memoire, /networks:\n {6}default:\n {8}aliases: \[memory\]/);
  assert.match(memoire, /\$\{OMP_HARNESS_ROOT:-\/var\/lib\/omp-harness\}\/memory:\/data/);
  assert.match(memoire, /\/memory:\/run\/secrets\/memory:ro/);
  assert.match(memoire, /entrypoint: .*\. \/run\/secrets\/memory\/memory\.env .*\/usr\/local\/bin\/memory-rs /);
  assert.equal([...memoire.matchAll(/:8321"$/gm)].length, 1, "une seule déclaration du port 8321");
  assert.match(memoire, /OMP_HARNESS_MEMORY_PORT:-\$\{OMP_HARNESS_MEM0_PORT:-8321\}/);
  assert.match(blocService(racine, "pairing"), /\/memory:\/secrets:ro/);
  assert.match(blocService(racine, "harness"), /mem0: \{ condition: service_started \}/);
  assert.doesNotMatch(
    racine,
    /^ {2}memory:$/m,
    "aucun second service `memory` : un seul service mémoire tient le port",
  );

  // Une configuration d'avant (`oracle.url` = http://mem0:8321) joint le service : l'hôte est la clé ou l'alias.
  const gabarit = JSON.parse(lire("omp-harness/deploy/container/config.container.json")) as { oracle: { url: string } };
  const conteneur = lire("omp-harness/deploy/container/compose.yaml");
  for (const [nomFichier, texte] of [
    ["docker-compose.yml", racine],
    ["compose.yaml", conteneur],
  ] as const) {
    const service = blocService(texte, "mem0");
    const alias = /aliases: \[([^\]]+)\]/.exec(service)![1]!.split(",").map((a) => a.trim());
    for (const url of ["http://mem0:8321", "http://memory:8321", gabarit.oracle.url]) {
      const hote = new URL(url).hostname;
      assert.ok(hote === "mem0" || alias.includes(hote), `${nomFichier} : ${hote} ne joint pas le service mémoire`);
    }
  }
  assert.equal(new URL(gabarit.oracle.url).port, "8321");
  assert.match(blocService(conteneur, "mem0"), /env_file:\n {6}- \$\{OMP_HARNESS_MEMORY_ENV\}/);
  assert.match(blocService(conteneur, "mem0"), /\$\{OMP_HARNESS_MEMORY_DATA\}:\/data/);
  assert.equal([...blocService(conteneur, "mem0").matchAll(/:8321"$/gm)].length, 1);
  assert.match(blocService(conteneur, "mem0"), /build: \.\.\/\.\.\/\.\.\/memory-stack\/memory-rs/);

  // ── harness.sh : le choix du dossier de données et du fichier de secrets, refait à chaque `up`. ──
  const moteur = tmpdir("renommage-memoire-moteur-");
  fs.writeFileSync(path.join(moteur, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const monter = (dossiers: string[], secrets: Record<string, string>): { root: string; secrets: string; dir: string } => {
    const dir = tmpdir("renommage-memoire-up-");
    const root = path.join(dir, "root");
    fs.mkdirSync(path.join(root, "state"), { recursive: true });
    fs.writeFileSync(path.join(root, "state", "token"), "t\n");
    for (const nom of dossiers) {
      fs.mkdirSync(path.join(root, nom), { recursive: true });
      fs.writeFileSync(path.join(root, nom, "base"), nom);
    }
    fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
    for (const [nom, contenu] of Object.entries(secrets)) fs.writeFileSync(path.join(dir, "secrets", nom), contenu);
    return { root, secrets: path.join(dir, "secrets"), dir };
  };
  const up = (pile: { root: string; secrets: string; dir: string }): string => {
    spawnSync("bash", [HARNESS_SH, "up"], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        PATH: `${moteur}:${process.env.PATH}`,
        HOME: pile.dir,
        OMP_HARNESS_ENGINE: "docker",
        OMP_HARNESS_ROOT: pile.root,
        OMP_HARNESS_SECRETS: pile.secrets,
        OMP_HARNESS_TAILSCALE: "0",
        OMP_HARNESS_BUILD: "0",
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
    });
    return lireFichier(pile.root, "compose.env");
  };
  const ancienne = monter(["mem0"], { "mem0.env": "MEM0_HTTP_TOKEN=T\nOMLX_BASE_URL=http://10.0.0.2:8000/v1\n" });
  for (const passage of ["première fois", "seconde fois"]) {
    const composeEnv = up(ancienne);
    assert.match(
      composeEnv,
      new RegExp(`^OMP_HARNESS_MEMORY_DATA=${ancienne.root}/mem0$`, "m"),
      `${passage} : l'ancien dossier`,
    );
    assert.match(
      composeEnv,
      new RegExp(`^OMP_HARNESS_MEMORY_ENV=${ancienne.secrets}/mem0\\.env$`, "m"),
      `${passage} : l'ancien fichier`,
    );
    assert.equal(fs.existsSync(path.join(ancienne.root, "memory")), false, `${passage} : $ROOT/memory n'est pas créé`);
    assert.equal(
      fs.existsSync(path.join(ancienne.secrets, "memory.env")),
      false,
      `${passage} : memory.env n'est pas créé`,
    );
    assert.match(lireFichier(ancienne.secrets, "mem0.env"), /^MEM0_HTTP_TOKEN=T$/m, `${passage} : le même jeton`);
  }
  const lesDeux = monter(["mem0", "memory"], {
    "mem0.env": "MEM0_HTTP_TOKEN=OLD\n",
    "memory.env": "MEMORY_HTTP_TOKEN=NEW\n",
  });
  const choisi = up(lesDeux);
  assert.match(
    choisi,
    new RegExp(`^OMP_HARNESS_MEMORY_DATA=${lesDeux.root}/memory$`, "m"),
    "le nouveau dossier l'emporte",
  );
  assert.match(
    choisi,
    new RegExp(`^OMP_HARNESS_MEMORY_ENV=${lesDeux.secrets}/memory\\.env$`, "m"),
    "le nouveau fichier l'emporte",
  );
  const neuf = up(monter([], {}));
  assert.match(neuf, /^OMP_HARNESS_MEMORY_DATA=.*\/memory$/m, "une installation neuve : le nouveau nom");

  // ── Debian : l'unité lue comme texte, face à sysusers.conf et tmpfiles.conf. ──
  const unite = lire("omp-harness/deploy/omp-harness-memory.service");
  const sysusers = lire("omp-harness/deploy/sysusers.conf");
  const tmpfiles = lire("omp-harness/deploy/tmpfiles.conf");
  assert.deepEqual(verifierUnite(unite, sysusers, tmpfiles), [], "l'unité tourne sous le propriétaire des données");
  assert.match(
    verifierUnite(unite.replace("User=omp-mem0", "User=omp-memory"), sysusers, tmpfiles).join("\n"),
    /sous omp-memory, pas sous omp-mem0/,
    "une unité sous un autre utilisateur échoue",
  );
  assert.match(
    verifierUnite(unite.replace("ReadWritePaths=/var/lib/omp-mem0 ", "ReadWritePaths="), sysusers, tmpfiles).join("\n"),
    /ReadWritePaths ne contient pas \/var\/lib\/omp-mem0/,
    "une unité sans l'ancien dossier dans ReadWritePaths échoue",
  );
  assert.match(
    verifierUnite(unite, sysusers, tmpfiles.replace("0700 omp-mem0 omp-mem0", "0700 omp-memory omp-memory")).join("\n"),
    /omp-memory/,
    "un dossier de données propriété d'un autre utilisateur échoue",
  );
  assert.equal(
    tmpfiles.includes("/var/lib/omp-memory"),
    false,
    "aucune règle tmpfiles ne crée le nouveau dossier vide",
  );
  assert.ok(unite.includes("ExecStart=/usr/local/bin/memory-rs --host 127.0.0.1 --port 8321"));
  for (const fichier of ["launcher.conf", "omp-harness-systemd-run"]) {
    const texte = lire(`omp-harness/deploy/${fichier}`);
    const assignations = [...texte.matchAll(/^(?:RUNNER|HEAVY)_HIDDEN="?[^\n]*/gm)].map((m) => m[0]);
    assert.equal(assignations.length, 2, `${fichier} : RUNNER_HIDDEN et HEAVY_HIDDEN`);
    for (const ligne of assignations) {
      assert.ok(
        ligne.includes("/var/lib/omp-mem0 ") && ligne.includes("/var/lib/omp-memory "),
        `${fichier} : ${ligne.slice(0, 20)} — runners et jobs heavy n'atteignent ni l'ancien ni le nouveau dossier de la base`,
      );
    }
  }

  // `install.sh` sur un faux `/` : l'ancienne unité est arrêtée et retirée, rien n'est créé sous le nouveau nom, et une
  // seconde mise à niveau ne crée rien non plus.
  const etat = fauxRoot({ memoryEnv: false, ancienne: true, ancienEnv: true });
  for (const passage of ["première fois", "seconde fois"]) {
    fs.writeFileSync(etat.journal, "");
    const r = installerDebian(etat.faux, { bin: etat.bin, journal: etat.journal });
    assert.equal(r.status, 0, `${passage} : ${r.stdout}\n${r.stderr}`);
    const appels = fs.readFileSync(etat.journal, "utf8");
    if (passage === "première fois") {
      assert.match(
        appels,
        /^systemctl disable --now omp-harness-mem0\.service$/m,
        "l'ancienne unité est arrêtée et désactivée",
      );
    } else {
      assert.doesNotMatch(appels, /omp-harness-mem0\.service/, "seconde fois : plus d'ancienne unité à arrêter");
    }
    assert.equal(
      fs.existsSync(path.join(etat.faux, "etc/systemd/system/omp-harness-mem0.service")),
      false,
      `${passage} : l'ancienne unité est retirée`,
    );
    assert.ok(
      fs.existsSync(path.join(etat.faux, "etc/systemd/system/omp-harness-memory.service")),
      `${passage} : la nouvelle unité`,
    );
    assert.match(appels, /^systemctl enable --now omp-harness-memory\.service$/m);
    assert.equal(
      fs.existsSync(path.join(etat.faux, "etc/omp-harness/memory.env")),
      false,
      `${passage} : memory.env n'est pas créé`,
    );
    assert.equal(
      fs.readFileSync(path.join(etat.faux, "etc/omp-harness/mem0.env"), "utf8"),
      lire("test/support/renommage-memoire/secrets-ancien.env"),
      `${passage} : mem0.env intact`,
    );
    assert.equal(fs.readFileSync(path.join(etat.faux, "var/lib/omp-mem0", "mem0-rs.db"), "utf8"), "souvenirs d'avant");
    assert.equal(
      fs.existsSync(path.join(etat.faux, "var/lib/omp-memory")),
      false,
      `${passage} : /var/lib/omp-memory n'est pas créé`,
    );
    assert.doesNotMatch(appels, /^chown .*omp-mem/m, `${passage} : la propriété des données ne change pas`);
  }

  // Sans cargo (celui de rustup est hors du PATH de sudo) et sans memory-rs, seul /usr/local/bin/mem0-rs étant posé :
  // l'ancienne unité n'est ni arrêtée ni retirée, la nouvelle ne démarre pas, et la sortie nomme la commande de
  // construction ; une fois memory-rs installé, la relance remplace l'unité.
  const sansCargo = fauxRoot({ memoryEnv: false, ancienne: true, ancienEnv: true });
  fs.rmSync(path.join(sansCargo.faux, "usr/local/bin/memory-rs"));
  fs.rmSync(path.join(sansCargo.bin, "cargo"));
  fs.writeFileSync(path.join(sansCargo.faux, "usr/local/bin/mem0-rs"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const sansConstruction = installerDebian(sansCargo.faux, { bin: sansCargo.bin, journal: sansCargo.journal });
  assert.equal(sansConstruction.status, 0, `${sansConstruction.stdout}\n${sansConstruction.stderr}`);
  const appelsSansCargo = fs.readFileSync(sansCargo.journal, "utf8");
  assert.doesNotMatch(appelsSansCargo, /omp-harness-mem0\.service/, "sans memory-rs : l'ancienne unité n'est pas touchée");
  assert.doesNotMatch(appelsSansCargo, /systemctl enable --now omp-harness-memory/, "sans memory-rs : rien à démarrer");
  assert.ok(
    fs.existsSync(path.join(sansCargo.faux, "etc/systemd/system/omp-harness-mem0.service")),
    "sans memory-rs : l'ancienne unité reste installée",
  );
  assert.ok(fs.existsSync(path.join(sansCargo.faux, "usr/local/bin/mem0-rs")), "l'ancien binaire reste");
  assert.match(sansConstruction.stdout, /cargo build --release --locked --manifest-path memory-stack\/memory-rs\/Cargo\.toml/);
  fs.writeFileSync(path.join(sansCargo.faux, "usr/local/bin/memory-rs"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(sansCargo.journal, "");
  const apresConstruction = installerDebian(sansCargo.faux, { bin: sansCargo.bin, journal: sansCargo.journal });
  assert.equal(apresConstruction.status, 0, `${apresConstruction.stdout}\n${apresConstruction.stderr}`);
  assert.match(
    fs.readFileSync(sansCargo.journal, "utf8"),
    /^systemctl disable --now omp-harness-mem0\.service$/m,
    "memory-rs installé : l'ancienne unité est retirée à la relance",
  );
  // Une installation neuve : memory.env est créé avec le jeton, repris par env et runner.env.
  const vierge = fauxRoot({ memoryEnv: false, ancienne: false, ancienEnv: false });
  const neuveDebian = installerDebian(vierge.faux, { bin: vierge.bin, journal: vierge.journal });
  assert.equal(neuveDebian.status, 0, `${neuveDebian.stdout}\n${neuveDebian.stderr}`);
  const jetonNeuf = /^MEMORY_HTTP_TOKEN=([0-9a-f]{64})$/m.exec(lireFichier(vierge.faux, "etc/omp-harness/memory.env"))?.[1];
  assert.ok(jetonNeuf, "memory.env porte le jeton");
  assert.match(lireFichier(vierge.faux, "etc/omp-harness/env"), new RegExp(`^MEMORY_HTTP_TOKEN=${jetonNeuf}$`, "m"));
  assert.match(
    lireFichier(vierge.faux, "etc/omp-harness/runner.env"),
    new RegExp(`^MEMORY_HTTP_TOKEN=${jetonNeuf}$`, "m"),
  );
  assert.match(
    lireFichier(vierge.faux, "etc/omp-harness/memory.env"),
    /^MEMORY_DB_PATH=\/var\/lib\/omp-mem0\/mem0-rs\.db$/m,
  );

  // ── NixOS : le module lu comme texte (options d'avant, mkDefault, warnings, unité, fileset). ──
  const module = lire("omp-harness/deploy/nixos/module.nix");
  for (const [libelle, motif] of [
    [
      "ancienne option mem0.enable en nullOr",
      /mem0 = \{\n\s+enable = lib\.mkOption \{\n\s+type = lib\.types\.nullOr lib\.types\.bool;\n\s+default = null;/,
    ],
    [
      "ancienne option mem0.environment en nullOr",
      /environment = lib\.mkOption \{\n\s+type = lib\.types\.nullOr \(lib\.types\.attrsOf lib\.types\.str\);\n\s+default = null;/,
    ],
    [
      "ancienne option tailscale.mem0HttpsPort en nullOr",
      /mem0HttpsPort = lib\.mkOption \{\n\s+type = lib\.types\.nullOr lib\.types\.port;\n\s+default = null;/,
    ],
    [
      "mkDefault de memory.enable",
      /services\.omp-harness\.memory\.enable = lib\.mkIf \(cfg\.mem0\.enable != null\) \(lib\.mkDefault cfg\.mem0\.enable\)/,
    ],
    [
      "mkDefault de memory.environment",
      /services\.omp-harness\.memory\.environment = lib\.mkIf \(cfg\.mem0\.environment != null\) \(lib\.mkDefault cfg\.mem0\.environment\)/,
    ],
    [
      "mkDefault de tailscale.memoryHttpsPort",
      /services\.omp-harness\.tailscale\.memoryHttpsPort = lib\.mkIf \(cfg\.tailscale\.mem0HttpsPort != null\) \(lib\.mkDefault cfg\.tailscale\.mem0HttpsPort\)/,
    ],
    [
      "avertissement nommant l'ancienne et la nouvelle",
      /warnings =\s+lib\.optional \(cfg\.mem0\.enable != null\) "services\.omp-harness\.mem0\.enable est renommée services\.omp-harness\.memory\.enable/,
    ],
    ["MEMORY_DB_PATH sur l'ancienne base", /MEMORY_DB_PATH = "\/var\/lib\/omp-mem0\/mem0-rs\.db"/],
    [
      "EnvironmentFile ancien puis nouveau",
      /EnvironmentFile = \[ "-\/etc\/omp-harness\/mem0\.env" "-\/etc\/omp-harness\/memory\.env" \]/,
    ],
    ["ReadWritePaths ancien et nouveau", /ReadWritePaths = \[ "\/var\/lib\/omp-mem0" "-\/var\/lib\/omp-memory" \]/],
    [
      "fileset avec omp-chrome/src/lib",
      /fileset = lib\.fileset\.unions \[ \(repo \+ "\/omp-harness"\) \(repo \+ "\/omp-memory"\) \(repo \+ "\/omp-chrome\/src\/lib"\) \]/,
    ],
    [
      "utilisateur propriétaire des données",
      /omp-mem0 = \{ isSystemUser = true; group = "omp-mem0"; home = "\/var\/lib\/omp-mem0"/,
    ],
    ["règle tmpfiles des données d'avant", /"d \/var\/lib\/omp-mem0 +0700 omp-mem0 omp-mem0 -"/],
    ["unité de la mémoire", /systemd\.services\.omp-harness-memory = lib\.mkIf cfg\.memory\.enable/],
  ] as const) {
    assert.match(module, motif, libelle);
  }
  assert.match(
    module,
    /User = "omp-mem0";\n\s+Group = "omp-mem0";/,
    "l'unité tourne sous le propriétaire déclaré des données",
  );
  assert.equal(
    module.includes("/var/lib/omp-memory "),
    true,
    "RUNNER_HIDDEN et HEAVY_HIDDEN couvrent le nouveau dossier",
  );
  assert.equal(
    /"d \/var\/lib\/omp-memory/.test(module),
    false,
    "aucune règle tmpfiles du module ne crée le nouveau dossier vide",
  );
  assert.doesNotMatch(module, /^\s*systemd\.services\.omp-harness-mem0 /m, "l'ancienne unité n'est plus déclarée");

  // Prometheus : la configuration livrée lit le fichier de jeton que la doc fait créer.
  const prometheus = lire("omp-harness/deploy/monitoring/prometheus.yml");
  assert.match(prometheus, /credentials_file: \/run\/secrets\/monitoring\/mem0\.token/);
  assert.match(lire("omp-harness/README.md"), /> mem0\.token && chmod 0600 \*\.token/, "la doc fait créer mem0.token");
  assert.match(prometheus, /- job_name: memory$/m);
  assert.match(prometheus, /targets: \["mem0:8321"\]/, "la cible est la clé du service");

  await t.test("NixOS évalué : mem0.enable = false et memory.enable = true → l'unité de la mémoire est déclarée", (st) => {
    const nix = spawnSync("nix-instantiate", ["--version"], { encoding: "utf8" });
    if (nix.status !== 0) {
      prerequisAbsent(st, "nix-instantiate", "module NixOS non évalué", null);
      return;
    }
    const nixos = `{ configuration }: (import <nixpkgs/nixos> { inherit configuration; }).config`;
    const base = `{ boot.loader.grub.enable = false; fileSystems."/" = { device = "/dev/null"; fsType = "ext4"; }; system.stateVersion = "24.11"; }`;
    const sonde = spawnSync(
      "nix-instantiate",
      ["--eval", "--strict", "--json", "--expr", `(${nixos}) { configuration = ${base}; } ? systemd`],
      { encoding: "utf8", timeout: 240_000 },
    );
    if (sonde.status !== 0) {
      prerequisAbsent(st, "nixpkgs évaluable (<nixpkgs/nixos>)", "module NixOS non évalué", null);
      return;
    }
    const configuration = `{ imports = [ ${path.join(DEPLOY, "nixos", "module.nix")} ]; ${base.slice(2, -2)}; services.omp-harness = { enable = true; mem0.enable = false; memory.enable = true; }; }`;
    const evalue = spawnSync(
      "nix-instantiate",
      [
        "--eval",
        "--strict",
        "--json",
        "--expr",
        `(${nixos}) { configuration = ${configuration}; }.systemd.services ? omp-harness-memory`,
      ],
      { encoding: "utf8", timeout: 240_000 },
    );
    assert.equal(evalue.status, 0, evalue.stderr);
    assert.equal(JSON.parse(evalue.stdout), true, "la nouvelle option l'emporte : l'unité est déclarée");
  });

  // ── Pile manuelle : les fichiers compose, l'ancien compose de repli, doctor.sh. ──
  const piles = lire("memory-stack/docker-compose.yml");
  assert.match(piles, /^ {2}memory-rs:$/m);
  assert.match(piles, /^ {4}build: \.\/memory-rs$/m);
  assert.match(piles, /^ {4}image: memory-rs:local$/m);
  assert.match(piles, /container_name: \$\{MEMORY_RS_CONTAINER:-\$\{MEM0_RS_CONTAINER:-memory-rs\}\}/);
  assert.match(piles, /127\.0\.0\.1:\$\{MEMORY_RS_PORT:-\$\{MEM0_RS_PORT:-8321\}\}:8321/);
  assert.match(piles, /\$\{MEMORY_RS_DATA_DIR:-\$\{MEM0_RS_DATA_DIR:-\.\/memory-rs-data\}\}:\/data/);
  assert.match(piles, /MEMORY_HTTP_TOKEN: \$\{MEMORY_HTTP_TOKEN:-\$\{MEM0_HTTP_TOKEN:-\}\}/);
  const garde = /omp\.memory\.garde: "(\$\{MEMORY_HTTP_TOKEN-\$\{MEM0_HTTP_TOKEN\?[^"]*\}\})"/.exec(piles)?.[1];
  assert.ok(garde, "la garde : `compose up` refuse de démarrer sans `.env`");
  assert.ok(
    garde.includes("mv ../mem0-stack/.env ../mem0-stack/mem0-rs-data ."),
    "le refus nomme la commande de déplacement",
  );
  assert.match(lire("memory-stack/.env.example"), /^MEMORY_HTTP_TOKEN=$/m);
  assert.match(lire("memory-stack/.env.example"), /^MEMORY_RS_DATA_DIR=\.\/memory-rs-data$/m);
  const repli = lire("mem0-stack/docker-compose.yml");
  assert.match(repli, /^ {4}build: \.\.\/memory-stack\/memory-rs$/m, "le compose de repli construit le crate renommé");
  assert.match(repli, /^ {4}image: memory-rs:local$/m);
  assert.match(repli, /\$\{MEM0_RS_DATA_DIR:-\.\/mem0-rs-data\}:\/data/, "il lit l'ancien dossier de données");
  assert.match(repli, /MEM0_HTTP_TOKEN: \$\{MEM0_HTTP_TOKEN:-\}/, "et l'ancien jeton");
  assert.match(
    repli,
    /mv \.\.\/mem0-stack\/\.env \.\.\/mem0-stack\/mem0-rs-data \./,
    "il nomme la commande de déplacement",
  );

  // doctor.sh dans un faux dépôt : les restes de mem0-stack/ font échouer, et la commande est imprimée.
  const faux = tmpdir("renommage-memoire-doctor-");
  fs.mkdirSync(path.join(faux, "memory-stack"));
  fs.mkdirSync(path.join(faux, "mem0-stack", "mem0-rs-data"), { recursive: true });
  fs.writeFileSync(
    path.join(faux, "mem0-stack", ".env"),
    lire("test/support/renommage-memoire/pile-manuelle-ancien.env"),
  );
  fs.copyFileSync(path.join(ROOT, "memory-stack", "doctor.sh"), path.join(faux, "memory-stack", "doctor.sh"));
  const moteurAbsent = path.join(faux, "bin");
  fs.mkdirSync(moteurAbsent);
  fs.writeFileSync(path.join(moteurAbsent, "podman"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const doctor = (): { status: number | null; sortie: string } => {
    const r = spawnSync("bash", [path.join(faux, "memory-stack", "doctor.sh")], {
      encoding: "utf8",
      timeout: 60_000,
      cwd: path.join(faux, "memory-stack"),
      env: { PATH: `${moteurAbsent}:${process.env.PATH ?? "/usr/bin:/bin"}`, MEMORY_HTTP_URL: "http://127.0.0.1:9" },
    });
    return { status: r.status, sortie: `${r.stdout}${r.stderr}` };
  };
  const restes = doctor();
  assert.notEqual(restes.status, 0, "les restes font échouer doctor.sh");
  assert.match(restes.sortie, /✗ des fichiers de mem0-stack\/ n'ont pas suivi/);
  assert.ok(
    restes.sortie.includes("mv ../mem0-stack/.env ../mem0-stack/mem0-rs-data ."),
    "la commande de déplacement est imprimée",
  );
  // Déplacés (l'ancienne `.env` garde ses anciennes clés, lues par les replis) : plus de reste.
  fs.renameSync(path.join(faux, "mem0-stack", ".env"), path.join(faux, "memory-stack", ".env"));
  fs.renameSync(path.join(faux, "mem0-stack", "mem0-rs-data"), path.join(faux, "memory-stack", "mem0-rs-data"));
  assert.match(doctor().sortie, /✓ rien à déplacer depuis mem0-stack\//);

  await t.test("pile manuelle : `docker compose config` sans `.env` refuse, avec une `.env` d'avant monte ./mem0-rs-data et transmet le jeton", (st) => {
    if (spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status !== 0) {
      prerequisAbsent(st, "docker compose", "pile manuelle non rendue par le moteur", null);
      return;
    }
    const dossier = tmpdir("renommage-memoire-compose-");
    fs.mkdirSync(path.join(dossier, "memory-rs"));
    fs.copyFileSync(path.join(ROOT, "memory-stack", "docker-compose.yml"), path.join(dossier, "docker-compose.yml"));
    const rendre = (): { status: number | null; sortie: string } => {
      const r = spawnSync("docker", ["compose", "config"], {
        cwd: dossier,
        encoding: "utf8",
        timeout: 60_000,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dossier },
      });
      return { status: r.status, sortie: `${r.stdout}${r.stderr}` };
    };
    const sans = rendre();
    assert.notEqual(sans.status, 0, "sans .env : refus");
    assert.ok(sans.sortie.includes("mv ../mem0-stack/.env"), sans.sortie);
    fs.copyFileSync(path.join(FIXTURES, "pile-manuelle-ancien.env"), path.join(dossier, ".env"));
    const avec = rendre();
    assert.equal(avec.status, 0, avec.sortie);
    assert.match(avec.sortie, /mem0-rs-data:\/data/, "le montage de l'ancien dossier de données");
    assert.match(avec.sortie, /MEMORY_HTTP_TOKEN: jeton-ancien-T/, "le jeton de l'ancienne clé est transmis");
  });
});

// ── AC-311 : les runners reçoivent la mémoire sous ses nouveaux noms ─────────────────────────────────────
const posix = (relatif: string): string => relatif.split(path.sep).join("/");

/** Les modules relatifs qu'un fichier charge à l'exécution : `import type` et `export type … from` sont effacés. */
function importsExecutes(fichier: string): string[] {
  const source = fs.readFileSync(fichier, "utf8");
  const specifiers: string[] = [];
  for (const m of source.matchAll(/(?:import|export)(\s[^"';]*?)from\s+"(\.[^"]+)"/g)) {
    if (!/^\s*type\s/.test(m[1] ?? "")) specifiers.push(m[2] ?? "");
  }
  for (const m of source.matchAll(/\bimport\(\s*"(\.[^"]+)"\s*\)/g)) specifiers.push(m[1] ?? "");
  return specifiers.map((specifier) => path.resolve(path.dirname(fichier), specifier)).filter(
    (cible) => fs.existsSync(cible),
  );
}

/** Les fichiers atteints depuis `entree` par les seuls imports chargés à l'exécution, entrée comprise. */
function fermeture(entree: string): string[] {
  const vus = new Set<string>();
  const visiter = (fichier: string): void => {
    if (vus.has(fichier)) return;
    vus.add(fichier);
    for (const dependance of importsExecutes(fichier)) visiter(dependance);
  };
  visiter(entree);
  return [...vus];
}

/** Les fichiers de la clôture hors de `omp-harness/` que le `fileset` du module NixOS ne couvre pas. */
function horsFileset(cloture: string[], fileset: string[]): string[] {
  return cloture.filter(
    (relatif) =>
      !relatif.startsWith("omp-harness/") && !fileset.some(
        (dossier) => relatif === dossier || relatif.startsWith(`${dossier}/`),
      ),
  );
}

const ANCIEN_CHEMIN = "/opt/omp-harness/omp-mem0-memory/extension.ts";

test("renommage-memoire/AC-311 : le runner reçoit les variables MEMORY_* et le plugin omp-memory, un ancien chemin déclaré donne le même plugin, le jeton du dépôt n'est jamais le jeton global, le fileset NixOS couvre le code partagé", (t) => {
  // Le plugin de la pile, et les variables du runner.
  assert.ok(MEMORY_EXTENSION.endsWith(path.join("omp-memory", "extension.ts")), MEMORY_EXTENSION);
  assert.ok(fs.existsSync(MEMORY_EXTENSION), "omp-memory/extension.ts existe");
  assert.equal(NO_GLOBAL_ENV, "MEMORY_NO_GLOBAL");
  assert.deepEqual(runnerMemoryEnv("projet", true, true), {
    MEMORY_PROJECT_ID: "projet",
    MEMORY_AUTOSETUP: "0",
    MEMORY_NUDGE: "0",
    MEMORY_MODE: "runner",
    MEMORY_NO_GLOBAL: "1",
  });
  assert.deepEqual(
    Object.keys(runnerMemoryEnv("projet", false)),
    ["MEMORY_PROJECT_ID", "MEMORY_AUTOSETUP", "MEMORY_NUDGE"],
  );

  // Une configuration qui déclare l'ancien chemin charge le plugin de la pile, jamais l'ancien.
  const avec = (extensions: string[]) => testConfig("/srv/repo", (c) => (c.runner.extensions = extensions));
  assert.equal(
    memoryExtension(avec([ANCIEN_CHEMIN])),
    MEMORY_EXTENSION,
    "memoryExtension : l'ancien chemin donne le nouveau",
  );
  assert.equal(memoryExtension(avec([])), MEMORY_EXTENSION);
  assert.equal(
    memoryExtension(avec(["/opt/omp-harness/omp-memory/extension.ts"])),
    "/opt/omp-harness/omp-memory/extension.ts",
  );
  assert.deepEqual(runnerExtensions(avec([ANCIEN_CHEMIN])), [MEMORY_EXTENSION]);
  assert.deepEqual(
    runnerExtensions(avec([ANCIEN_CHEMIN, "/opt/autre/extension.ts"])),
    [MEMORY_EXTENSION, "/opt/autre/extension.ts"],
  );
  assert.deepEqual(runnerExtensions(avec([ANCIEN_CHEMIN, MEMORY_EXTENSION])), [MEMORY_EXTENSION]);
  assert.deepEqual(runnerExtensions(avec([MEMORY_EXTENSION, ANCIEN_CHEMIN])), [MEMORY_EXTENSION]);
  assert.deepEqual(runnerExtensions(avec(["/opt/autre/extension.ts"])), [MEMORY_EXTENSION, "/opt/autre/extension.ts"]);
  const spec = { unit: "u", cwd: "/w", overlay: "/o", model: null, scope: "demo" };
  const extensionsDe = (args: string[]): string[] => args.flatMap((arg, i) => (args[i - 1] === "-e" ? [arg] : []));
  for (const declarees of [[ANCIEN_CHEMIN], [ANCIEN_CHEMIN, "/opt/autre/extension.ts"], [MEMORY_EXTENSION, ANCIEN_CHEMIN]]) {
    const charges = extensionsDe(runnerArgv(avec(declarees), spec).args);
    assert.ok(charges.includes(MEMORY_EXTENSION), `${declarees} : le plugin de la pile est chargé`);
    assert.equal(
      charges.some((fichier) => fichier.includes("omp-mem0-memory")),
      false,
      `${declarees} : aucun -e vers l'ancien chemin`,
    );
  }
  // `memory: false` retire le plugin mémoire sous ses deux noms.
  assert.deepEqual(
    extensionsDe(
      runnerArgv(avec([ANCIEN_CHEMIN, "/opt/autre/extension.ts", "/opt/omp-harness/omp-memory/extension.ts"]), { ...spec, memory: false }).args,
    ),
    ["/opt/autre/extension.ts"],
  );

  // Le jeton isolé : aucune variable du runner ne vaut le jeton global, sous aucun des deux noms.
  const GLOBAL = "global-0123456789abcdef";
  const DEPOT = "jeton-du-depot-0123456789";
  const oracle = { url: "http://memory:8321", token: GLOBAL };
  for (const [nom, base] of [
    ["ancien nom hérité", { [`${"MEM0"}_HTTP_TOKEN`]: GLOBAL }],
    ["nouveau nom hérité", { MEMORY_HTTP_TOKEN: GLOBAL }],
    ["les deux hérités", { [`${"MEM0"}_HTTP_TOKEN`]: GLOBAL, MEMORY_HTTP_TOKEN: GLOBAL }],
  ] as const) {
    const sans = runnerEnv("projet", oracle, base, true, {});
    assert.equal(
      sans.MEMORY_HTTP_TOKEN,
      GLOBAL,
      `${nom} : sans jeton de dépôt, le jeton de l'oracle sous les deux noms`,
    );
    assert.equal(sans[`${"MEM0"}_HTTP_TOKEN`], GLOBAL);
    const env = runnerEnv("projet", oracle, base, true, { memoryToken: DEPOT });
    assert.equal(env.MEMORY_HTTP_TOKEN, DEPOT, nom);
    assert.equal(env[`${"MEM0"}_HTTP_TOKEN`], DEPOT, nom);
    assert.deepEqual(
      Object.entries(env).filter(([, valeur]) => valeur === GLOBAL),
      [],
      `${nom} : aucune variable ne vaut le jeton global`,
    );
    assert.equal(env.MEMORY_HTTP_URL, "http://memory:8321");
    assert.equal(env[`${"MEM0"}_HTTP_URL`], "http://memory:8321");
    assert.equal(env.MEMORY_MODE, "runner");
  }

  // Le lanceur root : la dernière affectation de chaque nom, dans `envfile:`, est celle du jeton du dépôt.
  const dossier = tmpdir("renommage-memoire-lanceur-");
  fs.chmodSync(dossier, 0o755);
  fs.mkdirSync(path.join(dossier, "tokens"));
  const fichierJeton = path.join(dossier, "tokens", "mon-produit.env");
  fs.writeFileSync(fichierJeton, `MEMORY_HTTP_TOKEN=${DEPOT}\n`, { mode: 0o600 });
  // Le lanceur refuse un fichier de service qui appartient à root, et ignore sa configuration de remplacement
  // lancé par root : sous root (slot heavy), le fichier passe à `nobody` et le lanceur tourne sous lui.
  let lanceurEprouvable = true;
  const root = process.getuid?.() === 0;
  if (root) {
    try {
      fs.chownSync(fichierJeton, 65534, 65534);
    } catch {
      // Un root sans CAP_CHOWN (conteneur du slot heavy) ne peut ni rendre le fichier à `nobody` ni lancer sous lui.
      lanceurEprouvable = false;
      t.diagnostic("lanceur non éprouvé ici : root sans CAP_CHOWN ; éprouvé par la CI et par tout poste hors root");
    }
  }
  const configLanceur = loadConfig(path.join(DEPLOY, "config.example.json"));
  const ligne = runnerArgv(configLanceur, {
    unit: "omp-runner-r1-7",
    cwd: "/var/lib/omp-harness/worktrees/mon-produit/export",
    overlay: "/var/lib/omp-harness/state/runner-settings.json",
    model: { provider: "omlx", model: "qwen3-coder" },
    scope: "mon-produit",
    localOnly: true,
  });
  for (const [nom, runnerEnvContenu] of lanceurEprouvable
    ? ([
        ["runner.env d'ancien nom", `${"MEM0"}_HTTP_TOKEN=${GLOBAL}\n`],
        ["runner.env de nouveau nom", `MEMORY_HTTP_TOKEN=${GLOBAL}\n`],
        ["runner.env des deux noms", `${"MEM0"}_HTTP_TOKEN=${GLOBAL}\nMEMORY_HTTP_TOKEN=${GLOBAL}\n`],
      ] as const)
    : []) {
    const fichierRunnerEnv = path.join(dossier, "runner.env");
    fs.writeFileSync(fichierRunnerEnv, runnerEnvContenu);
    const conf = path.join(dossier, "launcher.conf");
    fs.writeFileSync(
      conf,
      `${lire("omp-harness/deploy/launcher.conf")}RUNNER_ENV_FILE=${fichierRunnerEnv}\nPROVIDERS_ENV_FILE=${path.join(dossier, "absent.env")}\n` +
        `PROVIDERS_MODELS_FILE=${path.join(dossier, "absent.yml")}\nMEMORY_TOKENS_DIR=${path.join(dossier, "tokens")}\n`,
    );
    const r = spawnSync(
      "bash",
      [path.join(DEPLOY, "omp-harness-systemd-run"), ...ligne.args.slice(DEFAULT_LAUNCHER.length - 1)],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", OMP_HARNESS_LAUNCHER_DRY_RUN: "1", OMP_HARNESS_LAUNCHER_CONF: conf },
        ...(root ? { uid: 65534, gid: 65534 } : {}),
      },
    );
    assert.equal(r.status, 0, `${nom} : ${r.stderr}`);
    const envfile = r.stdout
      .split("\n")
      .filter((entree) => entree.startsWith("envfile:"))
      .map((entree) => entree.slice("envfile:".length));
    for (const variable of ["MEMORY_HTTP_TOKEN", `${"MEM0"}_HTTP_TOKEN`]) {
      const affectations = envfile.filter((entree) => entree.startsWith(`${variable}=`));
      assert.ok(affectations.length >= 1, `${nom} : ${variable} est affecté`);
      assert.equal(
        affectations.at(-1),
        `${variable}='${DEPOT}'`,
        `${nom} : la dernière affectation de ${variable} est celle du dépôt`,
      );
    }
    assert.equal(
      r.stdout.slice(r.stdout.indexOf("systemd-run")).includes(DEPOT),
      false,
      `${nom} : jamais le jeton sur la ligne de commande`,
    );
  }

  // La garde du fileset : chaque fichier hors de omp-harness/ que main.ts charge est sous un chemin du `fileset`.
  const module = lire("omp-harness/deploy/nixos/module.nix");
  const filesetLigne = /fileset = lib\.fileset\.unions \[(.*)\];/.exec(module)?.[1];
  assert.ok(filesetLigne, "le fileset du code du service");
  const fileset = [...filesetLigne.matchAll(/\(repo \+ "\/([^"]+)"\)/g)].map((m) => m[1]!);
  assert.deepEqual(fileset, ["omp-harness", "omp-memory", "omp-chrome/src/lib"]);
  const cloture = fermeture(path.join(ROOT, "omp-harness", "main.ts")).map(
    (fichier) => posix(path.relative(ROOT, fichier)),
  );
  const hors = cloture.filter((relatif) => !relatif.startsWith("omp-harness/"));
  assert.ok(hors.some((relatif) => relatif.startsWith("omp-memory/")), "main.ts charge le plugin mémoire (scope.ts)");
  assert.ok(
    hors.some((relatif) => relatif.startsWith("omp-chrome/src/lib/")),
    "main.ts charge omp-chrome/src/lib (browser/vps.ts)",
  );
  assert.deepEqual(
    horsFileset(cloture, fileset),
    [],
    "chaque dossier hors de omp-harness/ atteint par main.ts est dans le fileset",
  );
  assert.deepEqual(
    horsFileset(cloture, fileset.filter((dossier) => dossier !== "omp-chrome/src/lib")).filter(
      (r) => r.startsWith("omp-chrome/"),
    ),
    hors.filter((relatif) => relatif.startsWith("omp-chrome/")),
    "un fileset sans omp-chrome/src/lib est signalé",
  );
  assert.ok(horsFileset(cloture, ["omp-harness"]).length >= hors.length, "un fileset sans omp-memory est signalé");
});

// ── AC-312 : la release d'un plugin renommé part de sa version courante ────────────────────────────────
type PlanDeRelease = {
  plan: {
    releases: Array<{ kind: string; name: string; version: string; from: string | null; tag: string; previousTag: string | null }>;
    alreadyPublished: unknown[];
  };
  plugins: Array<{ name: string; dir: string }>;
};

test("renommage-memoire/AC-312 : un plugin renommé avec son dossier garde ses tags d'avant — aucun rattrapage, le bump part de sa version courante et cite le dernier tag de l'ancien nom", async () => {
  const depot = tmpdir("renommage-memoire-release-");
  const distant = path.join(tmpdir("renommage-memoire-release-origin-"), "origin.git");
  const git = (...args: string[]): string =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], {
      cwd: depot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: depot,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });
  const paquet = (dossier: string, nom: string, version: string): void => {
    fs.mkdirSync(path.join(depot, dossier), { recursive: true });
    fs.writeFileSync(path.join(depot, dossier, "package.json"), `${JSON.stringify({ name: nom, version }, null, 2)}\n`);
  };
  fs.mkdirSync(distant);
  fs.writeFileSync(path.join(depot, "package.json"), '{ "type": "module" }\n');
  execFileSync("git", ["init", "-q", "--bare", distant]);
  git("init", "-q", "-b", "main");
  paquet("omp-mem0-memory", "omp-mem0-memory", "4.3.0");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: le plugin mémoire 4.3.0");
  git("tag", "-a", "omp-mem0-memory-v4.3.0", "-m", "omp-mem0-memory-v4.3.0");
  paquet("omp-mem0-memory", "omp-mem0-memory", "4.4.0");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: le plugin mémoire 4.4.0");
  git("tag", "-a", "omp-mem0-memory-v4.4.0", "-m", "omp-mem0-memory-v4.4.0");
  // Le renommage avec le dossier (même version), puis un apport.
  git("mv", "omp-mem0-memory", "omp-memory");
  paquet("omp-memory", "omp-memory", "4.4.0");
  git("add", "-A");
  git("commit", "-q", "-m", "feat(memory): le plugin mémoire change de nom avec son dossier");
  fs.writeFileSync(path.join(depot, "omp-memory", "extension.ts"), "export default function () {}\n");
  git("add", "-A");
  git("commit", "-q", "-m", "feat: un apport après le renommage");
  git("remote", "add", "origin", distant);
  git("push", "-q", "origin", "main", "--tags");
  const tagsAvant = git("tag", "-l").trim().split("\n").sort();
  assert.deepEqual(tagsAvant, ["omp-mem0-memory-v4.3.0", "omp-mem0-memory-v4.4.0"]);

  // `planOn` n'est pas exporté : une copie du script dans le dépôt jetable (sa racine devient ce dépôt) l'expose.
  fs.mkdirSync(path.join(depot, "scripts"));
  const copie = path.join(depot, "scripts", "release.ts");
  fs.writeFileSync(copie, `${lire("scripts/release.ts")}\nexport { planOn };\n`);
  const { planOn } = (await import(pathToFileURL(copie).href)) as {
    planOn: (main: string, catalog: unknown, after: string, eventDate: string) => PlanDeRelease & { published: boolean };
  };
  const catalogue = {
    name: "mem0-omp",
    plugins: [
      { name: "omp-memory", source: "./omp-memory", version: "4.4.0" },
      { name: "omp-mem0-memory", source: "./omp-memory", version: "4.4.0" },
    ],
  };
  const calcule = planOn("main", catalogue, "evenement-1", "2026-11-19");
  assert.deepEqual(
    calcule.plugins.map((p) => p.name),
    ["omp-memory"],
    "l'entrée alias n'a pas de release propre",
  );
  assert.deepEqual(
    calcule.plan.releases.filter((r) => r.kind === "rattrapage"),
    [],
    "aucune version déjà taguée sous l'ancien nom n'est proposée en rattrapage",
  );
  assert.deepEqual(
    calcule.plan.releases.map((r) => [r.kind, r.name, r.from, r.version, r.tag, r.previousTag]),
    [["bump", "omp-memory", "4.4.0", "4.5.0", "omp-memory-v4.5.0", "omp-mem0-memory-v4.4.0"]],
    "le bump part de 4.4.0 et cite omp-mem0-memory-v4.4.0",
  );
  assert.equal(
    calcule.plan.releases.some((r) => r.name === "omp-mem0-memory"),
    false,
    "aucune release pour l'alias",
  );
  assert.deepEqual(git("tag", "-l").trim().split("\n").sort(), tagsAvant, "les tags existants ne changent pas");
  // Le même plan, l'ancien tag 4.3.0 retiré du distant : la version reste à rattraper SOUS LE NOUVEAU NOM, jamais l'ancienne.
  execFileSync("git", ["--git-dir", distant, "tag", "-d", "omp-mem0-memory-v4.3.0"], { stdio: "ignore" });
  const manquant = planOn("main", catalogue, "evenement-2", "2026-11-19");
  assert.deepEqual(
    manquant.plan.releases.filter((r) => r.kind === "rattrapage").map((r) => r.tag),
    ["omp-memory-v4.3.0"],
    "un tag réellement absent reste rattrapé (le renommage ne masque que les versions taguées)",
  );
});

// ── AC-313 : la doc de mise à niveau ───────────────────────────────────────────────────────────────────
/** Pour chaque type d'installation : les anciens noms publics de la table de B-1 et leurs nouveaux, sur une même ligne. */
const NOMS_PAR_TYPE: Record<string, Array<[string, string]>> = {
  "### Plugins et catalogue": [
    ["omp-mem0-memory", "omp-memory"],
    ["omp-mem0-req", "omp-memory-req"],
    ...ALIAS_OUTILS.map((nom, i): [string, string] => [nom, OUTILS_ATTENDUS[i]!]),
    ...ALIAS_COMMANDES.map((nom, i): [string, string] => [`/${nom}`, `/${COMMANDES_ATTENDUES[i]!}`]),
    ["X-Mem0-Token", "X-Memory-Token"],
    ["~/.omp/mem0.json", "~/.omp/memory.json"],
    ...["HTTP_URL", "HTTP_TOKEN", "PROJECT_ID", "MODE", "AUTOSETUP", "NUDGE", "NO_GLOBAL", "QUIET", "CHECK_DEPTH"].map(
      (nom): [string, string] => [`MEM0_${nom}`, `MEMORY_${nom}`],
    ),
    ["MEM0_TOKEN_<NOM>", "MEMORY_TOKEN_<NOM>"],
    [".omp/mem0-brief.md", ".omp/memory-brief.md"],
    ["<!-- mem0:brief vN -->", "<!-- memory:brief vN -->"],
  ],
  "### Pile manuelle": [
    ["mem0-stack/", "memory-stack/"],
    ["mem0-stack/mem0-rs/", "memory-stack/memory-rs/"],
    ["mem0-rs-data", "memory-rs-data"],
    ["MEM0_RS_DATA_DIR", "MEMORY_RS_DATA_DIR"],
    ["MEM0_RS_PORT", "MEMORY_RS_PORT"],
    ["MEM0_RS_CONTAINER", "MEMORY_RS_CONTAINER"],
    ["mem0-rs:local", "memory-rs:local"],
    ["~/.mem0/mem0-rs.db", "~/.memory/memory-rs.db"],
    ["MEM0_DB_PATH", "MEMORY_DB_PATH"],
    ["MEM0_HTTP_TOKENS_FILE", "MEMORY_HTTP_TOKENS_FILE"],
    ["MEM0_SEARCH_FUSION", "MEMORY_SEARCH_FUSION"],
    ["MEM0_RRF_K", "MEMORY_RRF_K"],
    ...["INTERVAL_MINUTES", "QUIET_MINUTES", "PAIRS", "FORGET_DAYS"].map(
      (nom): [string, string] => [`MEM0_DREAM_${nom}`, `MEMORY_DREAM_${nom}`],
    ),
    ...["INTERVAL_HOURS", "KEEP", "FILE", "REMOTE_CMD", "REMOTE_TIMEOUT_SECONDS"].map(
      (nom): [string, string] => [`${"MEM0"}_BACKUP_${nom}`, `MEMORY_BACKUP_${nom}`],
    ),
    ["MEM0_LOG_DIR", "MEMORY_LOG_DIR"],
    ["MEM0_LOG_RETENTION_DAYS", "MEMORY_LOG_RETENTION_DAYS"],
    ["mem0-AAAA-MM-JJ.jsonl", "memory-AAAA-MM-JJ.jsonl"],
    ["mem0_*", "memory_*"],
  ],
  "### harness.sh": [
    ["${OMP_HARNESS_ROOT}/mem0", "${OMP_HARNESS_ROOT}/memory"],
    ["$SECRETS/mem0.env", "$SECRETS/memory.env"],
    ["OMP_HARNESS_MEM0_PORT", "OMP_HARNESS_MEMORY_PORT"],
    ["OMP_HARNESS_MEM0_ENV", "OMP_HARNESS_MEMORY_ENV"],
    ["OMP_HARNESS_TAILNET_MEM0_PORT", "OMP_HARNESS_TAILNET_MEMORY_PORT"],
    ["OMP_HARNESS_REBUILD_MEM0", "OMP_HARNESS_REBUILD_MEMORY"],
    ["MEM0_URL", "MEMORY_URL"],
    ["CORPO_MEM0_TOKEN", "CORPO_MEMORY_TOKEN"],
    ["http://mem0:8321", "http://memory:8321"],
    ["monitoring/mem0.token", "monitoring/memory.token"],
    ["~/.omp/mem0.json", "~/.omp/memory.json"],
  ],
  "### Portainer": [
    ["${OMP_HARNESS_ROOT}/mem0", "${OMP_HARNESS_ROOT}/memory"],
    ["${OMP_HARNESS_SECRETS}/mem0", "${OMP_HARNESS_SECRETS}/memory"],
    ["mem0.env", "memory.env"],
    ["OMP_HARNESS_MEM0_PORT", "OMP_HARNESS_MEMORY_PORT"],
    ["OMP_HARNESS_TAILNET_MEM0_PORT", "OMP_HARNESS_TAILNET_MEMORY_PORT"],
    ["MEM0_BACKUP_REMOTE_CMD", "MEMORY_BACKUP_REMOTE_CMD"],
    ["http://mem0:8321", "http://memory:8321"],
    ["MEM0_HTTP_URL", "MEMORY_HTTP_URL"],
    ["monitoring/mem0.token", "monitoring/memory.token"],
  ],
  "### Debian": [
    ["omp-harness-mem0.service", "omp-harness-memory.service"],
    ["/etc/omp-harness/mem0.env", "/etc/omp-harness/memory.env"],
    ["deploy/mem0.env.example", "deploy/memory.env.example"],
    ["/var/lib/omp-mem0", "/var/lib/omp-memory"],
    ["mem0-rs.db", "memory-rs.db"],
    ["omp-mem0", "omp-memory"],
    ["MEM0_DB_PATH", "MEMORY_DB_PATH"],
    ["MEM0_HTTP_TOKEN", "MEMORY_HTTP_TOKEN"],
    ["OMP_HARNESS_REBUILD_MEM0", "OMP_HARNESS_REBUILD_MEMORY"],
    ["monitoring/mem0.token", "monitoring/memory.token"],
  ],
  "### NixOS": [
    ["services.omp-harness.mem0.enable", "services.omp-harness.memory.enable"],
    ["services.omp-harness.mem0.environment", "services.omp-harness.memory.environment"],
    ["services.omp-harness.tailscale.mem0HttpsPort", "services.omp-harness.tailscale.memoryHttpsPort"],
    ["omp-mem0", "omp-memory"],
    ["/var/lib/omp-mem0", "/var/lib/omp-memory"],
    ["/etc/omp-harness/mem0.env", "/etc/omp-harness/memory.env"],
    ["MEM0_DB_PATH", "MEMORY_DB_PATH"],
    ["omp-harness-mem0.service", "omp-harness-memory.service"],
    ["monitoring/mem0.token", "monitoring/memory.token"],
  ],
  "### App Mac": [
    ["com.omp.console.mem0-rs", "com.omp.console.memory-rs"],
    ["mem0-rs.db", "memory-rs.db"],
    ["mem0-rs.log", "memory-rs.log"],
    ["MEM0_HTTP_TOKEN", "MEMORY_HTTP_TOKEN"],
    ["MEM0_HTTP_URL", "MEMORY_HTTP_URL"],
    ["MEM0_PROJECT_ID", "MEMORY_PROJECT_ID"],
    ["OMP_CONSOLE_MEM0_PORT", "OMP_CONSOLE_MEMORY_PORT"],
    ["OMP_CONSOLE_MEM0_RS_SHA256", "OMP_CONSOLE_MEMORY_RS_SHA256"],
    ["MEM0_CONSOLE_HOOK_ALL_WORKTREES", "MEMORY_CONSOLE_HOOK_ALL_WORKTREES"],
    ["Service mem0", "Service mémoire"],
    ["~/.omp/mem0.json", "~/.omp/memory.json"],
  ],
};

/** Les anciens noms de la table qui manquent dans leur section (ou y manquent sans leur nouveau nom sur la même ligne). */
function nomsManquants(section: string): string[] {
  const manques: string[] = [];
  for (const [titre, couples] of Object.entries(NOMS_PAR_TYPE)) {
    const lignes = sectionDe(section, titre).split("\n");
    for (const [ancien, nouveau] of couples) {
      if (!lignes.some((ligne) => ligne.includes(ancien) && ligne.includes(nouveau))) {
        manques.push(`${titre} : « ${ancien} » → « ${nouveau} »`);
      }
    }
  }
  return manques;
}

test("renommage-memoire/AC-313 : la section de mise à niveau nomme chaque ancien nom avec son nouveau sous le bon type d'installation, dit comment déplacer données et secrets, et l'ordre de désinstallation avant installation", () => {
  const readme = lire("README.md");
  const titre = "## Passer aux noms memory (mise à niveau)";
  const section = sectionDe(readme, titre);
  assert.ok(
    readme.indexOf(`\n${titre}\n`) > 0 && readme.indexOf(`\n${titre}\n`) < readme.indexOf("\n## Dépannage\n"),
    "avant « Dépannage »",
  );
  assert.deepEqual(
    [...section.matchAll(/^### (.+)$/gm)].map((m) => m[1]),
    ["Plugins et catalogue", "Pile manuelle", "harness.sh", "Portainer", "Debian", "NixOS", "App Mac"],
    "un sous-titre par type d'installation",
  );
  assert.deepEqual(nomsManquants(section), [], "anciens noms publics sans leur nouveau nom");
  // Cas planté : un ancien nom retiré d'une section est nommé.
  const privee = section.replaceAll("monitoring/mem0.token", "monitoring/autre.token");
  assert.ok(
    nomsManquants(privee).some((manque) => manque.includes("monitoring/mem0.token")),
    "un nom manquant est signalé",
  );
  assert.equal(
    nomsManquants(privee).filter((manque) => manque.includes("monitoring/mem0.token")).length,
    4,
    "monitoring/mem0.token est exigé sous harness.sh, Portainer, Debian et NixOS",
  );

  const plat = section.replace(/\s+/g, " ");
  const sous = (type: string): string => sectionDe(section, type).replace(/\s+/g, " ");
  // Déplacer données et secrets à la main.
  assert.ok(sous("### Pile manuelle").includes("mv ../mem0-stack/.env ../mem0-stack/mem0-rs-data ."));
  assert.ok(sous("### Pile manuelle").includes("compose de repli de `mem0-stack/` disparaît"));
  assert.ok(sous("### harness.sh").includes("mv mem0 memory"));
  assert.ok(sous("### Portainer").includes("renommer `mem0` en `memory`"));
  for (const type of ["### Debian", "### NixOS"]) {
    assert.ok(sous(type).includes("chown -R omp-memory:omp-memory"), `${type} : la propriété des données`);
    assert.ok(sous(type).includes("/var/lib/omp-mem0 /var/lib/omp-memory"), `${type} : le dossier de données`);
  }
  assert.ok(sous("### Debian").includes("usermod -l omp-memory omp-mem0"), "Debian : l'utilisateur système");
  assert.ok(sous("### Debian").includes("groupmod -n omp-memory omp-mem0"));
  // Le brief, les réglages, le catalogue, les replis.
  for (const phrase of [
    "L'ancien `.omp/mem0-brief.md` peut être supprimé",
    "Un ancien bloc `mem0:brief` de `AGENTS.md` qui n'a pas été édité est remplacé par le plugin à jour",
    "se remplace par `/memory-brief --update`",
    "des outils `mem0_*` qui n'existeront plus",
    "`~/.omp/mem0.json` ne se renomme en `memory.json` qu'une fois à jour **tous** ses écrivains",
    "le catalogue garde son nom `mem0-omp`",
    "Le catalogue devient `memory-omp` : retire-le puis rajoute-le",
    "Les replis disparaissent à la **version qui suit** la version de transition",
    "commit `feat(memory)`",
    "Rien à faire pendant la transition",
    "`monitoring/mem0.token` → `monitoring/memory.token`",
  ]) {
    assert.ok(plat.includes(phrase), `la section ne dit pas : ${phrase}`);
  }
  // Passer des anciens plugins aux nouveaux : désinstaller AVANT d'installer, et l'avertissement.
  const plugins = sectionDe(section, "### Plugins et catalogue");
  const desinstalle = plugins.search(/^omp plugin uninstall omp-mem0-memory@mem0-omp$/m);
  const desinstalleReq = plugins.search(/^omp plugin uninstall omp-mem0-req@mem0-omp$/m);
  const installe = plugins.search(/^omp plugin install omp-memory@mem0-omp$/m);
  const installeReq = plugins.search(/^omp plugin install omp-memory-req@mem0-omp$/m);
  assert.ok(
    desinstalle >= 0 && installe >= 0 && desinstalle < installe,
    "omp-mem0-memory est désinstallé avant l'installation de omp-memory",
  );
  assert.ok(
    desinstalleReq >= 0 && installeReq >= 0 && desinstalleReq < installeReq,
    "omp-mem0-req est désinstallé avant l'installation de omp-memory-req",
  );
  assert.ok(
    plugins.replace(/\s+/g, " ").includes(
      "N'installe **jamais** `omp-memory` à côté d'un `omp-mem0-memory` qui n'a pas été mis à jour",
    ),
    "l'avertissement sur une ancienne copie pas à jour",
  );
  // « Mettre à jour » du README et de PUBLISHING.md renvoient à cette section.
  assert.ok(
    readme.slice(0, readme.indexOf(`\n${titre}\n`)).includes("Passer aux noms memory"),
    "README : « Mettre à jour » renvoie à la section",
  );
  assert.ok(lire("PUBLISHING.md").includes("Passer aux noms memory"), "PUBLISHING.md renvoie à la section");
});
