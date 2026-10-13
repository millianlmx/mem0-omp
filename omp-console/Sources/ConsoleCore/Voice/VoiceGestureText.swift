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
             .answerAuditEscalation, .resume, .consult:
            return nil
        }
    }

    /// La confirmation d'un lancement vocal : le titre, le dépôt et le besoin
    /// relu, pour rattraper une mauvaise transcription. Valeurs insérées telles
    /// que reçues, l'appelant les ayant épurées.
    public static func launchConfirmation(title: String, repo: String, need: String) -> String {
        "Lancer \(title) sur \(repo) ? Besoin : \(need)"
    }

    /// La confirmation d'un arrêt vocal : l'arrêt vise tout le dépôt, comme le
    /// bouton (titre de la confirmation tactile), et rappelle la feature désignée.
    public static func stopConfirmation(repo: String, feature: String) -> String {
        KanbanText.stopConfirmTitle(repo: repo) + " (feature \(feature))"
    }

    /// L'annonce d'un geste refusé, resté sans réponse ou sans cible nommée.
    public static let cancelled = "Annulé, rien n’a été fait."

    /// L'annonce d'un intent dont la politique de déverrouillage diverge de la table.
    public static let misconfigured = "Ce raccourci est mal configuré, rien n’a été fait."
}
