// Le SOCLE des écrans partagés Mac/iOS : ce que chaque app fournit (le rendu Markdown,
// le direct d'une session, les gestes propres à une plateforme sur une feature) et les
// quelques styles qui diffèrent d'une plateforme à l'autre — identifiants
// d'accessibilité (`ios.` sur iOS, comme les écrans propres à l'app), bandeau, carte,
// pastille d'état.
//
// Aucune macro (`@Entry`, `@State`, `#Preview`) : la cible se compile aussi sous les
// seuls Command Line Tools, comme l'app Mac. L'état d'écran vit dans `HarnessDrafts`.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Ce que l'app fournit aux écrans partagés, posé à sa racine par `.consoleShell(_:)`.
public struct ConsoleShell: Sendable {
    /// Le rendu d'un document Markdown découpé par le noyau.
    public var markdown: @MainActor @Sendable ([MarkdownBlock]) -> AnyView
    /// Le direct d'une session en feuille (`drafts.sessionRequest`) : l'analyse d'un
    /// audit, un job du poste. Une feature, elle, s'ouvre en page.
    public var session: @MainActor @Sendable (HarnessSessionRequest) -> AnyView
    /// Les gestes de la plateforme sur une feature (iPhone : la suivre sur l'écran
    /// verrouillé), ajoutés à son menu.
    public var runActions: @MainActor @Sendable (HarnessRun) -> AnyView
    /// Montrer une section : la racine de l'app tient la sélection.
    public var select: @MainActor @Sendable (ConsoleSection) -> Void

    public init(
        markdown: @escaping @MainActor @Sendable ([MarkdownBlock]) -> AnyView,
        session: @escaping @MainActor @Sendable (HarnessSessionRequest) -> AnyView,
        runActions: @escaping @MainActor @Sendable (HarnessRun) -> AnyView = { _ in AnyView(EmptyView()) },
        select: @escaping @MainActor @Sendable (ConsoleSection) -> Void = { _ in }
    ) {
        self.markdown = markdown
        self.session = session
        self.runActions = runActions
        self.select = select
    }
}

private struct ConsoleShellKey: EnvironmentKey {
    /// Sans app autour (une vue isolée) : le texte brut de chaque bloc, aucun direct.
    static let defaultValue = ConsoleShell(
        markdown: { blocks in AnyView(Text(verbatim: blocks.map { "\($0)" }.joined(separator: "\n"))) },
        session: { _ in AnyView(EmptyView()) }
    )
}

extension EnvironmentValues {
    public var consoleShell: ConsoleShell {
        get { self[ConsoleShellKey.self] }
        set { self[ConsoleShellKey.self] = newValue }
    }
}

/// Les déplacements communs aux deux apps : ouvrir la page d'une feature, une page du
/// hub Système, une portée de Features. `select` est celui de la racine.
public enum ConsoleNavigation {
    @MainActor
    public static func openRun(_ id: String, drafts: HarnessDrafts, select: @MainActor (ConsoleSection) -> Void) {
        drafts.runsScope = .features
        drafts.openedRun = id
        select(.runs)
    }

    @MainActor
    public static func open(_ page: SystemPage, drafts: HarnessDrafts, select: @MainActor (ConsoleSection) -> Void) {
        // Le Serveur est la feuille de connexion, ouverte d'où que l'on soit.
        if page == .server {
            drafts.serverSheetShown = true
            return
        }
        drafts.systemPage = page
        select(.system)
    }

    @MainActor
    public static func open(_ scope: RunsScope, drafts: HarnessDrafts, select: @MainActor (ConsoleSection) -> Void) {
        drafts.runsScope = scope
        drafts.openedRun = nil
        select(.runs)
    }
}

extension View {
    /// Pose le socle de l'app sous cette vue.
    public func consoleShell(_ shell: ConsoleShell) -> some View {
        environment(\.consoleShell, shell)
    }

    /// L'identifiant d'accessibilité d'un élément partagé : `ios.<nom>` sur iOS, `<nom>`
    /// sur le Mac (les recettes de chaque plateforme les cherchent ainsi).
    public func consoleID(_ name: String) -> some View {
        accessibilityIdentifier(ConsolePlatform.id(name))
    }

    /// Le bandeau d'un état : teinte du ton à 12 %, coins arrondis. Le mot porte le
    /// sens, la teinte le double.
    public func consoleBanner(tone: ConsoleTone) -> some View {
        padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tone.consoleTint.opacity(0.12), in: .rect(cornerRadius: ConsolePlatform.cardRadius))
    }

    /// La carte d'une option ou d'une feature : fond du système, filet, accent quand
    /// elle est choisie.
    public func consoleCardSurface(selected: Bool = false) -> some View {
        background(ConsolePlatform.cardFill, in: .rect(cornerRadius: ConsolePlatform.cardRadius))
            .overlay {
                RoundedRectangle(cornerRadius: ConsolePlatform.cardRadius)
                    .strokeBorder(selected ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.separator), lineWidth: selected ? 2 : 0.5)
            }
    }

    /// Le texte de l'agent ou du serveur, entier ; sélectionnable sur le Mac (sur iOS,
    /// seules les specs, la fiche d'un souvenir et le direct le sont).
    @ViewBuilder
    public func consoleReadable() -> some View {
        #if os(macOS)
        fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        #else
        fixedSize(horizontal: false, vertical: true)
        #endif
    }
}

/// Les mesures et identifiants propres à chaque plateforme.
public enum ConsolePlatform {
    public static func id(_ name: String) -> String {
        #if os(iOS)
        "ios." + name
        #else
        name
        #endif
    }

    public static let cardRadius: CGFloat = 12
    /// La cible tactile minimale (iOS) ; le pointeur du Mac n'en a pas besoin.
    #if os(iOS)
    public static let minimumTarget: CGFloat = 44
    #else
    public static let minimumTarget: CGFloat = 0
    #endif

    static var cardFill: AnyShapeStyle {
        #if os(iOS)
        AnyShapeStyle(Color(uiColor: .secondarySystemGroupedBackground))
        #else
        AnyShapeStyle(.background.secondary)
        #endif
    }

    /// Le fond d'une situation décrite par l'agent.
    static var contextFill: AnyShapeStyle {
        #if os(iOS)
        AnyShapeStyle(Color(uiColor: .tertiarySystemFill))
        #else
        AnyShapeStyle(.quaternary.opacity(0.35))
        #endif
    }
}

extension ConsoleTone {
    /// La teinte qui double le mot d'un état (celle de `StatusBadge` et `IOSStatusChip`).
    public var consoleTint: Color {
        switch self {
        case .neutral: .gray
        case .info: .blue
        case .attention: .orange
        case .success: .green
        case .danger: .red
        case .paused: .yellow
        }
    }
}

/// Un document Markdown rendu par l'app (`ConsoleShell.markdown`).
public struct ConsoleMarkdown: View {
    @Environment(\.consoleShell) private var shell
    let blocks: [MarkdownBlock]

    public init(blocks: [MarkdownBlock]) {
        self.blocks = blocks
    }

    public init(markdown: String) {
        self.blocks = MarkdownDocument.blocks(markdown)
    }

    public var body: some View {
        shell.markdown(blocks)
    }
}

/// La pastille d'un état : un point teinté et le mot, sur une capsule teintée.
public struct ConsoleStatusChip: View {
    let status: ConsoleStatus

    public init(status: ConsoleStatus) {
        self.status = status
    }

    public var body: some View {
        HStack(spacing: 5) {
            Circle()
                .fill(status.tone.consoleTint)
                .frame(width: 8, height: 8)
            Text(status.text)
                .foregroundStyle(.primary)
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(status.tone.consoleTint.opacity(0.15)))
        .accessibilityElement(children: .combine)
    }
}

/// L'échec du dernier échange, cause puis remède, en bandeau.
public struct ConsoleFailureBanner: View {
    let failure: HarnessFailure

    public init(failure: HarnessFailure) {
        self.failure = failure
    }

    public var body: some View {
        Label {
            Text(failure.message)
                .consoleReadable()
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
        .font(.callout)
        .consoleBanner(tone: .attention)
        .consoleID("server.failure")
    }
}

extension HarnessRun {
    /// Le ton qui double l'état : l'attente de l'humain se signale, l'échec alarme.
    public var tone: ConsoleTone {
        switch phase {
        case .running, .merging: .info
        case .escalated, .awaitingHuman: .attention
        case .merged: .success
        case .failed: .danger
        case .queued, .cancelled, nil: .neutral
        }
    }
}
