// Les petites aides de regroupement en mémoire.

/**
 * Ajoute `item` à la liste de `key` dans `map`, sans recopier la liste : `map.set(k, [...liste, item])`
 * coûte le carré du nombre d'éléments d'un groupe, ce qui fige le service synchrone sur les grosses tables.
 */
export function pushTo<K, V>(map: Map<K, V[]>, key: K, item: V): void {
  const list = map.get(key);
  if (list) list.push(item);
  else map.set(key, [item]);
}
