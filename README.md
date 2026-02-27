# MCP Project Context Server

Automatische Projekt-Dokumentation für KI-Tools (Claude Code, Roovodev, etc.).

Scannt deine Code-Struktur und stellt sie als MCP Resources bereit:
- API Routes (Express/Fastify Endpunkte)
- Database Schema (SQLite Tabellen live)
- Service Functions (exportierte Funktionen)
- File Structure (Ordnerstruktur)
- Architecture Overview (aus CLAUDE.md/README.md)

## Features

- **Live Scanning**: Bei jedem Request werden Dateien neu gescannt
- **SQLite Support**: Liest Schema direkt aus der Datenbank
- **JSDoc Parsing**: Extrahiert Beschreibungen aus Kommentaren
- **Raspberry Pi optimiert**: Keine schweren Dependencies
- **PM2 Ready**: Ecosystem Config für dauerhaften Betrieb

## Installation

```bash
cd ~/projects/mcp-project-context

# Dependencies installieren
npm install

# Test-Start
npm start
```

## Wichtig: Wie MCP Server funktionieren

MCP Server mit STDIO-Transport laufen **nicht** als Daemon (wie ein Webserver).
Stattdessen werden sie von Claude Code / Roovodev **bei Bedarf gestartet** und kommunizieren über stdin/stdout.

Das bedeutet:
- **Kein PM2 nötig** für den MCP Server selbst
- Claude Code spawnt den Prozess automatisch
- Der Prozess läuft so lange wie deine Claude Code Session

## (Optional) PM2 für Development/Testing

Falls du den Server manuell testen willst:

```bash
# Manueller Test (gibt JSON auf stdout aus)
echo '{"jsonrpc":"2.0","id":1,"method":"resources/list"}' | node src/index.js
```

## Konfiguration

### config.json

Passe die `config.json` an deine Projekte an:

```json
{
  "projects": [
    {
      "name": "my-project",
      "path": "~/projects/my-project",
      "database": {
        "type": "sqlite",
        "path": "~/projects/my-project/database.db"
      },
      "scan": {
        "routes": ["routes/**/*.js"],
        "services": ["services/**/*.js"],
        "models": ["database/**/*.js"],
        "views": ["views/**/*.hbs"],
        "config": ["config/**/*.js"]
      },
      "ignore": ["node_modules", ".git", "public"]
    }
  ]
}
```

> ⚠️ **Wichtig:** `config.json` enthält deine lokalen Pfade und sollte **nicht** in das Repository eingecheckt werden. Nutze stattdessen `config.example.json` als Vorlage.

### Weiteres Projekt hinzufügen

```json
{
  "projects": [
    { "...": "erstes Projekt" },
    {
      "name": "another-project",
      "path": "~/projects/another-project",
      "database": null,
      "scan": {
        "routes": ["src/routes/**/*.ts"],
        "services": ["src/services/**/*.ts"]
      },
      "ignore": ["node_modules", "dist"]
    }
  ]
}
```

## Claude Code Konfiguration

Füge den Server zu deiner Claude Code Konfiguration hinzu:

### Option 1: Globale Konfiguration

Bearbeite `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "project-context": {
      "command": "node",
      "args": ["~/projects/mcp-project-context/src/index.js"],
      "env": {
        "MCP_CONFIG_PATH": "~/projects/mcp-project-context/config.json"
      }
    }
  }
}
```

### Option 2: Projekt-spezifisch

Erstelle `.mcp.json` im Projekt-Root:

```json
{
  "mcpServers": {
    "project-context": {
      "command": "node",
      "args": ["~/projects/mcp-project-context/src/index.js"]
    }
  }
}
```

## Verfügbare Resources

Nach der Konfiguration kannst du diese Resources in Claude Code abrufen:

| Resource URI | Beschreibung |
|--------------|--------------|
| `context://my-project/routes` | Alle API Endpunkte mit Methode, Pfad, Datei |
| `context://my-project/database-schema` | SQLite Tabellen und Spalten (live) |
| `context://my-project/services` | Service-Funktionen mit JSDoc |
| `context://my-project/file-structure` | Ordnerstruktur als Baum |
| `context://my-project/architecture` | High-Level Architektur |

## Verfügbare Tools

| Tool | Beschreibung |
|------|--------------|
| `find_function` | Sucht Funktion nach Namen |
| `search_routes` | Sucht Routes nach Pfad/Methode |
| `search_tables` | Sucht Tabellen/Spalten |
| `refresh_cache` | Erzwingt Neuladen (kein Cache, nur Compat) |

## Beispiel-Nutzung

In Claude Code kannst du dann sagen:

```
"Zeig mir alle API Routes vom my-project"
→ Claude liest context://my-project/routes

"Welche Tabellen hat die Datenbank?"
→ Claude liest context://my-project/database-schema

"Wo ist die Funktion processOrder definiert?"
→ Claude nutzt das find_function Tool
```

## Troubleshooting

### Server startet nicht

```bash
# Logs prüfen
pm2 logs mcp-project-context --lines 50

# Manuell testen
node ~/projects/mcp-project-context/src/index.js
```

### Datenbank-Fehler

Stelle sicher, dass der Pfad in `config.json` korrekt ist:

```bash
# Prüfen ob DB existiert
ls -la ~/projects/my-project/database.db
```

### Resource nicht gefunden

1. Prüfe ob der Projektname in der URI mit `config.json` übereinstimmt
2. Prüfe ob die Scan-Patterns Dateien finden

### Permission-Fehler

```bash
# Logs-Ordner erstellen
mkdir -p ~/projects/mcp-project-context/logs
chmod 755 ~/projects/mcp-project-context/logs
```

## Entwicklung

```bash
# Mit Auto-Reload entwickeln
npm run dev

# Oder mit nodemon
npx nodemon src/index.js
```

## Lizenz

MIT
