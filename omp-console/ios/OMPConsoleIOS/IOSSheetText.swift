// Les symboles de la barre des feuilles iOS (feature feuilles-ios-presentation-et-depots,
// S-2) : l'icône ✕ d'annulation et l'icône ✓ de validation d'`IOSSheetIconButton`.
// VoiceOver ne lit jamais ces noms : chaque bouton porte le texte de l'ancien
// bouton de barre comme libellé d'accessibilité.

enum IOSSheetText {
    /// L'icône du bouton d'annulation (✕), à la place de « Annuler ».
    static let cancelSymbol = "xmark"
    /// L'icône du bouton de validation (✓), à la place du verbe de la feuille.
    static let confirmSymbol = "checkmark"
}
