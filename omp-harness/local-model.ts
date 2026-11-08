// `main.ts --models <omlx/<modèle>|anthropic>` : les agents sur un modèle local ou chez
// Anthropic. Appelé par `harness.sh up --omlx <modèle>` (et `--anthropic`), qui pose
// aussi le fournisseur `omlx` dans le `models.yml` des runners.
//
// En local, une seule machine porte le modèle, les runners et la VM du moteur : les
// trois tiers prennent le même modèle (fast et standard vides prennent heavy) et les
// slots descendent pour tenir dans la mémoire laissée par le modèle.
//
// `main.ts --local-model omlx/<modèle>` (`harness.sh local <modèle>`) déclare le même
// fournisseur aux runners SANS toucher aux chaînes du serveur : les dépôts
// `"privacy": "local-only"` (policy.ts) y prennent leurs modèles, les autres restent où ils sont.
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessConfig, ModelChoice, Tier } from "./config.ts";

/** Le fournisseur des runners pour un serveur oMLX natif (déclaré dans leur `models.yml`). */
export const LOCAL_PROVIDER = "omlx";

/** Les chaînes du modèle de configuration conteneur : ce que `--models anthropic` rétablit. */
export const ANTHROPIC_MODELS: Record<Tier, ModelChoice[]> = {
  fast: [],
  standard: [{ provider: "anthropic", model: "claude-sonnet-5-5" }],
  heavy: [{ provider: "anthropic", model: "claude-opus-5-5" }],
};

/** Les slots en local : deux runners de 1 Go et un job de tests de 4 Go à la fois. */
export const LOCAL_SLOTS = { runner: 2, heavy: 1 };

/** Le `models.yml` des runners : oMLX, compatible OpenAI, joint depuis leur conteneur. */
export function localModelsYaml(baseUrl: string, models: readonly string[], contextWindow = 131_072): string {
  return [
    "# Écrit par harness.sh up --omlx : le serveur oMLX natif de l'hôte.",
    "providers:",
    `  ${LOCAL_PROVIDER}:`,
    `    baseUrl: ${baseUrl}`,
    "    api: openai-completions",
    "    # Le nom d'une variable de runner.env (posée si oMLX exige une clé), sinon ignoré.",
    "    apiKey: OMLX_API_TOKEN",
    "    models:",
    ...models.flatMap((model) => [
      `      - id: ${JSON.stringify(model)}`,
      `        name: ${JSON.stringify(model)}`,
      `        contextWindow: ${contextWindow}`,
      "        maxTokens: 32768",
    ]),
    "",
  ].join("\n");
}

/** Le `models.yml` que lit omp dans un runner : son HOME monté, sous son profil. */
export function runnerModelsFile(config: HarnessConfig): string | null {
  const home = config.container.runnerHome;
  return home ? path.join(home, ".omp", "profiles", config.runner.profile, "agent", "models.yml") : null;
}

/**
 * Le `models.yml` que le service écrit pour les runners : dans leur HOME monté en
 * isolation `container`, sinon `providersModelsFile` (le lanceur root le pose chez eux).
 */
export function servedModelsFile(config: HarnessConfig): string | null {
  return config.runner.isolation === "container" ? runnerModelsFile(config) : config.providersModelsFile;
}

/** Le bloc `omlx` d'un `models.yml` (écrit par `--models omlx` ou `--local-model`), ou `""`. */
export function localBlock(existing: string): string {
  const lines = existing.split("\n");
  const start = lines.indexOf(`  ${LOCAL_PROVIDER}:`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^ {3,}/.test(lines[end] as string))) end++;
  return lines.slice(start, end).join("\n");
}

export type LocalProvider = { baseUrl: string; models: string[] };

/** Le fournisseur local que voient les runners : son adresse et ses modèles, ou `null`. */
export function localProvider(config: HarnessConfig): LocalProvider | null {
  const file = servedModelsFile(config);
  let text: string;
  try {
    text = file === null ? "" : fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const block = localBlock(text);
  const baseUrl = /^ {4}baseUrl: *"?([^"\s]+)"?$/m.exec(block)?.[1];
  if (!baseUrl) return null;
  const models = [...block.matchAll(/^ {6}- id: *(.+)$/gm)].map((match) => {
    const raw = (match[1] as string).trim();
    return raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  });
  return { baseUrl, models };
}

/**
 * `--local-model omlx/<modèle>` : le fournisseur local déclaré aux runners (son bloc du
 * `models.yml` réécrit, le modèle ajouté à ceux déjà servis), sans toucher aux chaînes
 * ni aux slots du serveur. Le reste du fichier (fournisseurs de l'API) est gardé.
 */
export function addLocalModel(config: HarnessConfig, spec: string, local: LocalServer): string {
  const match = new RegExp(`^${LOCAL_PROVIDER}/(.+)$`).exec(spec);
  if (!match) throw new Error(`--local-model : « ${spec} » n'est pas ${LOCAL_PROVIDER}/<modèle>`);
  const model = match[1] as string;
  const file = servedModelsFile(config);
  if (file === null) throw new Error("--local-model exige container.runnerHome (le HOME des runners)");
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    existing = "";
  }
  const models = [...new Set([...(localProvider(config)?.models ?? []), model])];
  const block = localModelsYaml(local.baseUrl, models, local.contextWindow).split("\n").slice(2).join("\n");
  const old = localBlock(existing);
  let next: string;
  if (existing.trim() === "") next = localModelsYaml(local.baseUrl, models, local.contextWindow);
  else if (old !== "") next = existing.replace(old, () => block.replace(/\n+$/, ""));
  else {
    const base = existing.replace(/^providers: *\{\}$/m, "providers:").replace(/\n*$/, "\n");
    next = `${/^providers:$/m.test(base) ? base : `${base}providers:\n`}${block}`;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, { mode: 0o600 });
  return `${LOCAL_PROVIDER} déclaré aux runners (${models.join(", ")}) — les chaînes du serveur sont inchangées`;
}

export type LocalServer = { baseUrl: string; contextWindow?: number };

/**
 * Réécrit les modèles (et, en local, les slots) d'un fichier de configuration, le reste
 * intact ; en local, pose aussi le `models.yml` des runners.
 */
export function setModels(configFile: string, config: HarnessConfig, spec: string, local?: LocalServer): string {
  const raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as Record<string, unknown> & {
    runner?: Record<string, unknown>;
    heavy?: Record<string, unknown>;
  };
  let summary: string;
  if (spec === "anthropic") {
    raw.models = ANTHROPIC_MODELS;
    summary = "modèles Anthropic (standard : sonnet, heavy : opus)";
  } else {
    const match = new RegExp(`^${LOCAL_PROVIDER}/(.+)$`).exec(spec);
    if (!match) throw new Error(`--models : « ${spec} » n'est ni anthropic ni ${LOCAL_PROVIDER}/<modèle>`);
    const model = match[1] as string;
    const modelsFile = runnerModelsFile(config);
    if (!local || !modelsFile) throw new Error(`--models ${spec} exige --omlx-url et container.runnerHome`);
    fs.mkdirSync(path.dirname(modelsFile), { recursive: true });
    fs.writeFileSync(modelsFile, localModelsYaml(local.baseUrl, [model], local.contextWindow));
    raw.models = { fast: [], standard: [], heavy: [{ provider: LOCAL_PROVIDER, model }] };
    const slot = (value: unknown, cap: number) => Math.min(typeof value === "number" ? value : cap, cap);
    raw.runner = { ...raw.runner, slots: slot(raw.runner?.slots, LOCAL_SLOTS.runner) };
    raw.heavy = { ...raw.heavy, slots: slot(raw.heavy?.slots, LOCAL_SLOTS.heavy) };
    summary = `toutes les étapes sur ${LOCAL_PROVIDER}/${model}, ${raw.runner.slots} runners et ${raw.heavy.slots} job de tests à la fois`;
  }
  fs.writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`);
  return summary;
}
