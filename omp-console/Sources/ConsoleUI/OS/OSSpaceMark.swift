// L'« OS agentique » : la PASTILLE d'un espace — le client pour qui l'on regarde ou l'on
// tranche, reconnu à sa couleur. La couleur est stable : tirée de l'identifiant de
// l'espace, dans une palette de six teintes qui ne disent aucun état (ni orange « à
// vous », ni bleu d'accent « au travail », ni vert « livré », ni rouge « en échec »). `OSSpaceLine` est la ligne de
// contexte qui commence par elle : « ● Client Acme · acme-web · Revue ».

import ConsoleClient
import ConsoleCore
import SwiftUI

/// La teinte d'un espace : pure, la même partout où l'espace se montre.
public enum OSSpacePalette {
    /// Les six teintes d'un espace, dans l'ordre de `slot(of:)`.
    public static let colors: [Color] = [.purple, .teal, .brown, .yellow, .indigo, .pink]

    /// Le rang (0…5) de la teinte d'un espace : une empreinte FNV-1a des octets de son
    /// identifiant, la même d'un lancement à l'autre et d'un appareil à l'autre.
    public static func slot(of spaceId: String) -> Int {
        var hash: UInt32 = 2_166_136_261
        for byte in spaceId.utf8 {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        return Int(hash % UInt32(colors.count))
    }

    /// La teinte d'un espace.
    public static func color(of spaceId: String) -> Color {
        colors[slot(of: spaceId)]
    }
}

/// La pastille de couleur d'un espace.
public struct OSSpaceMark: View {
    let spaceId: String
    let size: CGFloat

    public init(spaceId: String, size: CGFloat = 9) {
        self.spaceId = spaceId
        self.size = size
    }

    public init(space: HarnessSpace, size: CGFloat = 9) {
        self.init(spaceId: space.id, size: size)
    }

    public var body: some View {
        Circle()
            .fill(OSSpacePalette.color(of: spaceId))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// Une ligne de contexte : la pastille et le nom de l'espace, puis des mots séparés par un
/// point médian (le dépôt, la sorte ou l'état, le coût, l'ancienneté). Sans espace : les
/// mots seuls.
struct OSSpaceLine: View {
    /// Un mot de la ligne. `strong` le distingue (la sorte d'une décision, l'état d'un fil) :
    /// il s'écrit en clair et en gras — la couleur, elle, est portée par son symbole (`tint`),
    /// jamais par un petit texte teinté, illisible en thème clair.
    struct Item {
        var text: String
        var strong: Bool
        var tint: Color?
        var symbol: String?

        init(_ text: String, strong: Bool = false, tint: Color? = nil, symbol: String? = nil) {
            self.text = text
            self.strong = strong
            self.tint = tint
            self.symbol = symbol
        }
    }

    let space: HarnessSpace?
    let items: [Item]
    var font: Font = .caption

    var body: some View {
        // Sur l'iPhone, la ligne passe à la ligne plutôt que de couper un nom.
        OSLine(spacing: 5, gestures: false) {
            if let space {
                HStack(spacing: 5) {
                    OSSpaceMark(space: space)
                    Text(space.name).fontWeight(.semibold).foregroundStyle(.primary)
                }
            }
            ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                HStack(spacing: 5) {
                    if space != nil || index > 0 {
                        Text(verbatim: "·").accessibilityHidden(true)
                    }
                    if let symbol = item.symbol {
                        Image(systemName: symbol).foregroundStyle(item.tint ?? .secondary).accessibilityHidden(true)
                    }
                    Text(item.text)
                        .fontWeight(item.strong ? .semibold : .regular)
                        .foregroundStyle(item.strong ? .primary : .secondary)
                }
            }
        }
        .font(font)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .accessibilityElement(children: .combine)
    }
}

/// Le raccourci d'un geste, dit dans son bouton sur le Mac (« ⏎ », « → ») ; rien sur
/// l'iPhone et l'iPad, qui n'ont pas de clavier sous la main.
struct OSKeyHint: View {
    let key: String

    var body: some View {
        #if os(macOS)
        // Des styles hiérarchiques : la touche se lit sur un bouton gris comme sur un bouton plein.
        Text(verbatim: key)
            .font(.caption.weight(.medium))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(.tertiary))
            .accessibilityHidden(true)
        #else
        EmptyView()
        #endif
    }
}
