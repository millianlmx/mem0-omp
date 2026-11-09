// Une escalade conforme à la carte de décision, pour les tests qui posent une escalade par l'outil `decision`.
// Le serveur exige une `evidence` qui désigne un nœud du graphe du run : `readA()` joue la lecture de `src/a.ts`
// (trames du direct) qui la fonde. Le titre des tests de la feature : test/session-graph/session-graph.test.ts.

export const CARD_CONTEXT =
  "La feature exporte les factures en CSV. `src/a.ts` doit dater chaque export ; le modèle n'a pas encore de champ de date. Il faut choisir où le stocker.";

/** Les champs de la carte d'une escalade, sans l'enveloppe (`context`, `rationale`, `category`). */
export const CARD_FIELDS = {
  headline: "Où garder la date d'export des factures ?",
  stake: "Sans date, chaque export reste impossible à dater.",
  established: "Le modèle de facture n'a aucun champ de date.",
  options: [
    { label: "colonne", impact: "Une migration à passer, puis une seule lecture.", reversible: false, cost: "moyen" },
    { label: "table", impact: "Une jointure de plus à chaque lecture.", reversible: true },
  ],
  recommended: "colonne",
  confidence: "moyenne",
  evidence: ["src/a.ts"],
};

/** Les arguments de l'outil `decision` d'une escalade conforme ; `extra` en remplace des champs. */
export function escalationArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    context: CARD_CONTEXT,
    rationale: "une seule lecture par facture",
    category: "schema",
    ...CARD_FIELDS,
    ...extra,
  };
}

/** Les trames d'une lecture réussie de `path` : de quoi fonder une `evidence` (le graphe ne vit que des trames). */
export function readFrames(path = "src/a.ts", id = "rd1"): Record<string, unknown>[] {
  return [
    { frame: { type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path } } },
    { frame: { type: "tool_execution_end", toolCallId: id, toolName: "read", result: { content: [] } } },
  ];
}
