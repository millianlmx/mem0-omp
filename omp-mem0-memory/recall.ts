// Rappel automatique par tour : filtrage par cosinus brut, injection, rendu du message de rappel.
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { checkBrief, SYSTEM_DIRECTIVE } from "./brief.ts";
import {
  GLOBAL_SCOPE,
  MEM0_HTTP_URL,
  RECALL_DISPLAY,
  RECALL_GLOBAL_LIMIT,
  RECALL_GLOBAL_POOL,
  RECALL_LIMIT,
  RECALL_LINE_CHARS,
  RECALL_MESSAGE_TYPE,
  RECALL_MIN_PROMPT,
  RECALL_POOL,
  RECALL_THRESHOLD,
  RECALL_BACKOFF_MS,
  TIMEOUT,
} from "./config.ts";
import { mem0, memoryLine, rows, selectRelevant } from "./mem0Client.ts";
import { projectId, stateOf } from "./state.ts";
import type { Mem0Runtime } from "./state.ts";
import { buildIndex, loadMemory } from "./summary.ts";

// ---------------------------------------------------------------------------
export type RecallHead = { id: string; head: string };

export type RecallDetails = {
  status: "hit" | "empty" | "unavailable";
  scope: string;
  threshold: number;
  /** souvenirs du sommaire injecté en prompt système ; 0 si le cache n'a pas chargé. */
  indexSize: number;
  /** agrafages survenus depuis le rappel précédent. */
  pinned: number;
  project: RecallHead[];
  global: RecallHead[];
  /** renseigné uniquement quand status === "unavailable". */
  error?: string;
};

export type RecallRow = { text: string; tone: "header" | "item" | "body" | "alert" };

export function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function wrapAt(s: string, n: number): string[] {
  if (s.length === 0) return [""];
  const result: string[] = [];
  let remaining = s;
  while (remaining.length > 0) {
    if (remaining.length <= n) { result.push(remaining); break; }
    // find last space at or before n
    const spaceIdx = remaining.slice(0, n).lastIndexOf(" ");
    if (spaceIdx === -1) {
      // no space: hard cut
      result.push(remaining.slice(0, n));
      remaining = remaining.slice(n);
    } else {
      result.push(remaining.slice(0, spaceIdx));
      remaining = remaining.slice(spaceIdx + 1);
    }
  }
  return result;
}

export function renderRecallRows(
  d: RecallDetails,
  body: string,
  expanded: boolean,
  width: number,
): RecallRow[] {
  const w = Math.max(20, width);
  const rows: RecallRow[] = [{ text: "", tone: "body" }];

  // En-tête
  let header = "";
  if (d.status === "hit") {
    const n = d.project.length + d.global.length;
    header = `mem0 · ${n} souvenir(s) (projet ${d.project.length} · global ${d.global.length}) · sommaire ${d.indexSize} · seuil ${d.threshold}`;
  } else if (d.status === "empty") {
    header = `mem0 · aucun souvenir au-dessus du seuil ${d.threshold} · sommaire ${d.indexSize}`;
  } else {
    header = `mem0 · mémoire injoignable : ${d.error ?? "erreur inconnue"}`;
  }

  // Suffixes
  if (d.pinned > 0) header += ` · ${d.pinned} agrafé(s)`;
  if (!expanded && (d.status !== "empty" || body)) header += " · Ctrl+O";

  header = clip(header, w);
  rows.push({ text: header, tone: d.status === "unavailable" ? "alert" : "header" });

  if (!expanded) {
    // Résumé : une ligne item par souvenir, projet d'abord puis global
    if (d.status !== "empty" && d.status !== "unavailable") {
      for (const p of d.project) {
        rows.push({ text: `    [${p.id.slice(0, 8)}] ${clip(p.head, w)}`, tone: "item" });
      }
      for (const g of d.global) {
        rows.push({ text: `    [${g.id.slice(0, 8)}] ${clip(g.head, w)}`, tone: "item" });
      }
    }
  } else {
    // Déplié : body découpé sur \n, chaque ligne repliée à w-4
    const wBody = Math.max(w - 4, 16);
    for (const line of body.split("\n")) {
      if (line.length === 0) { rows.push({ text: "", tone: "body" }); continue; }
      for (const wrapped of wrapAt(`    ${line}`, wBody)) {
        rows.push({ text: wrapped, tone: "body" });
      }
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Enregistrement du rendu, puis le tour lui-même
// ---------------------------------------------------------------------------

// Le composant retourné remplace le cadre par défaut (cf. renderFramedMessage côté hôte).
// Il n'implémente que `render(width)` : c'est le seul membre requis de l'interface Component,
// ce qui évite d'importer @oh-my-pi/pi-tui — un import de VALEUR depuis @oh-my-pi/* casse la
// résolution au runtime (extension chargée depuis ~/.omp/plugins/... qui n'a pas ces paquets)
// et fait échouer scripts/check.sh.
const TONES = { header: "customMessageLabel", item: "muted", body: "dim", alert: "warning" } as const;

export function registerRecallRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<RecallDetails>(RECALL_MESSAGE_TYPE, (message, options, theme) => {
    const d = message.details;
    if (!d || typeof d !== "object" || typeof d.status !== "string") return undefined;
    const body =
      typeof message.content === "string"
        ? message.content
        : message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    return {
      render(width: number) {
        return renderRecallRows(d, body, options.expanded, width).map((r) =>
          r.text ? theme.fg(TONES[r.tone], r.text) : "",
        );
      },
    };
  });
}

// Ligne d'aperçu d'un souvenir : son id, et sa première ligne rognée.
function head(m: unknown): RecallHead {
  const id = typeof m === "object" && m !== null && "id" in m ? m.id : undefined;
  return {
    id: String(id ?? "?"),
    head: clip(memoryLine(m).split("\n")[0]!.trim(), RECALL_LINE_CHARS),
  };
}

/** Notice du disjoncteur : courte, et sans rien affirmer sur le contenu de la mémoire. */
export function outageNotice(error: string, remainingMs: number): string {
  return (
    `[mem0] Mémoire indisponible (${error}) : rappel suspendu encore ${Math.ceil(remainingMs / 1000)} s. ` +
    `Ne conclus rien sur le contenu de la mémoire ce tour-ci.`
  );
}

/**
 * Le tour : compteurs, sommaire, puis le rappel lui-même.
 *
 * La requête est le PROMPT BRUT. L'ancienne version l'enveloppait dans un
 * gabarit fixe ("Projet X. Demande en cours… stack, conventions, décisions…") :
 * mesuré sur la base réelle, le gabarit seul (demande vide) sortait un top-1 à
 * 0.687, plus haut que le top-1 de n'importe quelle vraie question, et sur une
 * demande hors sujet 4 des 5 premiers résultats étaient ceux du gabarit. Le
 * boilerplate était l'attracteur, pas la question.
 *
 * Le chargement du cache et les deux recherches partent EN PARALLÈLE : en série,
 * un service lent coûtait 10 s + 20 s, soit le délai au bout duquel l'hôte coupe
 * le handler. Le checkpoint d'exploration ne passe plus par ici : il est posé au
 * milieu du tour, sur le résultat d'outil qui franchit le seuil (checkpoint.ts),
 * et ne prive donc plus aucun tour de son rappel.
 */
export async function handleRecall(
  rt: Mem0Runtime,
  event: BeforeAgentStartEvent,
  ctx: ExtensionContext,
): Promise<BeforeAgentStartEventResult | undefined> {
  const st = stateOf(rt, ctx);
  st.turns += 1;
  if (event.prompt.trim().length >= RECALL_MIN_PROMPT) st.substantiveTurns += 1;

  if (st.turns === 1) {
    try { checkBrief(rt, ctx); } catch { /* jamais bloquant */ }
  }

  const scope = projectId(ctx.cwd);
  const prompt = event.prompt.trim();
  const wantsRecall = prompt.length >= RECALL_MIN_PROMPT;
  const service = rt.service;
  const now = Date.now();

  // Disjoncteur ouvert : aucun appel au service, ni cache ni recherche. Le
  // sommaire déjà chargé reste posé — il ne dépend pas du service.
  if (service.downUntil > now) {
    const systemPrompt = [...event.systemPrompt, SYSTEM_DIRECTIVE, ...(st.index ? [st.index] : [])];
    if (!wantsRecall) return { systemPrompt };
    const error = service.lastError ?? "aucune réponse";
    const details: RecallDetails = {
      status: "unavailable",
      scope,
      threshold: RECALL_THRESHOLD,
      indexSize: st.mem?.entries.length ?? 0,
      pinned: st.pinnedSinceRecall,
      project: [],
      global: [],
      error: `${error} · rappel suspendu`,
    };
    st.pinnedSinceRecall = 0;
    return {
      systemPrompt,
      message: {
        customType: RECALL_MESSAGE_TYPE,
        content: outageNotice(error, service.downUntil - now),
        display: RECALL_DISPLAY,
        attribution: "agent" as const,
        details,
      },
    };
  }

  // Budget froid tant qu'aucune recherche n'a abouti (chargement du modèle
  // d'embedding), chaud ensuite. Le cache suit le même budget, sans descendre
  // sous celui d'une lecture ordinaire : la liste entière est plus longue à servir.
  const budget = service.warm ? TIMEOUT.searchWarm : TIMEOUT.search;

  // Cache + sommaire : une fois par session, retentés au tour suivant en cas
  // d'échec. Sans cache, pas d'agrafage — l'exploration se déroule normalement.
  const loading = st.mem === null ? loadMemory(scope, Math.max(budget, TIMEOUT.other)) : null;

  let recallError: string | undefined;
  // Les échecs sont tracés — un rappel muet a caché le problème trop longtemps.
  // `explain: true` est requis : sans `score_details.semantic_score`, aucune
  // décision de pertinence n'est possible (le `score` renvoyé est saturé par BM25).
  const searches = wantsRecall
    ? Promise.all([
        mem0.search(prompt.slice(0, 800), scope, RECALL_POOL, RECALL_THRESHOLD, true, budget).catch((err) => {
          recallError = (err as Error).message;
          console.warn(`[mem0] recall projet indisponible : ${recallError}`);
          return null;
        }),
        mem0.search(prompt.slice(0, 400), GLOBAL_SCOPE, RECALL_GLOBAL_POOL, RECALL_THRESHOLD, true, budget).catch(() => null),
      ])
    : null;

  const [loaded, results] = await Promise.all([loading, searches]);
  if (loading) {
    st.mem = loaded;
    st.index = loaded ? buildIndex(scope, loaded) : null;
  }

  // La directive et le sommaire sont reposés à chaque tour : un message se
  // dilue dans un long contexte et ne survit pas à la compaction, le system
  // prompt si.
  const systemPrompt = [...event.systemPrompt, SYSTEM_DIRECTIVE, ...(st.index ? [st.index] : [])];

  if (!results) return { systemPrompt };
  const [projectRes, globalRes] = results;

  // Disjoncteur : les deux recherches en échec l'ouvrent, une seule réussite le
  // referme et fait passer au budget chaud.
  if (projectRes === null && globalRes === null) {
    service.warm = false;
    service.downUntil = Date.now() + RECALL_BACKOFF_MS;
    service.lastError = recallError ?? "aucune réponse";
  } else {
    service.warm = true;
    service.downUntil = 0;
    service.lastError = null;
  }

  const recallMessage = (content: string, details: RecallDetails) => {
    st.pinnedSinceRecall = 0;
    return {
      systemPrompt,
      message: {
        customType: RECALL_MESSAGE_TYPE,
        content,
        display: RECALL_DISPLAY,
        attribution: "agent" as const,
        details,
      },
    };
  };

  try {
    // Calcul unique des métadonnées pour le bloc visible : pinned est lu AVANT
    // toute remise à zéro dans recallMessage, indexSize est le même partout.
    const indexSize = st.mem?.entries.length ?? 0;
    const pinned = st.pinnedSinceRecall;

    // Service injoignable : ne rien affirmer sur le contenu de la mémoire.
    if (projectRes === null && globalRes === null) {
      return recallMessage(
        `[mem0] Service mémoire injoignable (${MEM0_HTTP_URL}) : ${recallError ?? "aucune réponse"}. ` +
          `Aucun rappel ce tour, ni pendant les ${RECALL_BACKOFF_MS / 1000} s qui suivent : ne conclus rien ` +
          `sur le contenu de la mémoire, et ne tente pas d'écrire avec mem0_add tant qu'elle ne répond pas.`,
        { status: "unavailable", scope, threshold: RECALL_THRESHOLD, indexSize, pinned, project: [], global: [], error: recallError ?? "aucune réponse" },
      );
    }

    // Sélection sur le cosinus brut, avant le filtre des souvenirs déjà montrés :
    // un souvenir écarté par le plancher ne doit pas consommer son id, sinon il ne
    // pourrait plus être injecté le jour où la demande devient en rapport.
    const project = selectRelevant(rows(projectRes), RECALL_THRESHOLD, RECALL_LIMIT);
    const global = selectRelevant(rows(globalRes), RECALL_THRESHOLD, RECALL_GLOBAL_LIMIT);

    // Le service répond mais aucun candidat ne porte de cosinus : il tourne sans
    // `explain` (version antérieure à ce champ). Le doute se traduit par le silence,
    // mais l'échec est BRUYANT — un dispositif muet en silence a déjà caché ce
    // type de panne, et sans score le rappel ne saurait pas trier ce qu'il injecte.
    if (project.candidates + global.candidates > 0 && project.scored + global.scored === 0) {
      return recallMessage(
        `[mem0] Le service mémoire ne renvoie pas de score sémantique (paramètre absent) — ` +
          `reconstruis le conteneur : docker compose build mem0-http && docker compose up -d mem0-http. ` +
          `Aucun rappel ce tour.`,
        { status: "unavailable", scope, threshold: RECALL_THRESHOLD, indexSize, pinned, project: [], global: [], error: "score sémantique absent" },
      );
    }

    // Un souvenir déjà posé est dans le contexte : le reposer dilue le nouveau.
    // Exception sur le meilleur résultat du tour — il peut être loin derrière ou
    // avoir été compacté, et c'est celui dont l'agent a besoin maintenant.
    const fresh = (res: unknown, keepTop: boolean) =>
      rows(res).filter((m, i) => {
        const id = m?.id ? String(m.id) : memoryLine(m);
        const seen = st.injected.has(id);
        st.injected.add(id);
        return keepTop && i === 0 ? true : !seen;
      });

    const projectMems = fresh(project.kept, true);
    const globalMems = fresh(global.kept, false);

    // Cas vide : autrefois silencieux. C'est le signal qui déclenche l'écriture.
    if (!projectMems.length && !globalMems.length) {
      return recallMessage(
        `[mem0] Rien en mémoire sur cette demande (plancher de score ${RECALL_THRESHOLD}). ` +
          `Explore le dépôt, puis écris avec mem0_add ce qui sera encore vrai dans six mois : ` +
          `décision et sa raison, bug avec cause racine et correctif, convention, exigence.`,
        { status: "empty", scope, threshold: RECALL_THRESHOLD, indexSize, pinned, project: [], global: [] },
      );
    }

    const parts = [
      `[mem0] Déjà en mémoire sur cette demande — points acquis, ne relis pas les fichiers ` +
        `pour les revérifier, cite l'id quand tu t'en sers :`,
    ];
    if (projectMems.length) {
      parts.push(projectMems.map((m) => `- [${m.id ?? "?"}] ${memoryLine(m)}`).join("\n"));
    }
    if (globalMems.length) {
      parts.push("Préférences transverses :", globalMems.map((m) => `- ${memoryLine(m)}`).join("\n"));
    }
    parts.push(
      "Ce qui n'apparaît pas ci-dessus n'est pas en mémoire sur cette demande : explore, puis " +
        "écris ce que tu as appris avec mem0_add. Si le dépôt contredit un souvenir, le dépôt " +
        `gagne — corrige-le avec mem0_update.`,
    );
    st.recalls += 1;

    return recallMessage(
      parts.join("\n\n"),
      { status: "hit", scope, threshold: RECALL_THRESHOLD, indexSize, pinned, project: projectMems.map(head), global: globalMems.map(head) },
    );
  } catch (err) {
    console.warn(`[mem0] recall indisponible : ${(err as Error).message}`);
    return recallMessage(
      `[mem0] Service mémoire injoignable (${MEM0_HTTP_URL}) : ${(err as Error).message}. ` +
        `Aucun rappel ce tour : ne conclus rien sur le contenu de la mémoire, et ne tente pas ` +
        `d'écrire avec mem0_add tant qu'elle ne répond pas.`,
      { status: "unavailable", scope, threshold: RECALL_THRESHOLD, indexSize: st.mem?.entries.length ?? 0, pinned: st.pinnedSinceRecall, project: [], global: [], error: (err as Error).message },
    );
  }
}
