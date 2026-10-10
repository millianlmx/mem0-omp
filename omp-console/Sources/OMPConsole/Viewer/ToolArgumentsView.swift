// La section « Arguments » d'un appel d'outil déplié, en clé/valeur
// (visionneuse-appels-outils-lisibles, S-5) : la lecture `ToolArguments` du noyau
// devient une ligne par `ArgumentLine`, en retrait de `depth` niveaux.
//
// Trois états : « Aucun argument » (sans détail brut), « Arguments illisibles »,
// ou les champs. Les deux derniers offrent le détail brut, REPLIÉ par défaut.
//   — un groupe (objet ou liste non vide) : son libellé seul, en secondaire ;
//   — une valeur simple : UN texte « libellé : valeur », police système ;
//   — une valeur « code » : le libellé, puis la valeur à chasse fixe dessous.
// Une valeur longue montre son extrait et « Afficher plus », qui la montre entière.
//
// L'état (lignes dépliées, détail brut) vit ici : la vue n'existe que tant que
// l'appel est déplié, donc le replier l'oublie.

import ConsoleCore
import SwiftUI

struct ToolArgumentsView: View {
    let rowId: String
    let arguments: ToolArguments
    /// Les lignes dont la valeur longue est montrée entière.
    @State private var expanded: Set<String> = []
    /// Le détail brut est déplié.
    @State private var rawShown: Bool

    /// Le retrait d'un niveau de hiérarchie.
    private static let indent: CGFloat = 16

    /// `rawShown` fixe l'état initial du détail brut (le fil le laisse replié).
    init(rowId: String, arguments: ToolArguments, rawShown: Bool = false) {
        self.rowId = rowId
        self.arguments = arguments
        _rawShown = State(initialValue: rawShown)
    }

    private var baseId: String { "viewer.toolcall.\(rowId).args" }

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
        .accessibilityIdentifier(baseId)
    }

    private func status(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier("\(baseId).status")
    }

    private func lineView(_ line: ArgumentLine) -> some View {
        let isCut = line.excerpt != nil && !expanded.contains(line.id)
        return VStack(alignment: .leading, spacing: 2) {
            switch line.value {
            case .group:
                Text(line.label)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            case .plain(let value):
                Text(Self.labeled(line.label, isCut ? line.excerpt ?? value : value))
                    .font(.callout)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            case .code(let value):
                Text(ToolArgumentsText.codeLabel(line.label))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                MonospacedText(isCut ? line.excerpt ?? value : value)
            }
            if isCut {
                Button(ToolArgumentsText.showMore) {
                    _ = expanded.insert(line.id)
                }
                .buttonStyle(.link)
                .font(.callout)
                .accessibilityIdentifier("\(baseId).\(line.id).more")
            }
        }
        .padding(.leading, CGFloat(line.depth) * Self.indent)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("\(baseId).\(line.id)")
    }

    /// Le bouton du détail brut et, déplié, le texte d'origine entier.
    @ViewBuilder
    private var rawDetail: some View {
        if let raw = arguments.raw {
            Button(rawShown ? ToolArgumentsText.hideRaw : ToolArgumentsText.showRaw) {
                rawShown.toggle()
            }
            .buttonStyle(.link)
            .font(.callout)
            .accessibilityIdentifier("\(baseId).rawToggle")
            if rawShown {
                MonospacedText(raw)
                    .accessibilityIdentifier("\(baseId).raw")
            }
        }
    }

    /// « libellé : valeur » en UN texte (Doc D-2 : pas de `Text + Text`) : le
    /// libellé et le séparateur en secondaire, la valeur en primaire. Une chaîne
    /// passée à `AttributedString(_:)` n'est jamais lue comme du Markdown.
    private static func labeled(_ label: String, _ value: String) -> AttributedString {
        var head = AttributedString(label + ToolArgumentsText.separator)
        head[AttributeScopes.SwiftUIAttributes.ForegroundColorAttribute.self] = Color.secondary
        return head + AttributedString(value)
    }
}
