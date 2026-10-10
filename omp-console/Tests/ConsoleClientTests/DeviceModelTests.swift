// Le modèle précis transmis au Mac (S-2) : jamais le seul mot « iPhone » pour un
// appareil connu, jamais l'identifiant brut à l'écran.

@testable import ConsoleClient
import Testing

@Suite("DeviceModel")
struct DeviceModelTests {
    @Test("mac-feuille-appairage-debordante/AC-3 : un iPad et un iPhone connus portent leur modèle précis")
    func knownIdentifiersGivePreciseModel() {
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPad17,4") == "iPad Pro 13 pouces (M5)")
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPad17,3") == "iPad Pro 13 pouces (M5)")
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPad16,6") == "iPad Pro 13 pouces (M4)")
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPad8,7") == "iPad Pro 12,9 pouces (3e génération)")
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPad8,1") == "iPad Pro 11 pouces (1re génération)")
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPhone18,5") == "iPhone 17e")
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPhone19,2") == "iPhone 18 Pro")
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPhone19,7") == "iPhone 18 Pro Max")
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPhone14,6") == "iPhone SE (3e génération)")
    }

    @Test("mac-feuille-appairage-debordante/AC-3 : un identifiant inconnu retombe sur sa famille, jamais sur l'identifiant brut")
    func unknownIdentifiersFallBackToFamily() {
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPad99,1") == "iPad")
        #expect(ClientDeviceModel.displayName(forIdentifier: "iPhone99,1") == "iPhone")
        #expect(ClientDeviceModel.displayName(forIdentifier: "Mac16,1") == "Mac")
        #expect(ClientDeviceModel.displayName(forIdentifier: "") == "Appareil Apple")
        #expect(ClientDeviceModel.displayName(forIdentifier: "arm64") == "Appareil Apple")
    }

    @Test("mac-feuille-appairage-debordante/AC-3 : le simulateur donne son modèle simulé, une valeur blanche est ignorée")
    func simulatorIdentifierWinsWhenPresent() {
        #expect(ClientDeviceModel.identifier(environment: ["SIMULATOR_MODEL_IDENTIFIER": "iPad17,4"]) == "iPad17,4")
        #expect(ClientDeviceModel.identifier(environment: ["SIMULATOR_MODEL_IDENTIFIER": " iPhone19,2\n"]) == "iPhone19,2")
        // Sous `swift test` (macOS), sans la variable : l'identifiant matériel de
        // l'hôte, « Mac16,7 » sur un poste mais « VirtualMac2,1 » sur un runner CI
        // virtualisé — aucun préfixe n'est donc exigé.
        let host = ClientDeviceModel.identifier(environment: [:])
        #expect(!host.isEmpty)
        #expect(ClientDeviceModel.identifier(environment: ["SIMULATOR_MODEL_IDENTIFIER": "   "]) == host)
    }
}
