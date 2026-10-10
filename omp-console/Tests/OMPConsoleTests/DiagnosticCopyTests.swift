// Preuves de S-1 (BR-1) de jargon-technique-expose-mac-et-ios : le socle commun de
// « Copier le diagnostic ». Les surfaces (bulle Kanban, inspecteurs, erreurs)
// prouvent ensuite LEUR diagnostic ; ici, on prouve que ce qui est copié est
// exactement ce qui a été donné.
//
// Jamais `NSPasteboard.general` : il est global au système, l'écrire écraserait le
// presse-papiers de l'utilisateur. Un presse-papiers nommé unique, relâché en fin
// de test (sans `releaseGlobally()`, il survit au processus).

import AppKit
import Foundation
import Testing
@testable import OMPConsole

@MainActor
private func withScratchPasteboard(_ body: (NSPasteboard) -> Void) {
    let pasteboard = NSPasteboard.withUniqueName()
    defer { pasteboard.releaseGlobally() }
    body(pasteboard)
}

@MainActor
@Suite("Copier le diagnostic")
struct DiagnosticCopyTests {
    @Test("jargon-technique-expose-mac-et-ios/AC-7 : la copie du diagnostic rend le texte exact")
    func copiesExactText() {
        // Espaces de bord, ligne vide, tabulation, fin de ligne : rien n'est rogné.
        let raw = "  podman machine start\n\nstderr :\tError: VM \"omp\" already running\n"
        withScratchPasteboard { pasteboard in
            DiagnosticPasteboard.copy(raw, to: pasteboard)
            #expect(pasteboard.string(forType: .string) == raw)
        }
    }

    @Test("jargon-technique-expose-mac-et-ios/AC-2 : le diagnostic multiligne des anomalies se relit à l'identique, pid 1234 compris")
    func copiesMultilineAnomalies() {
        let raw = """
        mort · run jargon-technique : pid 1234 absent
        illisible · lot BR-2 : /Users/x/.omp/pipeline/lots/BR-2.json
        """
        withScratchPasteboard { pasteboard in
            DiagnosticPasteboard.copy(raw, to: pasteboard)
            let copied = pasteboard.string(forType: .string)
            #expect(copied == raw)
            #expect(copied?.contains("pid 1234") == true)
            #expect(copied?.split(separator: "\n").count == 2)
        }
    }

    @Test("jargon-technique-expose-mac-et-ios/AC-4 : une 2e copie remplace la 1re, le PID de la session est celui qu'on relit")
    func secondCopyReplacesFirst() {
        withScratchPasteboard { pasteboard in
            DiagnosticPasteboard.copy("Session OMP · pid 1111", to: pasteboard)
            DiagnosticPasteboard.copy("Session OMP · pid 4242", to: pasteboard)
            #expect(pasteboard.string(forType: .string) == "Session OMP · pid 4242")
            #expect(pasteboard.pasteboardItems?.count == 1)
        }
    }

    @Test("jargon-technique-expose-mac-et-ios/AC-7 : un échec lisible porte toujours un diagnostic à copier")
    func readableFailureDiagnosticNeverEmpty() {
        let withRaw = ReadableFailure(message: "La mémoire ne répond pas.", diagnostic: "GET http://127.0.0.1:8765/memory → 503")
        #expect(withRaw.diagnostic == "GET http://127.0.0.1:8765/memory → 503")
        #expect(withRaw.message == "La mémoire ne répond pas.")

        let withoutRaw = ReadableFailure(message: "La mémoire ne répond pas.", diagnostic: "")
        #expect(withoutRaw.diagnostic == "La mémoire ne répond pas.")
    }
}
