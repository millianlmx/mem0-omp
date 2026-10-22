// `main.ts --models <omlx/<modèle>|anthropic>` : les agents sur un modèle local ou chez
// Anthropic. Appelé par `harness.sh up --omlx <modèle>` (et `--anthropic`), qui pose
// aussi le fournisseur `omlx` dans le `models.yml` des runners.
//
// En local, une seule machine porte le modèle, les runners et la VM du moteur : les
// trois tiers prennent le même modèle (fast et standard vides prennent heavy) et les
// slots descendent pour tenir dans la mémoire laissée par le modèle.
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
export function localModelsYaml(baseUrl: string, model: string, contextWindow = 131_072): string {
  return [
    "# Écrit par harness.sh up --omlx : le serveur oMLX natif de l'hôte.",
    "providers:",
    `  ${LOCAL_PROVIDER}:`,
    `    baseUrl: ${baseUrl}`,
    "    api: openai-completions",
    "    # Le nom d'une variable de runner.env (posée si oMLX exige une clé), sinon ignoré.",
    "    apiKey: OMLX_API_TOKEN",
    "    models:",
    `      - id: ${JSON.stringify(model)}`,
    `        name: ${JSON.stringify(model)}`,
    `        contextWindow: ${contextWindow}`,
    "        maxTokens: 32768",
    "",
  ].join("\n");
}

/** Le `models.yml` que lit omp dans un runner : son HOME monté, sous son profil. */
export function runnerModelsFile(config: HarnessConfig): string | null {
  const home = config.container.runnerHome;
  return home ? path.join(home, ".omp", "profiles", config.runner.profile, "agent", "models.yml") : null;
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
    fs.writeFileSync(modelsFile, localModelsYaml(local.baseUrl, model, local.contextWindow));
    raw.models = { fast: [], standard: [], heavy: [{ provider: LOCAL_PROVIDER, model }] };
    const slot = (value: unknown, cap: number) => Math.min(typeof value === "number" ? value : cap, cap);
    raw.runner = { ...raw.runner, slots: slot(raw.runner?.slots, LOCAL_SLOTS.runner) };
    raw.heavy = { ...raw.heavy, slots: slot(raw.heavy?.slots, LOCAL_SLOTS.heavy) };
    summary = `toutes les étapes sur ${LOCAL_PROVIDER}/${model}, ${raw.runner.slots} runners et ${raw.heavy.slots} job de tests à la fois`;
  }
  fs.writeFileSync(configFile, `${JSON.stringify(raw, null, 2)}\n`);
  return summary;
}
