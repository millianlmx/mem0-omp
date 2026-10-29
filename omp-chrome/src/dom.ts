// Accès typé aux éléments des pages de l'extension (popup, options, micro) : un élément
// absent ou d'un autre type est une faute de la page, signalée tout de suite.

export function element<T extends HTMLElement>(id: string, type: new () => T): T {
  const found = document.getElementById(id);
  if (!(found instanceof type)) throw new Error(`élément #${id} absent de ${location.pathname}`);
  return found;
}
