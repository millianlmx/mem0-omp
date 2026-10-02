// Le rendu de l'avancement (`PipelineProgress.steps(for:)`) : une barre à cinq
// segments sur les cartes, une frise légendée dans la feuille de détail. Une
// étape n'est JAMAIS un contrôle : ni bouton radio ni case, seulement des formes
// et des symboles (l'ancienne liste à pastilles ressemblait à un choix).

import SwiftUI

private extension PipelineStepState {
    var tint: Color {
        switch self {
        case .done: .green
        case .current: .accentColor
        case .failed: .red
        case .upcoming: Color.secondary.opacity(0.25)
        }
    }

    var word: String {
        switch self {
        case .done: "fait"
        case .current: "en cours"
        case .failed: "en échec"
        case .upcoming: "à venir"
        }
    }
}

/// Cinq segments : l'avancement d'une carte en un coup d'œil.
struct PipelineProgressBar: View {
    let steps: [PipelineStep]

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                Capsule()
                    .fill(step.state.tint)
                    .frame(height: 4)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.accessibilityText(steps))
    }

    static func accessibilityText(_ steps: [PipelineStep]) -> String {
        steps.map { "\($0.title) : \($0.state.word)" }.joined(separator: ", ")
    }
}

/// La frise de la feuille de détail : un symbole par étape relié au suivant,
/// le nom dessous.
struct PipelineStepper: View {
    let steps: [PipelineStep]

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.offset) { index, step in
                VStack(spacing: 6) {
                    HStack(spacing: 0) {
                        connector(visible: index > 0, done: index > 0 && steps[index - 1].state == .done)
                        symbol(step.state)
                        connector(visible: index < steps.count - 1, done: step.state == .done)
                    }
                    Text(step.title)
                        .font(.caption)
                        .fontWeight(step.state == .current ? .semibold : .regular)
                        .foregroundStyle(step.state == .upcoming ? .secondary : .primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(PipelineProgressBar.accessibilityText(steps))
    }

    @ViewBuilder
    private func symbol(_ state: PipelineStepState) -> some View {
        Group {
            switch state {
            case .done: Image(systemName: "checkmark.circle.fill")
            case .current: Image(systemName: "circle.inset.filled")
            case .failed: Image(systemName: "xmark.circle.fill")
            case .upcoming: Image(systemName: "circle")
            }
        }
        .font(.title3)
        .foregroundStyle(state == .upcoming ? AnyShapeStyle(.tertiary) : AnyShapeStyle(state.tint))
    }

    private func connector(visible: Bool, done: Bool) -> some View {
        Rectangle()
            .fill(visible ? (done ? Color.green : Color.secondary.opacity(0.25)) : .clear)
            .frame(height: 2)
            .frame(maxWidth: .infinity)
    }
}
