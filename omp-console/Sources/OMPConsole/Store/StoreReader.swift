// Lecture du magasin d'état : nom des fichiers retenus, lecture JSON, comptage des
// entrées écartées, instantané complet (BR-1, S-2 … S-8).
//
// Aucune API d'écriture n'est appelée ici — la couche est un LECTEUR (B-10, S-10) :
// `contentsOfDirectory` et `contents(atPath:)` seulement.

import Foundation

/// Le type `JSONValue` vit avec le modèle de session (`Session/SessionModel.swift`) :
/// la cible `OMPConsole` est unique, donc un seul type par nom. Il est étendu ici du
/// parseur `JSONSerialization` dont la lecture du magasin a besoin, avec la
/// distinction STRICTE booléen / nombre que `JSONSerialization` mélange (les deux
/// sont des `NSNumber`). Le lecteur TypeScript rejette `true` là où il attend un
/// nombre, et réciproquement (`typeof` distingue les deux) : sans cette distinction,
/// un fichier falsifié se lirait.
extension JSONValue {
    /// `nil` quand le contenu n'est pas du JSON : la lecture rend alors « écarté »,
    /// jamais un objet partiel.
    static func parse(_ data: Data) -> JSONValue? {
        guard let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return nil
        }
        return JSONValue(any: any)
    }

    private init(any: Any) {
        switch any {
        case is NSNull:
            self = .null
        case let number as NSNumber:
            // `true`/`false` arrivent aussi en `NSNumber` : sans ce test, `true`
            // serait lu comme le nombre 1.
            self = CFGetTypeID(number) == CFBooleanGetTypeID()
                ? .bool(number.boolValue)
                : .number(number.doubleValue)
        case let text as String:
            self = .string(text)
        case let list as [Any]:
            self = .array(list.map { JSONValue(any: $0) })
        case let map as [String: Any]:
            self = .object(map.mapValues { JSONValue(any: $0) })
        default:
            self = .null
        }
    }
}

/// L'horloge des lectures, injectable : un test de péremption fixe un T0 au lieu de
/// dépendre de l'horloge murale.
struct StoreClock: Sendable {
    let nowMs: @Sendable () -> Double

    init(nowMs: @escaping @Sendable () -> Double) {
        self.nowMs = nowMs
    }

    static let live = StoreClock { Date().timeIntervalSince1970 * 1000 }
}

/// Un lecteur du magasin, lié à UNE racine et à UNE horloge : les deux sont
/// injectables, la couche ne lit donc jamais `~/.omp` par accident dans un test.
struct StoreReader: Sendable {
    let stateDir: String
    let clock: StoreClock

    init(stateDir: String = PipelineStore.stateDir(), clock: StoreClock = .live) {
        self.stateDir = stateDir
        self.clock = clock
    }

    func readRunning() -> RunningEnvelope {
        let nowMs = clock.nowMs()
        let (availability, entries, discarded) = scan(.running) { _, json in
            RunningEntry(json: json, nowMs: nowMs)
        }
        // Le plus ancien maillon d'abord (l'ordre d'arrivée) — puis la borne, qui
        // garde donc les premiers arrivés (parité `readStore`, store.ts:568-596).
        let sorted = entries.sorted { (left: RunningEntry, right: RunningEntry) -> Bool in
            if left.phaseStartedAt != right.phaseStartedAt {
                return left.phaseStartedAt < right.phaseStartedAt
            }
            return left.cwd < right.cwd
        }
        return RunningEnvelope(
            availability: availability,
            entries: Array(sorted.prefix(PipelineStore.runningReadLimit)),
            discarded: discarded
        )
    }

    func readHistory() -> HistoryEnvelope {
        let (availability, entries, discarded) = scan(.history) { _, json in
            HistoryEntry(json: json)
        }
        // Le plus récent d'abord — puis la borne, qui garde donc les plus récents.
        let sorted = entries.sorted { (left: HistoryEntry, right: HistoryEntry) -> Bool in
            if left.endedAt != right.endedAt {
                return left.endedAt > right.endedAt
            }
            return left.cwd < right.cwd
        }
        return HistoryEnvelope(
            availability: availability,
            entries: Array(sorted.prefix(PipelineStore.historyReadLimit)),
            discarded: discarded
        )
    }

    func readLots() -> LotEnvelope {
        let nowMs = clock.nowMs()
        let (availability, lots, discarded) = scan(.lots) { _, json in
            Lot(json: json, nowMs: nowMs)
        }
        return LotEnvelope(availability: availability, lots: lots, discarded: discarded)
    }

    func readProjects() -> ProjectEnvelope {
        let (availability, projects, discarded) = scan(.projects) { _, json in
            Project(json: json)
        }
        return ProjectEnvelope(availability: availability, projects: projects, discarded: discarded)
    }

    func readAudit() -> AuditEnvelope {
        let nowMs = clock.nowMs()
        // La clé d'identité d'un relais est le NOM du fichier (S-6) : c'est ici que
        // l'écart avec `readAuditRelay` — qui compare la session demandée — se voit.
        let (availability, relays, discarded) = scan(.audit) { name, json in
            AuditRelay(json: json, id: String(name.dropLast(".json".count)), nowMs: nowMs)
        }
        return AuditEnvelope(availability: availability, relays: relays, discarded: discarded)
    }

    /// Les boîtes d'un run : deux niveaux, donc pas le balayage générique. Un nom
    /// de boîte hors `^[0-9a-f]{16}-[0-9]+$` est ignoré SANS être compté, et une
    /// livraison illisible est CONSERVÉE avec `payload == nil` (le consommateur du
    /// dépôt doit pouvoir la supprimer) — d'où `discarded == 0` (S-5).
    func readInbox() -> InboxEnvelope {
        let dir = PipelineStore.directory(.inbox, stateDir: stateDir)
        var boxes: [InboxBox] = []
        for name in fileNames(dir).sorted() where isInboxBoxName(name) {
            let boxPath = joinPath(dir, name)
            var deliveries: [InboxDelivery] = []
            // Ordre chronologique = ordre lexicographique du nom
            // (`<epoch ms sur 16 chiffres>-<4 hex>.json`, store.ts:372-380).
            for file in fileNames(boxPath).sorted() where file.hasSuffix(".json") {
                let filePath = joinPath(boxPath, file)
                let payload: PanelDelivery?
                if let data = FileManager.default.contents(atPath: filePath), let json = JSONValue.parse(data) {
                    payload = asDelivery(json)
                } else {
                    payload = nil
                }
                deliveries.append(InboxDelivery(file: filePath, payload: payload))
            }
            boxes.append(InboxBox(name: name, path: boxPath, deliveries: deliveries))
        }
        return InboxEnvelope(availability: directoryAvailability(dir), boxes: boxes, discarded: 0)
    }

    /// Une passe de lecture complète. Aucune écriture, jamais : les propriétaires
    /// morts ne sont ni déplacés vers `history/` ni retirés (S-7, S-10).
    func readAll() -> StoreSnapshot {
        StoreSnapshot(
            running: readRunning(),
            history: readHistory(),
            lots: readLots(),
            projects: readProjects(),
            inbox: readInbox(),
            audit: readAudit()
        )
    }

    /// Le balayage commun aux cinq stores plats : noms conformes (`<16 hex>.json`)
    /// triés, un fichier illisible ou au schéma invalide est ÉCARTÉ et compté. Tout
    /// autre nom — temporaire `<fichier>.tmp-<pid>`, `.DS_Store`, sous-répertoire —
    /// est ignoré sans être compté (S-8).
    private func scan<T>(
        _ store: PipelineStore,
        decode: (String, JSONValue) -> T?
    ) -> (availability: StoreAvailability, entries: [T], discarded: Int) {
        let dir = PipelineStore.directory(store, stateDir: stateDir)
        var entries: [T] = []
        var discarded = 0
        for name in fileNames(dir).sorted() where isStoreEntryName(name) {
            let file = joinPath(dir, name)
            guard let data = FileManager.default.contents(atPath: file), let json = JSONValue.parse(data) else {
                discarded += 1
                continue
            }
            if let entry = decode(name, json) {
                entries.append(entry)
            } else {
                discarded += 1
            }
        }
        return (directoryAvailability(dir), entries, discarded)
    }
}

/// `.absent` quand le répertoire n'existe pas ou n'est PAS un répertoire ;
/// `.present` sinon — un répertoire présent mais illisible reste `.present` (c'est
/// l'échec de `readdir`, pas l'illisibilité d'une ENTRÉE).
func directoryAvailability(_ dir: String) -> StoreAvailability {
    var isDirectory: ObjCBool = false
    guard FileManager.default.fileExists(atPath: dir, isDirectory: &isDirectory), isDirectory.boolValue else {
        return .absent
    }
    return .present
}

/// Les noms d'un répertoire, sans tri (`contentsOfDirectory` n'en donne aucun) ;
/// un répertoire absent ou illisible rend `[]`, jamais une erreur.
func fileNames(_ dir: String) -> [String] {
    (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
}

/// `^[0-9a-f]{16}\.json$` (`STORE_FILE`, store.ts:104) : le SEUL nom qu'un store
/// plat lit.
func isStoreEntryName(_ name: String) -> Bool {
    let suffix = ".json"
    guard name.count == 16 + suffix.count, name.hasSuffix(suffix) else { return false }
    for character in name.dropLast(suffix.count) where !isLowerHex(character) { return false }
    return true
}

/// `^[0-9a-f]{16}-[0-9]+$` : un nom de boîte produit par `panelInboxDirFor`
/// (store.ts:356-366).
func isInboxBoxName(_ name: String) -> Bool {
    guard let dash = name.firstIndex(of: "-") else { return false }
    let head = name[name.startIndex..<dash]
    let tail = name[name.index(after: dash)...]
    guard head.count == 16, !tail.isEmpty else { return false }
    for character in head where !isLowerHex(character) { return false }
    for character in tail where !(character >= "0" && character <= "9") { return false }
    return true
}
