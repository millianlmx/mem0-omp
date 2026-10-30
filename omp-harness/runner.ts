// Le lancement d'un runner OMP : un process enfant par étape, plafonné à 1 Go, profil
// pipeline (LSP, DAP et noyau Python éteints), en mode RPC — et les outils hôtes
// que le service lui prête selon l'étape.
//
// En isolation `systemd`, le runner est un SERVICE transitoire (`--wait --pipe` : il garde
// ses tuyaux stdio avec le service) : MemoryMax=1G et OOMScoreAdjust=300 dans la tranche
// des runners. Le lanceur root y impose l'user des runners et le bac à sable : son seul
// worktree inscriptible, son seul clone lisible (les autres worktrees et clones masqués),
// le reste du système en lecture seule, sans élévation — l'équivalent du conteneur.
//
// En isolation `container`, c'est un conteneur frère (`run -i`, stdio gardés), aux
// mêmes plafonds, qui ne monte que son worktree, le clone en lecture, son HOME et
// ses clés.
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { FINDING_KINDS, MAX_FINDINGS, SEVERITIES } from "./challenge.ts";
import { launch } from "./config.ts";
import type { HarnessConfig, ModelChoice } from "./config.ts";
import type { StepKind } from "./machine.ts";
import { DECISION_CATEGORIES } from "./decisions.ts";
import type { Exec } from "./proc.ts";
import type { HostToolDefinition, RpcRunner } from "./rpc.ts";

/** Les réglages du profil pipeline, en overlay `--config` (YAML ⊃ JSON). */
export const PIPELINE_SETTINGS = {
  lsp: { enabled: false },
  debug: { enabled: false },
  eval: { py: false },
  python: { kernelMode: "per-call" },
} as const;

/** Écrit l'overlay du profil pipeline dans `dataDir` et rend son chemin. */
export function writePipelineOverlay(dataDir: string): string {
  const file = path.join(dataDir, "runner-settings.json");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(PIPELINE_SETTINGS, null, 2)}\n`);
  return file;
}

/**
 * Le plugin mémoire, partie de la pile : chaque runner le charge, sans qu'on le déclare.
 * Il vit à côté du harness dans toutes les installations (le dépôt, `/opt/omp-harness`,
 * les images du service et des runners, NixOS) ; sans lui, les prompts d'étape
 * demanderaient un `mem0_add` absent.
 */
export const MEMORY_EXTENSION = fileURLToPath(new URL("../omp-mem0-memory/extension.ts", import.meta.url));

/** Un chemin d'extension qui désigne le plugin mémoire (`…/omp-mem0-memory/extension.ts`). */
function isMemoryExtension(file: string): boolean {
  return path.basename(file) === "extension.ts" && path.basename(path.dirname(file)) === "omp-mem0-memory";
}

/** Le plugin mémoire que chargent les runners : celui que la configuration déclare encore, sinon celui de la pile. */
export function memoryExtension(config: HarnessConfig): string {
  return config.runner.extensions.find(isMemoryExtension) ?? MEMORY_EXTENSION;
}

/**
 * Les extensions d'un runner : le plugin mémoire d'abord, toujours, puis celles de la
 * configuration. Un plugin mémoire déclaré à un autre chemin est pris tel quel, jamais doublé.
 */
export function runnerExtensions(config: HarnessConfig): string[] {
  const declared = config.runner.extensions;
  return declared.some(isMemoryExtension) ? [...declared] : [MEMORY_EXTENSION, ...declared];
}

/** Le nom d'unité d'un runner : retrouvable (et arrêtable) après un redémarrage du service. */
export function runnerUnit(runId: string, stepId: number): string {
  return `omp-runner-${runId}-${stepId}`;
}

/** Une commande du moteur de conteneurs (`docker …` ou `podman …`). */
export function engine(config: HarnessConfig, args: string[]): { command: string; args: string[] } {
  const [command, ...prefix] = config.container.command;
  return { command: command as string, args: [...prefix, ...args] };
}

/** L'utilisateur des conteneurs : celui de la configuration, sinon celui du service. */
export function containerUser(config: HarnessConfig): string {
  return config.container.user ?? `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
}

/** Arrête de force l'unité d'un runner ou d'un job : le service systemd transitoire, ou le conteneur. */
export async function forceStop(
  config: HarnessConfig,
  exec: Exec,
  unit: string,
  isolation = config.runner.isolation,
): Promise<void> {
  if (isolation === "systemd") {
    const stop = launch(config, ["--stop", `${unit}.service`]);
    await exec(stop.command, stop.args, { timeoutMs: 15_000 });
  } else if (isolation === "container") {
    const stop = engine(config, ["rm", "--force", unit]);
    await exec(stop.command, stop.args, { timeoutMs: 30_000 });
  }
}

/**
 * Arrête un runner : stdin fermé, puis signaux, puis l'arrêt forcé de son unité — un
 * runner lancé par sudo, ou dans un conteneur, n'est pas signalable par le service.
 */
export async function stopRunner(
  config: HarnessConfig,
  exec: Exec,
  runner: RpcRunner,
  unit: string | null,
): Promise<void> {
  const force = unit && config.runner.isolation !== "none" ? () => forceStop(config, exec, unit) : undefined;
  await runner.stop(5000, force);
}

/**
 * Ce que le plugin mémoire d'un runner doit savoir : la scope du PROJET (celle du
 * Mac et de l'oracle), ne jamais écrire dans le dépôt (le brief finirait dans la
 * PR), pas de relance de fin de session (le knowledge-updater tient la mémoire), et
 * le mode runner (`config.memory.runnerMode`) : ni rappel par tour ni épinglage —
 * la section Oracle du prompt est la seule source ; les outils mem0_* restent.
 */
export function runnerMemoryEnv(scope: string, runnerMode: boolean): Record<string, string> {
  const env: Record<string, string> = { MEM0_PROJECT_ID: scope, MEM0_AUTOSETUP: "0", MEM0_NUDGE: "0" };
  if (runnerMode) env.MEM0_MODE = "runner";
  return env;
}

export type RunnerSpec = {
  unit: string;
  cwd: string;
  overlay: string;
  model: ModelChoice | null;
  scope: string;
  /** Le clone du dépôt (le gitdir du worktree y vit) : monté en lecture, seul clone visible (requis en `container`). */
  repo?: string;
  /** L'adresse de la mémoire vue du runner. */
  oracleUrl?: string | null;
};

/** Le runner en conteneur frère : ses seuls montages sont son worktree, le clone en lecture, l'overlay, son HOME et ses clés. */
function containerRunnerArgv(
  config: HarnessConfig,
  spec: RunnerSpec,
  omp: string[],
): { command: string; args: string[] } {
  if (!spec.repo) throw new Error("isolation container : le clone du dépôt du runner est requis");
  const box = config.container;
  const env = {
    HOME: "/home/runner",
    PI_PY: "0",
    ...runnerMemoryEnv(spec.scope, config.memory.runnerMode),
    ...(spec.oracleUrl ? { MEM0_HTTP_URL: spec.oracleUrl } : {}),
  };
  return engine(config, [
    "run",
    "--rm",
    "-i",
    "--init",
    `--name=${spec.unit}`,
    "--label=omp-harness=runner",
    `--memory=${config.runner.memoryMax}`,
    `--memory-swap=${config.runner.memoryMax}`,
    `--oom-score-adj=${config.runner.oomScoreAdjust}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--user=${containerUser(config)}`,
    ...(box.network ? [`--network=${box.network}`] : []),
    `--workdir=${spec.cwd}`,
    "--volume",
    `${spec.cwd}:${spec.cwd}`,
    "--volume",
    `${spec.repo}:${spec.repo}:ro`,
    "--volume",
    `${spec.overlay}:${spec.overlay}:ro`,
    ...(box.runnerHome ? ["--volume", `${box.runnerHome}:/home/runner`] : []),
    ...(box.runnerEnvFile ? ["--volume", `${box.runnerEnvFile}:/run/secrets/runner.env:ro`] : []),
    // Les clés déclarées par l'API (providers.ts) : montées seulement si le fichier existe
    // (un montage d'un fichier absent créerait un répertoire).
    ...(fs.existsSync(config.providersEnvFile)
      ? ["--volume", `${config.providersEnvFile}:/run/secrets/providers.env:ro`]
      : []),
    ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    box.runnerImage,
    ...omp,
  ]);
}

export function runnerArgv(config: HarnessConfig, spec: RunnerSpec): { command: string; args: string[] } {
  const omp = [
    config.ompBin,
    "--mode",
    "rpc",
    "--no-ui",
    "--no-session",
    "--no-lsp",
    "--no-title",
    "--auto-approve",
    "--profile",
    config.runner.profile,
    "--config",
    spec.overlay,
    "--cwd",
    spec.cwd,
    ...(spec.model ? ["--model", `${spec.model.provider}/${spec.model.model}`] : []),
    ...runnerExtensions(config).flatMap((extension) => ["-e", extension]),
  ];
  if (config.runner.isolation === "none") return { command: omp[0] as string, args: omp.slice(1) };
  if (config.runner.isolation === "container") return containerRunnerArgv(config, spec, omp);
  // Sans lanceur, rien ne poserait l'user, les clés ni le bac à sable du runner : il
  // tournerait en root. `--check` signale déjà la configuration ; ici, on refuse.
  if (config.launcher.length === 0)
    throw new Error("isolation systemd : un runner passe par le lanceur root (`launcher` est vide)");
  return launch(config, [
    "--wait",
    "--pipe",
    "--collect",
    "--service-type=exec",
    `--unit=${spec.unit}`,
    "--quiet",
    `--slice=${config.runner.slice}`,
    `--working-directory=${spec.cwd}`,
    "-p",
    `MemoryMax=${config.runner.memoryMax}`,
    "-p",
    `OOMScoreAdjust=${config.runner.oomScoreAdjust}`,
    // Le clone (le gitdir du worktree) : le lanceur le rend visible en lecture, et lui seul.
    ...(spec.repo ? ["-p", `BindReadOnlyPaths=${spec.repo}`] : []),
    // sudo remet l'environnement à zéro : la scope mémoire passe par la ligne (liste fermée côté lanceur).
    ...Object.entries(runnerMemoryEnv(spec.scope, config.memory.runnerMode)).map(
      ([key, value]) => `--setenv=${key}=${value}`,
    ),
    "--",
    ...omp,
  ]);
}

/**
 * L'environnement d'un runner lancé SANS le lanceur root : celui du service (clés des
 * fournisseurs), la mémoire du projet (adresse et jeton de l'oracle), jamais le jeton
 * de l'API. Avec le lanceur, sudo l'ignore : clés et oracle viennent de runner.env.
 */
export function runnerEnv(
  scope: string,
  oracle: HarnessConfig["oracle"],
  base: Record<string, string | undefined> = process.env,
  runnerMode = true,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, ...runnerMemoryEnv(scope, runnerMode), PI_PY: "0" };
  if (oracle) {
    env.MEM0_HTTP_URL = oracle.url;
    if (oracle.token) env.MEM0_HTTP_TOKEN = oracle.token;
  }
  delete env.HARNESS_TOKEN;
  return env;
}

const STRINGS = { type: "array", items: { type: "string" } } as const;

const DECISION_TOOL: HostToolDefinition = {
  name: "decision",
  label: "Harness — décision",
  description:
    "Enregistre une décision NON TRANCHÉE par les specs ou l'oracle. Choisis l'option la PLUS RÉVERSIBLE. " +
    "`category: reversible` (choix technique) ou `clarification` (question de produit/UX non tranchée, réversible) → le service pose un checkpoint (commit WIP « decision: … ») et tu continues avec ton choix ; l'humain pourra renverser. " +
    "`schema` (schéma de données), `public_api` (API publique) ou `deletion` (suppression) → escalade : n'applique PAS ce choix, " +
    "contourne et termine tout ce qui n'en dépend pas ; l'humain tranchera en fin d'étape. N'utilise JAMAIS l'outil `ask`.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "La question, autoportante, en une phrase." },
      context: {
        type: "string",
        description:
          "La situation, en Markdown (paragraphes courts, listes, `code` en ligne ; ni titres ni tableaux) : l'humain pilote " +
          "plusieurs projets à la fois et lit cette question hors de la session, sans le code sous les yeux. Dis la feature " +
          "et ce qu'elle doit livrer, l'endroit du code concerné (fichiers, symboles), ce qui pose la question (ce que les " +
          "specs ou l'existant ne tranchent pas) et l'enjeu. Explique tout terme propre au projet.",
      },
      options: { ...STRINGS, minItems: 2, maxItems: 4, description: "Les options envisagées (2 à 4), mot pour mot." },
      impacts: {
        ...STRINGS,
        minItems: 2,
        maxItems: 4,
        description:
          "Ce qu'emporte chaque option, dans l'ordre de `options` (une phrase chacune : ce qui change, ce qu'il en coûte, " +
          "ce qui devient difficile à défaire). REQUIS pour une escalade ; recommandé pour une clarification.",
      },
      chosen: { type: "string", description: "L'option retenue (reprise d'une des options)." },
      rationale: {
        type: "string",
        description: "Pourquoi cette option : réversibilité, coût, cohérence avec l'existant.",
      },
      category: { type: "string", enum: [...DECISION_CATEGORIES] },
      dependsOn: {
        type: "array",
        items: { type: "integer", minimum: 1 },
        description:
          "Les numéros (#N) des décisions déjà prises dont ce choix découle. Renverser l'une d'elles annulera aussi celle-ci ; " +
          "un choix qui tiendrait quelle que soit l'issue des autres n'en déclare aucune.",
      },
    },
    required: ["question", "context", "options", "chosen", "rationale", "category"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

// Jamais `checkpoint` : OMP lit tout résultat d'outil de ce nom comme son checkpoint
// de contexte et exige ensuite un `rewind` que le runner n'a pas — l'étape ne se
// clôt plus.
const CHECKPOINT_TOOL: HostToolDefinition = {
  name: "save_checkpoint",
  label: "Harness — checkpoint",
  description:
    "Commite l'état courant du worktree (commit WIP par le service) et rend son `sha`. Appelle-le après chaque incrément cohérent : un délai ou une relance repart de là.",
  parameters: {
    type: "object",
    properties: { message: { type: "string", description: "Ce que l'incrément livre, une phrase." } },
    required: ["message"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const SET_MODULES_TOOL: HostToolDefinition = {
  name: "set_modules",
  label: "Harness — modules touchés",
  description:
    "Pose tout de suite les chemins du dépôt que ce run touche (dossiers ou fichiers) : c'est ce qui décide du parallélisme avec les autres runs. Appelle-le dès que les chemins sont connus.",
  parameters: {
    type: "object",
    properties: { paths: { ...STRINGS, minItems: 1, description: "Chemins relatifs à la racine du dépôt." } },
    required: ["paths"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const SPLIT_TOOL: HostToolDefinition = {
  name: "split_feature",
  label: "Harness — découpage",
  description:
    "Découpe la feature : les sous-features listées (AUTRES que celle que ce run continue d'implémenter) partent dans un projet à part, chacune avec sa demande rédigée comme un /req et ses modules. Ce run garde la première part.",
  parameters: {
    type: "object",
    properties: {
      features: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            request: { type: "string", description: "La demande, autoportante, rédigée comme un /req." },
            modules: { ...STRINGS, minItems: 1 },
          },
          required: ["title", "request", "modules"],
          additionalProperties: false,
        },
      },
    },
    required: ["features"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const PROGRESS_TOOL: HostToolDefinition = {
  name: "progress",
  label: "Harness — avancement",
  description: "Signale une étape franchie (une phrase). Visible en direct par l'humain ; n'attend aucune réponse.",
  parameters: {
    type: "object",
    properties: { message: { type: "string" } },
    required: ["message"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

function runTestsTool(step: StepKind): HostToolDefinition {
  const scopes = step === "review" ? ["touched", "full", "check"] : ["touched", "check"];
  return {
    name: "run_tests",
    label: "Harness — tests (heavy)",
    description:
      (step === "review"
        ? "Lance la suite COMPLÈTE (`scope: full`, UNE fois par revue — le service l'a déjà mise en route, l'appel la rejoint) ou les tests des fichiers touchés (`scope: touched`), dans un slot heavy isolé (4 Go, sans réseau). Un arbre déjà testé rend le résultat en cache. Tu attends le résultat."
        : "Lance les tests des fichiers touchés (`scope: touched`) dans un slot heavy isolé (4 Go, sans réseau). Un arbre déjà testé rend le résultat en cache. La suite complète est réservée à /review. Tu attends le résultat.") +
      " `scope: check` + `check: <nom>` lance une commande nommée du dépôt (lint, typecheck…).",
    parameters: {
      type: "object",
      properties: {
        scope: { type: "string", enum: scopes },
        check: {
          type: "string",
          description: "Le nom de la commande (`repos[].checks`), avec `scope: check` seulement.",
        },
      },
      required: ["scope"],
      additionalProperties: false,
    },
    loadMode: "essential",
  };
}

const VERDICT_TOOL: HostToolDefinition = {
  name: "review_verdict",
  label: "Harness — verdict de revue",
  description:
    "Rend le verdict STRUCTURÉ de la revue, une fois, à la fin. `criteria` est la table AC par AC : chaque AC-n de specs.md, le test nommé qui le prouve, son état. " +
    "`blockers` non vide ⇒ correction. Aucun bloquant + risque sous le plafond + suite complète verte + chaque AC `pass` + `confidence: strong` ⇒ auto-merge. " +
    "`unverified` liste ce que tu n'as pas pu vérifier (cite l'AC-n concerné s'il y en a un) ; `confidence: weak` si tu doutes de ta propre revue (l'humain lira alors le code).",
  parameters: {
    type: "object",
    properties: {
      risk: { type: "string", enum: ["low", "medium", "high"] },
      summary: { type: "string" },
      blockers: STRINGS,
      risks: STRINGS,
      files: { ...STRINGS, description: "Tous les fichiers du diff, tels que relus." },
      unverified: STRINGS,
      criteria: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "AC-n" },
            test: { type: "string", description: "Le nom du test qui le prouve (vide si untested)." },
            status: { type: "string", enum: ["pass", "fail", "untested"] },
          },
          required: ["id", "test", "status"],
          additionalProperties: false,
        },
      },
      confidence: { type: "string", enum: ["strong", "weak"] },
    },
    required: ["risk", "summary", "blockers", "risks", "files", "unverified", "criteria", "confidence"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const RECALL_TOOL: HostToolDefinition = {
  name: "oracle_recall",
  label: "Harness — oracle",
  description:
    "Cherche dans l'oracle du projet (briefs clients, comptes rendus de besoins, schémas d'archi, décisions tranchées par l'humain). " +
    "Une décision tranchée par l'humain s'impose : ne la rouvre pas.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const AUDIT_TOOL: HostToolDefinition = {
  name: "audit_propose",
  label: "Harness — propositions d'audit",
  description:
    "Rend les propositions de l'audit, une fois, à la fin (la liste peut être vide). Chaque proposition est une feature AUTONOME : " +
    "`request` est rédigée comme une demande /req, `modules` liste les chemins du dépôt qu'elle touchera, `kind` dit si elle corrige une faiblesse ou ajoute une feature, " +
    "`evidence` cite les `fichier:ligne` qui prouvent une faiblesse (OBLIGATOIRE non vide pour `kind: faiblesse`), `dependsOn` les titres des propositions à livrer avant, `impact` et `effort` ordonnent la liste.",
  parameters: {
    type: "object",
    properties: {
      proposals: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            request: { type: "string" },
            modules: STRINGS,
            kind: { type: "string", enum: ["faiblesse", "feature"] },
            rationale: { type: "string" },
            evidence: {
              ...STRINGS,
              description: "`fichier:ligne` qui prouvent la faiblesse ; vide seulement pour une feature.",
            },
            dependsOn: { ...STRINGS, description: "Les titres des propositions à livrer avant celle-ci." },
            impact: { type: "string", enum: ["low", "medium", "high"] },
            effort: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: ["title", "request", "modules", "kind", "rationale", "evidence", "dependsOn", "impact", "effort"],
          additionalProperties: false,
        },
      },
    },
    required: ["proposals"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const PILOT_TOOL: HostToolDefinition = {
  name: "pilot_act",
  label: "Harness — geste du pilote",
  description:
    "Rend TA décision sur le run qui attend, une fois : le service l'applique par le même geste que l'humain. " +
    "`approve` : valide les specs (→ /impl) ou le verdict (→ merge). `refuse` : renvoie les specs à /specs ou le code en correction — `reason` est alors la consigne, précise et vérifiable. " +
    "`retry` : relance l'étape en panne — `instructions` dit ce qu'elle doit faire autrement. `cancel` : abandonne la feature (la branche est gardée). " +
    "`defer` : laisse la décision à l'humain — `reason` est la question, avec ta recommandation. Seuls les gestes listés dans le prompt sont permis.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["approve", "refuse", "retry", "cancel", "defer"] },
      reason: {
        type: "string",
        description: "Pourquoi ce geste, en une ou deux phrases qui citent les faits (journalisé, lu par l'humain).",
      },
      instructions: {
        type: ["string", "null"],
        description: "Avec `retry` : la consigne pour l'étape relancée. Sinon null.",
      },
    },
    required: ["action", "reason", "instructions"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const DREAM_TOOL: HostToolDefinition = {
  name: "dream_consolidate",
  label: "Harness — consolidation de la mémoire",
  description:
    "Rend la consolidation du rêve, une fois, à la fin (les listes peuvent être vides). Le service mémoire la valide : " +
    "un refus revient en erreur avec sa raison, corrige et rappelle l'outil. `observations` : croyances fondées sur des faits " +
    "(`id` d'une observation existante pour l'affiner, absent pour en créer une ; `evidence` = ids de FAITS, jamais d'observations). " +
    "`obsolete` : ids d'observations que les faits ne soutiennent plus. `causes` : `source` explique `target`. " +
    "`models` : les mental models périmés, réécrits (`name` du dossier, `content` en Markdown, `sources` = ids qui l'étayent).",
  parameters: {
    type: "object",
    properties: {
      observations: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          properties: { id: { type: "string" }, text: { type: "string" }, evidence: STRINGS },
          required: ["text", "evidence"],
          additionalProperties: false,
        },
      },
      obsolete: STRINGS,
      causes: {
        type: "array",
        maxItems: 50,
        items: {
          type: "object",
          properties: { source: { type: "string" }, target: { type: "string" }, reason: { type: "string" } },
          required: ["source", "target", "reason"],
          additionalProperties: false,
        },
      },
      models: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, content: { type: "string" }, sources: STRINGS },
          required: ["name", "content", "sources"],
          additionalProperties: false,
        },
      },
    },
    required: ["observations", "obsolete", "causes", "models"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const CHALLENGE_TOOL: HostToolDefinition = {
  name: "challenge_report",
  label: "Harness — constats du contradicteur",
  description:
    "Rend les constats du contradicteur, une fois, à la fin (la liste peut être vide). Chaque constat vise un id de l'artefact (`B-n`, `AC-n`, `S-n`) ou rien, " +
    "dit son type et sa gravité (`bloquant` : le résultat ne serait pas ce que le demandeur voulait ; `majeur` : un trou que les tests ne verraient pas ; `mineur` : pour mémoire), " +
    "cite l'extrait qui le PROUVE (`evidence`, obligatoire) et propose une correction.",
  parameters: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        maxItems: MAX_FINDINGS,
        items: {
          type: "object",
          properties: {
            target: { type: "string", description: "B-n, AC-n ou S-n ; vide pour l'artefact entier." },
            kind: { type: "string", enum: [...FINDING_KINDS] },
            severity: { type: "string", enum: [...SEVERITIES] },
            claim: { type: "string" },
            evidence: {
              type: "string",
              description: "L'extrait de la demande, de l'artefact ou du dépôt (fichier:ligne).",
            },
            suggestion: { type: "string" },
          },
          required: ["target", "kind", "severity", "claim", "evidence", "suggestion"],
          additionalProperties: false,
        },
      },
    },
    required: ["findings"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

/** Les jobs du poste de travail menés par un runner (workstation-agent.ts) : le nom est l'en-tête de leur prompt. */
export type WorkstationJob = "poste-profil" | "poste-digest" | "poste-service";

const NULLABLE_STRING = { type: ["string", "null"] } as const;

const WORKSTATION_ACT_TOOL: HostToolDefinition = {
  name: "workstation_act",
  label: "Poste — action dans le navigateur",
  description:
    "Fait UNE petite action dans le navigateur de l'utilisateur, par l'extension du poste, dans TA fenêtre (les onglets ouverts par `open`). " +
    "`rationale` est OBLIGATOIRE : pourquoi cette action — elle est journalisée et relue par l'humain. Tu attends le résultat (30 s au plus). " +
    "Un geste qui enverrait un message à quelqu'un d'autre que l'utilisateur est retenu pour SON approbation : le résultat le dit, n'insiste pas et ne réessaie pas. " +
    "Paramètres par `kind` : tabs {} (un onglet par ligne « tabId · titre · url ») ; open { url } ; navigate { tabId, url } ; snapshot { tabId } (texte et éléments `ref`) ; " +
    "click { tabId, ref } ; type { tabId, ref, text, submit? } ; key { tabId, ref?, key } (Enter, Escape, Tab, flèches, Backspace) ; scroll { tabId, dy } ; " +
    "screenshot { tabId } (l'image n'est pas transmise ici : préfère snapshot) ; wait { ms ≤ 10000 } ; close { tabId }.",
  parameters: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["tabs", "open", "navigate", "snapshot", "click", "type", "key", "scroll", "screenshot", "wait", "close"],
      },
      params: { type: "object", description: "Les paramètres de `kind` (voir la description)." },
      rationale: { type: "string", description: "Pourquoi cette action, en une ou deux phrases autoportantes." },
    },
    required: ["kind", "params", "rationale"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const WORKSTATION_DECISION_TOOL: HostToolDefinition = {
  name: "workstation_decision",
  label: "Poste — décision journalisée",
  description:
    "Journalise une décision SANS geste dans le navigateur : ce que tu as choisi de faire ou de ne pas faire, et pourquoi (l'humain relit le journal). Rien n'est exécuté.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "La décision, en une phrase." },
      rationale: { type: "string", description: "Pourquoi." },
    },
    required: ["summary", "rationale"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const WORKSTATION_ACTIVITY_TOOL: HostToolDefinition = {
  name: "workstation_activity",
  label: "Poste — activité récente",
  description:
    "L'activité récente de l'utilisateur observée dans son navigateur (visites, interactions sans valeur saisie).",
  parameters: {
    type: "object",
    properties: {
      sinceMin: {
        type: "integer",
        minimum: 1,
        maximum: 10080,
        description: "Depuis combien de minutes (60 par défaut).",
      },
    },
    additionalProperties: false,
  },
  loadMode: "essential",
};

const WORKSTATION_MEETINGS_TOOL: HostToolDefinition = {
  name: "workstation_meetings",
  label: "Poste — meetings",
  description: "Les derniers meetings transcrits : résumé et besoins exprimés par les clients.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  loadMode: "essential",
};

const WORKSTATION_PROFILE_TOOL: HostToolDefinition = {
  name: "workstation_profile_write",
  label: "Poste — profil",
  description:
    "Écrit la NOUVELLE version complète du profil de l'utilisateur, une fois, à la fin (elle remplace la précédente, qui reste en historique). " +
    "N'écris que ce que l'observation, les meetings ou le profil précédent montrent ; `null` quand un champ d'un besoin est inconnu.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Le portrait de travail en quelques phrases." },
      habits: { ...STRINGS, description: "Les habitudes observées, une phrase chacune." },
      tools: {
        type: "array",
        items: {
          type: "object",
          properties: { name: { type: "string" }, usage: { type: "string" } },
          required: ["name", "usage"],
          additionalProperties: false,
        },
      },
      schedule: { type: "string", description: "Les horaires et le rythme de travail." },
      repetitiveTasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            frequency: { type: "string" },
            steps: STRINGS,
            automatable: { type: "boolean" },
          },
          required: ["title", "frequency", "steps", "automatable"],
          additionalProperties: false,
        },
      },
      clientNeeds: {
        type: "array",
        items: {
          type: "object",
          properties: {
            need: { type: "string" },
            who: NULLABLE_STRING,
            meetingId: NULLABLE_STRING,
            at: { type: ["integer", "null"] },
          },
          required: ["need", "who", "meetingId", "at"],
          additionalProperties: false,
        },
      },
      preferences: STRINGS,
    },
    required: ["summary", "habits", "tools", "schedule", "repetitiveTasks", "clientNeeds", "preferences"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const WORKSTATION_DIGEST_TOOL: HostToolDefinition = {
  name: "workstation_meeting_digest",
  label: "Poste — digest de meeting",
  description:
    "Rend le digest du meeting, une fois, à la fin : le résumé et les besoins exprimés (qui, échéance si dite, la citation qui le prouve).",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" },
      needs: {
        type: "array",
        items: {
          type: "object",
          properties: {
            need: { type: "string" },
            who: NULLABLE_STRING,
            due: NULLABLE_STRING,
            quote: { type: "string", description: "L'extrait du transcript, mot pour mot." },
          },
          required: ["need", "who", "due", "quote"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "needs"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

/**
 * Les outils hôtes d'une étape (ou de l'audit, du contradicteur et du rêve, qui ne
 * décident ni ne testent rien, ou d'un job du poste de travail) : `save_checkpoint` et
 * `set_modules` partout, `split_feature` en specs et impl, `run_tests` dès /impl,
 * `review_verdict` en revue seulement.
 */
export function hostToolsFor(
  step: StepKind | "audit" | "pilot" | "challenge" | "dream" | WorkstationJob,
): HostToolDefinition[] {
  if (step === "audit") return [PROGRESS_TOOL, RECALL_TOOL, AUDIT_TOOL];
  if (step === "pilot") return [PROGRESS_TOOL, RECALL_TOOL, PILOT_TOOL];
  if (step === "dream") return [PROGRESS_TOOL, RECALL_TOOL, DREAM_TOOL];
  if (step === "challenge") return [PROGRESS_TOOL, RECALL_TOOL, CHALLENGE_TOOL];
  if (step === "poste-profil") return [PROGRESS_TOOL, WORKSTATION_PROFILE_TOOL];
  if (step === "poste-digest") return [PROGRESS_TOOL, WORKSTATION_DIGEST_TOOL];
  if (step === "poste-service")
    return [
      PROGRESS_TOOL,
      WORKSTATION_ACT_TOOL,
      WORKSTATION_DECISION_TOOL,
      WORKSTATION_ACTIVITY_TOOL,
      WORKSTATION_MEETINGS_TOOL,
    ];
  const tools = [DECISION_TOOL, PROGRESS_TOOL, RECALL_TOOL, CHECKPOINT_TOOL, SET_MODULES_TOOL];
  if (step === "specs" || step === "impl") tools.push(SPLIT_TOOL);
  if (step === "impl" || step === "fix" || step === "review") tools.push(runTestsTool(step));
  if (step === "review") tools.push(VERDICT_TOOL);
  return tools;
}
