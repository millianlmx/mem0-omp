// L'environnement d'exécution d'un dépôt, déclaré PAR LE DÉPÔT (`.harness-env.json` à sa
// racine) : ses cibles (Linux, macOS…), ce que chacune exige d'un exécuteur, son image,
// ses commandes de tests, les chemins qui la concernent et ses configurations.
//
// Le fichier est lu sur le commit de BASE du run, jamais dans le worktree : un agent ne
// change pas les commandes qui le jugent. Un changement du fichier vaut après son merge.
import { createHash } from "node:crypto";
import type { Git } from "../forge/git.ts";
import { matchesGlob, shellQuote } from "../heavy/heavy.ts";

export const ENV_FILE = ".harness-env.json";

/** Un nom de cible, de configuration ou de commande : il entre dans des noms d'unité et d'image. */
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export type EnvTarget = {
  name: string;
  /** Les étiquettes qu'un exécuteur doit porter (`os` toujours : `linux` | `macos`). */
  requires: Record<string, string>;
  /** Linux : l'image des jobs, ou le Dockerfile (chemin du dépôt) qui la construit. Absents : l'image de tests du dépôt. */
  image: string | null;
  dockerfile: string | null;
  /** La recette de la VM Tart des jobs (macOS ou Linux arm64) : sans elle, l'image fixe de l'exécuteur. */
  vm: VmRecipe | null;
  /** Les commandes lancées avant chaque job sur l'exécuteur (`brew bundle`, `xcodegen generate`). */
  setup: string[];
  /** `{files}` reçoit les fichiers de test touchés, `{configuration}` la configuration du passage. */
  tests: { touched: string; full: string; pattern: string | null };
  /** Les chemins qui concernent la cible (globs) ; vide : tous. Un diff qui n'en touche aucun ne la lance pas. */
  paths: string[];
  /** Les configurations jouées chacune (`Debug`, `Release`) ; vide : un passage sans `{configuration}`. */
  configurations: string[];
  /** Les rapports JUnit produits (globs relatifs au dépôt) : la preuve des tests réellement exécutés. */
  reports: string[];
  /** Les commandes nommées que l'agent lance sur la cible par `run_on` (générateurs) ; leurs modifications reviennent au worktree. */
  commands: Record<string, string>;
  /** `false` : la suite complète de la cible n'est pas exigée pour l'auto-merge (informative). */
  required: boolean;
};

/**
 * Une image de VM construite par le harness : la VM `base` (une image OCI, `ghcr.io/cirruslabs/…`), puis chaque
 * étape de `provision` (`brew install xcodegen`). Construite une fois, gardée sous un nom qui porte l'empreinte
 * de la recette : la changer en construit une nouvelle, et l'ancienne est retirée.
 */
export type VmRecipe = { base: string; provision: string[]; hash: string };

export type EnvSpec = { targets: EnvTarget[]; hash: string };

export class EnvSpecError extends Error {}

function fail(message: string): never {
  throw new EnvSpecError(`${ENV_FILE} : ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim() !== ""))
    fail(`${where} : liste de chaînes non vides`);
  return value as string[];
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${where} : chaîne non vide`);
  return value;
}

function stringMap(value: unknown, where: string, keys: RegExp): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail(`${where} : objet de chaînes`);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!keys.test(key)) fail(`${where}.${key} : nom invalide`);
    out[key] = text(item, `${where}.${key}`);
  }
  return out;
}

/** Un chemin du dépôt : relatif, sans `..`. */
function repoPath(value: unknown, where: string): string {
  const file = text(value, where);
  if (file.startsWith("/") || file.split("/").includes("..")) fail(`${where} : chemin relatif au dépôt, sans ..`);
  return file;
}

function vmOf(raw: unknown, where: string): VmRecipe {
  if (!isRecord(raw)) fail(`${where} : { base, provision? }`);
  const base = text(raw.base, `${where}.base`);
  // L'image de base part telle quelle sur la ligne de commande de `tart clone`.
  if (!/^[\w./:@-]+$/.test(base)) fail(`${where}.base : une image Tart (ghcr.io/cirruslabs/macos-tahoe-xcode:26)`);
  const provision = strings(raw.provision, `${where}.provision`);
  const hash = createHash("sha256")
    .update(JSON.stringify([base, provision]))
    .digest("hex")
    .slice(0, 12);
  return { base, provision, hash };
}

function targetOf(name: string, raw: unknown): EnvTarget {
  const where = `targets.${name}`;
  if (!NAME.test(name)) fail(`${where} : nom invalide (minuscules, chiffres, . _ -)`);
  if (!isRecord(raw)) fail(`${where} : objet`);
  const os = raw.os ?? "linux";
  if (os !== "linux" && os !== "macos") fail(`${where}.os : linux | macos`);
  const requires = { ...stringMap(raw.labels, `${where}.labels`, /^[a-z][a-z0-9_-]*$/), os };
  if (!isRecord(raw.tests)) fail(`${where}.tests : { touched, full, pattern? }`);
  const pattern = raw.tests.pattern;
  if (pattern !== undefined && pattern !== null && typeof pattern !== "string") fail(`${where}.tests.pattern : glob`);
  const image = raw.image === undefined ? null : text(raw.image, `${where}.image`);
  const dockerfile = raw.dockerfile === undefined ? null : repoPath(raw.dockerfile, `${where}.dockerfile`);
  if (image !== null && dockerfile !== null) fail(`${where} : image OU dockerfile, pas les deux`);
  if (os === "macos" && (image !== null || dockerfile !== null))
    fail(`${where} : une cible macos tourne dans une VM (\`vm\`) ou sur son exécuteur (ni image ni dockerfile)`);
  const vm = raw.vm === undefined ? null : vmOf(raw.vm, `${where}.vm`);
  if (vm !== null && (image !== null || dockerfile !== null)) fail(`${where} : vm OU image/dockerfile, pas les deux`);
  const configurations = strings(raw.configurations, `${where}.configurations`);
  for (const configuration of configurations)
    if (!NAME.test(configuration.toLowerCase())) fail(`${where}.configurations : « ${configuration} » invalide`);
  if (raw.required !== undefined && typeof raw.required !== "boolean") fail(`${where}.required : booléen`);
  return {
    name,
    requires,
    image,
    dockerfile,
    vm,
    setup: strings(raw.setup, `${where}.setup`),
    tests: {
      touched: text(raw.tests.touched, `${where}.tests.touched`),
      full: text(raw.tests.full, `${where}.tests.full`),
      pattern: typeof pattern === "string" ? pattern : null,
    },
    paths: strings(raw.paths, `${where}.paths`),
    configurations,
    // Un glob de rapport entre tel quel dans le script bash de l'exécuteur distant : chemin et jokers seulement.
    reports: strings(raw.reports, `${where}.reports`).map((file, i) => {
      const glob = repoPath(file, `${where}.reports[${i}]`);
      if (!/^[\w./*?-]+$/.test(glob)) fail(`${where}.reports[${i}] : lettres, chiffres, . _ - / * ? seulement`);
      return glob;
    }),
    commands: stringMap(raw.commands, `${where}.commands`, NAME),
    required: raw.required !== false,
  };
}

/** Le fichier lu et validé ; lève `EnvSpecError` en nommant le champ fautif. */
export function parseEnvSpec(source: string): EnvSpec {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (err) {
    fail(`JSON illisible (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isRecord(raw) || !isRecord(raw.targets)) fail("la racine porte `targets` : { <nom>: { os, tests, … } }");
  const targets = Object.entries(raw.targets).map(([name, target]) => targetOf(name, target));
  if (targets.length === 0) fail("`targets` est vide");
  return { targets, hash: createHash("sha256").update(source).digest("hex") };
}

/** La spec du dépôt au commit `ref`, ou `null` s'il n'en déclare pas ; lève si le fichier est invalide. */
export async function loadEnvSpec(git: Git, cwd: string, ref: string): Promise<EnvSpec | null> {
  const shown = await git.raw(cwd, ["show", `${ref}:${ENV_FILE}`]);
  if (shown.code !== 0) return null;
  return parseEnvSpec(shown.stdout);
}

/** Un passage de la matrice : une cible, une configuration (ou aucune), sa commande. */
export type Leg = { target: EnvTarget; configuration: string | null; command: string };

function expand(template: string, files: string[] | null, configuration: string | null): string {
  let command = template;
  if (files !== null) {
    const quoted = files.map(shellQuote).join(" ");
    command = command.includes("{files}") ? command.split("{files}").join(quoted) : `${command} ${quoted}`;
  }
  return configuration === null ? command : command.split("{configuration}").join(shellQuote(configuration));
}

/** La cible est-elle concernée par ces fichiers touchés ? Sans `paths` : toujours. */
export function concerns(target: EnvTarget, files: string[]): boolean {
  return target.paths.length === 0 || files.some((file) => target.paths.some((glob) => matchesGlob(glob, file)));
}

/**
 * Les passages d'une scope : `full` lance chaque cible (requise ou non) ; `touched` seulement les cibles que le
 * diff concerne ET qui ont un fichier de test touché (selon leur `pattern`). Une configuration par passage.
 */
export function legsOf(spec: EnvSpec, scope: "touched" | "full", files: string[]): Leg[] {
  const legs: Leg[] = [];
  for (const target of spec.targets) {
    let tests: string[] | null = null;
    if (scope === "touched") {
      if (!concerns(target, files)) continue;
      const pattern = target.tests.pattern;
      tests = pattern === null ? files : files.filter((file) => matchesGlob(pattern, file));
      if (tests.length === 0) continue;
    }
    const template = scope === "full" ? target.tests.full : target.tests.touched;
    for (const configuration of target.configurations.length > 0 ? target.configurations : [null])
      legs.push({ target, configuration, command: expand(template, tests, configuration) });
  }
  return legs;
}

/** Le nom lisible d'un passage : `ios/Release`, `linux`. */
export function legName(leg: Pick<Leg, "target" | "configuration">): string {
  return leg.configuration === null ? leg.target.name : `${leg.target.name}/${leg.configuration}`;
}
