# GeoFinder — Technisches Konzept & Systemarchitektur

> Phase 1: Konzeptdokument. Enthält **keinen** Quellcode — Grundlage für die
> Implementierung in Phase 2.

## Tech-Stack im Überblick

| Bereich | Wahl | Warum |
| --- | --- | --- |
| Hosting | GitHub Pages (statisch) | Kein Server, kostenlos, HTTPS inklusive |
| Sprache/Runtime | Vanilla JS (ES-Module), HTML5, CSS3 | Keine Build-Pflicht, läuft direkt aus dem Repo |
| Multiplayer-Transport | PeerJS (WebRTC DataChannel) | Kein eigener Signaling-Server nötig |
| Karte | Leaflet.js | Leichtgewichtig, kein API-Key |
| 360°-Panorama | Pannellum | Reines JS, MIT-Lizenz, kein API-Key |
| Panorama-Quelle | Kuratiertes, selbst gehostetes Bild-Set (CC0/CC-BY, z. B. Wikimedia) | Keine Rate-Limits, keine API-Keys, rechtlich sauber |
| Location-Daten | Statisches `data/locations.json` im Repo | Versionierbar, kein Backend nötig |
| Persistenz (lokal) | `localStorage` | Spielername, letzte Einstellungen, Sound-Präferenz |

---

## 1. GitHub Pages Deployment & Statische Architektur

### 1.1 Projektstruktur

Das Repository ist bewusst **ohne Build-Schritt** nutzbar (kein Bundler-Zwang),
damit "git clone → im Browser öffnen bzw. direkt auf Pages deployen" ohne
CI/CD funktioniert. Optionaler Vite-Build kann später für Minifizierung
ergänzt werden, ändert aber nichts an der Grundstruktur:

```
/index.html                 # Single-Entry-Point, alle Screens als <section>-Container
/css/
  base.css                  # Reset, Typografie, Farbvariablen
  layout.css                # Screen-Layouts (Menu, Lobby, HUD, Result, Leaderboard)
  components.css            # Buttons, Cards, Timer, Toasts
/js/
  main.js                   # Bootstrapping, Screen-Router (hash-basiert)
  core/
    state.js                # Zentraler Game-State (Client- und Host-Sicht)
    scoring.js               # Haversine + Punkteformel
    rng.js                   # Seeded Zufallsauswahl der Locations
  network/
    peer-manager.js          # PeerJS-Wrapper: Verbindungsaufbau, Reconnect
    protocol.js               # Nachrichtentypen + (De-)Serialisierung
    host-controller.js        # Autoritative Host-Logik (Timer, Scoring, Broadcast)
    client-controller.js      # Client-seitige Reaktion auf Host-Events
  map/
    guess-map.js              # Leaflet-Integration für Tipp-Platzierung
    result-map.js              # Leaflet-Integration für Ergebnis-Polylines
  panorama/
    pano-viewer.js             # Pannellum-Wrapper, Preloading
  ui/
    screen-menu.js, screen-lobby.js, screen-hud.js,
    screen-result.js, screen-leaderboard.js
    toast.js, clipboard.js
/data/
  locations/
    world-landmarks.json
    capitals.json
    europe.json
  panoramas/                  # (optional, falls selbst gehostet statt extern verlinkt)
/lib/                         # Vendored Third-Party-Libs (kein CDN-Zwang)
  peerjs.min.js
  leaflet/ (leaflet.js, leaflet.css, images/)
  pannellum/ (pannellum.js, pannellum.css)
/assets/
  icons/, sounds/, og-image.png
.github/workflows/deploy.yml  # optional, nur falls später ein Build-Schritt dazukommt
```

**Warum Vendoring statt CDN?** Drei Gründe: (1) Offline-/PWA-Fähigkeit ohne
externe Requests, (2) kein Supply-Chain-Risiko durch fremde CDN-Änderungen,
(3) GitHub Pages liefert alles über dieselbe Origin aus, was CORS-Themen für
die eigenen Assets komplett eliminiert (relevant bleiben nur externe
Kartenkacheln und ggf. externe Panoramabilder, siehe 1.2/3.1).

### 1.2 HTTPS, CORS & Asset-Pfade

- **HTTPS**: GitHub Pages liefert automatisch TLS-Zertifikate aus (auch für
  Custom Domains via Let's Encrypt). Das ist Voraussetzung für WebRTC
  (Secure-Context-Anforderung des Browsers) — PeerJS/WebRTC funktioniert auf
  `http://` nur auf `localhost`, nicht auf einer echten Domain.
- **CORS bei Kartenkacheln**: Externe Tile-Server (siehe 3.2) werden nur für
  Bild-Requests (`<img>`/Canvas-Tiles) genutzt, nicht per `fetch()` mit
  Credential-Zugriff — dafür ist in der Regel kein CORS-Header nötig.
  Kritischer ist die **Nutzungsrichtlinie** der Tile-Anbieter (Rate-Limits,
  Attribution-Pflicht) — dazu mehr in Abschnitt 3.2.
- **CORS bei Panoramabildern**: Falls Panoramen nicht selbst gehostet, sondern
  extern verlinkt werden (z. B. Wikimedia Commons), werden sie ausschließlich
  als `<img>`-Quelle innerhalb von Pannellum geladen (kein Canvas-Pixelzugriff
  nötig, damit greift die CORS-Beschränkung nicht). Für spätere WebGL-Effekte
  (z. B. Cross-Fade zwischen Panoramen) wäre ein `crossorigin="anonymous"`-
  Header seitens des Hosts nötig — Wikimedia liefert diesen bereits.
- **Asset-Pfade**: GitHub Pages Project-Sites laufen unter einem Unterpfad
  (`https://user.github.io/geo-finder/`), nicht unter der Domain-Wurzel.
  Alle Pfade in HTML/CSS/JS werden deshalb **relativ** (`./js/main.js`,
  `./data/locations/world-landmarks.json`) statt absolut (`/js/...`)
  referenziert. Damit funktioniert der exakt gleiche Code sowohl unter einer
  Custom Domain als auch unter einem Repo-Unterpfad, ohne Konfiguration.

### 1.3 Einladungs-Links über URL-Hash

Da es keinen Server gibt, der Routen wie `/room/ABC123` auflösen könnte (GitHub
Pages würde bei einem echten Pfad-Wechsel ohne vorhandene Datei einen 404
werfen), wird der komplette Client-State ausschließlich über das
**URL-Fragment (`#...`)** transportiert. Das Fragment wird nie an den Server
geschickt — ein Page-Reload oder Deep-Link auf `index.html#room=AB3F9K` liefert
immer dieselbe `index.html` aus, das JS übernimmt danach das Routing:

```
https://<user>.github.io/geo-finder/#room=AB3F9K
```

Ablauf:
1. Host erstellt eine Lobby → `peer-manager.js` initialisiert einen PeerJS-
   `Peer` mit einer kurzen, für Menschen lesbaren ID (z. B. `geo-AB3F9K`,
   generiert aus Base32-Alphabet ohne verwechselbare Zeichen wie `0/O`, `1/I`).
2. Die App schreibt `location.hash = 'room=AB3F9K'` und zeigt den vollen Link
   plus "Link kopieren"-Button (Clipboard API) und optional einen QR-Code
   (rein clientseitig gerendert, kein externer QR-Dienst).
3. Öffnet ein zweiter Spieler diesen Link, liest `main.js` beim Start
   `location.hash` aus, erkennt `room=...` und verzweigt direkt in den
   **Client-Beitritts-Flow** statt ins Hauptmenü — es wird sofort ein
   `PeerJS`-Connect zur Host-ID `geo-AB3F9K` versucht.
4. Ein `hashchange`-Listener erlaubt zusätzlich manuelles Eingeben eines Codes
   im Hauptmenü (Fallback, falls der Link z. B. per Sprachnachricht diktiert
   wurde) — dieselbe Logik wie beim Deep-Link, nur ausgelöst durch
   Formular-Submit statt initialem Hash.

---

## 2. P2P-Architektur & Data Flow (PeerJS)

### 2.1 Topologie: Host-autoritatives Sternmodell

PeerJS übernimmt nur das **Signaling** (Austausch von SDP/ICE-Kandidaten) über
den kostenlosen, öffentlichen Standard-Broker (`0.peerjs.com`). Nach dem
Verbindungsaufbau läuft aller Spieldaten-Traffic direkt Peer-zu-Peer über den
WebRTC-DataChannel — der Broker ist danach nicht mehr involviert.

Gewählt wird **kein Full-Mesh**, sondern ein **Stern mit dem Host als
Autorität**:

- Der Host hält ein einziges `Peer`-Objekt und eine `DataConnection` pro
  Client (PeerJS erlaubt mehrere gleichzeitige Verbindungen auf einem Peer).
- Clients verbinden sich ausschließlich mit dem Host, nie untereinander.
- Der Host ist **Single Source of Truth** für: aktuelle Runde, Timer-Start,
  Location-Auswahl, Punkteberechnung, Rundenergebnisse, Spielerliste.
- Clients senden nur Inputs (Tipp-Koordinaten, Ready-Status) und rendern,
  was der Host broadcastet.

**Begründung**: Full-Mesh würde bei >2 Spielern Konsistenzprobleme lösen
müssen (wer ist bei Punktegleichheit/Timeout autoritativ?). Das
Stern-Modell macht das Spiel deterministisch und einfach zu debuggen — der
Host ist ohnehin schon der Initiator des Raums, das passt konzeptionell.

**Bekannter Trade-off**: Verlässt der Host das Spiel, endet die Session
(kein automatisches Host-Failover in v1). Für ein GeoGuessr-Duell (typ. 2,
gelegentlich 3–4 Spieler) ist das ein akzeptabler Scope — Host-Migration wird
als mögliche Phase-3-Erweiterung vermerkt, nicht für den MVP geplant.

### 2.2 Zustandsautomat (Host-Sicht)

```
LOBBY → COUNTDOWN → ROUND_ACTIVE → ROUND_RESULT → (n. Runden) → FINAL_LEADERBOARD
                        ↑_________________________|
```

- **LOBBY**: Spieler joinen, setzen Namen/Farbe, markieren sich "bereit".
  Host konfiguriert Rundenanzahl, Zeitlimit, Location-Pool.
- **COUNTDOWN**: kurzer synchronisierter Countdown (3-2-1), damit alle
  Clients das erste Panorama zeitgleich sehen.
- **ROUND_ACTIVE**: Panorama wird angezeigt, Tipp-Timer läuft (host-seitig
  autoritativ, siehe 2.4), Spieler platzieren Pin auf der Mini-Karte.
- **ROUND_RESULT**: Host berechnet Distanzen/Punkte aller eingegangenen
  Tipps (fehlende Tipps = 0 Punkte), broadcastet Ergebnis inkl.
  tatsächlicher Position.
- **FINAL_LEADERBOARD** nach der letzten Runde, mit Option "Nochmal spielen"
  (zurück zu LOBBY mit gleicher Spielergruppe) oder "Verlassen".

### 2.3 Daten-Paket-Format

Alle Nachrichten folgen einem einheitlichen Envelope, um Versionierung und
Debugging zu vereinfachen:

```
{
  type: "<MESSAGE_TYPE>",
  senderId: "<peerId>",
  ts: <unix_ms>,
  payload: { ... }
}
```

| Typ | Richtung | Payload (Kurzbeschreibung) |
| --- | --- | --- |
| `ROOM_JOIN_REQUEST` | Client → Host | `{ name, colorTag }` |
| `ROOM_JOIN_ACCEPTED` | Host → Client | `{ yourPlayerId, settings, players[] }` |
| `LOBBY_STATE` | Host → Alle | `{ players[], settings }` (bei jeder Änderung) |
| `PLAYER_READY` | Client → Host | `{ ready: bool }` |
| `GAME_START` | Host → Alle | `{ roundCount, timeLimitMs, poolId }` |
| `ROUND_START` | Host → Alle | `{ roundIndex, panoramaUrl, startTimestamp, timeLimitMs }` |
| `SUBMIT_GUESS` | Client → Host | `{ roundIndex, lat, lng, submittedAtMs }` |
| `PLAYER_GUESSED` | Host → Alle | `{ playerId }` (nur Indikator "hat getippt", ohne Position — verhindert Abschauen) |
| `ROUND_RESULT` | Host → Alle | `{ roundIndex, actualLat, actualLng, results:[{playerId, lat, lng, distanceKm, score}] }` |
| `GAME_OVER` | Host → Alle | `{ finalScores:[{playerId, total, perRound[]}] }` |
| `PLAYER_LEFT` | Host → Alle | `{ playerId }` |
| `HOST_DISCONNECTED` | (lokal erkannt) | Client zeigt "Host getrennt"-Screen |
| `PING` / `PONG` | beidseitig | Latenz-/Clock-Offset-Messung |

### 2.4 Timer- und Punktesynchronisation

- Der Host ist alleinige Zeitquelle. `ROUND_START` enthält `startTimestamp`
  (Host-`Date.now()`) und `timeLimitMs`. Jeder Client berechnet die
  Restzeit lokal als `timeLimitMs - (Date.now() - startTimestamp + clockOffset)`.
- `clockOffset` wird beim Verbindungsaufbau per einfachem `PING`/`PONG`-
  Roundtrip grob geschätzt (Halbierung der Round-Trip-Time), um
  Anzeige-Drift bei spürbarer Latenz zu minimieren. Das ist eine
  UI-Komfort-Korrektur, keine harte Fairness-Garantie — für ein Casual-Duell
  ausreichend.
- **Autoritativ für Rundenende ist ausschließlich der Host**: Läuft der
  host-lokale Timer ab, wird die Runde serverseitig (= hostseitig)
  geschlossen und `ROUND_RESULT` verschickt, unabhängig davon, ob ein
  Client wegen Netzwerklatenz noch "denkt", er hätte Zeit. Das verhindert
  Manipulation durch client-seitig verzögerte `SUBMIT_GUESS`-Nachrichten.
- Reconnect: Trennt sich ein Client kurzzeitig (z. B. Tab-Wechsel, WLAN-
  Hänger), erkennt `peer-manager.js` das über PeerJS-`close`/`error`-Events
  und versucht automatisch einen Re-Connect zur gleichen Host-ID. Der Host
  hält den Spielerzustand für ein Kulanzfenster (z. B. 30 s) und sendet bei
  erfolgreichem Wiederverbinden den aktuellen `LOBBY_STATE`/Rundenstatus
  erneut, damit der Client nahtlos weitermachen kann.

---

## 3. Karten- & Panorama-Integration

### 3.1 360°-Panorama-System: Pannellum + kuratiertes Bild-Set

**Viewer**: [Pannellum](https://pannellum.org/) — reines JavaScript, MIT-
Lizenz, kein API-Key, rendert äquirektangulare JPG/PNG-Panoramen per WebGL
(mit Canvas2D-Fallback). Steuerung per Maus/Touch/Gyroskop ist eingebaut.

**Bildquelle — Abwägung**:

| Option | Kosten | Abdeckung | Bewertung |
| --- | --- | --- | --- |
| Google Street View Static API | Kostenpflichtig ab Freikontingent, API-Key | Weltweit, sehr dicht | **Ausgeschlossen** — widerspricht "ohne teure API-Keys" |
| Mapillary API | Kostenloser API-Key, aber Rate-Limits, meist perspektivische statt echter 360°-Aufnahmen | Gut in Städten, lückenhaft global | Interessant für spätere "Explorer-Mode"-Erweiterung, aber zusätzliche Abhängigkeit (Key-Management, CORS, Bildfilterung nach echten Equirectangular-Captures) |
| Kuratiertes Set aus Wikimedia Commons ("Equirectangular panoramic images", CC0/CC-BY/CC-BY-SA) | Kostenlos, keine Keys, keine Rate-Limits (moderater Traffic, GH Pages CDN) | Begrenzt auf handverlesene, aber weltweit verteilte Landmarks | **Gewählt für v1** |

**Entscheidung für v1**: Ein handkuratiertes Set von ca. 150–300 frei
lizenzierten Equirectangular-Panoramen (Landmarks, Städte, Naturorte über alle
Kontinente verteilt), referenziert in `data/locations/*.json`. Die Bilder
werden entweder direkt aus Wikimedia Commons verlinkt (mit Attribution im
UI, wie von CC-BY/CC-BY-SA gefordert) oder — um Verfügbarkeits-/Lizenz-Risiko
zu minimieren — als eigene Kopien via Git-LFS oder als Release-Assets im
Repo gehostet. Vorteil: **keine Laufzeit-Abhängigkeit von einer fremden API**,
100 % deterministisches Verhalten, keine Rate-Limits, keine Kosten.
Mapillary-Anbindung bleibt als optionale, klar getrennte Erweiterung für
später dokumentiert (eigenes Modul, eigener Location-Pool-Typ), berührt aber
nicht den MVP-Kern.

### 3.2 Leaflet.js für Tipp-Platzierung & Distanzlinien

Leaflet wird an zwei Stellen eingesetzt:

1. **Guess-Map (während der Runde)**: Kleines, ausklappbares Overlay
   (kollabiert in einer Ecke, expandiert on-hover/on-click zur vollen
   Interaktionsgröße, ähnlich dem GeoGuessr-Vorbild). Klick/Touch setzt
   einen Marker; Bestätigen aktiviert den "Raten"-Button.
2. **Result-Map (Rundenergebnis)**: Zeigt echten Standort (roter Marker) und
   Tipp-Marker aller Spieler in ihrer jeweiligen Farbe, verbunden durch
   `L.polyline([...])` zur exakten Position. `map.fitBounds()` zoomt
   automatisch so, dass alle Marker sichtbar sind.

**Tile-Provider**: Für ein reines Hobby-/Community-Projekt ohne eigenen
Tile-Server kommen kostenlose Basiskarten infrage:

- **OpenStreetMap Standard-Tiles** — kostenlos, aber mit strikter
  [Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
  (kein produktiver Dauerbetrieb mit hohem Traffic ohne eigenen Server).
  Für ein kleines Duell-Spiel im Freundeskreis vertretbar, aber Risiko einer
  Blockierung bei viralem Wachstum.
- **CARTO Basemaps (Positron/Voyager)** — kostenlos für moderate,
  nicht-kommerzielle Nutzung, kein API-Key nötig, i. d. R. großzügigeres
  Rate-Limit als der OSM-Haupt-Tile-Server. **Empfehlung als Default**, mit
  OSM-Tiles als dokumentiertem Alternativ-Layer.
- Beide werden ausschließlich per `<img>`/Leaflet-TileLayer geladen (kein
  authentifizierter `fetch`), Attribution wird gemäß Lizenzbedingungen im
  Karten-Layer eingeblendet (Leaflet-Standardverhalten via `attribution`-
  Option).

Leaflet selbst wird vendored (`/lib/leaflet/`) statt per CDN geladen (siehe
1.1) — nur die Kachel-**Bilder** kommen zur Laufzeit extern.

---

## 4. Game Mechanics & Formeln

### 4.1 Distanzberechnung (Haversine)

Großkreisdistanz zwischen Tipp-Koordinate und tatsächlicher Koordinate,
Erdradius R = 6371 km:

```
a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlng/2)
c = 2·atan2(√a, √(1−a))
distanceKm = R · c
```

### 4.2 Punkteformel (0–5000 pro Runde)

Exponentieller Abfall nach GeoGuessr-Vorbild, damit auch "grobe Richtung"
noch belohnt wird, aber Präzision stark incentiviert bleibt:

```
score = round( 5000 · e^(−distanceKm / scaleKm) )
```

- `scaleKm` ist ein pro Location-Pool konfigurierbarer Skalierungsfaktor:
  größerer Wert bei weltweiten Pools (z. B. `scaleKm = 2000` für
  `world-landmarks.json`), kleinerer Wert bei regional begrenzten Pools
  (z. B. `scaleKm = 300` für `europe.json`), damit die Punkteverteilung zur
  geografischen Streuung des Pools passt.
- **Perfect-Guess-Bonus**: Distanz < 50 m (typischer GPS-/Klickfehler bei
  exaktem Treffer) → fixe 5000 Punkte, unabhängig von Rundungsfehlern der
  Exponentialformel.
- **Kein Tipp abgegeben** (Timeout ohne `SUBMIT_GUESS`) → 0 Punkte, wird im
  `ROUND_RESULT` explizit als "kein Tipp" markiert (nicht als "0 Punkte
  wegen 20.000 km Distanz" missverständlich dargestellt).
- Score wird ausschließlich **host-seitig** berechnet (siehe 2.1) — Clients
  zeigen nur an, was der Host im `ROUND_RESULT` liefert. Das verhindert
  Client-seitige Manipulation der eigenen Punktzahl.

### 4.3 Location-Pools

Statische JSON-Dateien im Repository, kein Backend-Abruf nötig:

```
{
  "id": "world-landmarks",
  "scaleKm": 2000,
  "locations": [
    {
      "id": "eiffel-tower",
      "name": "Eiffelturm, Paris",
      "lat": 48.8584,
      "lng": 2.2945,
      "panoramaUrl": "./assets/panoramas/eiffel-tower.jpg",
      "attribution": "CC-BY-SA, Wikimedia Commons, Autor XY",
      "difficulty": "easy",
      "tags": ["landmark", "europe", "urban"]
    }
  ]
}
```

- Host wählt bei Spielstart einen Pool und zieht daraus `roundCount` eindeutige
  (nicht wiederholte) Locations per **seeded** Zufallsauswahl (`rng.js`),
  damit bei "Nochmal spielen" auf Wunsch reproduzierbare Sequenzen möglich
  sind (z. B. für Turniere: alle Gruppen spielen dieselben Locations).
- Nur der Host liest den vollen Pool inkl. Koordinaten; Clients erhalten pro
  Runde ausschließlich `panoramaUrl` (nicht die Koordinaten!) über
  `ROUND_START`, damit ein neugieriger Blick in die DevTools-Netzwerk-Tab
  der Clients die Lösung nicht vorab verrät.

---

## 5. UI/UX & Screen-Flow

```
┌────────────┐    ┌───────────┐    ┌─────────────┐    ┌──────────────┐    ┌───────────────────┐
│ Main Menu  │───▶│  Lobby    │───▶│  Game HUD   │───▶│ Round Result │───▶│ Final Leaderboard  │
│            │    │           │    │ (Panorama + │    │ (Karte +     │    │                    │
│ Solo / Host│    │ Code+Link │    │  Mini-Karte │    │  Distanz-    │    │ Podium, Verlauf,   │
│ / Beitreten│    │ Copy, Spie│    │  + Timer)   │    │  linien)     │    │ "Nochmal spielen"  │
└────────────┘    │lerliste,  │    └──────┬──────┘    └──────────────┘    └────────┬───────────┘
                   │ Ready/    │           │  (Runde n von N wiederholt sich)      │
                   │ Start)    │◀──────────┴────────────────────────────────────────┘
                   └───────────┘
```

- **Main Menu**: "Solo spielen", "Duell erstellen" (→ Lobby als Host),
  "Beitreten" (Code-Eingabefeld, wird auch automatisch übersprungen, wenn
  `#room=...` im Link steckt — siehe 1.3). Grundeinstellungen (Name, Avatar-
  Farbe) werden in `localStorage` gemerkt.
- **Lobby**: Großer, leicht kopierbarer Einladungslink + "Link kopieren"-
  Button (Clipboard API mit Toast-Bestätigung), Spielerliste mit
  Bereit-Status, Host-exklusive Einstellungen (Rundenanzahl, Zeitlimit,
  Location-Pool), "Spiel starten"-Button (nur Host, aktiv sobald ≥1 anderer
  Spieler bereit ist oder im Solo-Modus sofort).
- **Game HUD**: Vollflächiger Pannellum-Viewer als Hintergrund; unten rechts
  eine kollabierte Mini-Karte, die on-hover/on-tap zur vollen
  Interaktionsgröße aufklappt (Leaflet, siehe 3.2); oben mittig Rundenanzeige
  ("Runde 3/5") und Countdown-Timer (Farbwechsel zu Rot unter 10 s);
  "Raten"-Button wird erst aktiv, sobald ein Pin gesetzt wurde; dezenter
  Live-Indikator, welche Mitspieler schon getippt haben (ohne deren Position
  zu zeigen, siehe `PLAYER_GUESSED`).
- **Round Result**: Karte mit tatsächlichem Standort und allen
  Spieler-Pins inkl. farbcodierter Distanzlinien; darunter animierte
  Punkte-Zähler pro Spieler (Distanz + erzielte Punkte); automatischer
  Übergang zur nächsten Runde nach Ablauf einer kurzen Anzeigezeit (vom Host
  getriggert, für alle synchron).
- **Final Leaderboard**: Podium-Darstellung Top 3, vollständige
  Punktetabelle mit Rundenverlauf pro Spieler, Buttons "Nochmal spielen"
  (gleiche Lobby, gleiche Spieler) und "Zurück zum Menü".

---

## Offene Trade-offs (bewusst dokumentiert, nicht versteckt)

1. **Kein Host-Failover** in v1 — Host-Disconnect beendet die Partie. Für
   2–4-Spieler-Casual-Duelle akzeptiert, klar als Phase-3-Kandidat markiert.
2. **PeerJS-Cloud-Broker** (`0.peerjs.com`) ist ein kostenloser Drittanbieter-
   Dienst — theoretisch ein Ausfallpunkt für den *Verbindungsaufbau* (nicht
   für laufende Spiele, die schon eine offene DataChannel-Verbindung haben).
   Dokumentierte Option: eigener, selbst gehosteter `PeerServer` (Node,
   kostenlos z. B. auf Render/Fly.io) als austauschbarer Signaling-Endpunkt,
   ohne dass sich am P2P-Datenfluss etwas ändert.
3. **OSM/CARTO-Tile-Nutzung** unterliegt Fair-Use-Richtlinien der Anbieter —
   für ein kleines Community-Projekt unkritisch, bei starkem Wachstum wäre
   ein eigener Tile-Cache/Proxy nötig (dann aber kein "reines Static
   Hosting" mehr).
4. **Zeit-/Score-Synchronisation** ist "gut genug für Casual-Play", aber
   keine harte Anti-Cheat-Garantie (ein manipulierter Client könnte
   theoretisch die eigene Uhr verstellen). Für ein Freundeskreis-Duell ohne
   Ranglisten-Anspruch als akzeptables Risiko eingestuft.

---

**Ist dieses Konzept so freigegeben, oder gibt es gewünschte Anpassungen bei
den Bibliotheken (z. B. doch Mapillary statt kuratiertem Panorama-Set,
eigener PeerServer statt Public-Broker) oder bei den Spielmechaniken (Rundenanzahl,
Punkteformel, Location-Pools), bevor wir in Phase 2 mit der Implementierung
beginnen?**
