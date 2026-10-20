// Socle partagé du contrat (BR-1) : les constantes de service et le type d'erreur
// partagé portent les valeurs figées du contrat entre le Mac et l'iPhone.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

@Test("contrat partagé : les constantes de service portent les valeurs figées")
func serviceConstantsMatchTheContract() {
    #expect(ConsoleAPI.protocolVersion == 3)
    #expect(ConsoleAPI.Service.defaultPort == 8787)
    #expect(ConsoleAPI.Service.basePath == "/v1")
    #expect(ConsoleAPI.Service.bonjourType == "_ompconsole._tcp")
    #expect(ConsoleAPI.Service.bonjourName == "OMP Console")
    #expect(ConsoleAPI.Service.protocolHeader == "X-Console-Protocol-Version")
    #expect(ConsoleAPI.Service.pairingCodeLength == 8)
    #expect(ConsoleAPI.Service.pairingCodeTTLSeconds == 120)
    #expect(ConsoleAPI.Service.pairingAttemptLimit == 5)

    // L'alphabet d'appairage : exactement 32 symboles UNIQUES (l'entropie d'AC-25
    // repose sur cette taille, pas seulement sur celle du code).
    let alphabet = Array(ConsoleAPI.Service.pairingCodeAlphabet)
    #expect(alphabet.count == 32)
    #expect(Set(alphabet).count == 32)
}

@Test("contrat partagé : chaque erreur porte son code stable et son message")
func errorCasesKeepStableCodes() {
    #expect(ConsoleAPIError.incompatibleProtocol("protocole 2").code == "incompatible_protocol")
    #expect(ConsoleAPIError.incompatibleProtocol("protocole 2").message == "protocole 2")
    #expect(ConsoleAPIError.unauthorized.message == nil)

    // Les sept cas préexistants gardent leur code : le socle les avait déjà figés.
    #expect(ConsoleAPIError.badRequest("x").code == "bad_request")
    #expect(ConsoleAPIError.unauthorized.code == "unauthorized")
    #expect(ConsoleAPIError.notFound("x").code == "not_found")
    #expect(ConsoleAPIError.conflict("x").code == "conflict")
    #expect(ConsoleAPIError.unavailable("x").code == "unavailable")
    #expect(ConsoleAPIError.server("x").code == "server")
    #expect(ConsoleAPIError.decoding("x").code == "decoding")
    #expect(ConsoleAPIError.outdatedService("x").code == "outdated_service")
    #expect(ConsoleAPIError.outdatedService("x").message == "x")

    // Le message est rendu tel quel, jamais reformulé par le code.
    #expect(ConsoleAPIError.notFound("route inconnue").message == "route inconnue")
    #expect(ConsoleAPIError.badRequest("cible invalide").message == "cible invalide")
    #expect(ConsoleAPIError.server("échec").message == "échec")
}
