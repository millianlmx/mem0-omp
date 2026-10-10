// Sonde AX de la recette de la feuille d'appairage (S-10, lot BR-4 de
// mac-feuille-appairage-debordante), pilotée par scripts/mac-appairage-recette.sh.
//
// Elle lit et presse la feuille « Appairage » d'une instance de recette lancée en
// arrière-plan, SANS jamais l'activer : aucun CGEvent, aucun redimensionnement,
// aucun interrupteur. Tout passe par l'API d'accessibilité (`AXUIElement…`).
//
// Compilée une fois par `swiftc` (Command Line Tools seuls) dans le dossier
// jetable de la recette ; chaque sous-commande écrit son résultat sur la sortie
// standard (JSON pour `mesurer`) et rend 0 si elle a abouti, 1 sinon.
//
//   confiance                         « true » si l'Accessibilité est accordée (sinon 3)
//   ouvrir <pid>                      « OMP Console › Appairage… », attend `pairing.sheet` ≤ 5 s
//   mesurer <pid>                     cadres, lignes, textes de la feuille (JSON)
//   defiler <pid> <0…1>               barre verticale de `pairing.devices.list`
//   presser <pid> <identifiant>       AXPress de l'élément d'identifiant donné
//   lire <pid> <identifiant>          AXValue (texte) de l'élément, 1 s'il est absent
//   attendre <pid> <id> present|absent <secondes>
//   confirmer <pid>                   « Révoquer » de la confirmation de révocation
//   fenetre <pid>                     CGWindowID de la feuille (pour screencapture -l)
//
// Pièges mesurés (Doc-7 du contrat) : `AXWindows` peut être vide pour une app en
// arrière-plan, d'où la lecture de `AXMainWindow` en plus ; un cadre hors écran
// peut être infini, refusé par `JSONSerialization` : il est écarté.

import AppKit
import ApplicationServices
import Foundation

// MARK: - Lecture AX

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
    return value
}

func string(_ element: AXUIElement, _ name: String) -> String? {
    attribute(element, name) as? String
}

func element(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func children(_ element: AXUIElement) -> [AXUIElement] {
    (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func role(_ element: AXUIElement) -> String { string(element, kAXRoleAttribute) ?? "" }
func identifier(_ element: AXUIElement) -> String { string(element, kAXIdentifierAttribute) ?? "" }

func frame(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute),
          let size = attribute(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(),
          CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
    let rect = CGRect(origin: point, size: extent)
    guard rect.origin.x.isFinite, rect.origin.y.isFinite,
          rect.size.width.isFinite, rect.size.height.isFinite else { return nil }
    return rect
}

func json(_ rect: CGRect?) -> Any {
    guard let rect else { return NSNull() }
    return ["x": rect.origin.x, "y": rect.origin.y, "w": rect.size.width, "h": rect.size.height]
}

/// Les textes portés par un élément : valeur d'un texte statique, titre et
/// description d'un contrôle.
func texts(of element: AXUIElement) -> [String] {
    var found: [String] = []
    if let value = string(element, kAXValueAttribute), !value.isEmpty { found.append(value) }
    if let title = string(element, kAXTitleAttribute), !title.isEmpty { found.append(title) }
    if let description = string(element, kAXDescriptionAttribute), !description.isEmpty { found.append(description) }
    return found
}

/// Parcours préfixe (ordre du document), borné.
func walk(_ root: AXUIElement, limit: Int = 6000, _ visit: (AXUIElement) -> Bool) {
    var stack = [root]
    var seen = 0
    while let node = stack.popLast(), seen < limit {
        seen += 1
        guard visit(node) else { continue }
        stack.append(contentsOf: children(node).reversed())
    }
}

func application(_ pid: pid_t) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 3)
    return app
}

/// Les fenêtres de l'app : `AXMainWindow`, `AXFocusedWindow`, `AXWindows` et les
/// enfants `AXWindow`/`AXSheet` de l'app, sans doublon (en arrière-plan,
/// `AXWindows` est souvent vide). `AXMainWindow` peut rendre l'app elle-même
/// (MESURÉ, session verrouillée) : écartée.
func windows(_ app: AXUIElement) -> [AXUIElement] {
    var found: [AXUIElement] = []
    func add(_ candidate: AXUIElement?) {
        guard let candidate, ["AXWindow", "AXSheet"].contains(role(candidate)),
              !found.contains(where: { CFEqual($0, candidate) }) else { return }
        found.append(candidate)
    }
    add(element(attribute(app, kAXMainWindowAttribute)))
    add(element(attribute(app, kAXFocusedWindowAttribute)))
    for window in (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? [] { add(window) }
    for child in children(app) { add(child) }
    return found
}

/// Un élément absent à la première lecture est relu pendant `grace` secondes.
/// À la revue, sur un Mac chargé, la feuille a été introuvable après l'échéance
/// du code puis retrouvée plus tard, alors que l'app observée seule la garde
/// affichée (« Code expiré ») : un « absent » isolé n'est pas une preuve.
func steady(_ app: AXUIElement, id wanted: String, grace: Double = 5) -> AXUIElement? {
    var match: AXUIElement?
    _ = poll(seconds: grace) {
        match = find(app, id: wanted)
        return match != nil
    }
    return match
}

func find(_ app: AXUIElement, id wanted: String) -> AXUIElement? {
    var match: AXUIElement?
    for window in windows(app) where match == nil {
        walk(window) { node in
            if match != nil { return false }
            if identifier(node) == wanted { match = node; return false }
            return true
        }
    }
    return match
}

/// La feuille : l'`AXSheet` qui contient `pairing.sheet` (sinon l'élément lui-même).
func sheet(_ app: AXUIElement) -> (container: AXUIElement, content: AXUIElement)? {
    for window in windows(app) {
        var result: (AXUIElement, AXUIElement)?
        var sheets: [AXUIElement] = []
        walk(window) { node in
            if result != nil { return false }
            if role(node) == "AXSheet" { sheets.append(node) }
            if identifier(node) == "pairing.sheet" {
                // Le dernier `AXSheet` ouvert sur le chemin est le conteneur.
                result = (sheets.last ?? node, node)
                return false
            }
            return true
        }
        if let result { return (result.0, result.1) }
    }
    return nil
}

func press(_ element: AXUIElement) -> Bool {
    AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
}

func poll(seconds: Double, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    repeat {
        if condition() { return true }
        Thread.sleep(forTimeInterval: 0.2)
    } while Date() < deadline
    return condition()
}

// MARK: - Écran (Doc-7 : AX en haut à gauche, NSScreen en bas à gauche)

func screenFrame(containing rect: CGRect?) -> CGRect? {
    let screens = NSScreen.screens
    guard let primary = screens.first else { return nil }
    let primaryHeight = primary.frame.height
    let converted = screens.map { screen -> CGRect in
        let f = screen.frame
        return CGRect(x: f.origin.x, y: primaryHeight - (f.origin.y + f.height), width: f.width, height: f.height)
    }
    if let rect {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        if let hit = converted.first(where: { $0.contains(center) }) { return hit }
    }
    return converted.first
}

// MARK: - Sous-commandes

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func emit(_ object: Any) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
        fail("mesure non sérialisable")
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func pid(_ arguments: [String], _ index: Int) -> pid_t {
    guard arguments.count > index, let value = pid_t(arguments[index]) else { fail("pid attendu") }
    return value
}

func open(_ app: AXUIElement) {
    if sheet(app) != nil { emit(["ouverte": true, "deja": true]); exit(0) }
    guard let bar = element(attribute(app, kAXMenuBarAttribute)) else { fail("barre de menus illisible") }
    let menus = children(bar)
    guard let appMenu = menus.first(where: { string($0, kAXTitleAttribute) == "OMP Console" }) else {
        let titles = menus.compactMap { string($0, kAXTitleAttribute) }
        fail("menu « OMP Console » introuvable (menus : \(titles.joined(separator: ", ")))")
    }
    var item: AXUIElement?
    walk(appMenu) { node in
        if item != nil { return false }
        if role(node) == "AXMenuItem", string(node, kAXTitleAttribute) == "Appairage…" { item = node; return false }
        return true
    }
    guard let item else { fail("élément de menu « Appairage… » introuvable") }
    guard press(item) else { fail("« Appairage… » n'a pas pu être pressé") }
    guard poll(seconds: 5, { sheet(app) != nil }) else { fail("pairing.sheet absent 5 s après le menu") }
    emit(["ouverte": true, "deja": false])
}

func measure(_ app: AXUIElement) {
    var found: (container: AXUIElement, content: AXUIElement)?
    _ = poll(seconds: 5) { found = sheet(app); return found != nil }
    guard let (container, content) = found else { fail("feuille d'appairage absente") }
    let sheetFrame = frame(container) ?? frame(content)
    var allTexts: [String] = []
    var titleFrame: CGRect?
    walk(container) { node in
        let found = texts(of: node)
        allTexts.append(contentsOf: found)
        if titleFrame == nil, role(node) == "AXStaticText", string(node, kAXValueAttribute) == "Appairage" {
            titleFrame = frame(node)
        }
        return true
    }
    let close = find(app, id: "pairing.close")
    let address = find(app, id: "pairing.address").flatMap { string($0, kAXValueAttribute) }
    let expiry = find(app, id: "pairing.codeExpiry").flatMap { string($0, kAXValueAttribute) }
    let code = find(app, id: "pairing.code").flatMap { string($0, kAXValueAttribute) }

    // Les lignes, rattachées par le CADRE et non par l'ordre du document : dans
    // l'arbre réel, le bouton « Révoquer » d'une carte précède ses textes (date,
    // dernière activité). Un texte appartient au bouton le plus bas dont le haut
    // est au-dessus de son milieu : le bouton est aligné sur la 1re ligne de
    // texte de sa carte (nom), et la carte suivante commence sous la dernière.
    let list = find(app, id: "pairing.devices.list")
    var rows: [[String: Any]] = []
    if let list {
        var buttons: [(id: String, element: AXUIElement, frame: CGRect?)] = []
        var labels: [(value: String, frame: CGRect)] = []
        let prefix = "pairing.devices.revoke."
        walk(list) { node in
            let id = identifier(node)
            if id.hasPrefix(prefix) {
                buttons.append((String(id.dropFirst(prefix.count)), node, frame(node)))
                return false
            }
            if role(node) == "AXStaticText", let value = string(node, kAXValueAttribute), !value.isEmpty,
               let rect = frame(node) {
                labels.append((value, rect))
            }
            return true
        }
        let tops = buttons.compactMap { $0.frame?.minY }.sorted()
        for button in buttons {
            let mine: [(value: String, frame: CGRect)]
            if let top = button.frame?.minY {
                let next = tops.first { $0 > top } ?? .infinity
                mine = labels
                    .filter { $0.frame.midY >= top && $0.frame.midY < next }
                    .sorted { $0.frame.minY < $1.frame.minY }
            } else {
                mine = []
            }
            let name = mine.first { !$0.value.hasPrefix("Appairé le") && !$0.value.hasPrefix("Dernière activité") }
            rows.append([
                "id": button.id,
                "nom": name?.value ?? "",
                "cadreNom": json(name?.frame),
                "date": mine.first { $0.value.hasPrefix("Appairé le") }?.value ?? "",
                "ax": string(button.element, kAXDescriptionAttribute) ?? "",
                "titre": string(button.element, kAXTitleAttribute) ?? "",
                "cadre": json(button.frame),
            ])
        }
    }
    let addressCount = address.map { value in allTexts.filter { $0.contains(value) }.count } ?? 0
    emit([
        "feuille": json(sheetFrame),
        "ecran": json(screenFrame(containing: sheetFrame)),
        "titre": json(titleFrame),
        "fermer": json(close.flatMap(frame)),
        "liste": json(list.flatMap(frame)),
        "lignes": rows,
        "textes": allTexts,
        "adresse": address ?? NSNull(),
        "occurrencesAdresse": addressCount,
        "decompte": expiry ?? NSNull(),
        "code": code ?? NSNull(),
    ])
}

func scroll(_ app: AXUIElement, to value: Double) {
    guard let list = find(app, id: "pairing.devices.list") else { fail("pairing.devices.list absent") }
    // L'identifiant peut tomber sur l'`AXScrollArea` ou sur un de ses parents.
    var area: AXUIElement?
    walk(list) { node in
        if area != nil { return false }
        if role(node) == "AXScrollArea" { area = node; return false }
        return true
    }
    if area == nil, let parent = element(attribute(list, kAXParentAttribute)), role(parent) == "AXScrollArea" {
        area = parent
    }
    guard let area, let bar = element(attribute(area, kAXVerticalScrollBarAttribute)) else {
        fail("barre de défilement verticale introuvable")
    }
    guard AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, NSNumber(value: value)) == .success else {
        fail("défilement refusé")
    }
    Thread.sleep(forTimeInterval: 0.5)
    emit(["defile": value])
}

func confirm(_ app: AXUIElement) {
    var button: AXUIElement?
    let found = poll(seconds: 3) {
        button = nil
        for window in windows(app) where button == nil {
            walk(window) { node in
                if button != nil { return false }
                // L'alerte de confirmation est un `AXSheet` imbriqué dont les
                // boutons n'ont PAS d'`AXTitle` : leur texte est dans
                // `AXDescription` (MESURÉ : `action-button-1`, « Révoquer »).
                if role(node) == "AXButton",
                   string(node, kAXTitleAttribute) == "Révoquer" || string(node, kAXDescriptionAttribute) == "Révoquer",
                   !identifier(node).hasPrefix("pairing.devices.revoke.") {
                    button = node
                    return false
                }
                return true
            }
        }
        return button != nil
    }
    guard found, let button else { fail("confirmation « Révoquer » introuvable") }
    // L'alerte se ferme PENDANT l'action : AXPress peut alors rendre une erreur
    // alors que la révocation a eu lieu (MESURÉ). Le constat est la disparition
    // du bouton (élément détruit : plus de rôle lisible).
    let pressed = press(button)
    guard pressed || poll(seconds: 2, { role(button).isEmpty }) else {
        fail("« Révoquer » de la confirmation n'a pas pu être pressé")
    }
    emit(["confirme": true])
}

func windowNumber(_ pid: pid_t, _ app: AXUIElement) {
    let target = sheet(app).flatMap { frame($0.container) }
    let list = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
    let mine = list.filter {
        ($0[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid
            && ($0[kCGWindowLayer as String] as? Int) == 0
    }
    func bounds(_ info: [String: Any]) -> CGRect {
        guard let dict = info[kCGWindowBounds as String] as? NSDictionary,
              let rect = CGRect(dictionaryRepresentation: dict) else { return .zero }
        return rect
    }
    let best: [String: Any]?
    if let target {
        best = mine.min {
            let a = bounds($0), b = bounds($1)
            let da = abs(a.minX - target.minX) + abs(a.minY - target.minY) + abs(a.width - target.width) + abs(a.height - target.height)
            let db = abs(b.minX - target.minX) + abs(b.minY - target.minY) + abs(b.width - target.width) + abs(b.height - target.height)
            return da < db
        }
    } else {
        best = mine.max { bounds($0).width * bounds($0).height < bounds($1).width * bounds($1).height }
    }
    guard let best, let number = best[kCGWindowNumber as String] as? Int else { fail("fenêtre introuvable") }
    print(number)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else { fail("sous-commande attendue") }
switch arguments[1] {
case "confiance":
    let trusted = AXIsProcessTrusted()
    print(trusted ? "true" : "false")
    exit(trusted ? 0 : 3)
case "ouvrir":
    open(application(pid(arguments, 2)))
case "mesurer":
    measure(application(pid(arguments, 2)))
case "defiler":
    guard arguments.count > 3, let value = Double(arguments[3]) else { fail("valeur 0…1 attendue") }
    scroll(application(pid(arguments, 2)), to: value)
case "presser":
    guard arguments.count > 3 else { fail("identifiant attendu") }
    let app = application(pid(arguments, 2))
    guard let target = steady(app, id: arguments[3]) else { fail("\(arguments[3]) absent") }
    guard press(target) else { fail("\(arguments[3]) n'a pas pu être pressé") }
case "lire":
    guard arguments.count > 3 else { fail("identifiant attendu") }
    let app = application(pid(arguments, 2))
    guard let target = steady(app, id: arguments[3]) else { fail("\(arguments[3]) absent") }
    print(string(target, kAXValueAttribute) ?? "")
case "attendre":
    guard arguments.count > 5, let seconds = Double(arguments[5]) else { fail("attendre <pid> <id> present|absent <s>") }
    let app = application(pid(arguments, 2))
    let wantPresent = arguments[4] == "present"
    let met = poll(seconds: seconds) { (find(app, id: arguments[3]) != nil) == wantPresent }
    exit(met ? 0 : 1)
case "confirmer":
    confirm(application(pid(arguments, 2)))
case "fenetre":
    let target = pid(arguments, 2)
    windowNumber(target, application(target))
default:
    fail("sous-commande inconnue : \(arguments[1])")
}
