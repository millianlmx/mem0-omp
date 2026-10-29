// Adresses observées et sites exclus : rien d'autre que l'origine et le chemin ne quitte
// le navigateur (la query et le fragment portent souvent des jetons, des recherches ou
// des identifiants de message).

/** Origine + chemin d'une adresse web, sans identifiants, query ni fragment ; `null` hors http(s). */
export function stripUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${url.pathname}`;
}

/** L'hôte (minuscules, sans `www.` initial) d'une adresse web ; `null` hors http(s). */
export function hostOf(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * La liste des sites exclus telle que l'utilisateur la saisit (un par ligne, ou séparés
 * par des virgules ; une adresse complète est réduite à son hôte), dédoublonnée.
 */
export function parseExcludedSites(text: string): string[] {
  const out = new Set<string>();
  for (const piece of text.split(/[\n,]/)) {
    let entry = piece.trim().toLowerCase();
    if (entry === "") continue;
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(entry)) entry = `https://${entry}`;
    let host: string;
    try {
      host = new URL(entry).hostname;
    } catch {
      continue;
    }
    host = host.replace(/^\*\./, "").replace(/^www\./, "");
    if (host !== "") out.add(host);
  }
  return [...out];
}

/** Vrai si `host` est un site exclu ou l'un de ses sous-domaines (`bank.fr` exclut `pro.bank.fr`). */
export function isExcludedHost(host: string, excluded: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return excluded.some((site) => h === site || h.endsWith(`.${site}`));
}
