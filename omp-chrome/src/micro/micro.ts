// Demande l'accès au micro UNE fois, depuis une page visible de l'extension : l'accord est
// donné à l'origine de l'extension, que partage le document offscreen qui enregistre (il ne
// peut pas afficher la demande lui-même). Le flux est coupé aussitôt obtenu.

import { element } from "../dom.ts";

const result = element("result", HTMLParagraphElement);

element("ask", HTMLButtonElement).addEventListener("click", () => {
  void (async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      result.textContent = "Micro autorisé : vous pouvez fermer cet onglet.";
      result.className = "message success";
    } catch (error) {
      result.textContent = `Micro refusé (${error instanceof Error ? error.message : String(error)}). Rouvrez l'autorisation depuis l'icône de la barre d'adresse, puis réessayez.`;
      result.className = "message error";
    }
  })();
});
