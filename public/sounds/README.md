# Event-Sounds

Lege hier lizenzierte Sounddateien fuer die Event-Zuordnung ab. MP3- und OGG-Dateien werden automatisch erkannt.

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
Fuer die Zufallsauswahl legst du einen eigenen Ordner an. Alle MP3- und OGG-Dateien in diesem Ordner gehoeren dann zu einem Pool:

```text
sounds/
	commedy/
		sound-01.mp3
		sound-02.ogg
```

Der Controller erkennt den Ordner automatisch und zeigt im Dropdown nur den Verweis `Random_Comedy` an. Dieser Verweis spielt bei jedem Event zufaellig eine Datei aus `sounds/commedy/`. Auch weitere Unterordner werden einbezogen. So kannst du beispielsweise fuer das Winner-Overlay einen eigenen Ordner mit Sieger-Sounds anlegen und `Random_Comedy` oder `Random_Western` als Sound auswaehlen. Nach dem Ablegen den Controller neu laden.
