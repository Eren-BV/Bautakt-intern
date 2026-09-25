# Bautakt → Lovable: Übernahme

Quelle: GitHub `Eren-BV/Bautakt` (React 19 + Vite + Tailwind 4, Hono-API, SQLite, 42 Tabellen, ~18k Zeilen).
Entscheidung des Nutzers: alles auf einmal (Oberfläche + Backend) nach Lovable/Lovable Cloud.
Eigene GitHub-Verbindung angelegt (getrennt von "Prozess Tool") — erledigt.

## Aufgaben
- [x] Repo auslesen und analysieren
- [x] Eigene GitHub-Verbindung für dieses Projekt
- [x] Lovable Cloud aktivieren
- [x] Datenbankschema (4 SQLite-Migrationen, 42 Tabellen) nach Postgres portieren
- [x] Datenzugriffsschicht auf Postgres umstellen (137 Abfragestellen, sync → async)
- [x] Hono-API als Catch-all-Serverroute unter /api einhängen
- [x] Frontend (App, ~30 Seiten, Gantt, Stores) + shared/engine übernehmen
- [x] Eigener Router → TanStack-Routen bzw. Catch-all-Einbindung
- [x] Startseite / ersetzen, Styles/Tailwind übernehmen
- [x] Demo-Daten/Seed übernehmen
- [ ] Build prüfen, App im Preview durchklicken, Fehler beheben
- [ ] Optional: Git-Sync einrichten

## Baumission: interner Aufgabenbereich
- [x] Planquelle „Aus Lucidchart oder Dokument“ im Projekt-Assistenten
- [x] Lucidchart-Import (Diagramm → Aufgaben, Meilensteine, Abhängigkeiten)
- [x] KI-Import aus PDF/Word (Textauslese im Browser, Analyse im Backend)
- [x] Prüf- und Bearbeitungsansicht vor der Übernahme
- [x] Personenbezogene Benachrichtigungen (startbereit, Frist, Verzug, Verschiebung)
- [x] Lucidchart-API-Schlüssel hinterlegt
- [x] Lucidchart-Reihenfolge: Pfeile werden ausgewertet (connectedTo), Rahmen = Phasen, Phasenabfolge nach Fachlogik
- [x] Reihenfolge in der Vorschau manuell verschiebbar (Phase wandert mit ihren Vorgängen)
- [x] KI-Knopf „Reihenfolge sortieren“ und „Mit KI überarbeiten“ in der Vorschau
- [x] Jira-Import (Epics → Phasen, Vorgänge → Aufgaben, „wird blockiert von“ → Abhängigkeiten)
- [x] KI-Projektentwurf aus einer freien Beschreibung
- [x] KI-Ergänzung/Optimierung innerhalb eines bestehenden Projekts (Projekteinstellungen → Aufgaben ergänzen)
- [ ] Jira-Zugangsdaten dauerhaft hinterlegen (JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN) – wartet auf Angaben des Nutzers
- [ ] Skalierung auf mehrere tausend Nutzer: Datenbank-Indizes prüfen, Listen seitenweise laden, KI-Aufträge im Hintergrund


## Benachrichtigungen & Zeitplanung
- [x] Zwei Stufen: sofort (startbereit, Frist heute/morgen, Verzug, kritisch) vs. Sammelmail alle 3 Stunden (Zuweisungen, Verschiebungen, Infos)
- [x] E-Mail-Warteschlange `email_outbox` mit Bündelung je Person und Hintergrundlauf `/api/public/email-dispatch`
- [x] Stundengenaue Planung: Uhrzeit von/bis und Stundendauer je Vorgang (mehrere Vorgänge pro Tag)
- [ ] Absenderdomain für den E-Mail-Versand einrichten (baumission.de) – wartet auf Nutzer
- [x] Persönliche Postfach-Anbindung: „Mein Postfach“-Karte im Posteingang (Microsoft 365 / Gmail verbinden, trennen, jetzt synchronisieren)
- [x] E-Mail-Verfassen & Antworten im Posteingang, Versandprotokoll je Benutzer
- [ ] Anbieter-Anbindung freischalten (OAuth-App-Registrierung Microsoft Entra / Google Cloud Console) – danach echter Versand aus dem Postfach und automatischer Abruf neuer Mails
- [ ] Stundenraster im Gantt-Zeitstrahl (Tages-Zoom)
- [ ] Jarvis: sprachgesteuerter KI-Assistent für das gesamte System
