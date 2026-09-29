// Le contenu d'une fenêtre de visionneuse (S-5, S-6 de la feature
// `visionneuse-de-session`) : bandeau d'état, flux des faits, placeholders des
// états vides, bouton « Revenir au direct ».
//
// Le titre de la fenêtre est `target.title`, figé à l'ouverture ; une valeur
// absente (choix « File > Nouveau » du menu macOS, qui ne fournit aucune valeur)
// rend un contenu de remplacement, jamais une fenêtre muette.
//
// Le flux est mesuré : la distance au bas du fil est publiée par une préférence
// (macOS 14 n'a pas `onScrollGeometryChange`, et `scrollPosition(id:)` ne rapporte
// pas une distance — Documentation §2), et le modèle décide du suivi.
//
// Aucun attribut macro SwiftUI (Documentation §3) : l'état vit dans
// `SessionViewerModel`, et `@StateObject` — une vraie property wrapper — l'alloue
// par fenêtre.

import SwiftUI

/// Le repère de FIN de fil : un zéro de hauteur après tout le contenu, y compris
/// son rembourrage. Défiler jusqu'au dernier FAIT laissait un reste mesuré (le
/// rembourrage et le reliquat de la dernière ligne), donc une distance au bas non
/// nulle — que la politique de suivi interprétait comme « l'utilisateur a remonté
/// le fil ».
private let viewerEndId = "viewer.end"

/// Le contenu de la scène : il traite la valeur absente, donne son titre à la
/// fenêtre, et ne construit le modèle que lorsqu'il y a une session à afficher.
struct SessionViewerView: View {
    let target: Binding<ViewerTarget?>

    var body: some View {
        Group {
            if let value = target.wrappedValue {
                SessionViewerContent(target: value)
            } else {
                ViewerNotice(text: "Choisissez un run dans la section Sessions.")
            }
        }
        .navigationTitle(target.wrappedValue?.title ?? "Visionneuse de session")
        .frame(minWidth: 560, minHeight: 400)
    }
}

/// Le contenu d'UNE session : son modèle vit ici, et nulle part ailleurs.
struct SessionViewerContent: View {
    @StateObject private var model: SessionViewerModel

    init(target: ViewerTarget) {
        // Évalué UNE fois par fenêtre : SwiftUI alloue un stockage neuf par
        // instance de `WindowGroup(for:)`, donc chaque visionneuse a son modèle.
        _model = StateObject(wrappedValue: SessionViewerModel(target: target))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(statusText)
                .font(.system(.callout, design: .monospaced))
                .accessibilityIdentifier("viewer.status")
            placeholder
            Divider()
            thread
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay(alignment: .bottomTrailing) { returnToLiveButton }
        .onDisappear { model.stop() }
    }

    // MARK: - Bandeau d'état

    /// Le bandeau est TOUJOURS là : le nombre de faits, les entrées ignorées, l'état
    /// du suivi, et ce que l'état de lecture ajoute
    private var statusText: String {
        var text = "\(model.rows.count) faits · \(model.ignoredCount) ignorés · "
        text += model.following ? "suivi" : "suivi suspendu"
        switch model.state {
        case .waiting: text += " · en attente"
        case .unreadable: text += " · erreur de lecture"
        case .ready: break
        }
        if model.reconstructions > 0 { text += " · fichier réécrit — affichage reconstruit" }
        return text
    }

    /// Un état sans texte n'existe pas : l'erreur de lecture s'affiche MÊME quand des
    /// faits sont déjà affichés (on n'efface jamais un fait lu), l'attente et le vide
    /// n'ont de sens que sans aucune ligne.
    @ViewBuilder private var placeholder: some View {
        if case .unreadable(let message) = model.state {
            ViewerNotice(text: "Session illisible : \(message). Nouvelle tentative automatique.")
        } else if model.rows.isEmpty {
            switch model.state {
            case .waiting:
                ViewerNotice(text: "en attente des premiers faits")
            default:
                ViewerNotice(text: "Session vide — aucun fait.")
            }
        }
    }

    // MARK: - Flux

    private var thread: some View {
        GeometryReader { outer in
            ScrollViewReader { proxy in
                ScrollView([.vertical, .horizontal]) {
                    VStack(alignment: .leading, spacing: 0) {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(model.rows) { row in
                            SessionRowView(row: row, model: model)
                                .id(row.id)
                        }
                    }
                    .frame(minWidth: outer.size.width, alignment: .leading)
                    .padding(8)
                    Color.clear.frame(height: 0).id(viewerEndId)
                    // La distance au bas est mesurée par AppKit (le clip view de la
                    // `NSScrollView` poste un événement à chaque déplacement) : le
                    // modèle en déduit s'il est « au direct » ou si l'utilisateur a
                    // remonté le fil (Documentation §2, corrigée par mesure).
                    .background(
                        ScrollBottomObserver(
                            onGeometry: { geometry in model.reportBottomGap(geometry) },
                            onUserScroll: { deltaY in model.reportUserScroll(deltaY: deltaY) }
                        )
                    )
                    }
                }
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
        .frame(minHeight: 240)
    }

    @ViewBuilder private var returnToLiveButton: some View {
        if !model.following, !model.rows.isEmpty {
            Button("Revenir au direct") { model.returnToLive() }
                .buttonStyle(.borderedProminent)
                .padding(12)
                .accessibilityIdentifier("viewer.returnToLive")
        }
    }
}

/// Le texte d'un état vide ou d'une erreur, cadré sur la largeur.
struct ViewerNotice: View {
    let text: String

    var body: some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
