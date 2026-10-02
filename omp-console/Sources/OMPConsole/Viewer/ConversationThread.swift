// Le fil de conversation (S-15 de omp-console-redesign), partagé par la
// visionneuse d'un run et la fenêtre « Session OMP » : bandeau d'erreur de
// lecture, états vides, fil des faits, notes discrètes sous le fil.
//
// La mécanique de suivi est CELLE de la visionneuse (S-5, S-6 de
// `visionneuse-de-session`), extraite telle quelle : la distance au bas du fil est
// mesurée par AppKit (`ScrollBottomObserver`, mécanisme mesuré quand la cible
// était macOS 14, conservé sous la cible macOS 26 — `scrollPosition(id:)` ne
// rapporte pas une distance), et le modèle décide du suivi. Seule différence : le
// fil ne défile plus qu'en hauteur, les longues lignes monospacées défilent dans
// leur propre bloc (`SessionRowView`).

import SwiftUI

/// Le repère de FIN de fil : un zéro de hauteur après tout le contenu, y compris
/// son rembourrage. Défiler jusqu'au dernier FAIT laissait un reste mesuré (le
/// rembourrage et le reliquat de la dernière ligne), donc une distance au bas non
/// nulle — que la politique de suivi interprétait comme « l'utilisateur a remonté
/// le fil ».
private let viewerEndId = "viewer.end"

struct ConversationThread: View {
    @ObservedObject var model: SessionViewerModel

    var body: some View {
        VStack(spacing: 0) {
            // L'erreur de lecture s'affiche MÊME quand des faits sont déjà là : on
            // n'efface jamais un fait lu.
            if case .unreadable(let message) = model.state {
                Text(ConversationText.unreadable(message))
                    .consoleBanner(tint: .red)
                    .padding(.horizontal, 20)
                    .padding(.top, 10)
                    .accessibilityIdentifier("viewer.unreadable")
            }
            if model.rows.isEmpty {
                placeholder
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityIdentifier("viewer.placeholder")
            } else {
                thread
            }
            if model.ignoredCount > 0 || model.reconstructions > 0 {
                HStack(spacing: 12) {
                    if model.ignoredCount > 0 {
                        Text(ConversationText.ignored(model.ignoredCount))
                    }
                    if model.reconstructions > 0 {
                        Text(ConversationText.rewritten)
                    }
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .padding(.vertical, 6)
                .accessibilityIdentifier("viewer.notes")
            }
        }
    }

    @ViewBuilder private var placeholder: some View {
        if model.state == .waiting {
            ContentUnavailableView(ConversationText.waitingTitle, systemImage: "hourglass")
        } else {
            ContentUnavailableView(ConversationText.emptyTitle, systemImage: "bubble.left")
        }
    }

    private var thread: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                VStack(spacing: 0) {
                    LazyVStack(alignment: .leading, spacing: 14) {
                        ForEach(model.rows) { row in
                            // Valeurs, pas le modèle : une publication ne réévalue
                            // que les lignes qui ont changé (S-18 R8).
                            SessionRowView(
                                row: row,
                                isOpen: model.isExpanded(row.id),
                                isThinkingOpen: model.isExpanded(SessionRowView.thinkingKey(of: row.id)),
                                onToggle: { [model] key in model.toggleFold(key) }
                            )
                            .equatable()
                            .id(row.id)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: 820)
                    .frame(maxWidth: .infinity)
                    Color.clear.frame(height: 0).id(viewerEndId)
                        // La distance au bas est mesurée par AppKit (le clip view de
                        // la `NSScrollView` poste un événement à chaque déplacement) :
                        // le modèle en déduit s'il est « au direct » ou si
                        // l'utilisateur a remonté le fil.
                        .background(
                            ScrollBottomObserver(
                                onGeometry: { geometry in model.reportBottomGap(geometry) },
                                onUserScroll: { deltaY in model.reportUserScroll(deltaY: deltaY) }
                            )
                        )
                }
            }
            // Le texte qui passe sous la barre de titre s'estompe (effet de bord
            // du système) au lieu de se superposer au titre.
            .scrollEdgeEffectStyle(.soft, for: .top)
            .accessibilityIdentifier("viewer.thread")
            .onAppear {
                // À l'ouverture, le fil se lit par la FIN : la demande de
                // défilement initiale du modèle est déjà posée quand la vue
                // apparaît, et `onChange` ne voit pas la valeur initiale.
                guard let last = model.rows.last else { return }
                proxy.scrollTo(last.id, anchor: .bottom)
                proxy.scrollTo(viewerEndId, anchor: .bottom)
            }
            .onChange(of: model.scrollRequest) { _, _ in
                // Le motif de défilement du dépôt : `ScrollViewReader` +
                // `scrollTo(…, anchor: .bottom)`.
                guard let last = model.rows.last else { return }
                proxy.scrollTo(last.id, anchor: .bottom)
                proxy.scrollTo(viewerEndId, anchor: .bottom)
            }
        }
    }
}
