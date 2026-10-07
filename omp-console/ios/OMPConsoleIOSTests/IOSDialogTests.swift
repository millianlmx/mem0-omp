// Les preuves Swift des escalades de l'écran Projet (BR-5) : le gating par forme,
// le texte initial (le `prefill` d'un `editor`), le corps envoyé par forme, et le
// refus LOCAL d'une saisie blanche en `input`.

@testable import OMPConsoleIOS
import ConsoleClient
import Foundation
import Testing

@Suite("ios-projet — les escalades de projet")
struct IOSDialogTests {
    private func dialog(
        method: String,
        options: [String] = [],
        descriptions: [String?] = [],
        placeholder: String? = nil,
        prefill: String? = nil
    ) throws -> RpcDialogRequest {
        var object: [String: Any] = [
            "id": "d1",
            "method": method,
            "title": "Titre de la question",
            "options": options,
            "optionDescriptions": descriptions.map { (value: String?) -> Any in value.map { $0 as Any } ?? NSNull() },
            "promptStyle": false,
        ]
        if let placeholder { object["placeholder"] = placeholder }
        if let prefill { object["prefill"] = prefill }
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(RpcDialogRequest.self, from: data)
    }

    @Test("ios-projet/AC-5 : le gating suit la forme de l'escalade")
    func canAnswerPerForm() throws {
        let select = try dialog(method: "select", options: ["A", "B"])
        #expect(!IOSDialogGating.canAnswer(dialog: select, text: "", selectedIndex: nil))
        #expect(IOSDialogGating.canAnswer(dialog: select, text: "", selectedIndex: 1))
        #expect(!IOSDialogGating.canAnswer(dialog: select, text: "", selectedIndex: 5))

        let confirm = try dialog(method: "confirm")
        #expect(IOSDialogGating.canAnswer(dialog: confirm, text: "", selectedIndex: nil))

        let editor = try dialog(method: "editor")
        #expect(IOSDialogGating.canAnswer(dialog: editor, text: "", selectedIndex: nil))

        let input = try dialog(method: "input")
        #expect(!IOSDialogGating.canAnswer(dialog: input, text: "   ", selectedIndex: nil))
        #expect(!IOSDialogGating.canAnswer(dialog: input, text: "", selectedIndex: nil))
        #expect(IOSDialogGating.canAnswer(dialog: input, text: "texte", selectedIndex: nil))
    }

    @Test("ios-projet/AC-4 : le texte initial d'un editor est son prefill")
    func initialTextIsPrefillForEditor() throws {
        let editor = try dialog(method: "editor", prefill: "Plan courant\nligne 2")
        #expect(IOSDialogGating.initialText(dialog: editor) == "Plan courant\nligne 2")

        let emptyEditor = try dialog(method: "editor")
        #expect(IOSDialogGating.initialText(dialog: emptyEditor) == "")

        let input = try dialog(method: "input")
        #expect(IOSDialogGating.initialText(dialog: input) == "")
    }

    @Test("ios-projet — le corps envoyé porte le libellé de l'option, jamais l'indice")
    func requestBodyPerForm() throws {
        let select = try dialog(method: "select", options: ["A", "B recommandé"])
        let selected = IOSDialogGating.request(dialog: select, selectedIndex: 1, text: "")
        #expect(selected?.kind == ProjectDialogKind.value)
        #expect(selected?.value == "B recommandé")
        #expect(selected?.confirmed == nil)

        let unselected = IOSDialogGating.request(dialog: select, selectedIndex: nil, text: "")
        #expect(unselected == nil)

        let input = try dialog(method: "input")
        let typed = IOSDialogGating.request(dialog: input, selectedIndex: nil, text: "ma réponse")
        #expect(typed?.kind == ProjectDialogKind.value)
        #expect(typed?.value == "ma réponse")

        // Une saisie blanche est refusée AVANT toute route.
        #expect(IOSDialogGating.request(dialog: input, selectedIndex: nil, text: "  ") == nil)

        // Une valeur vide en editor est ACCEPTÉE : c'est la coque qui juge le plan.
        let editor = try dialog(method: "editor", prefill: "")
        let edited = IOSDialogGating.request(dialog: editor, selectedIndex: nil, text: "")
        #expect(edited?.kind == ProjectDialogKind.value)
        #expect(edited?.value == "")

        // La forme confirm n'a pas de « Répondre » : elle passe par les deux boutons.
        let confirm = try dialog(method: "confirm")
        #expect(IOSDialogGating.request(dialog: confirm, selectedIndex: nil, text: "") == nil)

        let accepted = IOSDialogGating.confirmation(true)
        #expect(accepted.kind == ProjectDialogKind.confirmed)
        #expect(accepted.confirmed == true)
        #expect(accepted.value == nil)

        let declined = IOSDialogGating.confirmation(false)
        #expect(declined.kind == ProjectDialogKind.confirmed)
        #expect(declined.confirmed == false)

        let cancelled = IOSDialogGating.cancellation()
        #expect(cancelled.kind == ProjectDialogKind.cancelled)
        #expect(cancelled.value == nil)
        #expect(cancelled.confirmed == nil)
    }
}
