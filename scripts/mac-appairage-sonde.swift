// Sonde AX de la recette des Réglages › Appareils (S-6, lot BR-4 de
// reglages-mac-appareils), pilotée par scripts/mac-appairage-recette.sh.
//
// Elle lit et presse le panneau Réglages (onglet « Appareils ») d'une instance de
// recette lancée en arrière-plan, SANS jamais l'activer : aucun CGEvent, aucun
// redimensionnement, aucun interrupteur. Tout passe par l'API d'accessibilité
// (`AXUIElement…`), les fenêtres se comptent par CoreGraphics.
//
// Le « conteneur » est la fenêtre qui contient `settings.devices` ; à défaut
// (bundle de la base, captures « avant »), l'`AXSheet` qui contient
// `pairing.sheet`.
//
// Compilée une fois par `swiftc` (Command Line Tools seuls) dans le dossier
// jetable de la recette ; chaque sous-commande écrit son résultat sur la sortie
// standard et rend 0 si elle a abouti, 1 sinon, 2 si l'arbre AX de l'app n'a
// aucune fenêtre (Space plein écran, session verrouillée), 4 si la pression d'un
// menu a mis l'instance de recette au premier plan (focus volé).
//
//   confiance                         « true » si l'Accessibilité est accordée (sinon 3)
//   plein-ecran                       0 (et le nom de l'app) si une fenêtre plein écran occupe l'écran, 1 sinon
//   ouvrir <pid>                      « OMP Console › Appairage… », attend le conteneur ≤ 5 s (JSON)
//   reglages <pid>                    « OMP Console › Réglages… », attend `settings.devices` ≤ 5 s (JSON)
//   compter <pid> <titre>             nombre de fenêtres CG de calque 0 du pid titrées <titre>
//   fermer <pid>                      bouton de fermeture de la fenêtre des Réglages, attend leur absence ≤ 2 s
//   onglets <pid>                     titres des boutons de la barre d'outils des Réglages (JSON)
//   mesurer <pid>                     cadres, lignes, textes du conteneur (JSON)
//   defiler <pid> <0…1>               barre verticale de `pairing.devices.list`
//   presser <pid> <identifiant>       AXPress de l'élément d'identifiant donné
//   lire <pid> <identifiant>          AXValue (texte ou nombre) de l'élément, 1 s'il est absent
//   attendre <pid> <id> present|absent <secondes>
//   confirmer <pid>                   « Révoquer » de la confirmation de révocation
//   fenetre <pid>                     CGWindowID du conteneur (pour screencapture -l)
//
// Pièges mesurés : `AXWindows` peut être vide pour une app en arrière-plan, d'où
// la lecture de `AXMainWindow` et des enfants de l'app en plus ; un cadre hors
// écran peut être infini, refusé par `JSONSerialization` : il est écarté ; sur un
// Space plein écran d'une autre app, l'instance de recette n'expose AUCUNE fenêtre.

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

/// Le libellé d'un contrôle : son titre, sinon sa description (les boutons d'une
/// alerte et d'une barre d'outils n'ont souvent que la seconde).
func label(_ element: AXUIElement) -> String {
    if let title = string(element, kAXTitleAttribute), !title.isEmpty { return title }
    return string(element, kAXDescriptionAttribute) ?? ""
}

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
/// (MESURÉ, session verrouillée ou Space plein écran) : écartée.
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

/// Un élément absent à la première lecture est relu pendant `grace` secondes :
/// sur un Mac chargé, un élément affiché a déjà été introuvable un instant
/// (MESURÉ) ; un « absent » isolé n'est pas une preuve.
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

/// Le conteneur des contrôles d'appairage : la fenêtre des Réglages qui contient
/// `settings.devices` (« fenetre »), sinon l'`AXSheet` qui contient
/// `pairing.sheet` (« feuille », bundle de la base).
struct Panel {
    let container: AXUIElement
    let content: AXUIElement
    let kind: String
}

func panel(_ app: AXUIElement) -> Panel? {
    for window in windows(app) where role(window) == "AXWindow" {
        var content: AXUIElement?
        walk(window) { node in
            if content != nil { return false }
            if identifier(node) == "settings.devices" { content = node; return false }
            return true
        }
        if let content { return Panel(container: window, content: content, kind: "fenetre") }
    }
    for window in windows(app) {
        var result: Panel?
        var sheets: [AXUIElement] = []
        walk(window) { node in
            if result != nil { return false }
            if role(node) == "AXSheet" { sheets.append(node) }
            if identifier(node) == "pairing.sheet" {
                // Le dernier `AXSheet` ouvert sur le chemin est le conteneur.
                result = Panel(container: sheets.last ?? node, content: node, kind: "feuille")
                return false
            }
            return true
        }
        if let result { return result }
    }
    return nil
}

/// Le nombre d'`AXSheet` attachées aux fenêtres de l'app (AC-10, AC-11 : aucune).
func sheetCount(_ app: AXUIElement) -> Int {
    var seen: [AXUIElement] = []
    for window in windows(app) {
        walk(window) { node in
            if role(node) == "AXSheet", !seen.contains(where: { CFEqual($0, node) }) { seen.append(node) }
            return true
        }
    }
    return seen.count
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

// MARK: - Premier plan

/// Le pid de l'app au premier plan, lu en direct par l'élément système (le cache
/// de `NSWorkspace.frontmostApplication` n'est pas rafraîchi sans boucle
/// d'exécution).
func frontmostPID() -> pid_t? {
    let system = AXUIElementCreateSystemWide()
    if let app = element(attribute(system, kAXFocusedApplicationAttribute)) {
        var pid: pid_t = 0
        if AXUIElementGetPid(app, &pid) == .success { return pid }
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier
}

// MARK: - Écran (AX en haut à gauche, NSScreen en bas à gauche)

func screenFrames() -> [CGRect] {
    let screens = NSScreen.screens
    guard let primary = screens.first else { return [] }
    let primaryHeight = primary.frame.height
    return screens.map { screen -> CGRect in
        let f = screen.frame
        return CGRect(x: f.origin.x, y: primaryHeight - (f.origin.y + f.height), width: f.width, height: f.height)
    }
}

func screenFrame(containing rect: CGRect?) -> CGRect? {
    let converted = screenFrames()
    if let rect {
        let center = CGPoint(x: rect.midX, y: rect.midY)
        if let hit = converted.first(where: { $0.contains(center) }) { return hit }
    }
    return converted.first
}

// MARK: - CoreGraphics

func cgWindows(of pid: pid_t, options: CGWindowListOption = [.optionAll]) -> [[String: Any]] {
    let list = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
    return list.filter {
        ($0[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) == pid
            && ($0[kCGWindowLayer as String] as? Int) == 0
    }
}

func bounds(_ info: [String: Any]) -> CGRect {
    guard let dict = info[kCGWindowBounds as String] as? NSDictionary,
          let rect = CGRect(dictionaryRepresentation: dict) else { return .zero }
    return rect
}

// MARK: - Sous-commandes

func fail(_ message: String, code: Int32 = 1) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code)
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

/// Un Space plein écran : une fenêtre de calque 0 à l'écran, de toute la largeur
/// d'un écran et jusqu'à son bas, haute d'au moins l'écran moins l'encoche, et
/// seule app à avoir des fenêtres de calque 0 à l'écran (MESURÉ, cmux plein
/// écran sur un écran 1728 × 1117 : fenêtre (0, 33, 1728 × 1084), sous la seule
/// barre de menus). L'instance de recette n'aurait alors aucune fenêtre accessible.
func fullScreen() {
    let frames = screenFrames()
    let onScreen = ((CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
        as? [[String: Any]]) ?? []).filter { ($0[kCGWindowLayer as String] as? Int) == 0 }
    let owners = Set(onScreen.compactMap { $0[kCGWindowOwnerPID as String] as? Int })
    guard owners.count == 1 else { exit(1) }
    for info in onScreen {
        let rect = bounds(info)
        let covers = frames.contains { screen in
            rect.minX == screen.minX && rect.width == screen.width
                && rect.maxY == screen.maxY && rect.height >= screen.height - 60
        }
        if covers {
            print(info[kCGWindowOwnerName as String] as? String ?? "?")
            exit(0)
        }
    }
    exit(1)
}

/// Le rapport d'une ouverture : conteneur trouvé, feuilles attachées, titre.
func report(_ app: AXUIElement, _ found: Panel, already: Bool, front: (pid_t?, pid_t?)) {
    // Une feuille éventuelle s'attache avec l'ouverture : on lui laisse le temps.
    Thread.sleep(forTimeInterval: 0.5)
    emit([
        "ouverte": true,
        "deja": already,
        "conteneur": found.kind,
        "feuilles": sheetCount(app),
        "titre": found.kind == "fenetre" ? (string(found.container, kAXTitleAttribute) ?? "") : "",
        "premierPlanAvant": front.0.map { Int($0) } ?? NSNull(),
        "premierPlanApres": front.1.map { Int($0) } ?? NSNull(),
    ])
}

/// Presse l'item `title` du menu de l'app, puis attend `ready` ≤ 5 s. Le premier
/// plan est relevé avant et après : l'instance de recette au premier plan ⇒ 4.
func pressAppMenu(_ pid: pid_t, _ app: AXUIElement, title: String, until ready: () -> Panel?) -> (Panel, (pid_t?, pid_t?)) {
    guard let bar = element(attribute(app, kAXMenuBarAttribute)) else { fail("barre de menus illisible") }
    let menus = children(bar)
    guard let appMenu = menus.first(where: { string($0, kAXTitleAttribute) == "OMP Console" }) else {
        let titles = menus.compactMap { string($0, kAXTitleAttribute) }
        fail("menu « OMP Console » introuvable (menus : \(titles.joined(separator: ", ")))")
    }
    var item: AXUIElement?
    walk(appMenu) { node in
        if item != nil { return false }
        if role(node) == "AXMenuItem", string(node, kAXTitleAttribute) == title { item = node; return false }
        return true
    }
    guard let item else { fail("élément de menu « \(title) » introuvable") }
    let before = frontmostPID()
    guard press(item) else { fail("« \(title) » n'a pas pu être pressé") }
    var found: Panel?
    let appeared = poll(seconds: 5) { found = ready(); return found != nil }
    let after = frontmostPID()
    if after == pid {
        fail("focus volé : « \(title) » a mis l'instance de recette (pid \(pid)) au premier plan "
             + "(avant : \(before.map(String.init) ?? "?"))", code: 4)
    }
    guard appeared, let found else {
        if windows(app).isEmpty {
            fail("arbre AX sans fenêtre après « \(title) » (Space plein écran ou session verrouillée ?)", code: 2)
        }
        fail("conteneur d'appairage absent 5 s après « \(title) »")
    }
    return (found, (before, after))
}

func open(_ pid: pid_t, _ app: AXUIElement) {
    if let found = panel(app) { report(app, found, already: true, front: (nil, nil)); exit(0) }
    let (found, front) = pressAppMenu(pid, app, title: "Appairage…") { panel(app) }
    report(app, found, already: false, front: front)
}

func settings(_ pid: pid_t, _ app: AXUIElement) {
    let already = panel(app)?.kind == "fenetre"
    let (found, front) = pressAppMenu(pid, app, title: "Réglages…") {
        guard let found = panel(app), found.kind == "fenetre" else { return nil }
        return found
    }
    report(app, found, already: already, front: front)
}

func count(_ pid: pid_t, title: String) {
    print(cgWindows(of: pid).filter { ($0[kCGWindowName as String] as? String) == title }.count)
}

func close(_ app: AXUIElement) {
    guard let found = panel(app), found.kind == "fenetre" else { fail("fenêtre des Réglages absente") }
    guard let button = element(attribute(found.container, kAXCloseButtonAttribute)) else {
        fail("bouton de fermeture de la fenêtre des Réglages introuvable")
    }
    guard press(button) else { fail("le bouton de fermeture n'a pas pu être pressé") }
    guard poll(seconds: 2, { find(app, id: "settings.devices") == nil }) else {
        fail("settings.devices toujours présent 2 s après la fermeture")
    }
    emit(["fermee": true])
}

func tabs(_ app: AXUIElement) {
    guard let found = panel(app), found.kind == "fenetre" else { fail("fenêtre des Réglages absente") }
    guard let toolbar = children(found.container).first(where: { role($0) == "AXToolbar" }) else {
        fail("barre d'outils de la fenêtre des Réglages introuvable")
    }
    var titles: [String] = []
    walk(toolbar) { node in
        if ["AXButton", "AXRadioButton", "AXCheckBox"].contains(role(node)) {
            titles.append(label(node))
            return false
        }
        return true
    }
    emit(titles)
}

func measure(_ app: AXUIElement) {
    var found: Panel?
    _ = poll(seconds: 5) { found = panel(app); return found != nil }
    guard let found else { fail("conteneur d'appairage absent") }
    let containerFrame = frame(found.container) ?? frame(found.content)
    var allTexts: [String] = []
    walk(found.container) { node in
        allTexts.append(contentsOf: texts(of: node))
        return true
    }
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
        "conteneur": found.kind,
        "fenetre": json(containerFrame),
        "ecran": json(screenFrame(containing: containerFrame)),
        "interrupteur": json(find(app, id: "pairing.toggle").flatMap(frame)),
        "generer": json(find(app, id: "pairing.generate").flatMap(frame)),
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
                if role(node) == "AXButton", label(node) == "Révoquer",
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
    let target = panel(app).flatMap { frame($0.container) }
    // Une feuille fermée garde une fenêtre CG hors écran, que `screencapture -l`
    // refuse (MESURÉ : feuille de préparation fermée avant celle d'appairage) :
    // les fenêtres à l'écran passent d'abord.
    let all = cgWindows(of: pid)
    let visible = all.filter { ($0[kCGWindowIsOnscreen as String] as? Bool) == true }
    let mine = visible.isEmpty ? all : visible
    let best: [String: Any]?
    if let target {
        func distance(_ info: [String: Any]) -> CGFloat {
            let a = bounds(info)
            return abs(a.minX - target.minX) + abs(a.minY - target.minY)
                + abs(a.width - target.width) + abs(a.height - target.height)
        }
        best = mine.min { distance($0) < distance($1) }
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
case "plein-ecran":
    fullScreen()
case "ouvrir":
    let target = pid(arguments, 2)
    open(target, application(target))
case "reglages":
    let target = pid(arguments, 2)
    settings(target, application(target))
case "compter":
    guard arguments.count > 3 else { fail("titre attendu") }
    count(pid(arguments, 2), title: arguments[3])
case "fermer":
    close(application(pid(arguments, 2)))
case "onglets":
    tabs(application(pid(arguments, 2)))
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
    // Un texte rend sa chaîne ; un interrupteur rend son état (0 ou 1).
    switch attribute(target, kAXValueAttribute) {
    case let text as String: print(text)
    case let number as NSNumber: print(number.intValue)
    default: print("")
    }
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
