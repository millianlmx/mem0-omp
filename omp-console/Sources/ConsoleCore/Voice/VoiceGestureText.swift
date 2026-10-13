/// Les textes des gestes vocaux (Siri, Raccourcis), communs à l'iPhone et au Mac.
/// Ils sont affichés ou prononcés par Siri.
public enum VoiceGestureText {
    /// La question de confirmation d'un geste à risque : l'action et sa cible
    /// nommée. `nil` pour un geste qui part sans confirmation. `target` est employé
    /// tel que reçu, la porte l'ayant déjà épuré.
    public static func confirmation(for gesture: VoiceGesture, target: String) -> String? {
        switch gesture {
        case .stopFeature:
            return "Arrêter la feature \(target) ?"
        case .validateSpecs:
            return "Valider les specs de la feature \(target) ?"
        case .acceptReview:
            return "Accepter la revue de la feature \(target) ?"
        case .launchPipeline:
            return "Lancer la pipeline \(target) ?"
        case .answerOption, .answerText, .answerProjectDialog, .answerHostedDialog,
             .answerAuditEscalation, .promptHostedSession, .resume, .consult:
            return nil
        }
    }

    /// L'annonce d'un geste refusé, resté sans réponse ou sans cible nommée.
    public static let cancelled = "Annulé, rien n’a été fait."

    /// L'annonce d'un intent dont la politique de déverrouillage diverge de la table.
    public static let misconfigured = "Ce raccourci est mal configuré, rien n’a été fait."
}
