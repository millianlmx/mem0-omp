// Modèle d'une feature : ses deux groupes de phase, leur forme canonique, les
// choix d'une porte, leur lecture.
//
// Module PUR : aucun import de l'hôte (`## Documentation` §4), aucune I/O — les
// modèles connus sont des objets structurels `{ provider, id }`, jamais le type
// `Model` de l'hôte. Le sélecteur qu'on en tire est EXACTEMENT la valeur passée à
// `--model` : c'est la seule forme stockée dans le lot, et elle n'est jamais
// réécrite (S-1).
import type { PipelinePhase } from "./contract.ts";
import { realpathOr } from "./git.ts";
import type { Lot, LotFeature } from "./lot.ts";



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
 * Le libellé de l'option « aucun modèle ». Mot pour mot la même chaîne dans toutes
 * les portes (S-2) : c'est lui que la traduction relit pour retrouver l'absence.
 */
export const DEFAULT_MODEL_LABEL = "défaut OMP (aucun modèle)";

/**
 * Le choix « défaut OMP » : une ABSENCE de modèle, jamais une valeur stockée. Une
 * feature née ainsi ne porte aucune clé de modèle, et ses runs partent sans lui (S-1).
 */
export const DEFAULT_MODEL_CHOICE: ModelChoice = { value: "", label: DEFAULT_MODEL_LABEL };

/** Ce que dit l'option par défaut dans un dialogue de l'hôte (S-2). */
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
 * Le filtre de l'étape du panneau (S-4) : le libellé CONTIENT `query`, sans tenir
 * compte de la casse. L'entrée « défaut OMP » n'est jamais filtrée — elle reste la
 * première ligne, quoi qu'on tape. `query` vide rend donc tous les choix.
 */
export function filterModelChoices(choices: readonly ModelChoice[], query: string): ModelChoice[] {
  const needle = query.toLowerCase();
  return choices.filter((choice) => choice.value === "" || choice.label.toLowerCase().includes(needle));
}



// --- les deux groupes de phase (S-1) -----------------------------------------

/**
 * Les deux groupes de modèle d'une feature (S-1) : `req`+`specs` d'un côté,
 * `impl`+`review`+`release` de l'autre. Les valeurs SONT les noms des champs du
 * lot — c'est cette coïncidence qui fait de `modelGroupOf` la seule table de
 * résolution des phases.
 */
export type ModelGroupKey = "modelReqSpecs" | "modelImplReview";

/** Le libellé d'un groupe, mot pour mot, partout où il s'affiche (S-1). */
export const MODEL_GROUP_LABELS: Record<ModelGroupKey, string> = {
  modelReqSpecs: "req+specs",
  modelImplReview: "impl+review",
};

/**
 * Le libellé d'un groupe VIDE à l'affichage — distinct de `DEFAULT_MODEL_LABEL`,
 * qui est le libellé d'une OPTION de choix : le rang du panneau et la console
 * disent `défaut OMP` là où les listes de choix disent `défaut OMP (aucun modèle)`.
 */
export const DEFAULT_MODEL_SHORT_LABEL = "défaut OMP";

/**
 * Le groupe de phase d'un maillon : `req` et `specs` d'un côté, `impl`, `review`
 * et `release` de l'autre. C'est la SEULE granularité de modèle (S-1) : un maillon
 * ne porte jamais son propre modèle.
 */
export function modelGroupOf(phase: PipelinePhase): ModelGroupKey {
  return phase === "req" || phase === "specs" ? "modelReqSpecs" : "modelImplReview";
}

/** Le porteur minimal des trois clés de modèle : la feature du lot, ou toute forme qui les porte. */
export type ModelSlotsCarrier = Pick<LotFeature, "model" | "modelReqSpecs" | "modelImplReview">;

/** Les deux modèles RÉSOLUS d'une feature, un par groupe de phase (S-1). */
export type ModelSlots = { reqSpecs: string | null; implReview: string | null };

/**
 * Le modèle d'un groupe de phase (S-1) : la clé du groupe si elle est renseignée,
 * sinon l'ANCIEN modèle unique (`model`, conservé en lecture seule), sinon `null` —
 * « défaut OMP », donc aucun `--model` sur les runs de ce groupe (AC-6).
 */
export function featureModelForPhase(feature: ModelSlotsCarrier, phase: PipelinePhase): string | null {
  const keyed = feature[modelGroupOf(phase)];
  if (typeof keyed === "string" && keyed.trim() !== "") return keyed;
  return typeof feature.model === "string" && feature.model.trim() !== "" ? feature.model : null;
}

/**
 * Les deux modèles RÉSOLUS d'une feature (S-1), ou `null` quand aucune des trois
 * clés n'est renseignée — ce `null` distingue « feature née défaut OMP » (aucun
 * segment d'affichage) de « deux groupes au défaut ». L'ancien `model` remplit les
 * DEUX groupes tant qu'il existe (AC-4).
 */
export function featureModelSlots(feature: ModelSlotsCarrier): ModelSlots | null {
  const reqSpecs = featureModelForPhase(feature, "req");
  const implReview = featureModelForPhase(feature, "impl");
  if (reqSpecs === null && implReview === null) return null;
  return { reqSpecs, implReview };
}

/**
 * Les deux champs de modèle à ÉCRIRE dans le lot (S-2, S-3) : une clé n'existe que
 * pour une valeur exploitable (non vide après `trim()`), la valeur étant conservée
 * telle quelle. Une entrée blanche EFFACE donc la clé — c'est ce qui rend le défaut
 * OMP représentable à l'écriture.
 */
export function modelSlotsField(input: {
  modelReqSpecs?: string | null;
  modelImplReview?: string | null;
}): { modelReqSpecs?: string; modelImplReview?: string } {
  const out: { modelReqSpecs?: string; modelImplReview?: string } = {};
  if (typeof input.modelReqSpecs === "string" && input.modelReqSpecs.trim() !== "") {
    out.modelReqSpecs = input.modelReqSpecs;
  }
  if (typeof input.modelImplReview === "string" && input.modelImplReview.trim() !== "") {
    out.modelImplReview = input.modelImplReview;
  }
  return out;
}


/**
 * Le modèle de la feature du lot dont le `worktree` est le même répertoire que
 * `cwd`, pour la phase `phase`, ou `null`. Deux précautions : `""` n'est JAMAIS
 * apparié (un worktree pas encore créé, ou un cwd inconnu, ne doit pas absorber une
 * feature), et le `realpathOr("")` de repli ne doit pas se lire comme le cwd du
 * process. Une feature hors du lot, ou sans modèle pour ce groupe, rend `null` : la
 * cible d'un run de conversation reste alors celle d'avant cette feature, sans clé
 * `model`.
 */
export function featureModelOf(lot: Lot | null, cwd: string, phase: PipelinePhase): string | null {
  if (!lot || cwd === "") return null;
  const target = realpathOr(cwd);
  for (const feature of lot.features) {
    if (feature.worktree === "" || realpathOr(feature.worktree) !== target) continue;
    return featureModelForPhase(feature, phase);
  }
  return null;
}


// --- les portes à dialogue (S-2) ---------------------------------------------

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


/**
 * Le titre du dialogue d'un groupe de modèle — le même dans toutes les portes, à
 * ceci près que le groupe et le slug le nomment (S-2).
 */
export function modelQuestionTitle(slug: string, group: ModelGroupKey): string {
  return `Modèle ${MODEL_GROUP_LABELS[group]} — ${slug}`;
}


/**
 * La traduction du libellé rendu par un dialogue : `null` = l'utilisateur a annulé
 * (Échap), `{ model: null }` = défaut OMP, sinon la valeur du choix telle quelle.
 * La porte range ensuite la valeur dans la clé de SON groupe.
 */
export function modelDialogChoice(label: string | undefined): { model: string | null } | null {
  if (label === undefined) return null;
  return { model: label === DEFAULT_MODEL_LABEL ? null : label };
}


/**
 * Les choix de l'ÉTAPE du panneau (S-4) : `[]` quand aucun modèle n'est connu —
 * l'étape n'existe alors pas, et le flux d'ajout reste celui d'aujourd'hui.
 */
export function modelPanelChoices(models: readonly ModelRow[]): ModelChoice[] {
  return models.length === 0 ? [] : modelChoices(models);
}
