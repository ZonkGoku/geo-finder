# GeoFinder / PulseMap — Technisches Audit & Roadmap

Analyse-Datum: 2026-09-07 · Branch: `claude/geoguessr-clone-architecture-bsandn`

Diese Analyse deckt fünf Säulen ab: Architektur & Performance, AAA-Juice/Sound,
P2P-Netzwerk & Anti-Cheat, Mobile/Responsive UX, sowie Retention & Meta-Game.
Jeder Befund ist an konkreten Code-Stellen verifiziert (Datei:Zeile), keine
generischen Vermutungen.

Vorab positiv festzuhalten, weil es den Rahmen für alle Empfehlungen unten
setzt: Die Grundarchitektur ist bereits sauber getrennt — `core/state.js`
(zentraler State + `EventBus`), `net/host.js`/`net/client.js` (Controller,
Host bleibt konsequent autoritativ) und `app.js` (reine UI, reagiert nur auf
Bus-Events) bilden drei klar getrennte Schichten. Das ist kein Nebenprodukt,
sondern eine gute Grundlage — die meisten Befunde unten sind Lücken
*innerhalb* dieser Schichten, nicht Brüche der Architektur selbst.

---

## 1. Kritische Schwachstellen & Tech-Debt

### 1.1 Orphaned Timer-Leak beim Verlassen einer laufenden Heatmap-Runde
**`js/app.js`, `resetToMenu()` (Zeile ~2312) vs. `heatmapTimerInterval` (Zeile 1065)**

`resetToMenu()` räumt gezielt `hudTimerInterval` und `resultCountdownInterval`
auf (Zeile 2320f.) — aber **nicht** das separate, heatmap-eigene
`heatmapTimerInterval`. Verlässt ein Spieler eine PulseMap-Runde mit
gesetztem Zeitlimit vorzeitig über "Spiel verlassen", läuft der
`setInterval(update, 250)` aus `renderHeatmapTimer()` (Zeile 1126) im
Hintergrund weiter — inklusive `sound.setRoundTension()`-Aufrufen und
DOM-Writes auf ein inzwischen verstecktes Element — bis die (jetzt stale)
`state.round.startTimestamp + timeLimitMs`-Differenz irgendwann von selbst
negativ wird. Kein Absturz, aber unnötige CPU/Audio-Last nach dem
Menü-Rücksprung, und strukturell derselbe Fehlerklasse, die `HostController`
auf der Host-Seite (Zeile 85-88: `destroy()` räumt `roundTimer`,
`nextRoundTimer`, alle `leaveTimers`) bereits sauber vermeidet — dieselbe
Disziplin fehlt hier nur auf der Client-UI-Seite.

**Fix:** `clearHeatmapTimer()` (existiert bereits, Zeile 1065) in
`resetToMenu()` aufrufen, analog zu den anderen beiden Timern.

### 1.2 Kein echter Reconnect nach WebRTC-Verbindungsabbruch
**`js/net/peer-manager.js`, Zeile 70-75**

Der einzige Reconnect-Mechanismus ist `peer.on('disconnected', () =>
peer.reconnect())` — das repariert *nur* die PeerJS-Signaling-Verbindung
zum Broker, nicht die eigentliche `DataConnection` zum Host/Client. Bricht
die Datenverbindung selbst ab (z. B. Handy wechselt von WLAN auf Mobilfunk,
sehr wahrscheinliches Szenario für ein mobile-first P2P-Spiel), gibt es
keinen Retry-Loop und keinen Weg zurück in denselben Spieler-Slot — der
Client landet über `net:host-disconnected` (Zeile 97) direkt im
"Verbindung verloren"-Zustand und muss komplett neu beitreten. Für ein Spiel,
das explizit auf Mobile-Netzwerke zielt, ist ein kurzer Netzwechsel aber
eher Regel als Ausnahme.

**Fix-Richtung:** Host reserviert den Spieler-Slot für ein kurzes Zeitfenster
(z. B. 20-30s) nach Connection-Close statt ihn sofort zu entfernen, Client
versucht in diesem Fenster automatisch erneut `joinRoom()` mit derselben
`peerId`/demselben Namen und wird dem reservierten Slot wieder zugeordnet
statt einen neuen Eintrag zu erzeugen.

### 1.3 Keine Wertebereichs-Prüfung bei Host-autoritativen Koordinaten
**`js/core/scoring.js`, `scoreGuess()` Zeile 57-69**

Der `Number.isFinite`-Guard (Zeile 64, mit gutem erklärendem Kommentar zum
NaN-Crash-Fall) fängt `NaN`/nicht-numerische Werte zuverlässig ab — prüft
aber keinen Wertebereich. Ein manipulierter Client könnte weiterhin ein
*endliches*, aber unsinniges `lat`/`lng` (z. B. `99999`) senden. Das rechnet
sich zwar über `haversineDistanceKm()` durch, ohne zu crashen, kann aber als
Ergebnis-Koordinate an `result-map.js`/Leaflet weitergereicht werden, dessen
`LatLng`-Handling für Werte weit außerhalb ±90/±180 nicht auf Robustheit
geprüft ist.

**Fix:** `lat`/`lng` zusätzlich auf den validen Bereich clampen oder Tipp bei
Überschreitung wie einen fehlenden Tipp behandeln (gleiches Muster wie der
bestehende NaN-Fall).

### 1.4 Monolithisches `app.js` (2653 Zeilen) ohne Code-Splitting
Ein einziges Modul rendert Menü, Lobby, Panorama-HUD, Leaderboard, i18n
*und* das komplette PulseMap-UI (Suche, Karte, Top-3, Ergebnis-Screen,
Share-Flow). Jedes Gerät lädt/parst diesen kompletten Code auch dann, wenn
nur Solo-PulseMap gespielt wird — auf einem älteren Mobilgerät (der explizit
priorisierten Zielplattform, siehe Abschnitt 4) ist das unnötige
Parse-/Compile-Zeit für nie genutzten Code. Kein akuter Bug, aber die
Datei ist inzwischen groß genug, dass jede weitere Funktion (Achievements,
Rank-Tiers, s. Abschnitt 5) die Wartbarkeit weiter verschlechtert, wenn nicht
gegengesteuert wird.

**Fix-Richtung:** Modus-spezifische Render-Funktionen (Heatmap-Block ist mit
~1200 Zeilen bereits der größte zusammenhängende Abschnitt) in eigene Module
extrahieren, `app.js` auf Bus-Wiring + Screen-Routing reduzieren.

### 1.5 Drei getrennte, unverbundene Local-Storage-Profile
**`heatmap-stats.js`, `player-stats.js`, `high-scores.js`** — jedes mit
eigenem `STORAGE_KEY`, eigenem Schema, keine gemeinsame Spieler-Identität.
Für sich funktioniert jedes einwandfrei, aber ein modusübergreifendes
Achievement-/Rang-System (Abschnitt 5, bereits als Phase-2/3-Aufgabe
vorgemerkt) lässt sich auf drei disjunkten Stores nicht sauber aufbauen,
ohne vorher ein gemeinsames Profil-Schema zu schaffen.

---

## 2. Top 5 Quick Wins (maximale AAA-Wirkung, minimaler Aufwand)

1. **Battle-Royale-Elimination als eigener Moment.** Aktuell reagiert eine
   Elimination nur mit generischem `haptics.tapStrong()` + Text-Tag
   "Ausgeschieden" (`app.js` Zeile 1898f., 1971f.) — demselben Haptik-Level
   wie ein normaler Rundensieg. Das ist der dramatischste Moment des
   kompetitivsten Modus und hat aktuell **kein** eigenes Sound-Signal und
   keinen eigenen visuellen Beat. Ein kurzer Sting (`sound.js` hat bereits
   die Infrastruktur für weitere Cues) + Vignette/Screen-Flash auf
   `.score-card.eliminated` wäre mit vorhandenen Bausteinen (Partikel-,
   Sound-, Haptik-Module existieren bereits) schnell umsetzbar.

2. **Konfetti-Angleichung zwischen den Modi.** PulseMap bekam diese Session
   sehr reichhaltiges Feedback (Glow-Pulse, Radar-Ping, Wordle-Share,
   glassmorphe Toasts). Klassische Modi (Punkte/HP/Country-Streak) nutzen
   `particleBurst()` nur an zwei Stellen mit kleinerem Farbschema
   (Zeile 1961). Das Farbschema/Timing von PulseMap auf die Runden-Siege der
   älteren Modi zu übertragen schließt eine spürbare "Politur-Lücke"
   zwischen alt und neu.

3. **Einheitliche Hover-/Ripple-Sprache für alle interaktiven Elemente.**
   `attachRipple()` (Zeile 2355) läuft aktuell nur auf den drei
   Menü-Action-Cards (Host/Join/Solo). Lobby-Einstellungs-Buttons
   (Runden/Dauer/Modus/Modus-spezifische Choice-Rows) haben keinen
   vergleichbaren Klick-Impact — dieselbe Funktion einfach auf alle
   `.choice-row button`-Elemente anzuwenden ist eine reine CSS/JS-Wiring-
   Aufgabe ohne neue Logik.

4. **Leichtes Hover-Sound-Feedback.** `sound.js` deckt Klick, Pin-Set, Tick,
   Guess, Reveal, Success, Streak und Ambience/Tension ab — aber
   ausschließlich Klick-getriggert, kein einziges Hover-Signal irgendwo im
   UI. Ein sehr leiser Hover-Tick auf Choice-Buttons/Vorschlagsliste
   (`.heatmap-suggestion:hover`) ist die Art von kaum wahrnehmbarem, aber
   spürbarem Detail, das AAA-Menüs von funktionalen UIs unterscheidet.

5. **FLIP-Animation für Leaderboard-Rangwechsel.** Bereits als Task
   vorgemerkt, aber noch offen: Rangänderungen zwischen Runden springen
   aktuell hart um, statt sichtbar zu gleiten. Bei einem eng gefochtenen
   Duell/Battle-Royale ist genau dieser Moment (wer überholt gerade wen)
   der emotionale Kern des Leaderboards — eine reine CSS/JS-FLIP-Technik
   ohne Backend-Änderung.

---

## 3. Priorisierte Entwicklungs-Roadmap

### Phase 1 — Core Polish
- [ ] Fix 1.1: `clearHeatmapTimer()` in `resetToMenu()` nachziehen
- [ ] `panoViewer`/`heatmapMap`-Lebenszyklus bei Rückkehr zum Menü klären
      (aktuell page-lifetime Singletons, nie `destroy()`t — auf Dauer
      relevant für Browser-WebGL-Context-Limits bei häufigem
      Neustart/Wechsel zwischen Spielen)
- [ ] Quick Wins #1-5 aus Abschnitt 2 umsetzen
- [ ] Mobile-First-Pass (bereits für PulseMap fertig: Sticky-CTA,
      Bottom-Sheet-Suche, `dvh`-Sizing, VisualViewport-Keyboard-Avoidance)
      auf Klassik-Modi (Punkte/HP/Country-Streak/Battle-Royale) und deren
      Lobby/HUD ausweiten — aktuell PulseMap-exklusiv
- [ ] Kompaktes Accordion/Grid für Lobby-Einstellungen auf Mobile (bisher
      nur Touch-Target-Größe angepasst, nicht strukturell verdichtet)
- [ ] Pinch-Zoom/Double-Tap-Physik auf den Leaflet-Karten (Heatmap +
      Ergebnis-Übersichtskarte) gezielt tunen statt Leaflet-Standard

### Phase 2 — P2P & Anti-Cheat
- [ ] Fix 1.2: Reconnect-Fenster mit Slot-Reservierung statt Sofort-Drop
      bei Verbindungsabbruch
- [ ] Fix 1.3: Lat/Lng-Wertebereichsprüfung im Host als zweites
      Sicherheitsnetz neben dem bestehenden NaN-Guard
- [ ] Tab-Switch-Heuristik (`host.js`, bereits mit explizitem
      Grenzen-Kommentar im Code) um ein zweites, unabhängiges Signal
      erweitern (z. B. unplausibel schnelle Tipp-Abgabe direkt nach
      Rundenstart) statt sich allein auf Tab-Wechsel-Timing zu verlassen
- [ ] Fix 1.4 als Voraussetzung: `app.js` schrittweise pro Modus in eigene
      Module aufteilen (PulseMap-Block zuerst, da mit Abstand größter
      zusammenhängender Abschnitt), damit weiteres Wachstum aus Phase 2/3
      wartbar bleibt

### Phase 3 — Meta-Game & Retention
- [ ] Fix 1.5: gemeinsames, versioniertes Lokal-Profil-Schema als
      Fundament, das `heatmap-stats.js`/`player-stats.js`/`high-scores.js`
      konsolidiert oder zumindest referenziert
- [ ] Achievements/Badges-Datenmodell + UI
- [ ] Daily-Streak-Tracker (Flame-Counter)
- [ ] Lokales Rang-Tier-System (Bronze/Silber/Gold/Geo-Master)
- [ ] Live-Gegner-Aktivitätsanzeige (Spannungsindikator während der Runde)
- [ ] Minimap-Emoji-Pings (P2P-Broadcast)

---

*Methodik-Hinweis: Alle Befunde in Abschnitt 1 sind durch direkte
Code-Lektüre verifiziert (keine Ausführung nötig, da es sich um statisch
erkennbare Logikfehler bzw. fehlende Guards handelt). Abschnitt 2 und 3
kombinieren diese Befunde mit bereits im Projekt-Task-Backlog vorgemerkten,
aber noch offenen Punkten (Phase-2/3/4-Items), um Doppelarbeit zu vermeiden.*
