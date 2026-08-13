# Event-Sounds

Lege hier lizenzierte Sounddateien fuer die Event-Zuordnung ab. MP3- und OGG-Dateien werden beim Laden des Controllers automatisch erkannt und in die Ton-Auswahl aufgenommen.

Unterstuetzte Dateinamen:

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
Eigene Dateinamen sind ebenfalls erlaubt, zum Beispiel `mein-wurf.mp3`. Nach dem Ablegen den Controller neu laden; anschliessend kann der Sound pro Event ausgewaehlt und gespeichert werden.
