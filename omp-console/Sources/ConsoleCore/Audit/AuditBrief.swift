// Les rubriques d'un brief d'audit (audit-panel-in-omp-console S-2, S-6) : la
// feuille du brief signale une rubrique manquante AVANT tout envoi, avec la même
// règle que le refus du service (`briefRubricsMissing(text, AUDIT_BRIEF_SECTIONS)`,
// omp-mem0-req/context.ts:92-115).
//
// VIT DANS `ConsoleCore` : la feuille du Mac et celle de l'iPhone l'emploient.

import Foundation

public enum AuditBrief {
    /// `AUDIT_BRIEF_SECTIONS` (omp-mem0-req/auditRecord.ts) : les cinq rubriques
    /// d'un brief, puis « Orientation » et « Constats ».
    public static let sections = ["But", "Fonction", "Décisions", "Contraintes", "Non-objectifs", "Orientation", "Constats"]

    /// La PREMIÈRE rubrique absente de `text`, dans l'ordre de `sections`, ou
    /// `nil` si le brief est complet. Une rubrique est présente quand une ligne,
    /// rognée, vaut exactement `## <nom>` — même vide, elle compte.
    public static func missingRubric(_ text: String) -> String? {
        let headings = Set(
            text.split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        )
        return sections.first { !headings.contains("## \($0)") }
    }
}
