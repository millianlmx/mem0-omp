// La section « Arguments » d'un appel d'outil déplié, en clé/valeur
// (visionneuse-appels-outils-lisibles, S-5) : la lecture `ToolArguments` du noyau
// devient une ligne par `ArgumentLine`, en retrait de `depth` niveaux.
//
// Trois états : aucun argument (sans détail brut), arguments illisibles, ou les
// champs. Les deux derniers offrent le détail brut, REPLIÉ par défaut.
//   — un groupe (objet ou liste non vide) : son libellé seul, en secondaire ;
//   — une valeur simple : UN texte « libellé : valeur », police système ;
//   — une valeur « code » : le libellé, puis la valeur à chasse fixe dessous.
// Une valeur longue montre l'EXTRAIT du noyau (troncature de contenu, jamais un
// plafond de lignes), puis un bouton qui la montre entière.
//
// L'état (lignes dépliées, détail brut) vit ici : la vue n'existe que tant que
// l'appel est déplié, donc le replier l'oublie. Aucun littéral alphabétique : les
// mots viennent de `ToolArgumentsText`, les identifiants d'`IOSSessionsAccessibility`.

import ConsoleCore
import SwiftUI

struct IOSToolArgumentsView: View {
    let rowId: String
    let arguments: ToolArguments
    /// Les lignes dont la valeur longue est montrée entière.
    @State private var expanded: Set<String> = []
    /// Le détail brut est déplié.
    @State private var rawShown = false
    /// Le retrait d'un niveau de hiérarchie, qui suit Dynamic Type.
    @ScaledMetric(relativeTo: .callout) private var indent: CGFloat = 16

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch arguments.content {
            case .none:
                status(ToolArgumentsText.none)
            case .unreadable:
                status(ToolArgumentsText.unreadable)
                rawDetail
            case .fields(let lines):
                ForEach(lines) { line in
                    lineView(line)
                }
                rawDetail
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSSessionsAccessibility.toolArguments(rowId))
    }

    private func status(_ words: String) -> some View {
        Text(words)
            .font(.callout)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier(IOSSessionsAccessibility.argumentsStatus(rowId))
    }

    private func lineView(_ line: ArgumentLine) -> some View {
        let isCut = line.excerpt != nil && !expanded.contains(line.id)
        return VStack(alignment: .leading, spacing: 2) {
            switch line.value {
            case .group:
                Text(line.label)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            case .plain(let value):
                Text(Self.labeled(line.label, isCut ? line.excerpt ?? value : value))
                    .font(.callout)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .code(let value):
                Text(ToolArgumentsText.codeLabel(line.label))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
                IOSMonospacedText(isCut ? line.excerpt ?? value : value)
            }
            if isCut {
                Button(ToolArgumentsText.showMore) {
                    _ = expanded.insert(line.id)
                }
                .buttonStyle(.borderless)
                .font(.callout)
                .frame(minHeight: IOSMetrics.minimumTarget, alignment: .leading)
                .accessibilityIdentifier(IOSSessionsAccessibility.argumentMore(rowId, line.id))
            }
        }
        .padding(.leading, CGFloat(line.depth) * indent)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSSessionsAccessibility.argumentLine(rowId, line.id))
    }

    /// Le bouton du détail brut et, déplié, le texte d'origine entier.
    @ViewBuilder
    private var rawDetail: some View {
        if let raw = arguments.raw {
            Button(rawShown ? ToolArgumentsText.hideRaw : ToolArgumentsText.showRaw) {
                rawShown.toggle()
            }
            .buttonStyle(.borderless)
            .font(.callout)
            .frame(minHeight: IOSMetrics.minimumTarget, alignment: .leading)
            .accessibilityIdentifier(IOSSessionsAccessibility.argumentsRawToggle(rowId))
            if rawShown {
                IOSMonospacedText(raw)
                    .accessibilityIdentifier(IOSSessionsAccessibility.argumentsRaw(rowId))
            }
        }
    }

    /// « libellé : valeur » en UN texte (Doc D-2 : ni `Text + Text`, ni
    /// interpolation de `Text`) : le libellé et le séparateur en secondaire, la
    /// valeur en primaire. `AttributedString(_:)` ne lit jamais de Markdown.
    private static func labeled(_ label: String, _ value: String) -> AttributedString {
        var head = AttributedString(label + ToolArgumentsText.separator)
        head[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = Color.secondary
        return head + AttributedString(value)
    }
}
