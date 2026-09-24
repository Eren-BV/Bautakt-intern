# Bautakt: Übernahme des GitHub-Repos in Lovable

## Ziel
Das mit Claude Code entwickelte Produkt (Repo `Eren-BV/Bautakt`) vollständig in dieses Lovable-Projekt übertragen, sodass Lovable die Haupt-Entwicklungsumgebung wird. Das Repo ist privat und wird über den GitHub-Connector ausgelesen.

## Wichtig zu wissen
Lovable kann bestehende GitHub-Repos nicht direkt über die Git-Sync-Funktion importieren (dabei wird immer ein neues Repo angelegt). Deshalb übernehmen wir den Code manuell: auslesen → hier einbauen. Danach kann das Lovable-Projekt optional wieder mit GitHub synchronisiert werden.

## Phase 1 – Zugriff & Analyse
1. GitHub-Connector verbinden (Bestätigungskarte erscheint im Chat – du wählst deine Verbindung bzw. erstellst eine).
2. Repo `Eren-BV/Bautakt` auslesen: Struktur, Tech-Stack, Umfang, externe Dienste/API-Keys, Backend-Abhängigkeiten.
3. Kurze Lageeinschätzung: Was kann 1:1 übernommen werden, was muss angepasst werden.

## Phase 2 – Übertragung
1. Code in dieses Lovable-Projekt übertragen. Lovable-Projekte laufen auf React + TanStack Start; falls Claude Code einen anderen Stack verwendet hat (z. B. Next.js oder reines HTML/JS), wird der Code entsprechend angepasst.
2. Design, Seiten, Logik und Inhalte möglichst originalgetreu übernehmen.
3. Platzhalter-Startseite (`/`) durch die echte Startseite ersetzen.
4. Falls das Produkt Daten speichert oder Logins braucht: Lovable Cloud einrichten (Datenbank, Auth, Dateispeicher) und entsprechend anbinden.

## Phase 3 – Verifikation & Abschluss
1. Build prüfen und die App im Preview durchklicken (wichtige Seiten, Buttons, Formulare).
2. Fehler beheben, bis alles läuft.
3. Optional: Projekt über Git-Sync mit deinem GitHub verbinden, damit Änderungen künftig in beide Richtungen synchronisiert werden.
4. Veröffentlichen, wenn du zufrieden bist.

## Offene Punkte
- Tech-Stack und Umfang des Repos sind unbekannt und werden in Phase 1 geprüft – der Aufwand von Phase 2 hängt davon ab. Sollte sich herausstellen, dass das Produkt sehr groß ist, melde ich mich mit einer Einschätzung, bevor alles übertragen wird.
