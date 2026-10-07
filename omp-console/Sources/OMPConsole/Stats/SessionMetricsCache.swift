// Le cache de LECTEURS INCRÉMENTAUX d'une dérivation de statistiques (D-4) : un
// `SessionReader` par `sessionFile`, lu une fois par relevé, RÉINITIALISÉ puis
// relu immédiatement sur une réécriture (`truncated`/`replaced`), et libéré pour
// tout fichier hors du plan du projet demandé.
//
// Extrait du corps de `StatsModel.readMetrics` pour être PARTAGÉ : la fenêtre
// macOS et l'API distante dérivent le même tableau avec le même coût — un relevé
// ne consomme que les octets AJOUTÉS depuis le relevé précédent.
//
// Aucune écriture, aucun verrou, aucun descripteur conservé : le contrat de
// `SessionReader` est celui d'un lecteur incrémental qui relit le fichier à
// chaque appel. Tout se fait sur le `MainActor`, donc aucune lecture concurrente.

import Foundation

@MainActor
final class SessionMetricsCache {
    /// Un `SessionReader` par `sessionFile`, conservé tant qu'un relevé peut
    /// encore le lire.
    private var readers: [String: SessionReader] = [:]

    /// Le nombre de lecteurs conservés : une mesure des tests (jamais affichée).
    var retainedCount: Int { readers.count }

    /// Lit (ou relit) la session d'un run et rend son état de métriques.
    func metrics(_ sessionFile: String) -> RunMetricsState {
        let reader: SessionReader
        if let existing = readers[sessionFile] {
            reader = existing
        } else {
            let fresh = SessionReader(path: sessionFile)
            readers[sessionFile] = fresh
            reader = fresh
        }

        let delta = reader.read()
        if let issue = delta.issue {
            if let reason = statsUnreadableReason(issue) { return .unreadable(reason) }
            // Réécriture (`truncated`/`replaced`) : jamais montrée — lecteur NEUF
            // PUIS relecture immédiate dans la même passe (règle `SessionViewerModel`).
            let fresh = SessionReader(path: sessionFile)
            readers[sessionFile] = fresh
            let reread = fresh.read()
            if let issue = reread.issue, let reason = statsUnreadableReason(issue) {
                return .unreadable(reason)
            }
            return .measured(sessionMetrics(fresh.conversation))
        }
        return .measured(sessionMetrics(reader.conversation))
    }

    /// Libère les lecteurs de tout fichier HORS de l'ensemble conservé : après un
    /// relevé, seuls les runs du projet demandé gardent leur lecteur.
    func release(keeping files: Set<String>) {
        for file in readers.keys where !files.contains(file) {
            readers.removeValue(forKey: file)
        }
    }
}
