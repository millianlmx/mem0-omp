// Le contrat Swift ↔ serveur : lire les champs d'une struct Codable du client, et vérifier que le
// JSON réel du serveur les porte. Partagé par les tests de contrat (un test n'importe jamais un autre test).
import assert from "node:assert/strict";

/** Les propriétés stockées d'une struct Swift : nom → optionnelle ? */
export function swiftFields(source: string, struct: string): Map<string, boolean> {
  const start = source.indexOf(`public struct ${struct}:`);
  assert.ok(start >= 0, `struct ${struct} introuvable`);
  const body = source.slice(start, source.indexOf("\n}\n", start));
  const fields = new Map<string, boolean>();
  for (const [, name, type] of body.matchAll(/^ {4}public var (\w+): ([^\s{=]+)\s*$/gm))
    fields.set(name as string, (type as string).endsWith("?"));
  assert.ok(fields.size > 0, `aucun champ lu dans ${struct}`);
  return fields;
}

/** Vérifie qu'un objet JSON du serveur porte chaque champ du client Swift. */
export function covers(object: Record<string, unknown>, fields: Map<string, boolean>, label: string): void {
  for (const [name, optional] of fields) {
    assert.ok(name in object, `${label}.${name} : le client Swift le décode, le serveur ne l'envoie pas`);
    if (!optional)
      assert.notEqual(object[name], null, `${label}.${name} : non optionnel côté Swift, null côté serveur`);
  }
}
