# Eigener Bereich für Baumission – getrennt von den Demo-Daten

Ziel: Ein sauberer, echter Arbeitsbereich für euch drei, ohne Testprojekte. Der Demo-Bereich bleibt in der Datenbank erhalten, verschwindet aber aus der Oberfläche.

## Was entsteht

**Neuer Bereich "Baumission"** mit drei Zugängen als Inhaber/Admin:

- Dino-Denis Sejdinovic – dds@es-wohnbau-sanierung.de
- Edis Sejdinovic – es@es-wohnbau-sanierung.de
- Jan Pfeiffer – jp@architektur-pfeiffer.de

Jeder bekommt ein Start-Passwort, das beim ersten Login geändert werden kann. Die Zugänge nenne ich dir nach dem Anlegen im Chat.

**Startausstattung im neuen Bereich**

- Keine Projekte, keine Aufgaben, kein Baufortschritt – die Projektliste ist leer.
- Übliche Gewerke (Rohbau, Zimmerer, Dach, Elektro, Sanitär/Heizung, Estrich, Putz, Fliesen, Trockenbau, Maler, Fenster, Außenanlagen …) mit Farben, wie in der Demo.
- Ein Standard-Arbeitskalender (Mo–Fr, Feiertage Bayern) als Vorgabe für neue Projekte.
- Die eingebauten Projektvorlagen stehen zur Verfügung, damit ihr ein neues Projekt schnell aufsetzen könnt.
- Firmen, Kontakte, Ressourcen bleiben leer – die pflegt ihr selbst oder importiert sie später.

**Demo-Bereich verstecken**

- Die Liste der Demo-Zugänge auf der Anmeldeseite wird entfernt.
- Die Demo-Daten bleiben unangetastet in der Datenbank; wer die E-Mail kennt, kann sich weiterhin anmelden und Testprojekte ausprobieren.
- Die beiden Bereiche sehen sich gegenseitig nicht: Projekte, Gewerke und Berichte sind pro Bereich getrennt.

## Technische Umsetzung

- Neue Seed-Funktion `seedOrg` in `src/bautakt/server/seed.ts`: legt Organisation, Nutzer (PBKDF2-Hash), Mitgliedschaften, Standard-Gewerke und den Standard-Kalender an – idempotent, also ohne Doppelanlage bei erneutem Start.
- Aufruf im Lazy-Init in `src/bautakt/server/index.ts` neben `seedBuiltinTemplates` und `seedDemoOrg`; Reihenfolge bleibt, Demo-Seed bleibt bestehen.
- Route `GET /api/auth/demo` liefert künftig eine leere Liste (oder wird aus `index.ts` entfernt); `LoginPage.tsx` blendet den Demo-Kasten aus und setzt das vorausgefüllte Passwortfeld zurück.
- Mandantentrennung nutzt die bestehende `org_id`-Filterung in `repo.ts` – keine Schemaänderung nötig.
- Prüfung: Login mit einem der drei Zugänge über Playwright, Projektliste leer, Gewerke und Kalender vorhanden, Demo-Kasten weg.
