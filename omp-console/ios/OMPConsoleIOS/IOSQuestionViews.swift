// Les pièces d'une question SITUÉE de la boîte iOS (escalade à trancher, décision
// prise seule, specs ou verdict à valider) — pendant de
// `Sources/OMPConsole/Server/HarnessQuestionViews.swift` : l'humain pilote
// plusieurs projets et lit chaque question hors de la session de l'agent.
//
// - `IOSQuestionPlaceView` : dépôt › feature › étape, puis la demande d'origine,
//   repliée ;
// - `IOSContextView` : la situation décrite par l'agent, en Markdown complet ;
// - `IOSChoiceRow` : une option, son impact et sa marque, touchable d'un doigt.
//
// Contrôles SYSTÈME uniquement ; les mots viennent de `PipelineServerText`, les
// textes de l'agent passent par `MarkdownDocument` (aucun `**` à l'écran).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// D'où vient la question : le dépôt, la feature, l'étape ; puis ce que la feature
/// devait livrer, replié sous « Demande d'origine ».
struct IOSQuestionPlaceView: View {
    let place: HarnessQuestion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(PipelineServerText.trail(place.trail), systemImage: PipelineServerText.trailSymbol)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.secondary)
            if place.request != nil || !place.modules.isEmpty {
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 6) {
                        if let request = place.request {
                            IOSMarkdownView(blocks: MarkdownDocument.blocks(request))
                        }
                        if !place.modules.isEmpty {
                            Text(PipelineServerText.touches(place.modules))
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                        }
                    }
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
struct IOSContextView: View {
    let context: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(PipelineServerText.contextTitle, systemImage: PipelineServerText.contextSymbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let context {
                IOSMarkdownView(blocks: MarkdownDocument.blocks(context))
            } else {
                Text(PipelineServerText.noContext)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(uiColor: .tertiarySystemFill), in: .rect(cornerRadius: IOSSurface.cardRadius))
    }
}

/// Un texte de l'agent sous un intitulé : la raison d'une recommandation ou d'un choix.
struct IOSReasonView: View {
    let title: String
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            IOSMarkdownView(blocks: MarkdownDocument.blocks(text))
        }
    }
}

/// Une option : son libellé, sa marque, ce qu'elle emporte. Touchable quand
/// `select` est donné (escalade) ; sinon une simple ligne (décision prise seule).
struct IOSChoiceRow: View {
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
                Text(MarkdownDocument.inline(choice.option))
                    .font(.body.weight(.semibold))
                if choice.isPreferred {
                    Text(badge)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.green)
                }
                if let impact = choice.impact {
                    Text(MarkdownDocument.inline(impact))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
        .contentShape(.rect)
        .background(Color(uiColor: .secondarySystemGroupedBackground), in: .rect(cornerRadius: IOSSurface.cardRadius))
        .overlay {
            RoundedRectangle(cornerRadius: IOSSurface.cardRadius)
                .strokeBorder(selected ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(Color(uiColor: .separator)), lineWidth: selected ? 2 : 0.5)
        }
    }
}
