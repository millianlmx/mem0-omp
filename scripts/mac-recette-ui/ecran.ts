// Pré-contrôle de l'écran de la recette UI Mac (S-2 de recette-ui-mac-automatisee),
// AVANT tout lancement : juge les faits que `sonde etat-ecran` constate sans rien
// lancer ni activer. Fonction pure ; recette.ts lit le fichier de faits.
//
// Pourquoi refuser le plein écran (D-4, mesuré) : sur un Space plein écran d'une
// autre app, une instance lancée par `open -g -n` ouvre ses fenêtres sur le
// Space Bureau, invisibles pour AX et pour `screencapture` ; l'activer volerait
// le focus de l'utilisateur.

export type Rectangle = { x: number; y: number; largeur: number; hauteur: number };

export type FaitsEcran = {
  version: 1;
  verrouille: boolean;
  accessibilite: boolean;
  enregistrementEcran: boolean;
  premierPlan: { bundle: string | null; nom: string; pid: number; pleinEcran: boolean | null };
  ecrans: Rectangle[];
  fenetres: (Rectangle & { pid: number; proprietaire: string; calque: number })[];
};

export type JugementEcran = { executable: true } | { executable: false; raison: string };

/** Raison commune d'une sonde en échec ou de faits illisibles (S-2, cas limites). */
export const RAISON_PRECONTROLE_ECHOUE = "le pré-contrôle de l'écran a échoué";

const estNombre = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function estRectangle(v: unknown): v is Rectangle {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return estNombre(r.x) && estNombre(r.y) && estNombre(r.largeur) && estNombre(r.hauteur);
}

/** Les faits S-2 s'ils ont la forme attendue, sinon `null`. */
export function lireFaitsEcran(v: unknown): FaitsEcran | null {
  if (typeof v !== "object" || v === null) return null;
  const f = v as Record<string, unknown>;
  if (f.version !== 1) return null;
  if (typeof f.verrouille !== "boolean" || typeof f.accessibilite !== "boolean") return null;
  if (typeof f.enregistrementEcran !== "boolean") return null;
  const pp = f.premierPlan as Record<string, unknown> | null | undefined;
  if (typeof pp !== "object" || pp === null) return null;
  if (!(pp.bundle === null || typeof pp.bundle === "string") || typeof pp.nom !== "string") return null;
  if (!Number.isInteger(pp.pid) || !(pp.pleinEcran === null || typeof pp.pleinEcran === "boolean")) return null;
  if (!Array.isArray(f.ecrans) || !f.ecrans.every(estRectangle)) return null;
  if (!Array.isArray(f.fenetres)) return null;
  for (const w of f.fenetres) {
    if (!estRectangle(w)) return null;
    const o = w as unknown as Record<string, unknown>;
    if (!Number.isInteger(o.pid) || typeof o.proprietaire !== "string" || !estNombre(o.calque)) return null;
  }
  return f as unknown as FaitsEcran;
}

/**
 * Le jugement S-2 : la première règle vraie conclut, dans l'ordre verrouillé,
 * plein écran, Accessibilité, Enregistrement de l'écran.
 */
export function jugerEcran(faits: FaitsEcran): JugementEcran {
  if (faits.verrouille) {
    return { executable: false, raison: "l'écran est verrouillé. Déverrouillez la session, puis relancez la recette." };
  }
  const pleinEcran = (nom: string): JugementEcran => ({
    executable: false,
    raison: `l'écran est sur un Space plein écran (${nom}). Revenez sur le Bureau, puis relancez la recette.`,
  });
  if (faits.premierPlan.pleinEcran === true) return pleinEcran(faits.premierPlan.nom);
  const couvrante = faits.fenetres.find((w) =>
    faits.ecrans.some(
      (e) =>
        Math.abs(w.x - e.x) <= 1 &&
        Math.abs(w.y - e.y) <= 1 &&
        Math.abs(w.largeur - e.largeur) <= 1 &&
        Math.abs(w.hauteur - e.hauteur) <= 1,
    ),
  );
  if (couvrante !== undefined) return pleinEcran(couvrante.proprietaire);
  if (!faits.accessibilite) {
    return {
      executable: false,
      raison:
        "le terminal qui lance la recette n'a pas l'autorisation Accessibilité " +
        "(Réglages Système ▸ Confidentialité et sécurité ▸ Accessibilité).",
    };
  }
  if (!faits.enregistrementEcran) {
    return {
      executable: false,
      raison:
        "le terminal qui lance la recette n'a pas l'autorisation Enregistrement de l'écran " +
        "(Réglages Système ▸ Confidentialité et sécurité ▸ Enregistrement de l'écran et audio du système).",
    };
  }
  return { executable: true };
}
