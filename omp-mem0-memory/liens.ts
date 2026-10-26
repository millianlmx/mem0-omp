// Mémoire liée : rendu des liens typés d'un souvenir, marque des observations, bloc des
// mental models et rendu du journal de rêve. Fonctions PURES, exportées pour être
// exécutables sans OMP ni serveur (convention `buildIndex`).
//
// Le serveur (mem0-rs, schéma v4) relie les souvenirs — `cause`, `remplace`,
// `contredit`, `precise`, `voir` posés par un agent ou par le rêve, `preuve` d'une
// observation vers ses faits — et consolide les faits en observations et en mental
// models. Un serveur sans ces routes (mem0-http, mem0-rs v3) ne rend rien de tout ça :
// chaque lecture ici tolère l'absence.

/** `s` rogné à `n` caractères, ellipse comprise (comme `clip` du rappel, sans dépendre de recall.ts). */
function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Les types de lien qu'un agent pose avec `mem0_link`. */
export const LINK_TYPES = ["cause", "remplace", "contredit", "precise", "voir"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** Libellé d'un lien vu depuis un souvenir : `out` = ce souvenir est la source. */
const LIBELLES: Record<string, { out: string; in: string }> = {
  cause: { out: "est la cause de", in: "a pour cause" },
  remplace: { out: "remplace", in: "remplacé par" },
  contredit: { out: "contredit", in: "contredit par" },
  precise: { out: "précise", in: "précisé par" },
  voir: { out: "voir aussi", in: "cité par" },
  preuve: { out: "fondée sur", in: "preuve de l'observation" },
};

/** Liens rendus au plus par souvenir dans le rappel et la recherche. */
export const LINKS_PER_MEMORY = 3;
/** Longueur d'aperçu du souvenir à l'autre bout d'un lien. */
export const LINK_HEAD_CHARS = 90;
/** Bloc des mental models injecté en prompt système : au plus ces caractères, et chaque modèle rogné. */
export const MODELS_BLOCK_CHARS = 6_000;
export const MODEL_ITEM_CHARS = 2_000;

export type SeenLink = { id: string; type: string; direction: "out" | "in"; reason?: string | null };

/** Les liens d'une ligne de recherche (`links`, avec `links: true`), validés ; `[]` sinon. */
export function linksOf(row: unknown): SeenLink[] {
  if (typeof row !== "object" || row === null || !("links" in row) || !Array.isArray(row.links)) return [];
  return row.links.flatMap((l: unknown) => {
    if (typeof l !== "object" || l === null) return [];
    const { id, type, direction, reason } = l as Record<string, unknown>;
    if (typeof id !== "string" || typeof type !== "string" || (direction !== "out" && direction !== "in")) return [];
    return [{ id, type, direction, reason: typeof reason === "string" ? reason : null }];
  });
}

/** Une ligne est-elle une observation (souvenir consolidé par le rêve) ? Rend son nombre de preuves. */
export function observationProofs(row: unknown): number | null {
  if (typeof row !== "object" || row === null || !("metadata" in row)) return null;
  const metadata = row.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const m = metadata as Record<string, unknown>;
  if (m.memory_type !== "observation") return null;
  return typeof m.preuves === "number" ? m.preuves : 0;
}

/** Préfixe d'une observation dans une liste : `[observation · N preuves] `. */
export function observationMark(row: unknown): string {
  const n = observationProofs(row);
  return n === null ? "" : `[observation · ${n} preuve${n > 1 ? "s" : ""}] `;
}

/**
 * Les lignes `↳ …` des liens d'un souvenir, `indent` devant chacune, au plus
 * `LINKS_PER_MEMORY` (les liens d'agent et de rêve d'abord, `preuve` ensuite).
 * `textOf` rend le texte d'un souvenir connu localement (cache, autres résultats) ;
 * un id inconnu est rendu seul.
 */
export function renderLinks(row: unknown, textOf: (id: string) => string | null, indent = "  "): string[] {
  const links = linksOf(row).sort((a, b) => Number(a.type === "preuve") - Number(b.type === "preuve"));
  return links.slice(0, LINKS_PER_MEMORY).map((l) => {
    const libelle = LIBELLES[l.type]?.[l.direction] ?? l.type;
    const text = textOf(l.id);
    const head = text ? ` ${clip(text.split("\n")[0]!.trim(), LINK_HEAD_CHARS)}` : "";
    const why = l.reason ? ` (${clip(l.reason, 80)})` : "";
    return `${indent}↳ ${libelle} [${l.id}]${head}${why}`;
  });
}

/**
 * Le texte d'un souvenir par son id, cherché dans les lignes reçues puis dans le cache
 * local du projet (chargé une fois par session) ; `null` si inconnu.
 */
export function textResolver(
  rows: readonly unknown[],
  cache: readonly { id: string; text: string }[] = [],
): (id: string) => string | null {
  const known = new Map<string, string>();
  for (const e of cache) known.set(e.id, e.text);
  for (const r of rows) {
    if (typeof r !== "object" || r === null || !("id" in r) || !("memory" in r)) continue;
    if (typeof r.memory === "string") known.set(String(r.id), r.memory);
  }
  return (id) => known.get(id) ?? null;
}

export type MentalModel = { name: string; question: string; content: string; stale: boolean; updated_at: string | null };

/** Les mental models d'une réponse `GET /memory/models`, validés ; `[]` sinon. */
export function modelsOf(body: unknown): MentalModel[] {
  const list = typeof body === "object" && body !== null && "models" in body ? body.models : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m: unknown) => {
    if (typeof m !== "object" || m === null) return [];
    const r = m as Record<string, unknown>;
    if (typeof r.name !== "string" || typeof r.content !== "string" || typeof r.question !== "string") return [];
    return [
      {
        name: r.name,
        question: r.question,
        content: r.content,
        stale: r.stale === true,
        updated_at: typeof r.updated_at === "string" ? r.updated_at : null,
      },
    ];
  });
}

/**
 * Le bloc des mental models du projet, posé en prompt système avant le sommaire :
 * la connaissance consolidée par le rêve, lue d'un coup au lieu d'être redécouverte.
 * Seuls les modèles écrits entrent ; un modèle périmé (des souvenirs ont changé depuis)
 * est signalé, pas retiré. `null` si aucun n'a de contenu.
 */
export function buildModelsBlock(scope: string, models: readonly MentalModel[]): string | null {
  const written = models.filter((m) => m.content.trim() !== "");
  if (written.length === 0) return null;
  const parts = [
    `[mem0] Connaissance consolidée du projet "${scope}" (mental models, réécrits par le rêve de la mémoire). ` +
      `C'est une synthèse : le dépôt et les souvenirs cités font foi s'ils la contredisent.`,
  ];
  let used = parts[0]!.length;
  for (const m of written) {
    const date = m.updated_at ? ` · ${m.updated_at.slice(0, 10)}` : "";
    const stale = m.stale ? " · peut être périmé : des souvenirs ont changé depuis" : "";
    let content = m.content.trim();
    if (content.length > MODEL_ITEM_CHARS) content = `${content.slice(0, MODEL_ITEM_CHARS - 1).trimEnd()}…`;
    const section = `## ${m.question}${date}${stale}\n${content}`;
    if (used + section.length > MODELS_BLOCK_CHARS) break;
    used += section.length;
    parts.push(section);
  }
  return parts.length > 1 ? parts.join("\n\n") : null;
}

/** Une proposition du rêve telle que rendue par `GET /memory/dream`. */
export type Proposal = {
  id: string;
  kind: string;
  memories: { id: string; memory: string | null }[];
  delete: string | null;
  reason: string | null;
};

/** Le journal de rêve rendu pour `/mem0-dream` : derniers rêves, puis propositions ouvertes. */
export function renderDreamJournal(body: unknown, width = 100): string {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const dreams = Array.isArray(b.dreams) ? (b.dreams as Record<string, unknown>[]) : [];
  const proposals = Array.isArray(b.proposals) ? (b.proposals as Proposal[]) : [];
  const lines: string[] = [];
  if (dreams.length === 0) lines.push("[mem0] Aucun rêve encore pour ce projet.");
  else {
    lines.push("[mem0] Derniers rêves :");
    for (const d of dreams.slice(0, 5)) {
      const r = (d.report ?? {}) as Record<string, unknown>;
      const faits =
        d.kind === "consolidation"
          ? `${r.observations_added ?? 0} observation(s) créée(s), ${r.observations_refined ?? 0} affinée(s), ${r.models ?? 0} modèle(s), ${r.causes ?? 0} cause(s)`
          : `${r.pairs_judged ?? 0} paire(s) jugée(s), ${r.links ?? 0} lien(s), ${r.proposals ?? 0} proposition(s), ${r.orphans_removed ?? 0} orpheline(s) retirée(s)`;
      const erreurs = Array.isArray(r.errors) && r.errors.length > 0 ? ` · ${r.errors.length} erreur(s)` : "";
      lines.push(`- ${String(d.started_at ?? "").slice(0, 16)} ${d.kind} : ${faits}${erreurs}`);
    }
  }
  if (proposals.length === 0) lines.push("", "Aucune proposition en attente.");
  else {
    lines.push("", `${proposals.length} proposition(s) en attente — /mem0-dream accept <id> ou reject <id> :`);
    for (const p of proposals) {
      lines.push(`- ${p.id} · ${p.kind}${p.reason ? ` — ${clip(p.reason, width)}` : ""}`);
      for (const m of p.memories) {
        const mark = p.delete === m.id ? "  ✗ supprimé si accepté" : "";
        lines.push(`    [${m.id}] ${clip((m.memory ?? "(supprimé depuis)").replace(/\s+/g, " "), width)}${mark}`);
      }
    }
  }
  return lines.join("\n");
}
