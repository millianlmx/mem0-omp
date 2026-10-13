/// Les textes des gestes vocaux (Siri, Raccourcis), communs à l'iPhone et au Mac.
/// Ils sont affichés ou prononcés par Siri.
public enum VoiceGestureText {
    /// La question de confirmation d'un geste à risque qui ne nomme qu'une cible.
    /// `nil` pour un geste qui part sans confirmation, et pour l'arrêt et le
    /// lancement, dont la phrase demande plusieurs valeurs (`stopConfirmation`,
    /// `launchConfirmation`, passées en `prompt` à la porte). `target` est employé
    /// tel que reçu, la porte l'ayant déjà épuré.
    public static func confirmation(for gesture: VoiceGesture, target: String) -> String? {
        switch gesture {
        case .validateSpecs:
            return "Valider les specs de la feature \(target) ?"
        case .acceptReview:
            return "Accepter la revue de la feature \(target) ?"
        case .stopFeature, .launchPipeline,
             .answerOption, .answerText, .answerProjectDialog, .answerHostedDialog,
             .answerAuditEscalation, .resume, .consult:
            return nil
        }
    }

    /// La confirmation de l'arrêt : le bouton « Arrêter » d'une carte arrête les
    /// pipelines de son DÉPÔT, la phrase le dit et nomme la feature désignée.
    public static func stopConfirmation(repo: String, feature: String) -> String {
        "Arrêter les pipelines de \(repo) ? (feature \(feature))"
    }

    /// La confirmation du lancement, qui relit les trois valeurs dictées. Phrase
    /// partagée par l'iPhone et le Mac.
    public static func launchConfirmation(title: String, repo: String, need: String) -> String {
        "Lancer \(title) sur \(repo) ? Besoin : \(need)"
    }

    /// L'annonce d'un geste refusé, resté sans réponse ou sans cible nommée.
    public static let cancelled = "Annulé, rien n’a été fait."

    /// L'annonce d'un intent dont la politique de déverrouillage diverge de la table.
    public static let misconfigured = "Ce raccourci est mal configuré, rien n’a été fait."
}
