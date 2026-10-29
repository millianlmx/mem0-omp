// Le code d'appairage `omp1:` que donne `harness.sh pair` : `omp1:` puis, en base64url,
// quatre lignes — l'adresse du harness, son jeton, l'adresse de la mémoire partagée et
// son jeton (ces deux dernières vides quand le serveur n'en publie pas).
//
// Le code de `harness.sh approver` porte une 5e ligne, le jeton approbateur : il est
// réservé à OMP Console et refusé ici, comme le fait `/pair` — ce jeton approuve les
// envois du poste et ne doit jamais entrer dans `chrome.storage`.
//
// Copie autonome de `decodePairing` (omp-mem0-req/harness.ts) : l'extension ne peut pas
// importer le plugin, et `Buffer` n'existe pas dans Chrome. Le décodage base64url est
// donc écrit ici, avec la même tolérance que `Buffer.from(…, "base64url")` : le
// bourrage `=` final est ignoré et un dernier caractère isolé (6 bits) ne produit rien.

export type Pairing = { url: string; token: string; mem0Url: string; mem0Token: string };

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64urlBytes(text: string): Uint8Array {
  const digits = text.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of digits) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) break;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

/** Le refus d'un code approbateur (5e ligne non vide) : rien n'est enregistré. */
export const APPROVER_CODE_REFUSAL = "code des apps : collez-le dans OMP Console ; ici, le code de `harness.sh pair`";

/** Un code ordinaire, `{ refusal }` pour un code approbateur, `null` pour un texte illisible. */
export function decodePairing(code: string): Pairing | { refusal: string } | null {
  const match = /^omp1:([A-Za-z0-9_-]+=*)$/.exec(code.trim());
  if (!match) return null;
  const [url = "", token = "", mem0Url = "", mem0Token = "", approverToken = ""] = new TextDecoder()
    .decode(base64urlBytes(match[1] as string))
    .split("\n");
  if (approverToken !== "") return { refusal: APPROVER_CODE_REFUSAL };
  if (!/^https?:\/\/\S+$/.test(url) || !/^\S+$/.test(token)) return null;
  if (mem0Url !== "" && !/^https?:\/\/\S+$/.test(mem0Url)) return null;
  return { url: url.replace(/\/+$/, ""), token, mem0Url: mem0Url.replace(/\/+$/, ""), mem0Token };
}
