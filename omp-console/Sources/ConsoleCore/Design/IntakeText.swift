// Les mots de la DEMANDE (feuille de saisie, palette, cartes d'« À traiter », feuille
// « Modifier le plan »), partagés par le Mac et l'iPhone/iPad.

import Foundation

public enum IntakeText {
    // MARK: - Saisie

    public static let title = L10n.text("Demande")
    public static let titleSymbol = "text.bubble"
    public static let paletteHint = L10n.text("Dites ce que vous voulez : le serveur propose un plan")
    public static let fieldPrompt = L10n.text("Corriger un bug, lancer une feature, auditer un dépôt, planifier…")
    public static let fieldHint = L10n.text("Le serveur classe votre demande et propose un plan : rien n’est créé avant votre confirmation. La dictée du clavier fonctionne dans ce champ.")
    public static let repoLabel = L10n.text("Dépôt")
    public static let repoDeduced = L10n.text("Déduit par le serveur")
    public static let send = L10n.text("Envoyer")
    public static let sending = L10n.text("Envoi…")
    /// AC-21 : un serveur antérieur à la Demande (404 sur `/v1/intake`).
    public static let unsupported = L10n.text("Ce serveur ne connaît pas encore la Demande : mettez omp-harness à jour.")
    public static let approverOnly = L10n.text("Seul l’appareil approbateur peut confirmer une demande au poste : appairez cette app avec le code approbateur (harness.sh approver sur le VPS).")

    // MARK: - Gestes

    public static let confirm = L10n.text("Confirmer")
    public static let replyPrompt = L10n.text("Votre réponse")

    /// Le type d'un plan, en français.
    public static func kind(_ kind: String) -> String {
        switch kind {
        case "feature": L10n.text("Feature")
        case "bug": L10n.text("Bogue")
        case "audit": L10n.text("Audit")
        case "workstation_request": L10n.text("Demande au poste")
        case "schedule": L10n.text("Planification")
        case "question": L10n.text("Question")
        default: kind
        }
    }

    // MARK: - Modifier le plan

    public static let editTitle = L10n.text("Modifier le plan")
    public static let kindLabel = L10n.text("Type")
    public static let titleLabel = L10n.text("Titre")
    public static let statementLabel = L10n.text("Énoncé")
    public static let focusLabel = L10n.text("Périmètre")
    public static let cronLabel = L10n.text("Fréquence (cron)")
    public static let targetLabel = L10n.text("Cible")
    public static let labelLabel = L10n.text("Label")

    /// Les cibles d'une planification, en français (choisies par la feuille).
    public static let targetFeature = L10n.text("Une feature")
    public static let targetAudit = L10n.text("Un audit")
    public static let targetIssues = L10n.text("Les issues")
}
