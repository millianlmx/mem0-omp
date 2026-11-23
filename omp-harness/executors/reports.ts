// La preuve qu'un test a tourné : les noms des tests EXÉCUTÉS, lus dans les rapports JUnit
// d'une cible et dans la sortie TAP de ses passages. Un test sauté (`<skipped/>`, `# SKIP`)
// ou compilé hors de la configuration jouée n'y figure pas.

const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const TAP_LINE = /^\s*(?:not ok|ok) \d+ - (.*?)(?:\s+# (SKIP|TODO)\b.*)?$/;

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attributes);
  return match
    ? (match[1] as string)
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
    : null;
}

/** Les tests exécutés d'un rapport JUnit : `classname.name`, hors `<skipped>`. */
export function junitExecuted(xml: string): string[] {
  const names: string[] = [];
  for (const match of xml.matchAll(TESTCASE)) {
    const [, attributes = "", body = ""] = match;
    if (/<skipped\b/.test(body)) continue;
    const name = attribute(attributes, "name");
    if (name === null || name === "") continue;
    const owner = attribute(attributes, "classname");
    names.push(owner ? `${owner}.${name}` : name);
  }
  return names;
}

/** Les tests exécutés d'une sortie TAP, hors SKIP et TODO. */
export function tapExecuted(output: string): string[] {
  const names: string[] = [];
  for (const line of output.split("\n")) {
    const match = TAP_LINE.exec(line);
    if (match && match[2] === undefined && match[1]) names.push(match[1].trim());
  }
  return names;
}

/** Un nom comparable : minuscules, lettres et chiffres seulement (`test_AC1_x()` ≈ `Suite.test_AC1_x`). */
function normalized(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Le test cité par un critère a-t-il tourné ? Il figure (à la forme près) dans un nom exécuté, ou l'inverse. */
export function wasExecuted(test: string, executed: readonly string[]): boolean {
  const wanted = normalized(test);
  if (wanted === "") return false;
  return executed.some((name) => {
    const seen = normalized(name);
    // L'inverse (le nom exécuté contenu dans celui cité) seulement pour un nom assez long : `a` ne prouve rien.
    return seen !== "" && (seen.includes(wanted) || (seen.length >= 8 && wanted.includes(seen)));
  });
}
