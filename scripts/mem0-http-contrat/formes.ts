// Vérification de forme des réponses du contrat boîte noire mem0-http (spec S-4).
//
// Pur : aucune entrée/sortie. Une `Forme` décrit le jeu de clés EXACT et le type
// de chaque valeur ; `verifierForme` rend la liste des écarts, chacun nommant la
// route et le chemin de la clé fautive. Les valeurs non déterministes (id, dates,
// hash, scores) ne sont contrôlées qu'en type et format.

export type Forme =
  | { type: "string" }
  | { type: "number" }
  | { type: "integer" }
  | { type: "boolean" }
  | { type: "null" }
  | { type: "const"; valeur: string | number | boolean | null }
  | { type: "format"; format: "uuid" | "date-iso" | "md5" }
  | { type: "ou"; formes: Forme[] }
  | { type: "tableau"; element: Forme }
  | { type: "objet"; cles: Record<string, Forme> };

export type Ecart = { route: string; chemin: string; message: string };

const FORMATS: Record<"uuid" | "date-iso" | "md5", RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  "date-iso": /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/,
  md5: /^[0-9a-f]{32}$/,
};

/** Nom du type JSON d'une valeur reçue, tel qu'il apparaît dans les messages. */
function typeRecu(valeur: unknown): string {
  if (valeur === null) return "null";
  if (Array.isArray(valeur)) return "array";
  return typeof valeur;
}

/** Noms des types JSON qu'une forme accepte (sans doublon, dans l'ordre). */
function typesAttendus(forme: Forme): string[] {
  switch (forme.type) {
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return [forme.type];
    case "const":
      return [typeRecu(forme.valeur)];
    case "format":
      return ["string"];
    case "tableau":
      return ["array"];
    case "objet":
      return ["object"];
    case "ou":
      return [...new Set(forme.formes.flatMap(typesAttendus))];
  }
}

function verifier(route: string, forme: Forme, valeur: unknown, chemin: string, ecarts: Ecart[]): void {
  const c = chemin === "" ? "(racine)" : chemin;
  const ecart = (message: string, cle: string = c): void => {
    ecarts.push({ route, chemin: cle, message: `${route} : ${message}` });
  };
  const typeFaux = (attendu: string): void => {
    ecart(`type de « ${c} » attendu ${attendu}, reçu ${typeRecu(valeur)}`);
  };

  switch (forme.type) {
    case "string":
    case "boolean":
    case "null":
      if (typeRecu(valeur) !== forme.type) typeFaux(forme.type);
      return;
    case "number":
      if (typeof valeur !== "number") typeFaux("number");
      return;
    case "integer":
      if (typeof valeur !== "number" || !Number.isInteger(valeur)) typeFaux("integer");
      return;
    case "const":
      if (valeur !== forme.valeur) {
        ecart(`valeur de « ${c} » attendue ${JSON.stringify(forme.valeur)}, reçue ${JSON.stringify(valeur)}`);
      }
      return;
    case "format":
      if (typeof valeur !== "string") {
        typeFaux("string");
        return;
      }
      if (!FORMATS[forme.format].test(valeur) || (forme.format === "date-iso" && Number.isNaN(Date.parse(valeur)))) {
        ecart(`format de « ${c} » invalide (${forme.format}) : ${JSON.stringify(valeur)}`);
      }
      return;
    case "ou": {
      const essais = forme.formes.map((alternative) => {
        const sous: Ecart[] = [];
        verifier(route, alternative, valeur, chemin, sous);
        return sous;
      });
      if (essais.some((sous) => sous.length === 0)) return;
      // Une seule alternative du même type JSON que la valeur : ses écarts sont
      // les plus précis (ex. metadata `{tags: 1}` contre ou(null, {tags: string})).
      const recu = typeRecu(valeur);
      const memeTypeJson = forme.formes
        .map((alternative, i) => ({ alternative, i }))
        .filter(({ alternative }) =>
          typesAttendus(alternative).some((t) => t === recu || (t === "integer" && recu === "number")),
        );
      if (memeTypeJson.length === 1) {
        ecarts.push(...essais[memeTypeJson[0].i]);
        return;
      }
      typeFaux(typesAttendus(forme).join("|"));
      return;
    }
    case "tableau":
      if (!Array.isArray(valeur)) {
        typeFaux("array");
        return;
      }
      valeur.forEach((element, i) => verifier(route, forme.element, element, `${chemin}[${i}]`, ecarts));
      return;
    case "objet": {
      if (typeRecu(valeur) !== "object") {
        typeFaux("object");
        return;
      }
      const objet = valeur as Record<string, unknown>;
      const prefixe = chemin === "" ? "" : `${chemin}.`;
      for (const [cle, sousForme] of Object.entries(forme.cles)) {
        const fille = `${prefixe}${cle}`;
        if (!Object.hasOwn(objet, cle)) {
          ecart(`clé manquante « ${fille} »`, fille);
          continue;
        }
        verifier(route, sousForme, objet[cle], fille, ecarts);
      }
      for (const cle of Object.keys(objet)) {
        if (!Object.hasOwn(forme.cles, cle)) ecart(`clé en trop « ${prefixe}${cle} »`, `${prefixe}${cle}`);
      }
      return;
    }
  }
}

/**
 * Écarts entre `valeur` et `forme`, dans l'ordre des clés déclarées puis des clés
 * en trop. `route` vaut `<MÉTHODE> <gabarit>` (ex. `PUT /memory/{id}`) ; le chemin
 * est en notation pointée avec indices (`results[0].metadata.tags`), `(racine)`
 * pour la valeur elle-même. Liste vide = conforme.
 */
export function verifierForme(route: string, forme: Forme, valeur: unknown): Ecart[] {
  const ecarts: Ecart[] = [];
  verifier(route, forme, valeur, "", ecarts);
  return ecarts;
}
