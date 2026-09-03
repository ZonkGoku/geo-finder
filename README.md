# GeoFinder

Ein GeoGuessr-artiges 360°-Multiplayer-Spiel für bis zu 6 Spieler, das komplett als statische Seite läuft:
kein Backend, kein Account, keine Datenbank. Multiplayer läuft direkt
Peer-zu-Peer über WebRTC ([PeerJS](https://peerjs.com/)), Panoramen zeigt
[Pannellum](https://pannellum.org/), die Tipp-Karte ist [Leaflet](https://leafletjs.com/).

Das technische Konzept steht in [`KONZEPT.md`](./KONZEPT.md).

## Lokal starten

Kein Build-Schritt nötig — ein beliebiger statischer Webserver reicht
(direktes Öffnen der `index.html` per `file://` funktioniert **nicht**, weil
Fetch/ES-Module und WebRTC einen echten Origin brauchen):

```bash
python3 -m http.server 8080
# oder: npx serve .
```

Dann `http://localhost:8080` öffnen.

## Spielen

- **Raum erstellen**: erzeugt einen Raum-Code + Einladungslink
  (`#room=CODE`), den man teilen kann. Bis zu 5 weitere Spieler (insgesamt
  max. 6) können beitreten; sobald mindestens einer beigetreten ist und
  alle auf „Bereit" geklickt haben, kann der Host starten.
- **Beitreten**: Code oder kompletten Link einfügen.
- **Solo spielen**: startet sofort, ganz ohne Netzwerk — nützlich zum Testen
  und für Einzelspieler-Runden.

Der Host ist während der Partie die einzige Autorität für Timer,
Rundenauswahl und Punkteberechnung (Sternmodell, siehe Konzept Abschnitt 2).
Trennt sich der Host, endet die Partie — es gibt kein Host-Failover.

**Spielregeln** (in der Lobby einstellbar, nur der Host ändert sie):
Rundenanzahl (3/5/10), Rundendauer (30/60/90/180s oder unbegrenzt), Modus
sowie ein Panorama-Modifier (frei umsehen + zoomen, oder "Zoom gesperrt"
für mehr Schwierigkeit). Ein echtes "Move/No-Move" wie im Original-
GeoGuessr gibt es bewusst nicht: jede Runde ist ein einzelnes statisches
Panorama ohne Wegpunkte, "Bewegen" existiert hier also gar nicht erst.

Drei Modi:
- **Punkte-Duell** — Standard-Scoring inkl. Speed- und Distanz-Streak-Bonus.
- **HP-Duell** — beide starten mit 6000 HP, pro Runde verliert der
  Langsamere/Ungenauere die Punktedifferenz als HP, bei 0 HP ist die Partie
  sofort vorbei.
- **Country-Streak** — nur das Land zählt, nicht der exakte Pin. Ein Klick
  auf die Karte wird per Punkt-in-Polygon-Test (`js/core/point-in-polygon.js`,
  `data/geo/countries-110m.json` von [world-atlas](https://github.com/topojson/world-atlas),
  110m-Auflösung) gegen echte Ländergrenzen aufgelöst und mit dem auf
  dieselbe Art aufgelösten Land der tatsächlichen Position verglichen —
  funktioniert dadurch unabhängig davon, ob das Kartenpaket ein `country`-
  Feld pflegt.

**Social**: ein Emote-Rad (😱 🎯 😂 💩 👏) unten in der HUD schickt ein kurz
aufploppendes Emoji an die Mitspieler.

**Fair Play**: Rechtsklick auf dem Panorama ist deaktiviert (erschwert die
triviale Bildersuche), und wechselt ein Spieler während einer aktiven Runde
den Tab, bekommt der Gegner eine Warnung eingeblendet. Das ist eine
Abschreckung, keine harte Absicherung — ein manipulierter Client lässt sich
damit nicht zuverlässig verhindern (siehe „Bekannte Grenzen").

## Projektstruktur

| Pfad | Inhalt |
| --- | --- |
| `index.html` | Einziger Einstiegspunkt, enthält alle fünf Screens als `<section>` |
| `css/styles.css` | Gesamtes Styling (dunkles „Feldgerät"-Thema) |
| `js/core/` | State-Container, Haversine/Punkte-Formel, seeded RNG für Rundenauswahl |
| `js/net/` | PeerJS-Wrapper, Nachrichtenprotokoll, Host- und Client-Controller |
| `js/map/` | Leaflet-Wrapper für Tipp-Karte und Ergebnis-Karte |
| `js/panorama/` | Pannellum-Wrapper |
| `js/ui/` | Screen-Router, Toast-Hinweise |
| `js/app.js` | Verdrahtet alles: Menü, Lobby, HUD, Ergebnis, Tabelle |
| `js/audio/sound.js` | Web-Audio-Soundeffekte (keine MP3-Dateien) |
| `js/config.js` | Mapillary-Zugangstoken (siehe unten) |
| `data/map-sets/` | Kartenpakete (siehe unten) |
| `lib/` | Vendored Third-Party-Libs (PeerJS, Leaflet, Pannellum) — kein CDN nötig |
| `assets/panoramas/` | Die statischen Panoramafotos des „Weltweit"-Pakets |

## Kartenpakete (`data/map-sets/`)

`data/map-sets/index.json` listet alle Pakete; jedes Paket ist eine eigene
Datei. Zwei Arten von Paketen:

**`"source": "static"`** — eine feste Liste kuratierter, vorab geprüfter
Panoramen (so wie `weltweit.json`). Ein Eintrag:

```json
{
  "id": "cerro-toco",
  "name": "Cerro Toco, Atacama-Wüste, Chile",
  "lat": -22.9592,
  "lng": -67.8108,
  "panoramaUrl": "./assets/panoramas/cerro-toco.jpg",
  "attribution": "Matthew Petroff, CC BY-SA 4.0",
  "difficulty": "hard",
  "hint": "Über 5000 Meter Höhe, extrem trockene Luft.",
  "funFact": "Cerro Toco liegt nahe dem ALMA-Observatorium ...",
  "tags": ["mountain", "desert", "south-america"]
}
```

Panorama muss **equirektangular** (2:1-Seitenverhältnis) sein, damit
Pannellum es korrekt als 360° darstellt (schmalere Fotos können per `vaov`
korrekt eingepasst werden, siehe `charles-street` in `weltweit.json`).
`scaleKm` im Paket-Objekt steuert, wie schnell die Punktzahl mit der
Entfernung abfällt — kleiner Wert für enger begrenzte Pakete (Stadt-Ebene),
größerer Wert für weltweite Pakete.

**`"source": "mapillary"`** — statt fester Fotos definiert das Paket
`regions` (Punkt + Radius in Metern); zu Rundenbeginn fragt der Host live
über die [Mapillary-API](https://www.mapillary.com/developer) ein echtes
360°-Bild (`is_pano: true`) aus jeder gewählten Region ab. So funktionieren
`hamburg.json`, `landmarks.json` und `capitals.json`, ohne dass Fotos
vorher manuell gesucht und lizenzrechtlich geprüft werden müssen — die
Koordinaten kommen direkt aus den von Mapillary gelieferten Bilddaten.

**Vorher nötig:** einen kostenlosen Mapillary-Zugangstoken unter
[mapillary.com/dashboard/developers](https://www.mapillary.com/dashboard/developers)
holen und in `js/config.js` eintragen (`MAPILLARY_ACCESS_TOKEN`). Ohne
gültigen Token zeigt die Lobby diese drei Pakete als „Token nötig" und lässt
sie nicht auswählen — das „Weltweit"-Paket funktioniert immer, unabhängig
vom Token. Der Mapillary-Abruf lief in der Entwicklungsumgebung dieses
Projekts nie gegen die echte API (kein Netzzugriff auf `graph.mapillary.com`
dort) — vor dem produktiven Einsatz einmal mit echtem Token durchspielen.

### Woher kommen die elf Fotos im „Weltweit"-Paket?

Alle Fotos stammen von Matthew Petroff (CC BY-SA 4.0), aus dem öffentlichen
Beispielmaterial von [pannellum.org](https://github.com/mpetroff/pannellum.org).
Zwei Koordinaten (`cerro-toco`, `cerro-toco-east`) sind aus den GPS-EXIF-Daten
der Originalfotos übernommen (`coordSource: "exif-gps"`), die übrigen sind
sorgfältig recherchierte, aber nicht EXIF-verifizierte Koordinaten der
jeweils abgebildeten, klar erkennbaren Orte (`coordSource: "approx-known-site"`).

## Deployment auf GitHub Pages

1. Repository-Einstellungen → Pages → Branch auswählen (z. B. `main`, Root).
2. Fertig — es gibt keinen Build-Schritt. Alle Pfade in `index.html` sind
   relativ, funktionieren also auch unter einem Repo-Unterpfad
   (`username.github.io/geo-finder/`).
3. Einladungslinks funktionieren automatisch über das URL-Fragment
   (`#room=CODE`) — kein Server-Routing nötig, kein 404-Risiko bei Reload.

## Bekannte Grenzen (bewusst, siehe KONZEPT.md)

- Kein Host-Failover: Verlässt der Host die Partie, endet sie für alle.
- Verbindungsaufbau läuft über den öffentlichen PeerJS-Cloud-Broker
  (`0.peerjs.com`) — nur für das Signaling, nicht für den Spieldaten-Traffic
  selbst. Fällt er aus, kann kein neuer Raum eröffnet werden.
- Kartenkacheln kommen von CARTO/OpenStreetMap unter deren Fair-Use-Regeln —
  für ein kleines Community-Projekt unkritisch.
- Keine harte Anti-Cheat-Garantie bei Timer/Score — für ein Freundeskreis-Duell
  ausreichend, aber ein manipulierter Client könnte theoretisch schummeln.

## Lizenzen

- Eigener Code: MIT (siehe `LICENSE`).
- PeerJS: MIT · Leaflet: BSD-2-Clause · Pannellum: MIT (siehe `lib/VERSIONS.txt`
  und `lib/pannellum/LICENSE`).
- Panoramafotos: Matthew Petroff, CC BY-SA 4.0.
- Ländergrenzen (`data/geo/countries-110m.json`): [world-atlas](https://github.com/topojson/world-atlas)
  von Michael Bostock, ISC-artige Lizenz (siehe `data/geo/world-atlas-LICENSE`).
