// L'« OS agentique » : le langage visuel commun au Mac et à l'iPhone/iPad. Un état = un
// symbole et une couleur (`OSPhaseMark`), le chemin d'une feature en cinq points
// (`OSStepDots`), une carte du fil (`OSCard`), une étiquette (`OSTag`), et OÙ et SUR QUOI
// travaille un agent (`OSPlace`).

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

/// Le chemin d'une feature en cinq points : fait, en cours, à venir.
public struct OSStepDots: View {
    let run: HarnessRun

    public init(run: HarnessRun) {
        self.run = run
    }

    public var body: some View {
        let current = OSThreads.stepIndex(of: run)
        let merged = run.phase == .merged
        HStack(spacing: 4) {
            ForEach(0..<5, id: \.self) { index in
                Circle()
                    .fill(index < current || merged ? Color.green : index == current ? Color.accentColor : Color.secondary.opacity(0.25))
                    .frame(width: 7, height: 7)
                    .help(OSText.steps[index])
            }
        }
        .accessibilityLabel(OSText.steps[current])
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
            if let symbol { Image(systemName: symbol) }
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
        HStack(spacing: 6) {
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
}
