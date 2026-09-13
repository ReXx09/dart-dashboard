# Aufgabenliste: Zentrale Spiel-, Statistik- und Highscore-Daten

**Sicherungsstand:** `save-before-live-structure-refactor-2026-09-13`

Ziel: Alle Anzeigen sollen dieselbe zentrale Datenquelle und dieselben Berechnungen verwenden. `live-state.json` bleibt ein aktueller Live-/Cache-Zustand und wird nicht zur unabhängigen Statistikquelle.

## Phase 0: Arbeitsgrundlage sichern

- [x] Backup lokal erstellen.
- [x] GitHub-Sicherungsbranch erstellen und pushen.
- [x] Arbeitsbranch für die Umsetzung vom Sicherungsbranch ableiten.
- [x] Vor jedem größeren Schritt Tests ausführen.
- [x] Nach jedem stabilen Schritt einen kleinen Commit erstellen.

## Phase 1: Ist-Zustand dokumentieren

- [ ] Alle aktuellen Datenquellen erfassen: SQLite, JSON-Dateien, Live-State und In-Memory-State.
- [ ] Jede Schreibstelle für Würfe, Aufnahmen, Legs, Highscores und Duellstatistiken dokumentieren.
- [ ] Jede Lesestelle in `live-spielstand.html`, `statistics.html`, `highscores.html` und TV-Ansichten dokumentieren.
- [ ] Festlegen, welche Daten künftig verbindlich aus der Datenbank kommen.
- [ ] Bestehende Datenbanktabellen und ihre Beziehungen dokumentieren.

## Phase 2: Einheitliches Datenmodell definieren

- [ ] Entitäten festlegen: Spieler, Begegnung, Leg, Aufnahme und Wurf.
- [ ] Pflichtfelder für jeden Wurf definieren: `matchId`, `legId`, `turnId`, `playerSlot`, `points`, `segment`, `bust`, `remaining`, `source`, `ts`.
- [ ] Regeln für Fehlwürfe, automatische Würfe und manuelle Würfe vereinheitlichen.
- [x] Korrekturen nachvollziehbar modellieren: ursprünglicher Wert, Delta, neuer Wert, Zeitpunkt und Quelle.
- [ ] Definition für Aufnahmensumme, Average, Busts, Checkout und Highscore festlegen.
- [ ] Umgang mit historischen und unvollständigen Legacy-Daten festlegen.

## Phase 3: Zentrale Serverlogik bauen

- [x] Neue gemeinsame Wurf-Logik in `lib/live-throws.js` erstellen.
- [x] Funktion zum Finden des letzten korrigierbaren Wurfs auslagern.
- [x] Funktion zum Anwenden einer Wurfkorrektur auslagern.
- [x] Funktion zum vollständigen Zurücksetzen eines Wurfs auslagern.
- [x] Gemeinsame Neuberechnung für Restscore, Aufnahme, Average und Bust-Status erstellen.
- [x] `currentRoundPoints` und `turnScoreRecorded` zentral synchronisieren.
- [x] `/api/live/undo` auf die gemeinsame Logik umstellen.
- [x] `/api/live/correct-last` auf die gemeinsame Logik umstellen.
- [ ] `/api/live/throw` ebenfalls auf die gemeinsame Logik vorbereiten.

## Phase 4: Datenbank als verbindliche Quelle

- [x] Datenbanktabellen für Würfe und Aufnahmen prüfen oder ergänzen.
- [ ] Datenbankmigration für fehlende Felder erstellen.
- [ ] Neue Würfe atomar in der Datenbank speichern.
- [ ] Aufnahmeabschluss und Legabschluss aus den Wurf-Daten ableiten.
- [x] Korrekturen transaktional speichern.
- [ ] Prüfen, ob eine Korrektur bereits gespeicherte Statistikwerte aktualisieren muss.
- [ ] Prüfen, ob Highscores nach einer Korrektur neu berechnet oder ersetzt werden müssen.
- [ ] JSON-/Live-State nur noch als Projektion oder Cache verwenden.

## Phase 5: Zentrale Berechnungs- und API-Schicht

- [ ] Gemeinsame Berechnungsfunktionen für Live-Stand, Statistiken und Highscores erstellen.
- [ ] API für Spielerstatistiken definieren.
- [ ] API für Aufnahme- und Wurfhistorie definieren.
- [ ] API für Highscores definieren.
- [ ] API-Antworten mit Versions-/Zeitstempel versehen.
- [ ] Fehler- und Korrekturstatus einheitlich zurückgeben.
- [ ] Unterschiede zwischen Live-Werten und Datenbankwerten diagnostizierbar machen.

## Phase 6: Frontends umstellen

- [ ] `live-spielstand.html` auf die zentrale Live-API ausrichten.
- [ ] Korrektur-Keypad auf die gemeinsame Korrektur-API ausrichten.
- [ ] Aufnahme-Liste aus den zentralen Wurf-Daten rendern.
- [ ] `statistics.html` vollständig auf die zentrale Statistik-API umstellen.
- [ ] `highscores.html` vollständig auf die zentrale Highscore-API umstellen.
- [ ] TV-Ansichten auf dieselben Datenfelder und Berechnungen umstellen.
- [ ] Doppelte Berechnungen in den HTML-Dateien entfernen.

## Phase 7: Migration und Abgleich

- [ ] Bestehende JSON- und SQLite-Daten sichern.
- [ ] Einmaliges Migrationsskript für vorhandene Würfe und Statistiken erstellen.
- [ ] Migration zunächst in einer Kopie der Datenbank ausführen.
- [ ] Spieler, Legs, Aufnahmen, Würfe und Highscores vergleichen.
- [ ] Abweichungsbericht erzeugen.
- [ ] Bekannte historische Sonderfälle dokumentieren.
- [ ] Erst nach erfolgreichem Abgleich die zentrale Datenbank produktiv verwenden.

## Phase 8: Tests und Freigabe

- [x] Unit-Tests für Wurfkorrektur und Undo ergänzen.
- [ ] Tests für Aufnahme- und Leg-Summen ergänzen.
- [ ] Tests für Bust- und Checkout-Neuberechnung ergänzen.
- [ ] Tests für Highscore-Neuberechnung ergänzen.
- [ ] Tests für Statistik-Neuberechnung ergänzen.
- [ ] Integrationstest: Wurf erfassen, korrigieren, Anzeige vergleichen.
- [ ] Integrationstest: Wurf entfernen, Anzeige vergleichen.
- [ ] Integrationstest: Leg abschließen und Statistiken prüfen.
- [ ] `npm test` ausführen.
- [ ] Dashboard manuell auf Browser, Tablet und TV prüfen.
- [ ] Stabilen Stand nach erfolgreicher Prüfung committen und pushen.

## Empfohlene erste Umsetzung

1. Phase 1 abschließen und die aktuellen Datenflüsse dokumentieren.
2. Datenmodell für Wurf, Aufnahme und Korrektur festlegen.
3. `lib/live-throws.js` mit Tests anlegen.
4. Undo und Wurfkorrektur auf diese gemeinsame Logik umstellen.
5. Erst danach Statistik- und Highscore-Datenbankmigration beginnen.

## Abbruch- und Rücksetzpunkt

Bei Problemen kann auf den GitHub-Branch `save-before-live-structure-refactor-2026-09-13` zurückgewechselt werden. Vor einer Datenbankmigration muss zusätzlich immer ein Datenbank-Backup erstellt werden.
