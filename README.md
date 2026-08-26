# GeoFinder

Ein GeoGuessr-artiges 360°-Duell, das komplett als statische Seite läuft:
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

- **Duell erstellen**: erzeugt einen Raum-Code + Einladungslink
  (`#room=CODE`), den man teilen kann. Sobald ein zweiter Spieler beitritt
  und auf „Bereit" klickt, kann der Host starten.
- **Beitreten**: Code oder kompletten Link einfügen.
- **Solo spielen**: startet sofort, ganz ohne Netzwerk — nützlich zum Testen
  und für Einzelspieler-Runden.

Der Host ist während der Partie die einzige Autorität für Timer,
Rundenauswahl und Punkteberechnung (Sternmodell, siehe Konzept Abschnitt 2).
Trennt sich der Host, endet die Partie — es gibt kein Host-Failover.

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
| `data/locations.json` | Location-Pool (Koordinaten + Panorama-Pfad + Attribution) |
| `lib/` | Vendored Third-Party-Libs (PeerJS, Leaflet, Pannellum) — kein CDN nötig |
| `assets/panoramas/` | Die Panoramafotos selbst |

## Location-Pool erweitern

`data/locations.json` ist eine einfache, versionierbare Liste. Ein Eintrag:

```json
{
  "id": "cerro-toco",
  "name": "Cerro Toco, Atacama-Wüste, Chile",
  "lat": -22.9592,
  "lng": -67.8108,
  "panoramaUrl": "./assets/panoramas/cerro-toco.jpg",
  "attribution": "Matthew Petroff, CC BY-SA 4.0",
  "difficulty": "hard",
  "tags": ["mountain", "desert", "south-america"]
}
```

Panorama muss **equirektangular** (2:1-Seitenverhältnis) sein, damit
Pannellum es korrekt als 360° darstellt. `scaleKm` im Pool-Objekt steuert,
wie schnell die Punktzahl mit der Entfernung abfällt — kleiner Wert für
enger begrenzte Pools (z. B. eine Stadt), größerer Wert für weltweite Pools.

### Woher kommen die sechs Start-Locations?

Alle sechs Fotos stammen von Matthew Petroff (CC BY-SA 4.0), aus dem
öffentlichen Beispielmaterial von [pannellum.org](https://github.com/mpetroff/pannellum.org).
Zwei Koordinaten (`cerro-toco`) sind aus den GPS-EXIF-Daten der Originalfotos
übernommen (`coordSource: "exif-gps"`), die übrigen sind sorgfältig
recherchierte, aber nicht EXIF-verifizierte Koordinaten der jeweils
abgebildeten, klar erkennbaren Orte (`coordSource: "approx-known-site"` —
ALMA-Observatorium, Vulkan Láscar, Tocopilla, JFK Airport, Johns Hopkins
University). Das Startpaket ist bewusst klein und dient als Vorlage; für
mehr geografische Vielfalt einfach weitere, frei lizenzierte Panoramen mit
bekannten Koordinaten ergänzen.

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
