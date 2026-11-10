import ConsoleClient
import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Le point d'entrée de l'extension de partage (`NSExtensionPrincipalClass`) : il lit
/// ce que l'app d'origine partage, montre la feuille SwiftUI, puis rend la main.
final class OMPShareViewController: UIViewController {
    private let model = OMPShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: OMPShareView(model: model) { [weak self] sent in self?.finish(sent) })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        let items = extensionContext?.inputItems.compactMap { $0 as? NSExtensionItem } ?? []
        Task { model.received(await OMPShareItems.draft(from: items)) }
    }

    private func finish(_ sent: Bool) {
        if sent {
            extensionContext?.completeRequest(returningItems: nil)
        } else {
            extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
        }
    }
}

/// La lecture de ce qui est partagé : la première page web, le premier texte, et le
/// titre que l'app d'origine donne (Safari met celui de la page dans le texte d'accompagnement).
enum OMPShareItems {
    @MainActor
    static func draft(from items: [NSExtensionItem]) async -> HarnessShareDraft {
        var url: String?
        var text: String?
        var title: String?
        var note: String?
        for item in items {
            title = title ?? item.attributedTitle?.string
            note = note ?? item.attributedContentText?.string
            for provider in item.attachments ?? [] {
                if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    url = await load(URL.self, from: provider)?.absoluteString
                } else if text == nil, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    text = await load(String.self, from: provider)
                }
            }
        }
        // Avec une page, le texte d'accompagnement est son titre ; seul, il est le texte partagé.
        return HarnessShareDraft(url: url, title: title ?? (url == nil ? nil : note), text: text ?? (url == nil ? note : nil))
    }

    /// Une valeur d'un élément partagé ; `nil` si l'app d'origine ne la donne pas.
    private static func load<Value>(_ type: Value.Type, from provider: NSItemProvider) async -> Value?
    where Value: _ObjectiveCBridgeable, Value._ObjectiveCType: NSItemProviderReading {
        await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: type) { value, _ in continuation.resume(returning: value) }
        }
    }
}
