// Les identifiants des runs, projets et audits : un préfixe, l'heure en base 36 et
// six chiffres hexadécimaux tirés au hasard — triables à l'œil, sans collision entre
// deux créations de la même milliseconde (plusieurs clients en même temps).
import { randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
}
