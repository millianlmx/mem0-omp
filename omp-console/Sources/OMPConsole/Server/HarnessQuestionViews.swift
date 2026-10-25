// Les pièces d'une question SITUÉE de la boîte (escalade à trancher, décision prise
// seule, specs ou verdict à valider) : l'humain pilote plusieurs projets et lit
// chaque question hors de la session de l'agent.
//
// - `HarnessQuestionPlaceView` : le fil d'Ariane dépôt › feature › étape, puis la
//   demande d'origine de la feature, repliée ;
// - `HarnessContextView` : la situation décrite par l'agent, rendue en Markdown
//   complet (listes, code, citations) ;
// - `HarnessChoiceRow` : une option, son impact et sa marque (recommandée,
//   retenue), sélectionnable d'un clic.
//
// Les textes de l'agent passent tous par `MarkdownDocument` : aucun `**` ni
// accent grave ne reste à l'écran. Les mots viennent de `PipelineServerText`.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// D'où vient la question : le dépôt, la feature, l'étape ; puis ce que la feature
/// devait livrer, replié sous « Demande d'origine ».
struct HarnessQuestionPlaceView: View {
    let place: HarnessQuestion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(PipelineServerText.trail(place.trail), systemImage: PipelineServerText.trailSymbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
            if place.request != nil || !place.modules.isEmpty {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 6) {
                        if let request = place.request {
                            MarkdownBlocksView(markdown: request)
                        }
                        if !place.modules.isEmpty {
                            Text(PipelineServerText.touches(place.modules))
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                        }
                    }
                    .padding(.top, 4)
                } label: {
                    Label(PipelineServerText.originalRequest, systemImage: PipelineServerText.requestSymbol)
                        .font(.callout)
                }
            }
        }
    }
}

/// La situation décrite par l'agent, sur une surface à part ; à défaut, le renvoi
/// à la demande d'origine.
struct HarnessContextView: View {
    let context: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(PipelineServerText.contextTitle, systemImage: PipelineServerText.contextSymbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let context {
                MarkdownBlocksView(markdown: context)
            } else {
                Text(PipelineServerText.noContext)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.35), in: .rect(cornerRadius: ConsoleSurface.cardRadius))
    }
}

/// Un texte de l'agent sous un intitulé : la raison d'une recommandation ou d'un choix.
struct HarnessReasonView: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            MarkdownBlocksView(markdown: text)
                .font(.callout)
        }
    }
}

/// Une option : son libellé, sa marque, ce qu'elle emporte. Sélectionnable quand
/// `select` est donné (escalade) ; sinon une simple ligne (décision prise seule).
struct HarnessChoiceRow: View {
    let choice: HarnessChoice
    /// La marque de l'option préférée par l'agent : « Recommandée » ou « Retenue ».
    let badge: String
    let selected: Bool
    var select: (@MainActor () -> Void)?

    var body: some View {
        if let select {
            Button { select() } label: { card }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
        } else {
            card
        }
    }

    private var card: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: selected ? PipelineServerText.chosenSymbol : PipelineServerText.optionSymbol)
                .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(MarkdownDocument.inline(choice.option))
                        .fontWeight(.semibold)
                        .fixedSize(horizontal: false, vertical: true)
                    if choice.isPreferred {
                        Text(badge)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.green)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Color.green.opacity(0.12), in: .capsule)
                    }
                }
                if let impact = choice.impact {
                    Text(MarkdownDocument.inline(impact))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(.rect)
        .consoleCard(selected: selected)
    }
}
