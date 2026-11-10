// L'« OS agentique » : le langage visuel commun au Mac et à l'iPhone/iPad. Un état = un
// symbole et une couleur (`OSPhaseMark`), une carte du fil (`OSCard`), une étiquette
// (`OSTag`), et OÙ et SUR QUOI travaille un agent (`OSPlace`). Les repères qui se lisent sans
// mot (le chemin d'une feature, les compteurs, les anneaux) sont dans `OSGlyphs.swift`.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// L'état d'un agent ou d'un fil en un symbole : il tourne quand l'agent travaille.
public struct OSPhaseMark: View {
    let phase: OSPhase
    let size: CGFloat

    public init(phase: OSPhase, size: CGFloat = 15) {
        self.phase = phase
        self.size = size
    }

    public var body: some View {
        Image(systemName: phase.symbol)
            .font(.system(size: size, weight: .semibold))
            .foregroundStyle(phase.color)
            .symbolEffect(.rotate, options: .repeat(.continuous), isActive: phase == .working)
            .frame(width: size + 6, height: size + 6)
            .accessibilityLabel(phase.label)
    }
}

/// Une carte du fil : un liseré de couleur, un contenu, rien d'autre.
public struct OSCard<Content: View>: View {
    let tint: Color
    let emphasized: Bool
    let content: Content

    public init(tint: Color = .secondary, emphasized: Bool = false, @ViewBuilder content: () -> Content) {
        self.tint = tint
        self.emphasized = emphasized
        self.content = content()
    }

    public var body: some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(emphasized ? tint.opacity(0.08) : Color.primary.opacity(0.03))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(emphasized ? tint.opacity(0.6) : Color.primary.opacity(0.08))
            )
    }
}

/// Une étiquette courte : un symbole et un mot.
public struct OSTag: View {
    let text: String
    let symbol: String?
    let tint: Color

    public init(text: String, symbol: String? = nil, tint: Color = .secondary) {
        self.text = text
        self.symbol = symbol
        self.tint = tint
    }

    public var body: some View {
        HStack(spacing: 4) {
            if let symbol { Image(systemName: symbol).accessibilityHidden(true) }
            Text(text)
        }
        .font(.caption.weight(.medium))
        .foregroundStyle(tint)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(tint.opacity(0.12)))
    }
}

/// OÙ et SUR QUOI travaille un agent, en étiquettes : la machine, le dépôt et sa branche,
/// l'étape et le modèle d'une feature ; le navigateur d'une demande au poste.
public struct OSPlace: View {
    public enum Subject {
        case run(HarnessRun)
        /// Une demande au poste, et le nom de son navigateur quand le poste le connaît.
        case request(WorkstationRequest, browser: String?)
    }

    let subject: Subject

    public init(subject: Subject) {
        self.subject = subject
    }

    public var body: some View {
        OSLine(spacing: 6, gestures: false) {
            switch subject {
            case let .run(run):
                OSTag(text: OSText.vps, symbol: "server.rack")
                OSTag(text: run.repo, symbol: "shippingbox", tint: .accentColor)
                OSTag(text: run.branch ?? "harness/" + run.slug, symbol: "arrow.triangle.branch")
                OSTag(text: run.osState, symbol: "flag")
                if let model = run.osModel {
                    OSTag(text: model, symbol: "cpu")
                }
                if let pr = run.osPR, let url = run.prUrl.flatMap(URL.init(string:)) {
                    Link(destination: url) {
                        OSTag(text: pr, symbol: "arrow.up.right.square", tint: .accentColor)
                    }
                }
            case let .request(request, browser):
                let onServer = request.browserId == WorkstationBrowser.serverID
                OSTag(text: onServer ? OSText.vpsBrowser : OSText.yourChrome, symbol: onServer ? "server.rack" : "desktopcomputer")
                OSTag(text: browser ?? request.browserId ?? OSText.defaultBrowser, symbol: "globe", tint: .accentColor)
                OSTag(text: OSText.poste, symbol: "hand.point.up.left")
            }
        }
        .lineLimit(1)
    }
}

/// Une tuile : une valeur en grand, son mot dessous, et au besoin un symbole à côté de la
/// valeur (une tendance). Une valeur absente se lit « — », en gris. Une valeur qui est une
/// part (`share`, de 0 à 1) s'inscrit dans un anneau qui se remplit.
struct OSTile: View {
    /// Le symbole posé à côté de la valeur : son nom, sa couleur, ce que VoiceOver en dit.
    struct Mark {
        let symbol: String
        let tint: Color
        let label: String
    }

    let value: String?
    let label: String
    var tint: Color = .primary
    var mark: Mark?
    var share: Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .center, spacing: 6) {
                if let share, let value {
                    OSRing(fraction: share, tint: tint, size: 56) {
                        Text(value)
                            .font(.system(size: 12, weight: .bold, design: .rounded).monospacedDigit())
                            .lineLimit(1)
                            .minimumScaleFactor(0.6)
                    }
                } else {
                    Text(value ?? OSWatchText.none)
                        .font(.system(size: 26, weight: .semibold, design: .rounded).monospacedDigit())
                        .foregroundStyle(value == nil ? Color.secondary : tint)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                if let mark {
                    Image(systemName: mark.symbol)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(mark.tint)
                        .accessibilityLabel(mark.label)
                }
            }
            // Sur l'iPhone, trois ou quatre tuiles se partagent la largeur : le mot passe à la
            // ligne plutôt que d'être coupé, et les tuiles gardent la même hauteur.
            #if os(macOS)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            #else
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            #endif
        }
        #if os(macOS)
        .frame(maxWidth: .infinity, alignment: .leading)
        #else
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        #endif
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
        .accessibilityElement(children: .combine)
    }
}

extension View {
    /// Un texte de l'agent ou de l'humain, sélectionnable sur le Mac. Sur iOS, seules les
    /// specs, la fiche d'un souvenir et le direct le sont (ios-gestes-et-retours-natifs).
    @ViewBuilder
    func osSelectable() -> some View {
        #if os(macOS)
        textSelection(.enabled)
        #else
        self
        #endif
    }

    /// La taille d'une feuille sur le Mac ; l'iPhone et l'iPad gardent celle du système.
    @ViewBuilder
    func osSheetSize(width: CGFloat, minHeight: CGFloat) -> some View {
        #if os(macOS)
        frame(width: width).frame(minHeight: minHeight)
        #else
        self
        #endif
    }

    /// Un menu à sa taille sur le Mac ; sur l'iPhone et l'iPad, il se serre dans la largeur de
    /// l'écran aux grandes tailles de texte.
    @ViewBuilder
    func osFixedSize() -> some View {
        #if os(macOS)
        fixedSize()
        #else
        fixedSize(horizontal: false, vertical: true)
        #endif
    }

    /// La marge d'une page : celle du Mac, ou celle d'un écran d'iPhone ou d'iPad (16 pt).
    @ViewBuilder
    func osPagePadding(_ mac: CGFloat) -> some View {
        #if os(macOS)
        padding(mac)
        #else
        padding(16)
        #endif
    }

    /// Un geste sans cadre (« Lire », « Comprendre › », un symbole seul) : le bouton sans
    /// bordure du Mac ; sur l'iPhone et l'iPad, le même, dont la cible fait au moins 44 pt.
    @ViewBuilder
    func osBorderless() -> some View {
        #if os(macOS)
        buttonStyle(.borderless)
        #else
        buttonStyle(OSTouchLinkStyle())
        #endif
    }

    /// Un bouton seul dans une rangée : sur l'iPhone et l'iPad il porte le cadre du système à
    /// la taille du doigt (sans cadre, la rangée entière d'un formulaire le déclencherait) ;
    /// le Mac garde son bouton par défaut.
    @ViewBuilder
    func osRowButton() -> some View {
        #if os(macOS)
        self
        #else
        buttonStyle(.bordered)
            .controlSize(.large)
        #endif
    }
}

/// Une rangée de gestes ou d'étiquettes : une ligne sur le Mac ; sur l'iPhone et l'iPad,
/// elle passe à la ligne quand la largeur manque. `gestures` : ses boutons prennent la
/// taille du doigt (cadre du système, 44 pt au moins) ; sans eux, une rangée d'étiquettes.
struct OSLine<Content: View>: View {
    let spacing: CGFloat
    let gestures: Bool
    let content: Content

    init(spacing: CGFloat = 8, gestures: Bool = true, @ViewBuilder content: () -> Content) {
        self.spacing = spacing
        self.gestures = gestures
        self.content = content()
    }

    var body: some View {
        #if os(macOS)
        HStack(spacing: spacing) { content }
        #else
        if gestures {
            OSFlow(spacing: spacing) { content }
                .buttonStyle(.bordered)
                .controlSize(.large)
        } else {
            OSFlow(spacing: spacing) { content }
        }
        #endif
    }
}

#if os(iOS)
/// Le bouton sans bordure de l'iPhone et de l'iPad : le libellé teinté, dans une cible de
/// 44 pt au moins.
struct OSTouchLinkStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
            .frame(minWidth: ConsolePlatform.minimumTarget, minHeight: ConsolePlatform.minimumTarget)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.5 : 1)
    }
}
#endif
