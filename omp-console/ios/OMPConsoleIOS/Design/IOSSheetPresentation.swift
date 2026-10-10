// La présentation des feuilles iOS (feature feuilles-ios-presentation-et-depots,
// S-1 et S-2) : leur taille sur iPad et le bouton icône de leur barre.
//
// Tailles, sur iPad seulement (sur iPhone, ces modificateurs ne changent rien :
// la feuille reste pleine hauteur, D-1) :
//   — « page » (Contrat, session, souvenir) : `presentationSizing(.page)`, une
//     feuille quasi pleine largeur pour un contenu long ;
//   — « ajustée » (Bienvenue, Piloter un projet, Lancer une session OMP) : la
//     largeur du formulaire et une hauteur égale au contenu. La hauteur est
//     MESURÉE sur l'unique conteneur défilant (D-2) puis posée en hauteur IDÉALE
//     du NavigationStack (D-3) : `.form.fitted(…)` seul écrase la feuille à
//     ~120 pt (piège mesuré, D-1).
// `presentationDetents` est exclu : il transformerait la feuille iPhone en
// feuille basse.

import SwiftUI

/// La règle pure de la hauteur idéale d'une feuille ajustée.
enum IOSSheetSizing {
    /// La hauteur idéale à poser sur le NavigationStack : `nil` tant que le
    /// contenu n'est pas mesuré (≤ 0), pour ne jamais écraser la feuille à une
    /// hauteur nulle ; sinon la hauteur mesurée.
    static func idealHeight(measured: CGFloat) -> CGFloat? {
        measured > 0 ? measured : nil
    }
}

extension View {
    /// Feuille « page » sur iPad. Se pose sur le NavigationStack racine de la
    /// vue présentée, jamais sur le présentateur.
    func iosPageSheet() -> some View {
        presentationSizing(.page)
    }

    /// Feuille ajustée au contenu sur iPad : largeur du formulaire, hauteur
    /// `contentHeight` (mesurée par `iosSheetContentHeight(_:)`). Se pose sur le
    /// NavigationStack racine de la vue présentée.
    func iosFittedSheet(contentHeight: CGFloat) -> some View {
        frame(idealHeight: IOSSheetSizing.idealHeight(measured: contentHeight))
            .presentationSizing(.form.fitted(horizontal: false, vertical: true))
    }

    /// Mesure la hauteur du contenu défilant, barre de navigation comprise
    /// (encarts haut et bas). Se pose sur l'UNIQUE conteneur défilant de la
    /// feuille : seul le premier trouvé rapporte sa géométrie (D-2).
    func iosSheetContentHeight(_ height: Binding<CGFloat>) -> some View {
        onScrollGeometryChange(for: CGFloat.self, of: { geometry in
            geometry.contentSize.height + geometry.contentInsets.top + geometry.contentInsets.bottom
        }) { _, new in
            height.wrappedValue = new
        }
    }
}

/// Le bouton icône de 44 pt d'une barre de feuille (✕ annuler, ✓ valider), sur
/// le patron plain de 44 pt du dépôt (D-6) : deux icônes laissent au titre en
/// ligne la place de se lire en entier (D-4), là où deux boutons texte le
/// masquaient sur un iPhone de 390 pt.
struct IOSSheetIconButton: View {
    enum Role { case cancel, confirm }
    let role: Role
    /// Le libellé lu par VoiceOver : le texte de l'ancien bouton.
    let label: String
    let action: () -> Void
    /// Faux quand l'appelant a posé `.disabled(true)` : le ✓ passe au gris.
    @Environment(\.isEnabled) private var isEnabled

    var body: some View {
        Button(action: action) {
            Image(systemName: role == .cancel ? IOSSheetText.cancelSymbol : IOSSheetText.confirmSymbol)
                .fontWeight(.semibold)
                .foregroundStyle(!isEnabled ? Color.secondary : (role == .confirm ? Color.accentColor : Color.primary))
                .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
