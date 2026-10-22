// Le lancement d'un runner OMP : un process enfant par étape, plafonné à 1 Go, profil
// pipeline (LSP, DAP et noyau Python éteints), en mode RPC — et les outils hôtes
// que le service lui prête selon l'étape.
//
// Le runner part dans une SCOPE systemd (il garde ses tuyaux stdio avec le service) :
// MemoryMax=1G dans la tranche des runners. Une scope ne porte pas `OOMScoreAdjust=`
// (propriété d'exécution) : `choom -n 300` le pose sur le process lui-même — relever
// son propre score n'exige aucun privilège.
//
// En isolation `container`, c'est un conteneur frère (`run -i`, stdio gardés), aux
// mêmes plafonds, qui ne monte que son worktree, le clone en lecture, son HOME et
// ses clés.
import * as fs from "node:fs";
import * as path from "node:path";
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

/** Arrête de force l'unité d'un runner ou d'un job : la scope systemd, ou le conteneur. */
export async function forceStop(
  config: HarnessConfig,
  exec: Exec,
  unit: string,
  isolation = config.runner.isolation,
): Promise<void> {
  if (isolation === "systemd") {
    const stop = launch(config, ["--stop", `${unit}.scope`]);
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
  /** Le clone du dépôt (le gitdir du worktree y vit) : monté en lecture, requis en isolation `container`. */
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
    ...config.runner.extensions.flatMap((extension) => ["-e", extension]),
  ];
  if (config.runner.isolation === "none") return { command: omp[0] as string, args: omp.slice(1) };
  if (config.runner.isolation === "container") return containerRunnerArgv(config, spec, omp);
  return launch(config, [
    "--scope",
    "--quiet",
    "--collect",
    `--unit=${spec.unit}`,
    `--slice=${config.runner.slice}`,
    "-p",
    `MemoryMax=${config.runner.memoryMax}`,
    // sudo remet l'environnement à zéro : la scope mémoire passe par la ligne (liste fermée côté lanceur).
    ...Object.entries(runnerMemoryEnv(spec.scope, config.memory.runnerMode)).map(
      ([key, value]) => `--setenv=${key}=${value}`,
    ),
    "--",
    "choom",
    "-n",
    String(config.runner.oomScoreAdjust),
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
      question: { type: "string", description: "La question, autoportante." },
      options: { ...STRINGS, minItems: 2, maxItems: 4, description: "Les options envisagées (2 à 4), mot pour mot." },
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
    required: ["question", "options", "chosen", "rationale", "category"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

const CHECKPOINT_TOOL: HostToolDefinition = {
  name: "checkpoint",
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

/**
 * Les outils hôtes d'une étape (ou de l'audit, qui ne décide ni ne teste rien) :
 * `checkpoint` et `set_modules` partout, `split_feature` en specs et impl, `run_tests`
 * dès /impl, `review_verdict` en revue seulement.
 */
export function hostToolsFor(step: StepKind | "audit"): HostToolDefinition[] {
  if (step === "audit") return [PROGRESS_TOOL, RECALL_TOOL, AUDIT_TOOL];
  const tools = [DECISION_TOOL, PROGRESS_TOOL, RECALL_TOOL, CHECKPOINT_TOOL, SET_MODULES_TOOL];
  if (step === "specs" || step === "impl") tools.push(SPLIT_TOOL);
  if (step === "impl" || step === "fix" || step === "review") tools.push(runTestsTool(step));
  if (step === "review") tools.push(VERDICT_TOOL);
  return tools;
}
