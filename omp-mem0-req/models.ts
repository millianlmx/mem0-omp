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


// --- le repli de chaque groupe (S-1) -----------------------------------------

/** Le porteur minimal des deux clés de repli : la feature du lot, ou toute forme qui les porte. */
export type FallbackSlotsCarrier = Pick<LotFeature, "fallbackReqSpecs" | "fallbackImplReview">;

/**
 * Le repli du groupe de la phase (S-1) : la clé du groupe si elle est renseignée,
 * sinon `null` — « aucun repli ». Contrairement au modèle, il n'y a AUCUN ancien
 * champ unique à relire : une feature d'avant le repli n'en a pas.
 */
export function featureFallbackForPhase(feature: FallbackSlotsCarrier, phase: PipelinePhase): string | null {
  const key = modelGroupOf(phase) === "modelReqSpecs" ? "fallbackReqSpecs" : "fallbackImplReview";
  const value = feature[key];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * Les champs de repli à ÉCRIRE dans le lot (S-1) : une clé n'existe que pour une
 * valeur exploitable (non vide après `trim()`), jamais `""` ni `null`.
 */
export function fallbackSlotsField(input: {
  fallbackReqSpecs?: string | null;
  fallbackImplReview?: string | null;
}): { fallbackReqSpecs?: string; fallbackImplReview?: string } {
  const out: { fallbackReqSpecs?: string; fallbackImplReview?: string } = {};
  if (typeof input.fallbackReqSpecs === "string" && input.fallbackReqSpecs.trim() !== "") {
    out.fallbackReqSpecs = input.fallbackReqSpecs;
  }
  if (typeof input.fallbackImplReview === "string" && input.fallbackImplReview.trim() !== "") {
    out.fallbackImplReview = input.fallbackImplReview;
  }
  return out;
}

/**
 * Le refus d'un repli égal au principal d'un même groupe (S-1), ou `null`. Un
 * principal `null` (« défaut OMP ») n'est jamais égal à un repli.
 */
export function fallbackEqualsPrimaryRefusal(
  primary: string | null | undefined,
  fallback: string | null | undefined,
  group: ModelGroupKey,
): string | null {
  if (typeof primary !== "string" || primary.trim() === "") return null;
  if (typeof fallback !== "string" || fallback.trim() === "") return null;
  return primary === fallback ? `repli identique au modèle principal (${MODEL_GROUP_LABELS[group]})` : null;
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


/** Le libellé de l'option « aucun repli » — mot pour mot dans toutes les portes (S-1). */
export const NO_FALLBACK_LABEL = "aucun repli";

/** Ce que dit l'option « aucun repli » dans un dialogue de l'hôte (S-1). */
export const NO_FALLBACK_DESCRIPTION = "si le modèle principal est épuisé, la feature passe en « bloquée : quota »";


/** Le titre du dialogue de repli d'un groupe — le même dans toutes les portes (S-1). */
export function fallbackQuestionTitle(slug: string, group: ModelGroupKey): string {
  return `Repli ${MODEL_GROUP_LABELS[group]} — ${slug}`;
}


/**
 * Les options du dialogue de repli (S-1) : « aucun repli » d'abord, puis chaque
 * sélecteur du catalogue SAUF le principal choisi juste avant. « défaut OMP » n'est
 * jamais une option de repli. Catalogue vide : `[]` — aucun dialogue.
 */
export function fallbackDialogOptions(
  models: readonly ModelRow[],
  principal: string | null,
): ModelSelectItem[] {
  if (models.length === 0) return [];
  return [
    { label: NO_FALLBACK_LABEL, description: NO_FALLBACK_DESCRIPTION },
    ...models.map(modelSelector).filter(selector => selector !== principal).map(label => ({ label })),
  ];
}


/**
 * La traduction du libellé d'un dialogue de repli (S-1) : `null` = annulation
 * (Échap), `{ fallback: null }` = aucun repli, sinon le sélecteur tel quel.
 */
export function fallbackDialogChoice(label: string | undefined): { fallback: string | null } | null {
  if (label === undefined) return null;
  return { fallback: label === NO_FALLBACK_LABEL ? null : label };
}


/** La porte `ctx.ui.select` de l'hôte, réduite à ce que les dialogues de modèle utilisent. */
export type ModelSelectFn = (
  title: string,
  options: ModelSelectItem[],
  opts?: { signal?: AbortSignal },
) => Promise<string | undefined>;


/**
 * Les QUATRE dialogues de création d'une feature (S-1), dans l'ordre : principal
 * req+specs → repli req+specs → principal impl+review → repli impl+review. Rend
 * `null` à la première annulation (Échap) — chaque porte la traite comme
 * l'annulation du dialogue de modèle principal. Catalogue vide : aucune question,
 * `{ models: {null, null}, fallbacks: {null, null} }` (le flux d'avant).
 */
export async function askFeatureModels(
  select: ModelSelectFn,
  models: readonly ModelRow[],
  slug: string,
  signal: AbortSignal | undefined,
): Promise<{ models: ModelSlots; fallbacks: ModelSlots } | null> {
  const picked: ModelSlots = { reqSpecs: null, implReview: null };
  const fallbacks: ModelSlots = { reqSpecs: null, implReview: null };
  if (models.length === 0) return { models: picked, fallbacks };
  const modelOptions = modelDialogOptions(models);
  const groups: { group: ModelGroupKey; slot: keyof ModelSlots }[] = [
    { group: "modelReqSpecs", slot: "reqSpecs" },
    { group: "modelImplReview", slot: "implReview" },
  ];
  for (const { group, slot } of groups) {
    const principal = modelDialogChoice(await select(modelQuestionTitle(slug, group), modelOptions, { signal }));
    if (principal === null) return null;
    picked[slot] = principal.model;
    const fallback = fallbackDialogChoice(
      await select(fallbackQuestionTitle(slug, group), fallbackDialogOptions(models, principal.model), { signal }),
    );
    if (fallback === null) return null;
    fallbacks[slot] = fallback.fallback;
  }
  return { models: picked, fallbacks };
}


// --- les quatre étapes de liste du panneau (S-1) -----------------------------

/**
 * Les étapes de choix d'un ajout ou d'une édition, DANS L'ORDRE du flux : principal
 * puis repli de req+specs, principal puis repli de impl+review. Les valeurs SONT les
 * noms des champs du brouillon.
 */
export const MODEL_STEPS = ["modelReqSpecs", "fallbackReqSpecs", "modelImplReview", "fallbackImplReview"] as const;
export type ModelStep = (typeof MODEL_STEPS)[number];

/** Le brouillon des quatre choix : `null` = défaut OMP (principal) ou aucun repli. */
export type ModelStepDraft = Record<ModelStep, string | null>;

export function isFallbackStep(step: ModelStep): step is "fallbackReqSpecs" | "fallbackImplReview" {
  return step === "fallbackReqSpecs" || step === "fallbackImplReview";
}

/** Le groupe d'une étape : `fallbackReqSpecs` et `modelReqSpecs` sont du groupe `modelReqSpecs`. */
export function groupOfStep(step: ModelStep): ModelGroupKey {
  return step === "modelReqSpecs" || step === "fallbackReqSpecs" ? "modelReqSpecs" : "modelImplReview";
}

/** Le choix « aucun repli » d'une liste du panneau : valeur vide, jamais filtré. */
export const NO_FALLBACK_CHOICE: ModelChoice = { value: "", label: NO_FALLBACK_LABEL };

/**
 * La liste d'une étape de repli (S-1) : « aucun repli » en tête, puis le catalogue
 * SANS « défaut OMP » et sans le principal choisi juste avant.
 */
export function fallbackChoices(catalogue: readonly ModelChoice[], principal: string | null): ModelChoice[] {
  return [NO_FALLBACK_CHOICE, ...catalogue.filter(choice => choice.value !== "" && choice.value !== principal)];
}

/** La liste AFFICHABLE d'une étape : le catalogue tel quel (principal), ou la liste de repli du brouillon. */
export function stepChoices(
  step: ModelStep,
  catalogue: readonly ModelChoice[] | undefined,
  draft: Pick<ModelStepDraft, "modelReqSpecs" | "modelImplReview">,
): ModelChoice[] {
  const all = catalogue ?? [];
  if (!isFallbackStep(step)) return [...all];
  return fallbackChoices(all, draft[groupOfStep(step)]);
}
