// Sonde de la recette UI Mac (recette-ui-mac-automatisee, S-2, S-3, S-6).
// Compilée par scripts/mac-recette-ui.sh (D-10) :
//   swiftc -swift-version 5 -o omp-console/build/mac-recette-ui/sonde scripts/mac-recette-ui/sonde.swift
//
// La sonde CONSTATE, le script juge (recette.ts) :
//   sonde etat-ecran
//     → faits S-2 en JSON sur stdout, sortie 0 ; 1 si les faits sont illisibles.
//       Rien n'est lancé ni activé, aucune invite système.
//   sonde parcours --catalogue <fichier JSON> --racine <R> --port <port> --sortie <dossier>
//     → une instance de recette isolée par surface (S-3), relevé AX et capture
//       (S-6), constats d'isolation ; `parcours.json` est réécrit après chaque
//       surface (une sonde arrêtée à mi-chemin laisse les surfaces restantes
//       « absentes du parcours »). Sortie 0 dès que le `parcours.json` final est
//       écrit, 1 sinon.
//   sonde terminer
//     → termine toute instance `com.omp.console.recette` (nettoyage S-3), sortie 0.
//
// Interdits absolus (S-3) : aucune activation (`activate`, `AXRaise`, écriture de
// `AXMain`/`AXFocused`/`AXFrontmost`), aucun `CGEvent`, aucun `osascript`, aucune
// invite (`kAXTrustedCheckOptionPrompt`, `CGRequestScreenCaptureAccess`). Les seules
// écritures AX visent la taille de la fenêtre de l'instance de RECETTE ; aucun
// signal ni aucune action AX n'atteint un processus de bundle `com.omp.console`.
//
// Les attentes font tourner `RunLoop.main` (jamais `Thread.sleep`) : les
// notifications d'activation de NSWorkspace et `isTerminated` n'arrivent que
// par elle (D-6).

import AppKit
import ApplicationServices
import CryptoKit
import Foundation

let bundleRecette = "com.omp.console.recette"
let bundleUtilisateur = "com.omp.console"
let limiteNoeuds = 20_000
let limiteProfondeur = 80

// MARK: - Sorties

func ecrireErreur(_ texte: String) {
    FileHandle.standardError.write(Data((texte + "\n").utf8))
}

func ecrireSortie(_ texte: String) {
    FileHandle.standardOutput.write(Data((texte + "\n").utf8))
}

func json(_ objet: Any) -> Data? {
    guard JSONSerialization.isValidJSONObject(objet) else { return nil }
    return try? JSONSerialization.data(withJSONObject: objet, options: [.sortedKeys])
}

@discardableResult
func ecrireJSON(_ objet: Any, vers chemin: String) -> Bool {
    guard let data = json(objet) else { return false }
    do {
        try data.write(to: URL(fileURLWithPath: chemin), options: .atomic)
        return true
    } catch {
        return false
    }
}

/// Un nombre JSON, ou `nil` s'il n'est pas fini (JSONSerialization plante sur NaN/∞, D-5).
func nombre(_ v: CGFloat) -> Double? {
    let d = Double(v)
    return d.isFinite ? d : nil
}

func rectangle(_ r: CGRect) -> [String: Any]? {
    guard let x = nombre(r.origin.x), let y = nombre(r.origin.y),
          let l = nombre(r.size.width), let h = nombre(r.size.height) else { return nil }
    return ["x": x, "y": y, "largeur": l, "hauteur": h]
}

// MARK: - Attentes

/// Une source permanente sur la boucle principale : sans elle, `run(until:)`
/// rendrait la main aussitôt et l'attente tournerait à vide.
let veilleuse = Timer(timeInterval: 86_400, repeats: true) { _ in }
RunLoop.main.add(veilleuse, forMode: .default)

func patienter(_ secondes: Double) {
    let fin = Date().addingTimeInterval(secondes)
    while Date() < fin {
        _ = RunLoop.main.run(mode: .default, before: fin)
    }
}

// MARK: - Processus externes

/// Lance un exécutable sans shell ; rend le code de sortie et stdout.
func executer(_ chemin: String, _ arguments: [String]) -> (code: Int32, sortie: Data) {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: chemin)
    p.arguments = arguments
    let tube = Pipe()
    p.standardOutput = tube
    p.standardError = FileHandle.nullDevice
    do {
        try p.run()
    } catch {
        return (127, Data())
    }
    let sortie = tube.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return (p.terminationStatus, sortie)
}

// MARK: - Accessibilité

func attribut(_ e: AXUIElement, _ nom: String) -> CFTypeRef? {
    var valeur: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, nom as CFString, &valeur) == .success else { return nil }
    return valeur
}

func chaine(_ e: AXUIElement, _ nom: String) -> String? {
    attribut(e, nom) as? String
}

func element(_ e: AXUIElement, _ nom: String) -> AXUIElement? {
    guard let v = attribut(e, nom), CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func enfants(_ e: AXUIElement) -> [AXUIElement] {
    guard let v = attribut(e, "AXChildren"), CFGetTypeID(v) == CFArrayGetTypeID() else { return [] }
    return (v as! [AnyObject]).compactMap { objet in
        CFGetTypeID(objet) == AXUIElementGetTypeID() ? (objet as! AXUIElement) : nil
    }
}

func role(_ e: AXUIElement) -> String? {
    chaine(e, "AXRole")
}

func valeurAX(_ e: AXUIElement, _ nom: String) -> AXValue? {
    guard let v = attribut(e, nom), CFGetTypeID(v) == AXValueGetTypeID() else { return nil }
    return (v as! AXValue)
}

func taille(_ e: AXUIElement) -> CGSize? {
    guard let v = valeurAX(e, "AXSize") else { return nil }
    var s = CGSize.zero
    return AXValueGetValue(v, .cgSize, &s) ? s : nil
}

func position(_ e: AXUIElement) -> CGPoint? {
    guard let v = valeurAX(e, "AXPosition") else { return nil }
    var p = CGPoint.zero
    return AXValueGetValue(v, .cgPoint, &p) ? p : nil
}

/// Le cadre AX (repère en haut à gauche de l'écran principal), ou `nil` s'il est
/// illisible ou non fini.
func cadre(_ e: AXUIElement) -> CGRect? {
    guard let p = position(e), let s = taille(e) else { return nil }
    let r = CGRect(origin: p, size: s)
    return rectangle(r) == nil ? nil : r
}

func poserTaille(_ e: AXUIElement, _ s: CGSize) {
    var t = s
    guard let v = AXValueCreate(.cgSize, &t) else { return }
    _ = AXUIElementSetAttributeValue(e, "AXSize" as CFString, v)
}

func actions(_ e: AXUIElement) -> [String] {
    var noms: CFArray?
    guard AXUIElementCopyActionNames(e, &noms) == .success, let liste = noms as? [String] else { return [] }
    return liste
}

/// Cherche un nœud d'identifiant donné, en profondeur, borné.
func contient(_ racine: AXUIElement, identifiant: String) -> Bool {
    var pile: [(AXUIElement, Int)] = [(racine, 0)]
    var vus = 0
    while let (e, profondeur) = pile.popLast() {
        vus += 1
        if vus > limiteNoeuds { return false }
        if chaine(e, "AXIdentifier") == identifiant { return true }
        if profondeur < limiteProfondeur {
            for enfant in enfants(e).reversed() { pile.append((enfant, profondeur + 1)) }
        }
    }
    return false
}

struct ArbreTropGrand: Error {}

/// Le nœud S-6 d'un élément et de ses descendants, dans l'ordre de `AXChildren`.
func releverNoeud(_ e: AXUIElement, profondeur: Int, compte: inout Int) throws -> [String: Any] {
    compte += 1
    if compte > limiteNoeuds || profondeur > limiteProfondeur { throw ArbreTropGrand() }
    var valeur: Any = NSNull()
    if let v = attribut(e, "AXValue") as? String {
        valeur = String(v.prefix(200))
    }
    var fils: [[String: Any]] = []
    for enfant in enfants(e) {
        fils.append(try releverNoeud(enfant, profondeur: profondeur + 1, compte: &compte))
    }
    return [
        "role": role(e) ?? "",
        "sousRole": chaine(e, "AXSubrole") ?? NSNull(),
        "identifiant": chaine(e, "AXIdentifier") ?? NSNull(),
        "titre": chaine(e, "AXTitle") ?? NSNull(),
        "description": chaine(e, "AXDescription") ?? NSNull(),
        "valeur": valeur,
        "cadre": cadre(e).flatMap(rectangle) ?? NSNull(),
        "actions": actions(e),
        "enfants": fils,
    ]
}

// MARK: - Applications

func instances(_ bundle: String) -> [NSRunningApplication] {
    NSRunningApplication.runningApplications(withBundleIdentifier: bundle).filter { app in
        !app.isTerminated && kill(app.processIdentifier, 0) == 0
    }
}

/// Termine toute instance de RECETTE : `forceTerminate`, 5 s d'attente, puis
/// `kill -9` (S-3, fin de surface). Jamais une autre app.
func terminerRecette() {
    let cibles = instances(bundleRecette)
    guard !cibles.isEmpty else { return }
    for app in cibles where app.bundleIdentifier == bundleRecette {
        _ = app.forceTerminate()
    }
    let fin = Date().addingTimeInterval(5)
    while Date() < fin, cibles.contains(where: { !$0.isTerminated && kill($0.processIdentifier, 0) == 0 }) {
        patienter(0.1)
    }
    for app in cibles where app.bundleIdentifier == bundleRecette && !app.isTerminated && kill(app.processIdentifier, 0) == 0 {
        kill(app.processIdentifier, SIGKILL)
    }
    let finKill = Date().addingTimeInterval(2)
    while Date() < finKill, cibles.contains(where: { kill($0.processIdentifier, 0) == 0 }) {
        patienter(0.1)
    }
}

// MARK: - etat-ecran (S-2)

func etatEcran() -> Int32 {
    let session = CGSessionCopyCurrentDictionary() as? [String: Any]
    let verrouille = (session?["CGSSessionScreenIsLocked"] as? Bool) ?? false
    let accessibilite = AXIsProcessTrustedWithOptions(nil)
    let enregistrement = CGPreflightScreenCaptureAccess()

    guard let devant = NSWorkspace.shared.frontmostApplication else {
        ecrireErreur("sonde etat-ecran : app au premier plan illisible")
        return 1
    }
    var pleinEcran: Any = NSNull()
    if accessibilite {
        let app = AXUIElementCreateApplication(devant.processIdentifier)
        AXUIElementSetMessagingTimeout(app, 2)
        if let fenetre = element(app, "AXFocusedWindow"), let v = attribut(fenetre, "AXFullScreen"),
           CFGetTypeID(v) == CFBooleanGetTypeID() {
            pleinEcran = CFBooleanGetValue((v as! CFBoolean))
        }
    }

    var nbEcrans: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &nbEcrans) == .success else {
        ecrireErreur("sonde etat-ecran : liste des écrans illisible")
        return 1
    }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(nbEcrans))
    guard CGGetActiveDisplayList(nbEcrans, &ids, &nbEcrans) == .success else {
        ecrireErreur("sonde etat-ecran : liste des écrans illisible")
        return 1
    }
    let ecrans = ids.prefix(Int(nbEcrans)).compactMap { rectangle(CGDisplayBounds($0)) }

    guard let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]] else {
        ecrireErreur("sonde etat-ecran : liste des fenêtres illisible")
        return 1
    }
    var fenetres: [[String: Any]] = []
    for info in infos {
        guard (info[kCGWindowLayer as String] as? Int) == 0,
              let pid = info[kCGWindowOwnerPID as String] as? Int,
              let bornes = info[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: bornes),
              var w = rectangle(r) else { continue }
        w["pid"] = pid
        w["proprietaire"] = (info[kCGWindowOwnerName as String] as? String) ?? ""
        w["calque"] = 0
        fenetres.append(w)
    }

    let faits: [String: Any] = [
        "version": 1,
        "verrouille": verrouille,
        "accessibilite": accessibilite,
        "enregistrementEcran": enregistrement,
        "premierPlan": [
            "bundle": devant.bundleIdentifier ?? NSNull(),
            "nom": devant.localizedName ?? "",
            "pid": Int(devant.processIdentifier),
            "pleinEcran": pleinEcran,
        ] as [String: Any],
        "ecrans": ecrans,
        "fenetres": fenetres,
    ]
    guard let data = json(faits) else {
        ecrireErreur("sonde etat-ecran : faits non sérialisables")
        return 1
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    return 0
}

// MARK: - parcours (S-3, S-6)

struct Surface {
    let id: String
    let type: String
    let marqueur: String
}

struct NonCouverte: Error {
    let raison: String
}

/// Constat d'isolation S-3 : pids de l'utilisateur, app au premier plan,
/// empreinte de ses préférences.
func constatIsolation() -> [String: Any] {
    let pids = instances(bundleUtilisateur).map { Int($0.processIdentifier) }.sorted()
    let devant = NSWorkspace.shared.frontmostApplication
    let export = executer("/usr/bin/defaults", ["export", bundleUtilisateur, "-"])
    let empreinte = SHA256.hash(data: export.sortie).map { String(format: "%02x", $0) }.joined()
    return [
        "instancesUtilisateur": pids,
        "premierPlan": [
            "bundle": devant?.bundleIdentifier ?? NSNull(),
            "pid": Int(devant?.processIdentifier ?? -1),
        ] as [String: Any],
        "preferences": empreinte,
    ]
}

final class Parcours {
    let catalogue: [Surface]
    let racine: String
    let port: String
    let sortie: String
    var surfaces: [[String: Any]] = []
    var activations: [[String: Any]] = []
    var observateur: NSObjectProtocol?

    init(catalogue: [Surface], racine: String, port: String, sortie: String) {
        self.catalogue = catalogue
        self.racine = racine
        self.port = port
        self.sortie = sortie
    }

    var app: String { "\(racine)/app/OMP Console Recette.app" }

    func ecrireParcours(isolation: [String: Any]?) -> Bool {
        var objet: [String: Any] = ["version": 1, "surfaces": surfaces]
        if let isolation { objet["isolation"] = isolation }
        return ecrireJSON(objet, vers: "\(sortie)/parcours.json")
    }

    func observerActivations() {
        observateur = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: nil
        ) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  let bundle = app.bundleIdentifier,
                  bundle == bundleUtilisateur || bundle == bundleRecette else { return }
            self?.activations.append(["bundle": bundle, "pid": Int(app.processIdentifier)])
        }
    }

    /// Avant chaque lancement (S-3) : instance précédente terminée, domaine de
    /// préférences de RECETTE remis à neuf, support recopié du modèle.
    func preparer() throws {
        terminerRecette()
        _ = executer("/usr/bin/defaults", ["delete", bundleRecette])
        let ecritures: [[String]] = [
            ["home.welcomeSeen", "-bool", "true"],
            ["session.projectRoot", "-string", "\(racine)/depots/atelier"],
            ["remote.enabled", "-bool", "false"],
            ["ApplePersistenceIgnoreState", "-bool", "true"],
        ]
        for e in ecritures {
            guard executer("/usr/bin/defaults", ["write", bundleRecette] + e).code == 0 else {
                throw NonCouverte(raison: "instance de recette introuvable")
            }
        }
        let fm = FileManager.default
        let support = "\(racine)/support"
        try? fm.removeItem(atPath: support)
        do {
            try fm.copyItem(atPath: "\(racine)/support-modele", toPath: support)
        } catch {
            throw NonCouverte(raison: "instance de recette introuvable")
        }
    }

    func lancer(_ surface: Surface) -> Bool {
        let recette = surface.id == "preparation" ? "indeterminee" : "succes"
        let arguments = [
            "-g", "-n", "-F", app,
            "--env", "OMP_CONSOLE_SUPPORT_ROOT=\(racine)/support",
            "--env", "MEM0_PIPELINE_STATE_DIR=\(racine)/magasin",
            "--env", "MEM0_CONSOLE_ALERTS_DIR=\(racine)/alertes",
            "--env", "MEM0_HTTP_URL=http://127.0.0.1:\(port)",
            "--env", "OMP_CONSOLE_OMP_BINARY=\(racine)/bin/omp",
            "--env", "OMP_CONSOLE_GH_BINARY=\(racine)/bin/gh-absent",
            "--args", "-surface.recipe", surface.id, "-setup.recipe", recette,
        ]
        return executer("/usr/bin/open", arguments).code == 0
    }

    /// Le pid de l'unique instance de recette, attendu au plus 10 s.
    func pidRecette() -> pid_t? {
        let fin = Date().addingTimeInterval(10)
        repeat {
            let liste = instances(bundleRecette)
            if liste.count == 1 { return liste[0].processIdentifier }
            patienter(0.2)
        } while Date() < fin
        return nil
    }

    /// Attend la fenêtre principale et le marqueur au bon endroit ; rend la
    /// fenêtre et la racine de surface (fenêtre ou `AXSheet`).
    func attendreSurface(_ surface: Surface, pid: pid_t, depuis lancement: Date) throws -> (AXUIElement, AXUIElement) {
        let appAX = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(appAX, 2)
        let fin = lancement.addingTimeInterval(20)
        var fenetreVue = false
        var feuilleVue = false
        while true {
            if let fenetre = element(appAX, "AXMainWindow"), role(fenetre) == "AXWindow" {
                fenetreVue = true
                AXUIElementSetMessagingTimeout(fenetre, 2)
                let feuilles = enfants(fenetre).filter { role($0) == "AXSheet" }
                if surface.type == "section" {
                    feuilleVue = !feuilles.isEmpty
                    if feuilles.isEmpty, contient(fenetre, identifiant: surface.marqueur) {
                        return (fenetre, fenetre)
                    }
                } else if let feuille = feuilles.first(where: { contient($0, identifiant: surface.marqueur) }) {
                    return (fenetre, feuille)
                }
            } else {
                fenetreVue = false
            }
            if Date() >= fin { break }
            patienter(0.25)
        }
        if !fenetreVue { throw NonCouverte(raison: "fenêtre principale absente après 20 s") }
        if feuilleVue { throw NonCouverte(raison: "feuille inattendue") }
        throw NonCouverte(raison: "marqueur \(surface.marqueur) absent après 20 s")
    }

    /// Taille minimale (S-6, étape 3) : (1, 1), relue ; puis un point de moins,
    /// qui ne doit plus rien changer.
    func tailleMinimale(_ fenetre: AXUIElement) throws -> CGSize {
        poserTaille(fenetre, CGSize(width: 1, height: 1))
        patienter(0.5)
        guard let s = taille(fenetre) else { throw NonCouverte(raison: "taille minimale introuvable") }
        poserTaille(fenetre, CGSize(width: s.width - 1, height: s.height - 1))
        patienter(0.5)
        guard let s2 = taille(fenetre), s2 == s else { throw NonCouverte(raison: "taille minimale introuvable") }
        return s
    }

    /// Le `CGWindowID` de calque 0 du pid dont les bornes égalent le cadre AX à 1 pt près.
    func fenetreCG(pid: pid_t, cadre r: CGRect) -> CGWindowID? {
        guard let infos = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for info in infos {
            guard (info[kCGWindowLayer as String] as? Int) == 0,
                  (info[kCGWindowOwnerPID as String] as? Int) == Int(pid),
                  let bornes = info[kCGWindowBounds as String] as? NSDictionary,
                  let b = CGRect(dictionaryRepresentation: bornes),
                  let numero = info[kCGWindowNumber as String] as? Int else { continue }
            if abs(b.origin.x - r.origin.x) <= 1, abs(b.origin.y - r.origin.y) <= 1,
               abs(b.width - r.width) <= 1, abs(b.height - r.height) <= 1 {
                return CGWindowID(numero)
            }
        }
        return nil
    }

    func couvrir(_ surface: Surface) throws -> CGSize {
        try preparer()
        let lancement = Date()
        guard lancer(surface), let pid = pidRecette() else {
            throw NonCouverte(raison: "instance de recette introuvable")
        }
        let (fenetre, racineSurface) = try attendreSurface(surface, pid: pid, depuis: lancement)
        let s = try tailleMinimale(fenetre)
        patienter(1.5)

        guard let cadreRacine = cadre(racineSurface) else {
            throw NonCouverte(raison: "cadre de la surface illisible")
        }
        var compte = 0
        let racineReleve: [String: Any]
        do {
            racineReleve = try releverNoeud(racineSurface, profondeur: 0, compte: &compte)
        } catch {
            throw NonCouverte(raison: "arbre AX trop grand")
        }
        let releve: [String: Any] = [
            "version": 1,
            "surface": surface.id,
            "fenetre": ["largeur": Double(s.width), "hauteur": Double(s.height)],
            "racine": racineReleve,
        ]
        guard ecrireJSON(releve, vers: "\(sortie)/releves/\(surface.id).json") else {
            throw NonCouverte(raison: "cadre de la surface illisible")
        }

        let image = "\(sortie)/captures/\(surface.id).png"
        guard let numero = fenetreCG(pid: pid, cadre: cadreRacine),
              executer("/usr/sbin/screencapture", ["-x", "-o", "-l", String(numero), image]).code == 0,
              let attributs = try? FileManager.default.attributesOfItem(atPath: image),
              let octets = attributs[.size] as? Int, octets > 0 else {
            throw NonCouverte(raison: "capture impossible")
        }
        return s
    }

    func derouler() -> Int32 {
        let fm = FileManager.default
        for dossier in ["\(sortie)/captures", "\(sortie)/releves"] {
            do {
                try fm.createDirectory(atPath: dossier, withIntermediateDirectories: true)
            } catch {
                ecrireErreur("sonde parcours : dossier \(dossier) non créé")
                return 1
            }
        }
        guard ecrireParcours(isolation: nil) else {
            ecrireErreur("sonde parcours : parcours.json non écrit")
            return 1
        }

        observerActivations()
        let avant = constatIsolation()
        for surface in catalogue {
            var entree: [String: Any] = ["id": surface.id]
            do {
                let s = try couvrir(surface)
                entree["statut"] = "couverte"
                entree["raison"] = NSNull()
                entree["fenetre"] = ["largeur": Double(s.width), "hauteur": Double(s.height)]
                ecrireSortie("  ✓ \(surface.id)")
            } catch {
                let raison = (error as? NonCouverte)?.raison ?? "instance de recette introuvable"
                entree["statut"] = "non-couverte"
                entree["raison"] = raison
                entree["fenetre"] = NSNull()
                ecrireErreur("  ✗ \(surface.id) : non couverte — \(raison)")
            }
            terminerRecette()
            surfaces.append(entree)
            _ = ecrireParcours(isolation: nil)
        }
        terminerRecette()
        // Une activation provoquée par la dernière terminaison arrive par la boucle.
        patienter(0.5)
        let apres = constatIsolation()
        if let observateur { NSWorkspace.shared.notificationCenter.removeObserver(observateur) }
        let isolation: [String: Any] = ["avant": avant, "apres": apres, "activations": activations]
        guard ecrireParcours(isolation: isolation) else {
            ecrireErreur("sonde parcours : parcours.json non écrit")
            return 1
        }
        return 0
    }
}

func lireCatalogue(_ chemin: String) -> [Surface]? {
    guard let data = FileManager.default.contents(atPath: chemin),
          let liste = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
    var surfaces: [Surface] = []
    for objet in liste {
        guard let id = objet["id"] as? String, let type = objet["type"] as? String,
              type == "section" || type == "feuille",
              let marqueur = objet["marqueur"] as? String else { return nil }
        surfaces.append(Surface(id: id, type: type, marqueur: marqueur))
    }
    return surfaces
}

// MARK: - Point d'entrée

let usage = """
usage : sonde etat-ecran
        sonde parcours --catalogue <fichier JSON> --racine <R> --port <port> --sortie <dossier>
        sonde terminer
"""

func principal(_ arguments: [String]) -> Int32 {
    guard let commande = arguments.first else {
        ecrireErreur(usage)
        return 2
    }
    let reste = Array(arguments.dropFirst())
    switch commande {
    case "etat-ecran" where reste.isEmpty:
        return etatEcran()
    case "terminer" where reste.isEmpty:
        terminerRecette()
        return 0
    case "parcours" where reste.count == 8:
        var options: [String: String] = [:]
        for i in stride(from: 0, to: reste.count, by: 2) {
            options[reste[i]] = reste[i + 1]
        }
        guard let fichier = options["--catalogue"], let racine = options["--racine"],
              let port = options["--port"], let sortie = options["--sortie"],
              racine.hasPrefix("/"), UInt16(port) != nil else { break }
        guard let catalogue = lireCatalogue(fichier) else {
            ecrireErreur("sonde parcours : catalogue illisible (\(fichier))")
            return 1
        }
        let parcours = Parcours(catalogue: catalogue, racine: racine, port: port, sortie: sortie)
        return withExtendedLifetime(parcours) { parcours.derouler() }
    default:
        break
    }
    ecrireErreur(usage)
    return 2
}

exit(principal(Array(CommandLine.arguments.dropFirst())))
