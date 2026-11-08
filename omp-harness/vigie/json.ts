// La lecture des données que la vigie reçoit du réseau (réponses du harness, de GitHub,
// lignes de journal) : un objet vérifié, jamais une forme supposée.

/** Un objet JSON (ni `null`, ni tableau) ; sinon un objet vide, que les lectures suivantes trouvent sans champ. */
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  // Vérifié juste au-dessus : un objet non tableau se lit champ par champ, chaque champ `unknown`.
  const object: Record<string, unknown> = value as Record<string, unknown>;
  return object;
}

/** Un texte, rogné ; autre chose donne une chaîne vide. */
export function textOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
