// Les fournisseurs LLM déclarés par l'API — depuis les apps Mac et iOS — et les chaînes
// de modèles de chaque tier.
//
// Trois sortes de fournisseurs :
// - les fournisseurs CONNUS d'omp (Anthropic, OpenAI, OpenRouter, Google, Mistral, xAI) :
//   leur nom est celui d'omp, leur clé passe par la variable qu'omp lit déjà ;
// - les fournisseurs COMPATIBLES OPENAI (Ollama, vLLM, oMLX, LiteLLM…) : un nom libre,
//   une adresse, des modèles, et une clé `<NOM>_API_KEY` ; ils sont déclarés aux runners
//   dans leur `models.yml` (omp résout `apiKey` par le nom de la variable) ;
// - les fournisseurs OAUTH (abonnements : `openai-codex`, `google-gemini-cli`…) : le nom
//   du fournisseur OAuth d'omp, ni adresse ni clé — omp lit les identifiants que la
//   connexion (oauth.ts) a posés chez les runners. Déclarés pour figurer dans les chaînes.
//
// Les clés n'entrent jamais en base ni dans une réponse de l'API : elles vivent dans
// `providersEnvFile` (0600, au service), que la session d'un runner lit (isolation
// `none`), que le conteneur d'un runner monte (`container`), ou que le lanceur root lit
// pour le runner (`systemd`, seulement des variables `*_API_KEY`). Le `models.yml` est
// écrit dans `providersModelsFile` ; le lanceur ou le HOME monté des runners le pose.
// Une clé de runner.env (déclarée par root) reste valable ; une clé déclarée ici passe
// après elle et l'emporte.
import * as fs from "node:fs";
import * as path from "node:path";
import type { HarnessConfig, ModelChoice, ProviderLimit, Tier } from "./config.ts";
import { TIERS } from "./config.ts";
import type { ProviderModel, ProviderRow, Store } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { LOCAL_PROVIDER, runnerModelsFile } from "./local-model.ts";
import type { Scheduler } from "./scheduler.ts";

/** Les fournisseurs connus d'omp et la variable de leur clé. */
export const KNOWN_PROVIDERS: Readonly<Record<string, string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  google: "GEMINI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  xai: "XAI_API_KEY",
};

/** La sorte d'un fournisseur compatible OpenAI ; les autres portent le nom de leur sorte. */
export const COMPATIBLE = "openai-compatible";

/** La sorte d'un fournisseur connecté par OAuth (oauth.ts), sans clé ni adresse. */
export const OAUTH = "oauth";

/** Les protocoles qu'un fournisseur compatible peut parler (le `api` de models.yml). */
export const COMPATIBLE_APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;

/** Une clé d'API : un jeton opaque, sans espace ni caractère de shell (elle traverse env, conteneur et lanceur). */
const KEY_PATTERN = /^[A-Za-z0-9._~+/=:-]{8,512}$/;
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9._:/@-]{1,128}$/;

/** L'en-tête du `models.yml` écrit ici (le lanceur et `--models omlx` le reconnaissent). */
const MODELS_HEADER = "# Écrit par omp-harness (fournisseurs déclarés par l'API) — ne pas éditer à la main.";

/** Ce que l'API rend d'un fournisseur : jamais sa clé. */
export type ProviderView = {
  name: string;
  kind: string;
  /** `api` : déclaré par l'API (modifiable) ; `config` : par la configuration du serveur (lecture seule). */
  source: "api" | "config";
  baseUrl: string | null;
  api: string | null;
  models: ProviderModel[];
  capacity: number | null;
  refillPerMinute: number | null;
  /** La variable que lisent les runners. */
  keyVariable: string;
  /** Une clé est déclarée par l'API ; `keyHint` : ses 4 derniers caractères. */
  hasKey: boolean;
  keyHint: string | null;
  updatedBy: string | null;
};

export type ProviderInput = {
  kind: string;
  baseUrl?: string | null;
  api?: string | null;
  models?: ProviderModel[];
  /** Une clé neuve ; `""` : retirer la clé ; absent : garder celle déclarée. */
  apiKey?: string;
  capacity?: number | null;
  refillPerMinute?: number | null;
};

export type ModelChains = Record<Tier, ModelChoice[]>;

/** La variable de la clé d'un fournisseur : celle d'omp, sinon `<NOM>_API_KEY`. */
export function keyVariable(name: string): string {
  return KNOWN_PROVIDERS[name] ?? `${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/** Le `models.yml` des fournisseurs compatibles (YAML écrit à la main : valeurs simples, citées en JSON). */
export function providersModelsYaml(providers: ProviderRow[], preserved = ""): string {
  const lines = [MODELS_HEADER, "providers:"];
  for (const provider of providers.filter((entry) => entry.kind === COMPATIBLE)) {
    lines.push(
      `  ${provider.name}:`,
      `    baseUrl: ${JSON.stringify(provider.baseUrl ?? "")}`,
      `    api: ${provider.api ?? "openai-completions"}`,
      // Le NOM de la variable : omp la résout dans l'environnement du runner.
      `    apiKey: ${keyVariable(provider.name)}`,
      "    models:",
      ...provider.models.flatMap((model) => [
        `      - id: ${JSON.stringify(model.id)}`,
        `        name: ${JSON.stringify(model.id)}`,
        ...(model.contextWindow ? [`        contextWindow: ${model.contextWindow}`] : []),
        ...(model.maxTokens ? [`        maxTokens: ${model.maxTokens}`] : []),
      ]),
    );
  }
  if (preserved !== "") lines.push(preserved.replace(/\n+$/, ""));
  if (lines.length === 2) lines[1] = "providers: {}";
  return `${lines.join("\n")}\n`;
}

/** Le bloc `omlx` qu'a écrit `--models omlx` (harness.sh up --omlx), gardé tel quel. */
export function localBlock(existing: string): string {
  const lines = existing.split("\n");
  const start = lines.indexOf(`  ${LOCAL_PROVIDER}:`);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^ {3,}/.test(lines[end] as string))) end++;
  return lines.slice(start, end).join("\n");
}

export class ProviderRegistry {
  readonly #config: HarnessConfig;
  readonly #store: Store;
  readonly #scheduler: Scheduler;
  readonly #log: (line: string) => void;
  /** Les chaînes et limites de la configuration, avant toute surcharge par l'API. */
  readonly #baseModels: ModelChains;
  readonly #baseLimits: Record<string, ProviderLimit>;

  constructor(deps: { config: HarnessConfig; store: Store; scheduler: Scheduler; log: (line: string) => void }) {
    this.#config = deps.config;
    this.#store = deps.store;
    this.#scheduler = deps.scheduler;
    this.#log = deps.log;
    this.#baseModels = structuredClone(deps.config.models);
    this.#baseLimits = structuredClone(deps.config.providers);
  }

  /** Applique la base à la configuration vivante (démarrage) : chaînes, limites, fichiers des runners. */
  apply(): void {
    const chains = this.#store.getSetting<ModelChains>("models");
    for (const tier of TIERS) this.#config.models[tier] = chains?.[tier] ?? this.#baseModels[tier];
    const limits: Record<string, ProviderLimit> = { ...this.#baseLimits };
    for (const row of this.#store.listProviders()) {
      if (row.capacity !== null && row.refillPerMinute !== null) {
        limits[row.name] = { capacity: row.capacity, refillPerMinute: row.refillPerMinute };
      }
    }
    for (const name of new Set([...Object.keys(this.#config.providers), ...Object.keys(limits)])) {
      this.#scheduler.setProviderLimit(name, limits[name] ?? null);
    }
    this.#config.providers = limits;
    this.#writeModels();
  }

  /** Les fournisseurs : ceux de l'API, puis ceux que la configuration ou les chaînes nomment. */
  list(): ProviderView[] {
    const keys = this.#readKeys();
    const rows = this.#store.listProviders();
    const views: ProviderView[] = rows.map((row) => ({
      name: row.name,
      kind: row.kind,
      source: "api",
      baseUrl: row.baseUrl,
      api: row.api,
      models: row.models,
      capacity: row.capacity,
      refillPerMinute: row.refillPerMinute,
      keyVariable: keyVariable(row.name),
      hasKey: keys.has(keyVariable(row.name)),
      keyHint: keys.has(keyVariable(row.name)) ? row.keyHint : null,
      updatedBy: row.updatedBy,
    }));
    const named = new Set(rows.map((row) => row.name));
    const fromConfig = new Set([
      ...Object.keys(this.#baseLimits),
      ...TIERS.flatMap((tier) => this.#baseModels[tier].map((choice) => choice.provider)),
    ]);
    for (const name of [...fromConfig].sort()) {
      if (named.has(name)) continue;
      const limit = this.#baseLimits[name];
      views.push({
        name,
        kind: KNOWN_PROVIDERS[name] ? name : COMPATIBLE,
        source: "config",
        baseUrl: null,
        api: null,
        models: [],
        capacity: limit?.capacity ?? null,
        refillPerMinute: limit?.refillPerMinute ?? null,
        keyVariable: keyVariable(name),
        hasKey: false,
        keyHint: null,
        updatedBy: null,
      });
    }
    return views;
  }

  /** Les chaînes de modèles en vigueur, et si elles viennent de l'API. */
  chains(): { models: ModelChains; source: "api" | "config" } {
    const stored = this.#store.getSetting<ModelChains>("models");
    return { models: structuredClone(this.#config.models), source: stored ? "api" : "config" };
  }

  /** Déclare ou modifie un fournisseur ; la clé (si donnée) part dans providers.env, jamais en base. */
  put(name: string, input: ProviderInput, by: string | null): ProviderView {
    if (!NAME_PATTERN.test(name))
      throw new HarnessError(400, "name : minuscules, chiffres et tirets (32 au plus), une lettre d'abord");
    const known = KNOWN_PROVIDERS[name] !== undefined;
    if (known && input.kind !== name)
      throw new HarnessError(400, `kind : « ${name} » est un fournisseur connu d'omp, sa sorte est « ${name} »`);
    if (!known && input.kind !== COMPATIBLE && input.kind !== OAUTH) {
      throw new HarnessError(
        400,
        `kind : ${Object.keys(KNOWN_PROVIDERS).join(", ")} (nom identique), ${COMPATIBLE} ou ${OAUTH}`,
      );
    }
    if (input.kind === OAUTH && input.apiKey !== undefined && input.apiKey.trim() !== "")
      throw new HarnessError(400, "apiKey : un fournisseur oauth n'a pas de clé, il se connecte depuis les apps");
    if (name === LOCAL_PROVIDER)
      throw new HarnessError(409, `« ${LOCAL_PROVIDER} » est réservé à harness.sh up --omlx`);
    const previous = this.#store.getProvider(name);
    let baseUrl: string | null = null;
    let api: string | null = null;
    let models: ProviderModel[] = [];
    if (input.kind === COMPATIBLE) {
      baseUrl = (input.baseUrl ?? previous?.baseUrl ?? "").trim();
      if (!/^https?:\/\/[^\s"]+$/.test(baseUrl))
        throw new HarnessError(400, "baseUrl : l'adresse http(s) du service compatible OpenAI (…/v1)");
      api = input.api ?? previous?.api ?? "openai-completions";
      if (!(COMPATIBLE_APIS as readonly string[]).includes(api))
        throw new HarnessError(400, `api : ${COMPATIBLE_APIS.join(" | ")}`);
      models = input.models ?? previous?.models ?? [];
      if (models.length === 0) throw new HarnessError(400, "models : au moins un modèle ({ id })");
      for (const model of models) {
        if (typeof model?.id !== "string" || !MODEL_PATTERN.test(model.id))
          throw new HarnessError(400, `models : identifiant de modèle illisible (${String(model?.id)})`);
        for (const field of ["contextWindow", "maxTokens"] as const) {
          const value = model[field];
          if (value !== undefined && !(Number.isInteger(value) && value > 0))
            throw new HarnessError(400, `models[].${field} : entier positif`);
        }
      }
      models = models.map((model) => ({
        id: model.id,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
      }));
    }
    const capacity = input.capacity === undefined ? (previous?.capacity ?? null) : input.capacity;
    const refill = input.refillPerMinute === undefined ? (previous?.refillPerMinute ?? null) : input.refillPerMinute;
    if ((capacity === null) !== (refill === null))
      throw new HarnessError(400, "capacity et refillPerMinute vont ensemble (ou aucun des deux)");
    if (
      capacity !== null &&
      !(Number.isInteger(capacity) && capacity >= 1 && Number.isInteger(refill) && (refill as number) >= 1)
    ) {
      throw new HarnessError(400, "capacity et refillPerMinute : entiers ≥ 1");
    }
    let keyHint = previous?.keyHint ?? null;
    if (input.apiKey !== undefined) {
      const key = input.apiKey.trim();
      if (key !== "" && !KEY_PATTERN.test(key))
        throw new HarnessError(400, "apiKey : un jeton de 8 à 512 caractères, sans espace");
      this.#writeKey(keyVariable(name), key === "" ? null : key);
      keyHint = key === "" ? null : key.slice(-4);
    }
    this.#store.putProvider({
      name,
      kind: input.kind,
      baseUrl,
      api,
      models,
      capacity,
      refillPerMinute: refill,
      keyHint,
      updatedBy: by,
    });
    this.apply();
    this.#changed({ provider: name, change: "put", by });
    this.#log(`fournisseur ${name} déclaré${by ? ` par ${by}` : ""}`);
    return this.list().find((view) => view.name === name) as ProviderView;
  }

  /**
   * Après une connexion OAuth réussie : un fournisseur qu'aucune chaîne ne pourrait encore
   * nommer (ni connu d'omp, ni déclaré) est déclaré en `oauth`. Rien d'autre ne change.
   */
  adoptOAuth(name: string, by: string | null): void {
    if (KNOWN_PROVIDERS[name] !== undefined || !NAME_PATTERN.test(name) || name === LOCAL_PROVIDER) return;
    if (this.list().some((view) => view.name === name)) return;
    this.put(name, { kind: OAUTH }, by);
  }

  /** Retire un fournisseur déclaré par l'API (refusé tant qu'une chaîne le nomme). */
  remove(name: string, by: string | null): void {
    if (!this.#store.getProvider(name))
      throw new HarnessError(404, `fournisseur inconnu (ou déclaré par la configuration) : ${name}`);
    const users = TIERS.filter((tier) => this.#config.models[tier].some((choice) => choice.provider === name));
    if (users.length > 0)
      throw new HarnessError(
        409,
        `fournisseur utilisé par les chaînes ${users.join(", ")} : retire-le d'abord des modèles`,
      );
    this.#store.deleteProvider(name);
    this.#writeKey(keyVariable(name), null);
    this.apply();
    this.#changed({ provider: name, change: "remove", by });
    this.#log(`fournisseur ${name} retiré${by ? ` par ${by}` : ""}`);
  }

  /** Remplace les chaînes de modèles ; `null` revient à celles de la configuration. */
  setChains(chains: ModelChains | null, by: string | null): ModelChains {
    if (chains !== null) {
      const known = new Set([...this.list().map((view) => view.name), LOCAL_PROVIDER]);
      for (const tier of TIERS) {
        const chain = chains[tier];
        if (!Array.isArray(chain))
          throw new HarnessError(400, `models.${tier} : liste de { provider, model } attendue`);
        for (const choice of chain) {
          if (
            typeof choice?.provider !== "string" ||
            typeof choice.model !== "string" ||
            !MODEL_PATTERN.test(choice.model)
          ) {
            throw new HarnessError(400, `models.${tier} : { provider, model } attendus`);
          }
          if (!known.has(choice.provider))
            throw new HarnessError(
              400,
              `models.${tier} : fournisseur inconnu « ${choice.provider} » (déclare-le d'abord)`,
            );
        }
      }
      if (TIERS.every((tier) => chains[tier].length === 0))
        throw new HarnessError(400, "models : au moins un tier doit nommer un modèle");
      this.#store.setSetting("models", { fast: chains.fast, standard: chains.standard, heavy: chains.heavy }, by);
    } else {
      this.#store.setSetting("models", null, by);
    }
    this.apply();
    this.#changed({ change: chains === null ? "models_reset" : "models", by });
    return structuredClone(this.#config.models);
  }

  /** Les clés déclarées, pour un runner lancé sans lanceur (isolation `none`). */
  runnerEnv(): Record<string, string> {
    return Object.fromEntries(this.#readKeys());
  }

  /** Les apps admin relisent les fournisseurs (jamais de clé dans l'événement). */
  #changed(payload: Record<string, unknown>): void {
    this.#store.appendEvent("providers_changed", null, payload);
  }

  // -- fichiers -------------------------------------------------------------

  #readKeys(): Map<string, string> {
    const keys = new Map<string, string>();
    let text = "";
    try {
      text = fs.readFileSync(this.#config.providersEnvFile, "utf8");
    } catch {
      return keys;
    }
    for (const line of text.split("\n")) {
      const match = /^([A-Z][A-Z0-9_]*_API_KEY)=(.+)$/.exec(line);
      if (match) keys.set(match[1] as string, match[2] as string);
    }
    return keys;
  }

  #writeKey(variable: string, value: string | null): void {
    const keys = this.#readKeys();
    if (value === null) keys.delete(variable);
    else keys.set(variable, value);
    const body = [...keys].map(([name, key]) => `${name}=${key}`).join("\n");
    atomicWrite(this.#config.providersEnvFile, body === "" ? "" : `${body}\n`, 0o600);
  }

  /**
   * Le `models.yml` des fournisseurs compatibles : écrit dès qu'un fournisseur compatible
   * existe (ou a existé : un fichier déjà écrit est vidé, jamais laissé périmé). En
   * conteneur, il va droit dans le HOME monté des runners, le bloc `omlx` d'un `up --omlx`
   * gardé ; sinon dans `providersModelsFile`, que le lanceur root pose chez les runners.
   */
  #writeModels(): void {
    const compatible = this.#store.listProviders().filter((row) => row.kind === COMPATIBLE);
    const target =
      this.#config.runner.isolation === "container" ? runnerModelsFile(this.#config) : this.#config.providersModelsFile;
    if (target === null) return;
    let existing: string | null = null;
    try {
      existing = fs.readFileSync(target, "utf8");
    } catch {
      existing = null;
    }
    const ours = existing?.startsWith(MODELS_HEADER) === true;
    if (compatible.length === 0 && !ours) return;
    // Un fichier écrit à la main (sans notre en-tête) n'est remplacé qu'au premier fournisseur compatible.
    const preserved = existing === null ? "" : localBlock(existing);
    atomicWrite(target, providersModelsYaml(compatible, preserved), 0o600);
  }
}

function atomicWrite(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content, { mode });
  fs.renameSync(temp, file);
}
