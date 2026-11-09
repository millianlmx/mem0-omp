// Le contexte de page d'une Demande posée par un des deux gestes du popup (« Faire ça sur cette
// page », « En faire un fil ») : l'adresse de l'onglet actif, son titre et le texte sélectionné,
// tels que `POST /v1/intake` les accepte (`context {url, title, selection}`). Le serveur refuse un
// champ trop long au lieu de le couper : c'est ici que le titre et la sélection sont tronqués, et
// qu'une adresse qui n'est pas du web (ou trop longue pour rester juste) est écartée.

/** Ce que le service worker sait de l'onglet : son adresse et son titre. */
export type ActivePage = { url: string; title: string };

export type PageContext = { url?: string; title?: string; selection?: string };

/** Les bornes du serveur (omp-harness/intake.ts), en caractères. */
export const PAGE_CONTEXT_MAX = { url: 2000, title: 300, selection: 4000 } as const;

/** L'adresse si elle est du web (http ou https) et tient dans la borne ; `null` sinon. */
export function webUrl(raw: string): string | null {
  const url = raw.trim();
  if (url.length > PAGE_CONTEXT_MAX.url || !URL.canParse(url)) return null;
  const { protocol } = new URL(url);
  return protocol === "http:" || protocol === "https:" ? url : null;
}

/**
 * Le contexte d'une page web : adresse entière (la query désigne souvent la page : un ticket, un
 * fil), titre et sélection tronqués à leurs bornes, champs vides omis. `null` hors du web : une
 * page interne du navigateur n'a rien à dire au serveur.
 */
export function pageContext(page: ActivePage, selection: string): PageContext | null {
  const url = webUrl(page.url);
  if (url === null) return null;
  const context: PageContext = { url };
  const title = page.title.trim().slice(0, PAGE_CONTEXT_MAX.title);
  if (title !== "") context.title = title;
  const selected = selection.trim().slice(0, PAGE_CONTEXT_MAX.selection);
  if (selected !== "") context.selection = selected;
  return context;
}

/** Le texte de « En faire un fil » : la page par son titre, sinon par son adresse. */
export function threadText(context: PageContext): string {
  return `Traite cette page : ${context.title ?? context.url ?? ""}`;
}
