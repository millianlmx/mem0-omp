// Modèle d'une feature : sa forme canonique, les choix d'une porte, sa lecture.
//
// Module PUR : aucun import de l'hôte (`## Documentation` §4), aucune I/O — les
// modèles connus sont des objets structurels `{ provider, id }`, jamais le type
// `Model` de l'hôte. Le sélecteur qu'on en tire est EXACTEMENT la valeur passée à
// `--model` : c'est la seule forme stockée dans le lot, et elle n'est jamais
// réécrite (S-1).
import { realpathOr } from "./git.ts";
import type { Lot } from "./lot.ts";



// --- la valeur et ses choix (S-1) --------------------------------------------

/**
 * Un choix de modèle : sa VALEUR — celle passée à `--model`, `""` pour « défaut
 * OMP » — et son LIBELLÉ d'option. Les deux coïncident aujourd'hui ; ils sont
 * distincts pour que la traduction libellé → valeur vive à UN seul endroit.
 */
export type ModelChoice = { value: string; label: string };

/** Un modèle connu, réduit aux deux champs qui font son sélecteur. */
export type ModelRow = { provider: string; id: string };

/**
 * Le libellé de l'option « aucun modèle ». Mot pour mot la même chaîne dans les
 * trois portes (S-1) : c'est lui que la traduction relit pour retrouver l'absence.
 */
export const DEFAULT_MODEL_LABEL = "défaut OMP (aucun modèle)";

/**
 * Le choix « défaut OMP » : une ABSENCE de modèle, jamais une valeur stockée. Une
 * feature née ainsi ne porte aucun `model`, et tous ses runs partent sans lui (S-6).
 */
export const DEFAULT_MODEL_CHOICE: ModelChoice = { value: "", label: DEFAULT_MODEL_LABEL };

/** Ce que dit l'option par défaut dans un dialogue de l'hôte (S-2, S-4). */
export const DEFAULT_MODEL_DESCRIPTION = "aucun --model sur les runs de cette feature";


/** Le sélecteur canonique d'un modèle — exactement la valeur passée à `--model`. */
export function modelSelector(model: ModelRow): string {
  return `${model.provider}/${model.id}`;
}


/**
 * Les choix d'une liste de modèles connus : « défaut OMP » en TÊTE, puis les
 * modèles triés par sélecteur croissant. La comparaison est celle des chaînes
 * (`<`), jamais `localeCompare` : l'ordre doit être le même partout, y compris
 * d'une machine à l'autre.
 */
export function modelChoices(models: readonly ModelRow[]): ModelChoice[] {
  const listed = models.map((model) => {
    const value = modelSelector(model);
    return { value, label: value };
  });
  listed.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  return [DEFAULT_MODEL_CHOICE, ...listed];
}


/**
 * Le filtre de l'étape du panneau (S-3) : le libellé CONTIENT `query`, sans tenir
 * compte de la casse. L'entrée « défaut OMP » n'est jamais filtrée — elle reste la
 * première ligne, quoi qu'on tape. `query` vide rend donc tous les choix.
 */
export function filterModelChoices(choices: readonly ModelChoice[], query: string): ModelChoice[] {
  const needle = query.toLowerCase();
  return choices.filter((choice) => choice.value === "" || choice.label.toLowerCase().includes(needle));
}


/**
 * Le `model` de la feature du lot dont le `worktree` est le même répertoire que
 * `cwd`, ou `null`. Deux précautions : `""` n'est JAMAIS apparié (un worktree pas
 * encore créé, ou un cwd inconnu, ne doit pas absorber une feature), et le
 * `realpathOr("")` de repli ne doit pas se lire comme le cwd du process.
 */
export function featureModelOf(lot: Lot | null, cwd: string): string | null {
  if (!lot || cwd === "") return null;
  const target = realpathOr(cwd);
  for (const feature of lot.features) {
    if (feature.worktree === "" || realpathOr(feature.worktree) !== target) continue;
    return typeof feature.model === "string" && feature.model !== "" ? feature.model : null;
  }
  return null;
}


// --- les portes à dialogue (S-2, S-4) ----------------------------------------

/** Une option de dialogue de l'hôte : le sélecteur en libellé, la description du défaut. */
export type ModelSelectItem = { label: string; description?: string };


/**
 * Les options du dialogue de l'hôte, ou `[]` quand aucun modèle n'est connu — auquel
 * cas la porte ne pose AUCUNE question (le flux d'aujourd'hui, à l'octet près).
 */
export function modelDialogOptions(models: readonly ModelRow[]): ModelSelectItem[] {
  if (models.length === 0) return [];
  return modelChoices(models).map(({ value, label }) => ({
    label,
    description: value === "" ? DEFAULT_MODEL_DESCRIPTION : undefined,
  }));
}


/** Le titre du dialogue de modèle — le même dans les deux portes (S-2, S-4). */
export function modelQuestionTitle(slug: string): string {
  return `Modèle de la pipeline — ${slug}`;
}


/**
 * La traduction du libellé rendu par un dialogue : `null` = l'utilisateur a annulé
 * (Échap), `{ model: null }` = défaut OMP, sinon la valeur du choix telle quelle.
 */
export function modelDialogChoice(label: string | undefined): { model: string | null } | null {
  if (label === undefined) return null;
  return { model: label === DEFAULT_MODEL_LABEL ? null : label };
}


/**
 * Les choix de l'ÉTAPE du panneau (S-3) : `[]` quand aucun modèle n'est connu —
 * l'étape n'existe alors pas, et le flux d'ajout reste celui d'aujourd'hui.
 */
export function modelPanelChoices(models: readonly ModelRow[]): ModelChoice[] {
  return models.length === 0 ? [] : modelChoices(models);
}


/**
 * Le champ `model` à écrire dans le lot : la clé n'existe QUE pour une valeur
 * exploitable (non vide après `trim()`). Toute autre entrée (`null`, `""`, `"  "`)
 * rend un objet vide — la feature naît sans modèle plutôt que d'en porter un faux.
 */
export function modelField(model: string | null | undefined): { model?: string } {
  return typeof model === "string" && model.trim() !== "" ? { model } : {};
}
