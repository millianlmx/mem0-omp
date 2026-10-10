// Les libellés d'accessibilité d'une ligne de diff (S-6 de `ios-sessions`) :
// la distinction des lignes ne repose JAMAIS sur la seule couleur, chaque ligne
// porte un mot en plus de sa teinte.
//
// PARTAGÉ : la coque macOS lit les mêmes libellés (son `toneLabel` privé a
// disparu), l'app iOS les pose en `.accessibilityValue`.

/// Le libellé d'une teinte de ligne de diff.
public enum SessionDiffText {
    public static func toneLabel(_ tone: DiffTone) -> String {
        switch tone {
        case .added: return "ligne ajoutée"
        case .removed: return "ligne supprimée"
        case .context: return "contexte"
        case .section: return "en-tête de différences"
        }
    }
}
