# Event-Sounds

Lege hier lizenzierte Sounddateien fuer die Event-Zuordnung ab. MP3- und OGG-Dateien werden beim Laden des Controllers automatisch erkannt und in die Ton-Auswahl aufgenommen.

Beispiel-Dateinamen:

- t20.ogg
- t19.ogg
- t18.ogg
- t17.ogg
- bull.ogg
- dbull.ogg
- triple.ogg
- maximum.ogg
- checkout.ogg
- winner.ogg
- bust.ogg
- elimination.ogg
- cricket-score.ogg

Die Dateien werden ueber `/sounds/<dateiname>` ausgeliefert. Fehlt eine Datei, verwendet das Dashboard den bisher konfigurierten WebAudio-Fallback.
Eigene Dateinamen sind ebenfalls erlaubt, zum Beispiel `mein-wurf.mp3`. Fuer getrennte Zufalls-Pools kannst du Unterordner anlegen:

```text
sounds/
	winner/
		fanfare-01.mp3
		fanfare-02.ogg
	bust/
		bust-01.mp3
```

Der Controller erkennt die Ordner automatisch und bietet sie als `Zufall: winner` oder `Zufall: bust` an. `Zufall aus Sound-Verzeichnis` verwendet weiterhin alle Sounddateien. Auch weitere Unterordner werden einbezogen. Nach dem Ablegen den Controller neu laden; anschliessend kann der Pool pro Event ausgewaehlt und gespeichert werden.
