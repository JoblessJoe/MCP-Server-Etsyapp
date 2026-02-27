#!/usr/bin/env node
/**
 * MCP Project Context Server
 *
 * Automatische Dokumentation von Projekten für KI-Tools.
 * Scannt Code-Struktur, API Routes, DB Schema und Service-Funktionen.
 *
 * Verwendung:
 *   - Als MCP Server in Claude Code / Roovodev konfigurieren
 *   - Oder standalone: node src/index.js
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { glob } from 'glob';

// ES Module __dirname Workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ============================================================================
// STRUCTURED ERROR LOGGING
// ============================================================================

function log(level, tool, message, extra = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    tool,
    message,
    ...extra
  };
  console.error(JSON.stringify(entry));
}

const logger = {
  info:  (tool, msg, extra) => log('INFO',  tool, msg, extra),
  warn:  (tool, msg, extra) => log('WARN',  tool, msg, extra),
  error: (tool, msg, extra) => log('ERROR', tool, msg, extra),
};

// ============================================================================
// KONFIGURATION LADEN
// ============================================================================

const CONFIG_PATH = process.env.MCP_CONFIG_PATH ||
                    path.join(__dirname, '..', 'config.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
} catch (err) {
  console.error(`Fehler beim Laden der Konfiguration: ${CONFIG_PATH}`);
  console.error(err.message);
  process.exit(1);
}

// ============================================================================
// SCANNER KLASSEN
// ============================================================================

/**
 * Scannt Express/Fastify Route-Dateien und extrahiert Endpunkte
 */
class RouteScanner {
  constructor(projectPath) {
    this.projectPath = projectPath;
  }

  /**
   * Scannt alle Route-Dateien und extrahiert HTTP Endpunkte
   */
  async scan(patterns) {
    const routes = [];

    for (const pattern of patterns) {
      const files = await glob(pattern, {
        cwd: this.projectPath,
        absolute: true
      });

      for (const file of files) {
        try {
          const content = fs.readFileSync(file, 'utf-8');
          const fileRoutes = this.extractRoutes(content, file);
          routes.push(...fileRoutes);
        } catch (err) {
          console.error(`Fehler beim Scannen von ${file}: ${err.message}`);
        }
      }
    }

    return routes;
  }

  /**
   * Extrahiert HTTP Methoden und Pfade aus einer Route-Datei
   */
  extractRoutes(content, filePath) {
    const routes = [];
    const relativePath = path.relative(this.projectPath, filePath);

    // Express Router Pattern: router.get('/path', ...) oder app.post('/path', ...)
    const routeRegex = /(?:router|app)\.(get|post|put|patch|delete|all)\s*\(\s*['"`]([^'"`]+)['"`]/gi;

    let match;
    let lineNumber = 1;
    const lines = content.split('\n');

    while ((match = routeRegex.exec(content)) !== null) {
      const method = match[1].toUpperCase();
      const routePath = match[2];

      // Zeilennummer finden
      const position = match.index;
      lineNumber = content.substring(0, position).split('\n').length;

      // JSDoc Kommentar suchen (über der Route)
      let description = '';
      for (let i = lineNumber - 2; i >= 0 && i >= lineNumber - 10; i--) {
        const line = lines[i]?.trim() || '';
        if (line.startsWith('*') || line.startsWith('//')) {
          const cleanLine = line.replace(/^[\/*\s]+/, '').trim();
          if (cleanLine && !cleanLine.startsWith('@')) {
            description = cleanLine;
            break;
          }
        } else if (!line.startsWith('/*') && line !== '') {
          break;
        }
      }

      routes.push({
        method,
        path: routePath,
        file: relativePath,
        line: lineNumber,
        description: description || null
      });
    }

    return routes;
  }
}

/**
 * Scannt Service-Dateien und extrahiert exportierte Funktionen
 */
class ServiceScanner {
  constructor(projectPath) {
    this.projectPath = projectPath;
  }

  async scan(patterns) {
    const services = [];

    for (const pattern of patterns) {
      const files = await glob(pattern, {
        cwd: this.projectPath,
        absolute: true
      });

      for (const file of files) {
        try {
          const content = fs.readFileSync(file, 'utf-8');
          const relativePath = path.relative(this.projectPath, file);
          const serviceFunctions = this.extractFunctions(content, relativePath);

          if (serviceFunctions.length > 0) {
            services.push({
              file: relativePath,
              functions: serviceFunctions
            });
          }
        } catch (err) {
          console.error(`Fehler beim Scannen von ${file}: ${err.message}`);
        }
      }
    }

    return services;
  }

  /**
   * Extrahiert alle Funktionen, Methoden und Klassen aus einer Datei
   * Verbessert: Findet auch Klassenmethoden und private Funktionen
   */
  extractFunctions(content, filePath) {
    const functions = [];
    const lines = content.split('\n');

    // Verschiedene Export-Patterns
    const patterns = [
      // module.exports = { func1, func2 }
      /module\.exports\s*=\s*\{([^}]+)\}/g,
      // exports.functionName = function
      /exports\.(\w+)\s*=/g,
      // export function name()
      /export\s+(?:async\s+)?function\s+(\w+)/g,
      // export const name =
      /export\s+const\s+(\w+)\s*=/g,
      // function name() { ... } (top-level)
      /^(?:async\s+)?function\s+(\w+)\s*\(/gm,
      // const name = async function
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/g,
      // const name = () => oder async () =>
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*=>/g,
      // class ClassName
      /class\s+(\w+)/g
    ];

    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        let names = match[1];

        // Bei module.exports = { } mehrere Namen extrahieren
        if (match[0].includes('module.exports')) {
          names = names.split(',').map(n => n.trim().split(':')[0].trim());
        } else {
          names = [names];
        }

        for (const name of names) {
          if (name && !functions.some(f => f.name === name)) {
            // Zeilennummer finden
            const position = match.index;
            const lineNumber = content.substring(0, position).split('\n').length;

            // JSDoc suchen
            let description = this.findJsDoc(lines, lineNumber - 1);

            functions.push({
              name,
              line: lineNumber,
              description,
              type: this.detectFunctionType(match[0])
            });
          }
        }
      }
    }

    // NEU: Extraiere auch Klassenmethoden
    const classMethodPattern = /(?:^\s*(?:async\s+)?(?:static\s+)?)(\w+)\s*\([^)]*\)\s*\{/gm;
    let classMatch;
    let currentClass = null;

    // Finde Klassen und ihre Methoden
    const classPattern = /^class\s+(\w+)/gm;
    while ((classMatch = classPattern.exec(content)) !== null) {
      currentClass = classMatch[1];
      const classStartLine = content.substring(0, classMatch.index).split('\n').length;
      
      // Finde Methoden innerhalb dieser Klasse
      const classBody = content.substring(classMatch.index);
      const methodPattern = /(?:^\s*(?:async\s+)?(?:static\s+)?)(\w+)\s*\([^)]*\)\s*\{/gm;
      let methodMatch;
      
      while ((methodMatch = methodPattern.exec(classBody)) !== null) {
        const methodName = methodMatch[1];
        
        // Überspringe constructor und andere reservierte Namen
        if (methodName === 'constructor' || methodName === currentClass) {
          continue;
        }
        
        if (!functions.some(f => f.name === methodName && f.type === 'method')) {
          const methodLine = classStartLine + classBody.substring(0, methodMatch.index).split('\n').length;
          const methodLines = classBody.split('\n');
          const relativeLineIdx = classBody.substring(0, methodMatch.index).split('\n').length - 1;
          
          let description = this.findJsDoc(methodLines, relativeLineIdx);
          
          functions.push({
            name: methodName,
            line: methodLine,
            description,
            type: 'method',
            className: currentClass,
            isStatic: /static\s+/.test(methodMatch[0]),
            isAsync: /async\s+/.test(methodMatch[0])
          });
        }
        
        // Safety: stop if we've gone past the end of a reasonable class body
        // Use line count instead of char count to handle large files correctly
        if (classBody.substring(0, methodMatch.index).split('\n').length > 500) break;
      }
    }

    return functions.sort((a, b) => a.line - b.line);
  }

  /**
   * Erkennt den Typ einer Funktion
   */
  detectFunctionType(match) {
    if (match.includes('class ')) return 'class';
    if (match.includes('export ')) return 'export';
    if (match.includes('async ')) return 'async-function';
    if (match.includes('const ') || match.includes('let ') || match.includes('var ')) return 'arrow-function';
    return 'function';
  }

  /**
   * Sucht JSDoc Kommentar über einer Zeile
   */
  findJsDoc(lines, lineIndex) {
    let description = '';

    for (let i = lineIndex - 1; i >= 0 && i >= lineIndex - 15; i--) {
      const line = lines[i]?.trim() || '';

      if (line.startsWith('*/')) continue;
      if (line.startsWith('*')) {
        const cleanLine = line.replace(/^\*\s*/, '').trim();
        if (cleanLine && !cleanLine.startsWith('@')) {
          description = cleanLine;
        }
      } else if (line.startsWith('//')) {
        description = line.replace(/^\/\/\s*/, '').trim();
        break;
      } else if (line.startsWith('/*')) {
        break;
      } else if (line !== '') {
        break;
      }
    }

    return description || null;
  }
}

/**
 * Liest SQLite Datenbank-Schema
 */
class DatabaseScanner {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Verbindet zur Datenbank (lazy loading)
   */
  async connect() {
    if (this.db) return;

    try {
      // Dynamic import für better-sqlite3
      const Database = (await import('better-sqlite3')).default;
      this.db = new Database(this.dbPath, { readonly: true });
    } catch (err) {
      console.error(`Datenbank-Verbindung fehlgeschlagen: ${err.message}`);
      this.db = null;
    }
  }

  /**
   * Scannt das komplette Datenbank-Schema
   */
  async scan() {
    await this.connect();

    if (!this.db) {
      return { error: 'Datenbank nicht verfügbar', tables: [] };
    }

    try {
      // Alle Tabellen abrufen
      const tables = this.db.prepare(`
        SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all();

      const schema = [];

      for (const { name } of tables) {
        // Spalten-Info abrufen
        const columns = this.db.prepare(`PRAGMA table_info("${name}")`).all();

        // Foreign Keys abrufen
        const foreignKeys = this.db.prepare(`PRAGMA foreign_key_list("${name}")`).all();

        // Indizes abrufen
        const indexes = this.db.prepare(`PRAGMA index_list("${name}")`).all();

        // Zeilen-Count (optional, kann langsam sein bei großen Tabellen)
        let rowCount = 0;
        try {
          const result = this.db.prepare(`SELECT COUNT(*) as count FROM "${name}"`).get();
          rowCount = result.count;
        } catch (e) {
          // Ignorieren wenn Count fehlschlägt
        }

        schema.push({
          table: name,
          columns: columns.map(col => ({
            name: col.name,
            type: col.type,
            nullable: col.notnull === 0,
            primaryKey: col.pk === 1,
            defaultValue: col.dflt_value
          })),
          foreignKeys: foreignKeys.map(fk => ({
            column: fk.from,
            references: `${fk.table}(${fk.to})`
          })),
          indexes: indexes.map(idx => idx.name),
          rowCount
        });
      }

      return { tables: schema };

    } catch (err) {
      return { error: err.message, tables: [] };
    }
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

/**
 * Scannt Ordnerstruktur
 */
class FileStructureScanner {
  constructor(projectPath, ignorePatterns = []) {
    this.projectPath = projectPath;
    this.ignorePatterns = ignorePatterns;
  }

  /**
   * Erstellt Baum-Struktur des Projekts
   */
  async scan(maxDepth = 4) {
    return this.scanDirectory(this.projectPath, 0, maxDepth);
  }

  scanDirectory(dirPath, depth, maxDepth) {
    if (depth > maxDepth) return null;

    const name = path.basename(dirPath);

    // Ignorierte Ordner/Dateien überspringen
    if (this.shouldIgnore(name)) return null;

    const stats = fs.statSync(dirPath);

    if (stats.isFile()) {
      return {
        name,
        type: 'file',
        extension: path.extname(name).slice(1) || null,
        size: stats.size
      };
    }

    if (stats.isDirectory()) {
      let children = [];

      try {
        const entries = fs.readdirSync(dirPath);
        children = entries
          .map(entry => this.scanDirectory(path.join(dirPath, entry), depth + 1, maxDepth))
          .filter(Boolean)
          .sort((a, b) => {
            // Ordner zuerst
            if (a.type === 'directory' && b.type === 'file') return -1;
            if (a.type === 'file' && b.type === 'directory') return 1;
            return a.name.localeCompare(b.name);
          });
      } catch (err) {
        // Lesefehler ignorieren
      }

      return {
        name,
        type: 'directory',
        children
      };
    }

    return null;
  }

  shouldIgnore(name) {
    return this.ignorePatterns.some(pattern => {
      if (pattern.includes('*')) {
        const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
        return regex.test(name);
      }
      return name === pattern;
    });
  }

  /**
   * Formatiert Struktur als Text-Baum
   */
  formatAsTree(node, prefix = '', isLast = true) {
    if (!node) return '';

    const connector = isLast ? '└── ' : '├── ';
    const extension = isLast ? '    ' : '│   ';

    let result = prefix + connector + node.name;

    if (node.type === 'file' && node.size) {
      const sizeStr = node.size > 1024
        ? `${(node.size / 1024).toFixed(1)}KB`
        : `${node.size}B`;
      result += ` (${sizeStr})`;
    }
    result += '\n';

    if (node.children) {
      node.children.forEach((child, index) => {
        const childIsLast = index === node.children.length - 1;
        result += this.formatAsTree(child, prefix + extension, childIsLast);
      });
    }

    return result;
  }
}

// ============================================================================
// MCP SERVER
// ============================================================================

class ProjectContextServer {
  constructor() {
    this.server = new Server(
      {
        name: config.server.name,
        version: config.server.version,
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  /**
   * Richtet alle MCP Handler ein
   */
  setupHandlers() {
    // Resource-Liste
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = [];

      for (const project of config.projects) {
        resources.push(
          {
            uri: `context://${project.name}/routes`,
            name: `${project.name}: API Routes`,
            description: `All HTTP endpoints in ${project.name} with file locations and line numbers`,
            mimeType: 'application/json'
          },
          {
            uri: `context://${project.name}/database-schema`,
            name: `${project.name}: Database Schema`,
            description: `Live SQLite schema — all tables, columns, types, foreign keys, and row counts`,
            mimeType: 'application/json'
          },
          {
            uri: `context://${project.name}/services`,
            name: `${project.name}: Service Functions`,
            description: `All business logic functions across all service files with descriptions and line numbers`,
            mimeType: 'application/json'
          },
          {
            uri: `context://${project.name}/file-structure`,
            name: `${project.name}: File Structure`,
            description: `Full directory tree of ${project.name} with file sizes`,
            mimeType: 'text/plain'
          },
          {
            uri: `context://${project.name}/architecture`,
            name: `${project.name}: Architecture`,
            description: `High-level architecture overview from AGENTS.md or auto-generated summary`,
            mimeType: 'text/markdown'
          }
        );
      }

      return { resources };
    });

    // Resource lesen
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;

      // URI parsen: context://projectName/resourceType
      const match = uri.match(/^context:\/\/([^/]+)\/(.+)$/);
      if (!match) {
        throw new Error(`Ungültige Resource URI: ${uri}`);
      }

      const [, projectName, resourceType] = match;
      const project = config.projects.find(p => p.name === projectName);

      if (!project) {
        throw new Error(`Projekt nicht gefunden: ${projectName}`);
      }

      let content;
      let mimeType = 'application/json';

      switch (resourceType) {
        case 'routes':
          content = await this.getRoutes(project);
          break;

        case 'database-schema':
          content = await this.getDatabaseSchema(project);
          break;

        case 'services':
          content = await this.getServices(project);
          break;

        case 'file-structure':
          content = await this.getFileStructure(project);
          mimeType = 'text/plain';
          break;

        case 'architecture':
          content = await this.getArchitecture(project);
          mimeType = 'text/markdown';
          break;

        default:
          throw new Error(`Unbekannter Resource-Typ: ${resourceType}`);
      }

      return {
        contents: [{
          uri,
          mimeType,
          text: typeof content === 'string' ? content : JSON.stringify(content, null, 2)
        }]
      };
    });

    // Tools-Liste
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'find_function',
            description: 'ALWAYS use this before opening any file. Finds the exact file path and line number of any function, class, or method by name. Also shows all call sites when include_references=true (DEFAULT - always use this to trace data flow). Works on class methods too.',
            inputSchema: {
              type: 'object',
              properties: {
                project: {
                  type: 'string',
                  description: 'Project name (e.g. "etsyapp")'
                },
                function_name: {
                  type: 'string',
                  description: 'Name of the function, method, or class to find (e.g. "processOrder", "OrderProcessor", "_processBallSet")'
                },
                include_references: {
                  type: 'boolean',
                  description: 'Set to true (default) to also see every file and line where this function is called — essential for tracing data flow',
                  default: true
                }
              },
              required: ['project', 'function_name']
            }
          },
          {
            name: 'search_routes',
            description: 'ALWAYS use this instead of reading route files. Finds any HTTP endpoint (GET/POST/PUT/DELETE) by path fragment or method. Returns exact file and line number. Use this before opening any routes/ file.',
            inputSchema: {
              type: 'object',
              properties: {
                project: {
                  type: 'string',
                  description: 'Project name (e.g. "etsyapp")'
                },
                query: {
                  type: 'string',
                  description: 'Path fragment or HTTP method to search for (e.g. "profit", "GET", "inventory")'
                }
              },
              required: ['project', 'query']
            }
          },
          {
            name: 'search_tables',
            description: 'ALWAYS use this instead of reading database files. Finds database tables and their columns by name. Returns column types, foreign keys, and row counts. Use before any DB-related work.',
            inputSchema: {
              type: 'object',
              properties: {
                project: {
                  type: 'string',
                  description: 'Project name (e.g. "etsyapp")'
                },
                query: {
                  type: 'string',
                  description: 'Table or column name to search for (e.g. "transactions", "user_id", "receipts")'
                }
              },
              required: ['project', 'query']
            }
          },
          {
            name: 'search_functions',
            description: 'Advanced function search — use this to find functions by partial name, description, type, or within a specific file. Prefer find_function for exact name lookups. Use this for fuzzy/exploratory search across all service files.',
            inputSchema: {
              type: 'object',
              properties: {
                project: {
                  type: 'string',
                  description: 'Project name (e.g. "etsyapp")'
                },
                query: {
                  type: 'string',
                  description: 'Search term — matched against function name or JSDoc description'
                },
                type: {
                  type: 'string',
                  enum: ['function', 'method', 'class', 'async-function', 'arrow-function', 'export'],
                  description: 'Optional: filter by function type'
                },
                in_file: {
                  type: 'string',
                  description: 'Optional: restrict search to one file (e.g. "services/order-processor.js")'
                }
              },
              required: ['project', 'query']
            }
          },
          {
            name: 'refresh_cache',
            description: 'Forces a reload of all cached project data (startup index, Etsy API spec). Use if you suspect stale data after recent file changes.',
            inputSchema: {
              type: 'object',
              properties: {
                project: {
                  type: 'string',
                  description: 'Project name, or "all" to refresh everything'
                }
              },
              required: ['project']
            }
          },
          {
            name: 'list_notes',
            description: 'Lists all files in the Notes/ directory with size, last-modified date, and first heading. Use at session start to discover what plans, TODOs, sprint docs, and architecture decisions exist — before deciding which to read with get_file.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' }
              },
              required: ['project']
            }
          },
          {
            name: 'search_notes',
            description: 'Search all markdown files in the Notes/ directory by keyword or regex. Returns matching lines with filename, line number, and surrounding context. Use this to find plans, TODOs, or decisions without reading every file.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' },
                query: { type: 'string', description: 'Search term or regex (e.g. "global etsyApi", "Sprint 5B", "blocked")' },
                context_lines: { type: 'number', description: 'Lines of context around each match (default: 5)', default: 5 }
              },
              required: ['project', 'query']
            }
          },
          {
            name: 'search_agents_md',
            description: 'Search the AGENTS.md documentation file for any topic. Use this to quickly find architecture decisions, data flow explanations, common patterns, auth details, or any project-specific guidance — without reading the entire 54KB file.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' },
                query: { type: 'string', description: 'Topic to find (e.g. "authentication", "multi-tenancy", "inventory", "sync flow")' },
                context_lines: { type: 'number', description: 'Lines of context around each match (default: 10)', default: 10 }
              },
              required: ['project', 'query']
            }
          },
          {
            name: 'get_db_table_usage',
            description: 'Shows which files query a specific database table — finds all SELECT/INSERT/UPDATE/DELETE statements referencing that table. Use this to understand the full data flow for any table before modifying schema or queries.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' },
                table_name: { type: 'string', description: 'Database table name (e.g. "transactions", "inventory", "receipts")' }
              },
              required: ['project', 'table_name']
            }
          },
          {
            name: 'recent_changes',
            description: 'Shows recent git commits with changed files. Use at the start of a session to understand what was recently modified, or before making changes to see if something was recently touched.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' },
                limit: { type: 'number', description: 'Number of commits to show (default: 10)', default: 10 }
              },
              required: ['project']
            }
          },
          {
            name: 'list_files',
            description: 'List files in a project directory with sizes and modification dates. Use instead of get_file for exploring what files exist in a folder. Faster than reading the full file structure.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' },
                directory: { type: 'string', description: 'Relative directory path (e.g. "services", "routes", "database/migrations"). Defaults to project root.' }
              },
              required: ['project']
            }
          },
          {
            name: 'get_route_handler',
            description: 'Given an HTTP method and path, returns the full route handler code. Use this to understand what a specific endpoint does without reading the entire route file.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' },
                method: { type: 'string', description: 'HTTP method (GET, POST, PUT, DELETE, PATCH)', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
                path: { type: 'string', description: 'Route path to find (e.g. "/profit-analysis", "/adjust-inventory")' }
              },
              required: ['project', 'method', 'path']
            }
          },
          {
            name: 'get_file_imports',
            description: 'Shows all imports/requires in a file AND all files that import this file. Use to understand dependencies between files before making changes — prevents breaking other parts of the codebase.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' },
                file_path: { type: 'string', description: 'Relative file path (e.g. "services/order-processor.js")' }
              },
              required: ['project', 'file_path']
            }
          },
          {
            name: 'get_context',
            description: 'CALL THIS FIRST at the start of every session. Returns a compact project overview: architecture summary, all route files with endpoint counts, all service files with function counts, database table list, and key file locations. Gives you everything you need to orient yourself without reading any files.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' }
              },
              required: ['project']
            }
          },
          {
            name: 'get_function_code',
            description: 'Returns the full source code of a named function, method, or class. ALWAYS use this instead of reading entire files when you need to inspect how a specific function works. Automatically detects function boundaries.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' },
                function_name: { type: 'string', description: 'Exact name of the function, method, or class to retrieve' },
                file_path: { type: 'string', description: 'Optional: relative path to narrow down if multiple matches exist (e.g. "services/order-processor.js")' }
              },
              required: ['project', 'function_name']
            }
          },
          {
            name: 'search_code',
            description: 'ALWAYS use this instead of reading files to find where something is used or defined. Full-text regex search across all project JS files. Returns matching lines with file path and line number. Use for: finding all usages of a variable, locating error handling, finding imports, tracing any string/pattern in the codebase.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' },
                pattern: { type: 'string', description: 'Regex or plain text to search for (e.g. "processOrder", "user_id", "require\\(.*auth")' },
                file_glob: { type: 'string', description: 'Optional: restrict to files matching this glob (e.g. "services/**/*.js", "routes/*.js"). Defaults to all JS files.' },
                case_sensitive: { type: 'boolean', description: 'Default false — case-insensitive search', default: false },
                max_results: { type: 'number', description: 'Max matching lines to return (default 30)', default: 30 }
              },
              required: ['project', 'pattern']
            }
          },
          {
            name: 'get_file',
            description: 'Read the content of any project file. Use after find_function or search_code to read a specific file or line range. Much cheaper than reading blindly — always specify start_line/end_line when you only need a section.',
            inputSchema: {
              type: 'object',
              properties: {
                project: { type: 'string', description: 'Project name (e.g. "etsyapp")' },
                file_path: { type: 'string', description: 'Relative path from project root (e.g. "services/order-processor.js", "routes/profit-routes.js")' },
                start_line: { type: 'number', description: 'Optional: first line to read (1-based). Use to read just a function.' },
                end_line: { type: 'number', description: 'Optional: last line to read (inclusive). Use together with start_line.' }
              },
              required: ['project', 'file_path']
            }
          },
          {
            name: 'search_etsy_api',
            description: 'Searches the Etsy OpenAPI spec by path, operationId, description, or tags. Returns full endpoint structure: parameters, request body, and optionally response schema. Use this before implementing any Etsy API call.',
            inputSchema: {
              type: 'object',
              properties: {
                project: {
                  type: 'string',
                  description: 'Project name (e.g. "etsyapp")'
                },
                query: {
                  type: 'string',
                  description: 'Search term matched against path, operationId, description, and tags'
                },
                method: {
                  type: 'string',
                  description: 'Optional: filter by HTTP method',
                  enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
                },
                show_response_schema: {
                  type: 'boolean',
                  description: 'Set to true to include full response schema with all properties (default: false)',
                  default: false
                }
              },
              required: ['project', 'query']
            }
          }
        ]
      };
    });

    // Tool ausführen
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      switch (name) {
        case 'find_function':
          return await this.findFunction(args.project, args.function_name, args.include_references !== false);

        case 'search_routes':
          return await this.searchRoutes(args.project, args.query);

        case 'search_tables':
          return await this.searchTables(args.project, args.query);

        case 'search_functions':
          return await this.searchFunctions(args.project, args.query, args.type, args.in_file);

        case 'refresh_cache':
          return await this.refreshCache(args.project);

        case 'list_notes':
          return await this.listNotes(args.project);

        case 'search_notes':
          return await this.searchNotes(args.project, args.query, args.context_lines);

        case 'search_agents_md':
          return await this.searchAgentsMd(args.project, args.query, args.context_lines);

        case 'get_db_table_usage':
          return await this.getDbTableUsage(args.project, args.table_name);

        case 'recent_changes':
          return await this.recentChanges(args.project, args.limit);

        case 'list_files':
          return await this.listFiles(args.project, args.directory);

        case 'get_route_handler':
          return await this.getRouteHandler(args.project, args.method, args.path);

        case 'get_file_imports':
          return await this.getFileImports(args.project, args.file_path);

        case 'get_context':
          return await this.getContext(args.project);

        case 'get_function_code':
          return await this.getFunctionCode(args.project, args.function_name, args.file_path);

        case 'search_code':
          return await this.searchCode(args.project, args.pattern, args.file_glob, args.case_sensitive, args.max_results);

        case 'get_file':
          return await this.getFile(args.project, args.file_path, args.start_line, args.end_line);

        case 'search_etsy_api':
          return await this.searchEtsyApi(args.project, args.query, args.method, args.show_response_schema);

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
  }

  // ============================================================================
  // RESOURCE METHODEN (werden bei jedem Request neu gescannt)
  // ============================================================================

  async getRoutes(project) {
    const scanner = new RouteScanner(project.path);
    const routes = await scanner.scan(project.scan.routes || []);

    return {
      project: project.name,
      scannedAt: new Date().toISOString(),
      totalRoutes: routes.length,
      routes: routes.sort((a, b) => a.path.localeCompare(b.path))
    };
  }

  async getDatabaseSchema(project) {
    if (!project.database?.path) {
      return { error: 'Keine Datenbank konfiguriert' };
    }

    const scanner = new DatabaseScanner(project.database.path);
    const schema = await scanner.scan();
    scanner.close();

    return {
      project: project.name,
      databaseType: project.database.type,
      scannedAt: new Date().toISOString(),
      ...schema
    };
  }

  async getServices(project) {
    const scanner = new ServiceScanner(project.path);
    const services = await scanner.scan(project.scan.services || []);

    return {
      project: project.name,
      scannedAt: new Date().toISOString(),
      totalFiles: services.length,
      totalFunctions: services.reduce((sum, s) => sum + s.functions.length, 0),
      services
    };
  }

  async getFileStructure(project) {
    const scanner = new FileStructureScanner(project.path, project.ignore || []);
    const structure = await scanner.scan(4);

    // Als Text-Baum formatieren
    let output = `# Projektstruktur: ${project.name}\n`;
    output += `# Gescannt: ${new Date().toISOString()}\n\n`;
    output += scanner.formatAsTree(structure);

    return output;
  }

  async getArchitecture(project) {
    // Try AGENTS.md first (most up-to-date), then fallback
    const docFiles = ['AGENTS.md', 'CLAUDE.md', 'ARCHITECTURE.md', 'README.md'];

    for (const docFile of docFiles) {
      const docPath = path.join(project.path, docFile);
      if (fs.existsSync(docPath)) {
        try {
          const content = fs.readFileSync(docPath, 'utf-8');
          return `# Architektur: ${project.name}\n\n*Quelle: ${docFile}*\n\n${content}`;
        } catch (e) {
          // Weiter zur nächsten Datei
        }
      }
    }

    // Fallback: Generierte Übersicht
    const routes = await this.getRoutes(project);
    const services = await this.getServices(project);
    const schema = await this.getDatabaseSchema(project);

    return `# Architektur: ${project.name}

## Übersicht

- **API Endpunkte:** ${routes.totalRoutes}
- **Service-Dateien:** ${services.totalFiles}
- **Funktionen:** ${services.totalFunctions}
- **Datenbank-Tabellen:** ${schema.tables?.length || 0}

## API Routes (Top 10)

${routes.routes.slice(0, 10).map(r => `- \`${r.method} ${r.path}\` → ${r.file}:${r.line}`).join('\n')}

## Services

${services.services.map(s => `- **${s.file}**: ${s.functions.map(f => f.name).join(', ')}`).join('\n')}

## Datenbank

${schema.tables?.map(t => `- **${t.table}** (${t.rowCount} Zeilen): ${t.columns.map(c => c.name).join(', ')}`).join('\n') || 'Keine Tabellen gefunden'}
`;
  }

  // ============================================================================
  // TOOL METHODEN
  // ============================================================================

  async findFunction(projectName, functionName, includeReferences = true) {
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      return { content: [{ type: 'text', text: `Projekt nicht gefunden: ${projectName}` }] };
    }

    const services = await this.getServices(project);
    const results = [];

    for (const service of services.services) {
      for (const func of service.functions) {
        if (func.name.toLowerCase().includes(functionName.toLowerCase())) {
          results.push({
            name: func.name,
            file: service.file,
            line: func.line,
            description: func.description,
            type: func.type || 'unknown',
            className: func.className || null,
            isStatic: func.isStatic || false,
            isAsync: func.isAsync || false,
            fullPath: path.join(project.path, service.file)
          });
        }
      }
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `Keine Funktion gefunden mit Namen "${functionName}"` }] };
    }

    let text = `Gefunden: ${results.length} Treffer\n\n`;
    
    for (const r of results) {
      let typeLabel = r.type;
      if (r.className) {
        typeLabel = r.isStatic ? 'static method' : 'method';
      }
      
      text += `• ${r.name} (${typeLabel})\n`;
      text += `  File: ${r.file}:${r.line}\n`;
      if (r.className) {
        text += `  Class: ${r.className}\n`;
      }
      if (r.description) {
        text += `  Description: ${r.description}\n`;
      }

      // Show a code snippet (5 lines starting at definition)
      try {
        const fullContent = fs.readFileSync(r.fullPath, 'utf-8');
        const snippet = fullContent.split('\n').slice(r.line - 1, r.line + 4)
          .map((l, i) => `    ${String(r.line + i).padStart(4, ' ')} │ ${l}`)
          .join('\n');
        text += `  Code preview:\n${snippet}\n`;
      } catch (e) { /* skip snippet if file unreadable */ }

      // Show where the function is called
      if (includeReferences) {
        const references = this.findReferences(project, r.name);
        if (references.length > 0) {
          text += `  Called from:\n`;
          references.slice(0, 5).forEach(ref => {
            text += `    - ${ref.file}:${ref.line}  ${ref.context || ''}\n`;
          });
          if (references.length > 5) {
            text += `    ... and ${references.length - 5} more\n`;
          }
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  }

  /**
   * Findet wo eine Funktion aufgerufen wird (Cross-Reference)
   */
  findReferences(project, functionName) {
    const references = [];
    const patterns = [
      new RegExp(`\\b${functionName}\\s*\\(`, 'g'),  // function()
      new RegExp(`\\.${functionName}\\s*\\(`, 'g'),  // obj.function()
      new RegExp(`\\b(?:new\\s+)?${functionName}\\s*[({]`, 'g')  // new Class() or Class {
    ];

    try {
      const files = glob.sync('**/*.js', {
        cwd: project.path,
        absolute: true
      });

      for (const file of files) {
        try {
          const content = fs.readFileSync(file, 'utf-8');
          const relativePath = path.relative(project.path, file);

          for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
              const lineNumber = content.substring(0, match.index).split('\n').length;
              
              // Ausschließe die Definitions-Zeile selbst
              if (!content.substring(0, match.index).includes(`function ${functionName}`) &&
                  !content.substring(0, match.index).includes(`${functionName}\\s*=`) &&
                  !content.substring(0, match.index).includes(`class ${functionName}`)) {
                
                references.push({
                  file: relativePath,
                  line: lineNumber,
                  context: content.split('\n')[lineNumber - 1]?.trim()
                });
              }
            }
          }
        } catch (e) {
          // Datei ignorieren
        }
      }
    } catch (e) {
      // Fehler ignorieren
    }

    return references;
  }

  async searchRoutes(projectName, query) {
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      return { content: [{ type: 'text', text: `Projekt nicht gefunden: ${projectName}` }] };
    }

    const routes = await this.getRoutes(project);
    const queryLower = query.toLowerCase();

    const results = routes.routes.filter(r =>
      r.path.toLowerCase().includes(queryLower) ||
      r.method.toLowerCase().includes(queryLower) ||
      (r.description && r.description.toLowerCase().includes(queryLower))
    );

    const text = results.length > 0
      ? `Gefunden: ${results.length} Routes\n\n` +
        results.map(r => `• ${r.method} ${r.path}\n  ${r.file}:${r.line}`).join('\n\n')
      : `Keine Routes gefunden mit "${query}"`;

    return { content: [{ type: 'text', text }] };
  }

  async searchTables(projectName, query) {
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      return { content: [{ type: 'text', text: `Projekt nicht gefunden: ${projectName}` }] };
    }

    const schema = await this.getDatabaseSchema(project);
    const queryLower = query.toLowerCase();

    const results = [];

    for (const table of schema.tables || []) {
      // Tabellennamen prüfen
      if (table.table.toLowerCase().includes(queryLower)) {
        results.push({
          type: 'table',
          name: table.table,
          columns: table.columns.map(c => c.name),
          rowCount: table.rowCount
        });
      }

      // Spaltennamen prüfen
      for (const col of table.columns) {
        if (col.name.toLowerCase().includes(queryLower)) {
          results.push({
            type: 'column',
            table: table.table,
            column: col.name,
            dataType: col.type,
            nullable: col.nullable
          });
        }
      }
    }

    const text = results.length > 0
      ? `Gefunden: ${results.length} Treffer\n\n` +
        results.map(r => {
          if (r.type === 'table') {
            return `• Tabelle: ${r.name} (${r.rowCount} Zeilen)\n  Spalten: ${r.columns.join(', ')}`;
          } else {
            return `• Spalte: ${r.table}.${r.column} (${r.dataType}${r.nullable ? ', nullable' : ''})`;
          }
        }).join('\n\n')
      : `Keine Tabellen/Spalten gefunden mit "${query}"`;

    return { content: [{ type: 'text', text }] };
  }

  async searchFunctions(projectName, query, typeFilter = null, inFileFilter = null) {
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      return { content: [{ type: 'text', text: `Projekt nicht gefunden: ${projectName}` }] };
    }

    const services = await this.getServices(project);
    const results = [];
    const queryLower = query.toLowerCase();

    for (const service of services.services) {
      // Filter by file — match against filename or partial path
      if (inFileFilter && !service.file.includes(inFileFilter) && !path.basename(service.file).includes(inFileFilter)) {
        continue;
      }

      for (const func of service.functions) {
        // Filter nach Typ
        if (typeFilter && func.type !== typeFilter) {
          continue;
        }

        // Suche in Name oder Beschreibung
        if (func.name.toLowerCase().includes(queryLower) || 
            (func.description && func.description.toLowerCase().includes(queryLower))) {
          results.push({
            name: func.name,
            file: service.file,
            line: func.line,
            description: func.description,
            type: func.type || 'unknown',
            className: func.className || null
          });
        }
      }
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `Keine Funktionen gefunden mit Query "${query}"${typeFilter ? ` (Typ: ${typeFilter})` : ''}${inFileFilter ? ` (in ${inFileFilter})` : ''}` }] };
    }

    let text = `Gefunden: ${results.length} Treffer\n`;
    if (typeFilter) text += `Filter: Typ = ${typeFilter}\n`;
    if (inFileFilter) text += `Filter: Datei enthält "${inFileFilter}"\n`;
    text += '\n';

    // Gruppiere nach Datei
    const byFile = {};
    for (const r of results) {
      if (!byFile[r.file]) {
        byFile[r.file] = [];
      }
      byFile[r.file].push(r);
    }

    for (const [file, funcs] of Object.entries(byFile)) {
      text += `📄 ${file}\n`;
      for (const f of funcs) {
        text += `  • ${f.name} (${f.type}${f.className ? ` in ${f.className}` : ''}) - Zeile ${f.line}\n`;
        if (f.description) {
          text += `    ${f.description}\n`;
        }
      }
      text += '\n';
    }

    return { content: [{ type: 'text', text }] };
  }

  // ============================================================================
  // SEARCH AGENTS MD — search project documentation by topic
  // ============================================================================

  async searchAgentsMd(projectName, query, contextLines = 10) {
    const tool = 'search_agents_md';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    const docFiles = ['AGENTS.md', 'CLAUDE.md', 'ARCHITECTURE.md', 'README.md'];
    let docPath = null, docName = null;
    for (const f of docFiles) {
      const p = path.join(project.path, f);
      if (fs.existsSync(p)) { docPath = p; docName = f; break; }
    }

    if (!docPath) {
      return { content: [{ type: 'text', text: `No documentation file found (AGENTS.md, CLAUDE.md, etc.) in ${projectName}` }] };
    }

    const content = fs.readFileSync(docPath, 'utf-8');
    const lines = content.split('\n');
    const queryLower = query.toLowerCase();
    const matches = [];

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(queryLower)) {
        matches.push(i);
      }
    }

    if (matches.length === 0) {
      logger.warn(tool, 'No matches found', { query, docName });
      return { content: [{ type: 'text', text: `No matches for "${query}" in ${docName}` }] };
    }

    // Merge overlapping context windows
    const windows = [];
    let currentWindow = null;
    for (const matchLine of matches) {
      const from = Math.max(0, matchLine - contextLines);
      const to = Math.min(lines.length - 1, matchLine + contextLines);
      if (currentWindow && from <= currentWindow.to + 1) {
        currentWindow.to = Math.max(currentWindow.to, to);
      } else {
        currentWindow = { from, to };
        windows.push(currentWindow);
      }
    }

    let text = `📖 ${docName} — ${matches.length} match${matches.length !== 1 ? 'es' : ''} for "${query}"\n\n`;
    for (const w of windows.slice(0, 5)) {
      text += `${'─'.repeat(50)} (lines ${w.from + 1}–${w.to + 1})\n`;
      text += lines.slice(w.from, w.to + 1).join('\n') + '\n\n';
    }
    if (windows.length > 5) text += `(${windows.length - 5} more sections not shown — refine your query)\n`;

    logger.info(tool, 'Search complete', { query, docName, matches: matches.length });
    return { content: [{ type: 'text', text }] };
  }

  // ============================================================================
  // LIST NOTES — directory listing of Notes/ with headings
  // ============================================================================

  async listNotes(projectName) {
    const tool = 'list_notes';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    const notesDir = project.notes_path || path.join(project.path, 'Notes');
    if (!fs.existsSync(notesDir)) {
      return { content: [{ type: 'text', text: `No Notes/ directory found in ${projectName}` }] };
    }

    const files = fs.readdirSync(notesDir)
      .filter(f => f.endsWith('.md'))
      .map(f => {
        const filePath = path.join(notesDir, f);
        const stat = fs.statSync(filePath);
        const firstLines = fs.readFileSync(filePath, 'utf-8').split('\n').slice(0, 20);
        const heading = firstLines.find(l => l.startsWith('#'));
        const title = heading ? heading.replace(/^#+\s*/, '').trim() : '(no heading)';
        return { name: f, size: stat.size, mtime: stat.mtime, title };
      })
      .sort((a, b) => b.mtime - a.mtime);

    let text = `📂 Notes/ — ${files.length} files (sorted by last modified)\n\n`;
    for (const f of files) {
      const sizeStr = f.size > 1024 ? `${(f.size / 1024).toFixed(1)}KB` : `${f.size}B`;
      const dateStr = f.mtime.toISOString().split('T')[0];
      text += `📄 ${f.name.padEnd(40)} ${sizeStr.padStart(7)}  ${dateStr}  "${f.title}"\n`;
    }
    text += `\n→ Use get_file to read any file, search_notes to search content`;

    logger.info(tool, 'Listed notes', { projectName, count: files.length });
    return { content: [{ type: 'text', text }] };
  }

  // ============================================================================
  // SEARCH NOTES — full-text search across all Notes/ markdown files
  // ============================================================================

  async searchNotes(projectName, query, contextLines = 5) {
    const tool = 'search_notes';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    const notesDir = project.notes_path || path.join(project.path, 'Notes');
    if (!fs.existsSync(notesDir)) {
      return { content: [{ type: 'text', text: `No Notes/ directory found in ${projectName}` }] };
    }

    const files = fs.readdirSync(notesDir).filter(f => f.endsWith('.md'));
    let regex;
    try {
      regex = new RegExp(query, 'gi');
    } catch {
      regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    }

    const allMatches = [];

    for (const file of files) {
      const filePath = path.join(notesDir, file);
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      const matchLines = [];

      for (let i = 0; i < lines.length; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) matchLines.push(i);
      }

      if (matchLines.length === 0) continue;

      // Merge overlapping context windows
      const windows = [];
      let current = null;
      for (const ml of matchLines) {
        const from = Math.max(0, ml - contextLines);
        const to = Math.min(lines.length - 1, ml + contextLines);
        if (current && from <= current.to + 1) {
          current.to = Math.max(current.to, to);
        } else {
          current = { from, to };
          windows.push(current);
        }
      }

      allMatches.push({ file, matchCount: matchLines.length, windows, lines });
    }

    if (allMatches.length === 0) {
      return { content: [{ type: 'text', text: `No matches for "${query}" in Notes/` }] };
    }

    const totalMatches = allMatches.reduce((sum, m) => sum + m.matchCount, 0);
    let text = `📖 Notes/ — ${totalMatches} match${totalMatches !== 1 ? 'es' : ''} for "${query}" across ${allMatches.length} file${allMatches.length !== 1 ? 's' : ''}\n\n`;

    for (const { file, windows, lines } of allMatches) {
      text += `${'═'.repeat(50)}\n📄 ${file}\n${'═'.repeat(50)}\n`;
      for (const w of windows.slice(0, 3)) {
        text += `${'─'.repeat(40)} (lines ${w.from + 1}–${w.to + 1})\n`;
        text += lines.slice(w.from, w.to + 1).join('\n') + '\n\n';
      }
      if (windows.length > 3) text += `  (${windows.length - 3} more sections in this file)\n\n`;
    }

    logger.info(tool, 'Search complete', { query, totalMatches, filesWithMatches: allMatches.length });
    return { content: [{ type: 'text', text }] };
  }

  // ============================================================================
  // GET DB TABLE USAGE — find all files that query a specific table
  // ============================================================================

  async getDbTableUsage(projectName, tableName) {
    const tool = 'get_db_table_usage';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    let files;
    try {
      files = await glob('**/*.js', {
        cwd: project.path,
        absolute: true,
        ignore: (project.ignore || []).map(p => `**/${p}/**`)
      });
    } catch (err) {
      logger.error(tool, 'Glob error', { error: err.message });
      return { content: [{ type: 'text', text: `Error scanning files: ${err.message}` }] };
    }

    const tablePattern = new RegExp(`\\b${tableName}\\b`, 'i');
    const sqlPattern = /\b(SELECT|INSERT|UPDATE|DELETE|FROM|INTO|JOIN)\b/i;
    const results = {};

    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        if (!tablePattern.test(content)) continue;

        const relPath = path.relative(project.path, file);
        const lines = content.split('\n');
        const hits = [];

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (tablePattern.test(line) && sqlPattern.test(line)) {
            hits.push({ line: i + 1, text: line.trim() });
          }
        }

        if (hits.length > 0) results[relPath] = hits;
      } catch { /* skip unreadable files */ }
    }

    if (Object.keys(results).length === 0) {
      return { content: [{ type: 'text', text: `No SQL usage of table "${tableName}" found in any JS file.` }] };
    }

    let text = `🗄  Table "${tableName}" is queried in ${Object.keys(results).length} file(s):\n\n`;
    for (const [file, hits] of Object.entries(results)) {
      text += `📄 ${file}\n`;
      for (const h of hits.slice(0, 8)) {
        text += `  L${h.line}: ${h.text.substring(0, 100)}\n`;
      }
      if (hits.length > 8) text += `  ... and ${hits.length - 8} more\n`;
      text += '\n';
    }

    logger.info(tool, 'Table usage found', { tableName, fileCount: Object.keys(results).length });
    return { content: [{ type: 'text', text }] };
  }

  // ============================================================================
  // RECENT CHANGES — git log summary
  // ============================================================================

  async recentChanges(projectName, limit = 10) {
    const tool = 'recent_changes';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    const { execSync } = await import('child_process');
    try {
      const safeLimit = Math.min(Math.max(1, limit || 10), 50);
      // Get log with changed files
      const log = execSync(
        `git log --oneline -${safeLimit} --name-status`,
        { cwd: project.path, encoding: 'utf-8', timeout: 5000 }
      );

      const lines = log.trim().split('\n');
      let text = `📋 Last ${safeLimit} commits in ${projectName}:\n\n`;
      let currentCommit = null;

      for (const line of lines) {
        if (/^[0-9a-f]{7,}/.test(line)) {
          if (currentCommit) text += '\n';
          currentCommit = line;
          text += `🔹 ${line}\n`;
        } else if (/^[AMD]\t/.test(line)) {
          const [status, file] = line.split('\t');
          const icon = status === 'A' ? '✚' : status === 'D' ? '✖' : '✎';
          text += `   ${icon} ${file}\n`;
        }
      }

      logger.info(tool, 'Git log retrieved', { projectName, limit: safeLimit });
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      logger.error(tool, 'Git log failed', { error: err.message });
      return { content: [{ type: 'text', text: `Git log failed: ${err.message}\n(Is this a git repository?)` }] };
    }
  }

  // ============================================================================
  // LIST FILES — directory listing with metadata
  // ============================================================================

  async listFiles(projectName, directory = '') {
    const tool = 'list_files';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    const targetPath = path.resolve(project.path, directory);
    if (!targetPath.startsWith(path.resolve(project.path))) {
      return { content: [{ type: 'text', text: 'Access denied: path outside project root' }] };
    }

    try {
      const entries = fs.readdirSync(targetPath, { withFileTypes: true });
      const ignore = project.ignore || [];

      const items = entries
        .filter(e => !ignore.some(pat => {
          if (pat.includes('*')) return new RegExp('^' + pat.replace(/\*/g, '.*') + '$').test(e.name);
          return e.name === pat;
        }))
        .map(e => {
          const fullPath = path.join(targetPath, e.name);
          try {
            const stat = fs.statSync(fullPath);
            return {
              name: e.name,
              type: e.isDirectory() ? 'dir' : 'file',
              size: e.isFile() ? stat.size : null,
              modified: stat.mtime.toISOString().substring(0, 10)
            };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      const relDir = directory || '.';
      let text = `📂 ${projectName}/${relDir}\n${'─'.repeat(50)}\n`;
      for (const item of items) {
        const sizeStr = item.size !== null
          ? (item.size > 1024 ? `${(item.size / 1024).toFixed(1)}KB` : `${item.size}B`)
          : '';
        const icon = item.type === 'dir' ? '📁' : '📄';
        text += `${icon} ${item.name.padEnd(40)} ${sizeStr.padStart(8)}  ${item.modified}\n`;
      }
      text += `\n${items.length} items`;

      logger.info(tool, 'Directory listed', { directory: relDir, count: items.length });
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      logger.error(tool, 'Cannot read directory', { directory, error: err.message });
      return { content: [{ type: 'text', text: `Cannot read directory "${directory}": ${err.message}` }] };
    }
  }

  // ============================================================================
  // GET ROUTE HANDLER — extract the handler code for a specific route
  // ============================================================================

  async getRouteHandler(projectName, method, routePath) {
    const tool = 'get_route_handler';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    // Find the route first
    const routesData = await this.getRoutes(project);
    const methodUpper = method.toUpperCase();
    const match = routesData.routes.find(r =>
      r.method === methodUpper &&
      (r.path === routePath || r.path.toLowerCase() === routePath.toLowerCase())
    );

    if (!match) {
      // Try partial match
      const partial = routesData.routes.filter(r =>
        r.method === methodUpper && r.path.includes(routePath)
      );
      if (partial.length === 0) {
        logger.warn(tool, 'Route not found', { method, routePath });
        return { content: [{ type: 'text', text: `Route ${method} ${routePath} not found. Try search_routes to find similar routes.` }] };
      }
      if (partial.length > 1) {
        const list = partial.map(r => `  ${r.method} ${r.path}  (${r.file}:${r.line})`).join('\n');
        return { content: [{ type: 'text', text: `Multiple matches found — be more specific:\n${list}` }] };
      }
      // Exactly one partial match — use it
      Object.assign(match || {}, partial[0]);
      const usedMatch = partial[0];
      return this._extractRouteHandler(project, usedMatch);
    }

    return this._extractRouteHandler(project, match);
  }

  _extractRouteHandler(project, route) {
    const tool = 'get_route_handler';
    const fullPath = path.join(project.path, route.file);
    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      logger.error(tool, 'Cannot read route file', { file: route.file, error: err.message });
      return { content: [{ type: 'text', text: `Cannot read file: ${err.message}` }] };
    }

    const lines = content.split('\n');
    const startIdx = route.line - 1;

    // Walk forward tracking brace depth to find handler end
    let depth = 0, foundOpen = false, endIdx = startIdx;
    for (let i = startIdx; i < lines.length; i++) {
      const stripped = lines[i].replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\/.*/g, '');
      for (const ch of stripped) {
        if (ch === '{') { depth++; foundOpen = true; }
        else if (ch === '}' && foundOpen) depth--;
      }
      if (foundOpen && depth === 0) { endIdx = i; break; }
      if (i - startIdx > 200) { endIdx = startIdx + 200; break; }
    }

    const snippet = lines.slice(startIdx, endIdx + 1);
    const numbered = snippet.map((l, i) => `${String(route.line + i).padStart(4)} │ ${l}`).join('\n');
    const header = `📄 ${route.file} — ${route.method} ${route.path} [lines ${route.line}–${route.line + snippet.length - 1}]\n${'─'.repeat(60)}\n`;

    logger.info(tool, 'Route handler extracted', { method: route.method, path: route.path, lines: snippet.length });
    return { content: [{ type: 'text', text: header + numbered }] };
  }

  // ============================================================================
  // GET FILE IMPORTS — dependency map for a file
  // ============================================================================

  async getFileImports(projectName, filePath) {
    const tool = 'get_file_imports';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    const fullPath = path.resolve(project.path, filePath);
    if (!fullPath.startsWith(path.resolve(project.path))) {
      return { content: [{ type: 'text', text: 'Access denied: path outside project root' }] };
    }

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      logger.error(tool, 'Cannot read file', { filePath, error: err.message });
      return { content: [{ type: 'text', text: `Cannot read file "${filePath}": ${err.message}` }] };
    }

    // Extract what THIS file imports
    const importLines = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(import\s|const\s.*require\(|let\s.*require\(|var\s.*require\()/.test(line)) {
        importLines.push({ line: i + 1, text: line.trim() });
      }
    }

    // Find which OTHER files import THIS file
    const fileName = path.basename(filePath, '.js');
    const fileNameNoExt = fileName;
    let importedBy = [];
    try {
      const allFiles = await glob('**/*.js', {
        cwd: project.path,
        absolute: true,
        ignore: (project.ignore || []).map(p => `**/${p}/**`)
      });

      for (const f of allFiles) {
        if (path.resolve(f) === fullPath) continue;
        try {
          const fc = fs.readFileSync(f, 'utf-8');
          if (fc.includes(fileNameNoExt) && /require|import/.test(fc)) {
            const rel = path.relative(project.path, f);
            // Verify it's an actual import, not just a string mention
            const importMatch = fc.match(new RegExp(`(require|import)[^'"]*['"]([^'"]*${fileNameNoExt.replace(/[-]/g, '[-]')})[^'"]*['"]`));
            if (importMatch) importedBy.push(rel);
          }
        } catch { /* skip */ }
      }
    } catch (err) {
      logger.warn(tool, 'Error scanning for importers', { error: err.message });
    }

    let text = `📄 ${filePath}\n${'─'.repeat(60)}\n`;
    text += `\n⬇️  IMPORTS (what this file depends on):\n`;
    if (importLines.length > 0) {
      for (const il of importLines) {
        text += `  L${il.line}: ${il.text}\n`;
      }
    } else {
      text += `  (no imports found)\n`;
    }

    text += `\n⬆️  IMPORTED BY (files that depend on this file):\n`;
    if (importedBy.length > 0) {
      for (const f of importedBy) text += `  • ${f}\n`;
    } else {
      text += `  (not imported by any scanned file)\n`;
    }

    logger.info(tool, 'Import map built', { filePath, imports: importLines.length, importedBy: importedBy.length });
    return { content: [{ type: 'text', text }] };
  }

  // ============================================================================
  // GET CONTEXT — compact project overview, cached per session
  // ============================================================================

  async getContext(projectName) {
    const tool = 'get_context';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    // Use session cache — rebuilt only when refresh_cache is called
    if (!this._contextCache) this._contextCache = {};
    if (this._contextCache[projectName]) {
      logger.info(tool, 'Serving from cache', { projectName });
      return { content: [{ type: 'text', text: this._contextCache[projectName] }] };
    }

    logger.info(tool, 'Building context overview', { projectName });

    try {
      // Run all scans in parallel for speed
      const [routesData, servicesData, schemaData] = await Promise.all([
        this.getRoutes(project),
        this.getServices(project),
        this.getDatabaseSchema(project)
      ]);

      // Read AGENTS.md summary (first 60 lines = overview section)
      let agentsMdSummary = '';
      const agentsPath = path.join(project.path, 'AGENTS.md');
      if (fs.existsSync(agentsPath)) {
        const agentsLines = fs.readFileSync(agentsPath, 'utf-8').split('\n');
        // Find the architecture/overview section
        const overviewStart = agentsLines.findIndex(l => l.includes('ARCHITECTURE') || l.includes('Overview') || l.includes('OVERVIEW'));
        const slice = overviewStart >= 0 ? agentsLines.slice(overviewStart, overviewStart + 40) : agentsLines.slice(0, 40);
        agentsMdSummary = slice.join('\n').trim();
      }

      // Group routes by file
      const routesByFile = {};
      for (const r of routesData.routes) {
        if (!routesByFile[r.file]) routesByFile[r.file] = [];
        routesByFile[r.file].push(`${r.method} ${r.path}`);
      }

      // Build compact output
      let text = `╔══════════════════════════════════════════════════════════════╗\n`;
      text += `║  PROJECT CONTEXT: ${projectName.toUpperCase().padEnd(43)}║\n`;
      text += `╚══════════════════════════════════════════════════════════════╝\n\n`;

      text += `📁 PROJECT PATH: ${project.path}\n`;
      text += `🗄  DATABASE:     ${project.database?.path || 'none'}\n\n`;

      if (agentsMdSummary) {
        text += `─── ARCHITECTURE SUMMARY (from AGENTS.md) ──────────────────────\n`;
        text += agentsMdSummary + '\n\n';
      }

      text += `─── ROUTES (${routesData.totalRoutes} endpoints across ${Object.keys(routesByFile).length} files) ────────────────────\n`;
      for (const [file, endpoints] of Object.entries(routesByFile)) {
        text += `  📄 ${file} (${endpoints.length} endpoints)\n`;
        for (const ep of endpoints.slice(0, 5)) {
          text += `      ${ep}\n`;
        }
        if (endpoints.length > 5) text += `      ... and ${endpoints.length - 5} more\n`;
      }

      text += `\n─── SERVICES (${servicesData.totalFunctions} functions across ${servicesData.totalFiles} files) ──────────────────\n`;
      for (const svc of servicesData.services) {
        const fnNames = svc.functions.map(f => f.name).join(', ');
        const preview = fnNames.length > 80 ? fnNames.substring(0, 80) + '…' : fnNames;
        text += `  📄 ${svc.file} (${svc.functions.length} fns)\n`;
        text += `      ${preview}\n`;
      }

      text += `\n─── DATABASE TABLES (${schemaData.tables?.length || 0}) ──────────────────────────────────\n`;
      for (const t of schemaData.tables || []) {
        const cols = t.columns.map(c => c.name).join(', ');
        const preview = cols.length > 70 ? cols.substring(0, 70) + '…' : cols;
        text += `  • ${t.table} (${t.rowCount} rows) — ${preview}\n`;
      }

      // Notes & Plans summary
      const notesDir = project.notes_path || path.join(project.path, 'Notes');
      if (fs.existsSync(notesDir)) {
        const noteFiles = fs.readdirSync(notesDir)
          .filter(f => f.endsWith('.md'))
          .map(f => {
            const fp = path.join(notesDir, f);
            const stat = fs.statSync(fp);
            const firstLines = fs.readFileSync(fp, 'utf-8').split('\n').slice(0, 20);
            const heading = firstLines.find(l => l.startsWith('#'));
            const title = heading ? heading.replace(/^#+\s*/, '').trim() : '(no heading)';
            return { name: f, mtime: stat.mtime, title };
          })
          .sort((a, b) => b.mtime - a.mtime)
          .slice(0, 8);

        text += `\n─── NOTES & PLANS (most recently updated) ──────────────────────\n`;
        for (const f of noteFiles) {
          const dateStr = f.mtime.toISOString().split('T')[0];
          text += `  📄 ${f.name.padEnd(35)} ${dateStr}  "${f.title}"\n`;
        }
        text += `  → Call list_notes() to see all files, search_notes() to search content\n`;
      }

      text += `\n─── HOW TO USE THIS MCP SERVER ─────────────────────────────────\n`;
      text += `  get_context        → This overview (call first each session)\n`;
      text += `  find_function      → Find any function by name (+ call sites)\n`;
      text += `  get_function_code  → Read full source of a specific function\n`;
      text += `  search_code        → Regex search across all files\n`;
      text += `  get_file           → Read a file or line range\n`;
      text += `  search_routes      → Find HTTP endpoints by path/method\n`;
      text += `  search_tables      → Find DB tables/columns by name\n`;
      text += `  search_functions   → Fuzzy search functions by name/description\n`;
      text += `  search_etsy_api    → Search Etsy OpenAPI spec\n`;
      text += `  list_notes         → List all Notes/ files with headings\n`;
      text += `  search_notes       → Search all Notes/ files by keyword\n`;
      text += `  refresh_cache      → Clear session cache after major changes\n`;

      this._contextCache[projectName] = text;
      logger.info(tool, 'Context built and cached', { projectName, routes: routesData.totalRoutes, functions: servicesData.totalFunctions });
      return { content: [{ type: 'text', text }] };

    } catch (err) {
      logger.error(tool, 'Failed to build context', { projectName, error: err.message });
      return { content: [{ type: 'text', text: `Error building context: ${err.message}` }] };
    }
  }

  // ============================================================================
  // GET FUNCTION CODE — extract full source of a named function/class
  // ============================================================================

  async getFunctionCode(projectName, functionName, filePath) {
    const tool = 'get_function_code';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    // First find where the function is defined
    const services = await this.getServices(project);
    let candidates = [];

    for (const service of services.services) {
      if (filePath && !service.file.includes(filePath)) continue;
      for (const func of service.functions) {
        if (func.name === functionName) {
          candidates.push({ ...func, file: service.file, fullPath: path.join(project.path, service.file) });
        }
      }
    }

    if (candidates.length === 0) {
      logger.warn(tool, 'Function not found', { functionName, filePath });
      return { content: [{ type: 'text', text: `Function "${functionName}" not found. Try find_function first to locate it.` }] };
    }

    // If multiple candidates, pick first (or the one matching filePath)
    const match = candidates[0];
    let fileContent;
    try {
      fileContent = fs.readFileSync(match.fullPath, 'utf-8');
    } catch (err) {
      logger.error(tool, 'Cannot read file', { file: match.fullPath, error: err.message });
      return { content: [{ type: 'text', text: `Cannot read file: ${err.message}` }] };
    }

    const lines = fileContent.split('\n');

    // Scan backwards from match.line to find the actual function/method signature
    // (the scanner sometimes points to the first line of the body, not the signature)
    let sigIdx = match.line - 1; // 0-based, default to reported line
    for (let i = match.line - 1; i >= Math.max(0, match.line - 5); i--) {
      if (lines[i].includes(functionName)) {
        sigIdx = i;
        break;
      }
    }

    // Walk forward from signature line, tracking brace depth.
    // Start counting only from the first '{' we encounter.
    let depth = 0;
    let endIdx = sigIdx;
    let foundOpen = false;

    for (let i = sigIdx; i < lines.length; i++) {
      // Strip string literals and line comments to avoid false brace counts
      const stripped = lines[i].replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`|\/\/.*/g, '');
      for (const ch of stripped) {
        if (ch === '{') { depth++; foundOpen = true; }
        else if (ch === '}' && foundOpen) { depth--; }
      }
      if (foundOpen && depth === 0) {
        endIdx = i;
        break;
      }
      // Safety: don't go more than 300 lines
      if (i - sigIdx > 300) {
        endIdx = sigIdx + 300;
        break;
      }
    }

    const startIdx = sigIdx; // use signature line as display start

    const snippet = lines.slice(startIdx, endIdx + 1);
    const numbered = snippet.map((l, i) => `${String(match.line + i).padStart(4, ' ')} │ ${l}`).join('\n');
    const header = `📄 ${match.file} — ${functionName}() [lines ${match.line}–${match.line + snippet.length - 1}]\n${'─'.repeat(60)}\n`;

    logger.info(tool, 'Function code retrieved', { functionName, file: match.file, lines: snippet.length });
    return { content: [{ type: 'text', text: header + numbered }] };
  }

  // ============================================================================
  // SEARCH CODE — full-text search across project files
  // ============================================================================

  async searchCode(projectName, pattern, fileGlob, caseSensitive = false, maxResults = 30) {
    const tool = 'search_code';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    let regex;
    try {
      regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
    } catch (err) {
      logger.error(tool, 'Invalid regex pattern', { pattern, error: err.message });
      return { content: [{ type: 'text', text: `Invalid regex pattern: ${err.message}` }] };
    }

    const globPattern = fileGlob || '**/*.js';
    let files;
    try {
      files = await glob(globPattern, {
        cwd: project.path,
        absolute: true,
        ignore: (project.ignore || []).map(p => `**/${p}/**`)
      });
    } catch (err) {
      logger.error(tool, 'Glob error', { globPattern, error: err.message });
      return { content: [{ type: 'text', text: `Glob error: ${err.message}` }] };
    }

    const matches = [];

    for (const file of files) {
      if (matches.length >= maxResults) break;
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n');
        const relativePath = path.relative(project.path, file);

        for (let i = 0; i < lines.length; i++) {
          if (matches.length >= maxResults) break;
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            matches.push({
              file: relativePath,
              line: i + 1,
              text: lines[i].trim()
            });
          }
        }
      } catch (err) {
        logger.warn(tool, 'Could not read file', { file, error: err.message });
      }
    }

    if (matches.length === 0) {
      return { content: [{ type: 'text', text: `No matches found for "${pattern}" in ${globPattern}` }] };
    }

    let text = `Found ${matches.length} match${matches.length !== 1 ? 'es' : ''} for "${pattern}"`;
    if (matches.length >= maxResults) text += ` (limited to ${maxResults})`;
    text += '\n\n';

    // Group by file for readability
    const byFile = {};
    for (const m of matches) {
      if (!byFile[m.file]) byFile[m.file] = [];
      byFile[m.file].push(m);
    }

    for (const [file, fileMatches] of Object.entries(byFile)) {
      text += `📄 ${file}\n`;
      for (const m of fileMatches) {
        text += `  L${m.line}: ${m.text}\n`;
      }
      text += '\n';
    }

    logger.info(tool, 'Search complete', { pattern, matchCount: matches.length, fileCount: Object.keys(byFile).length });
    return { content: [{ type: 'text', text }] };
  }

  // ============================================================================
  // GET FILE — read any project file or a line range
  // ============================================================================

  async getFile(projectName, filePath, startLine, endLine) {
    const tool = 'get_file';
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      logger.warn(tool, 'Project not found', { projectName });
      return { content: [{ type: 'text', text: `Project not found: ${projectName}` }] };
    }

    // Prevent path traversal
    const fullPath = path.resolve(project.path, filePath);
    if (!fullPath.startsWith(path.resolve(project.path))) {
      logger.error(tool, 'Path traversal attempt blocked', { filePath });
      return { content: [{ type: 'text', text: `Access denied: path outside project root` }] };
    }

    let content;
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (err) {
      logger.error(tool, 'Could not read file', { filePath, error: err.message });
      return { content: [{ type: 'text', text: `Could not read file "${filePath}": ${err.message}` }] };
    }

    const lines = content.split('\n');
    const totalLines = lines.length;

    let selectedLines = lines;
    let rangeNote = '';

    if (startLine !== undefined || endLine !== undefined) {
      const from = Math.max(1, startLine || 1);
      const to = Math.min(totalLines, endLine || totalLines);
      selectedLines = lines.slice(from - 1, to);
      rangeNote = ` (lines ${from}–${to} of ${totalLines})`;
    }

    // Add line numbers
    const startNum = startLine || 1;
    const numbered = selectedLines.map((l, i) => `${String(startNum + i).padStart(4, ' ')} │ ${l}`).join('\n');

    const text = `📄 ${filePath}${rangeNote}\n${'─'.repeat(60)}\n${numbered}`;
    logger.info(tool, 'File read', { filePath, lines: selectedLines.length, totalLines });
    return { content: [{ type: 'text', text }] };
  }

  // ============================================================================
  // ETSY API SEARCH
  // ============================================================================

  /**
   * Löst eine $ref-Referenz im OpenAPI-Spec auf
   */
  resolveSchemaRef(spec, ref) {
    if (!ref || !ref.startsWith('#/')) return null;
    const parts = ref.replace('#/', '').split('/');
    let current = spec;
    for (const part of parts) {
      current = current?.[part];
      if (!current) return null;
    }
    return current;
  }

  /**
   * Entfernt HTML-Tags aus Beschreibungstexten
   */
  stripHtml(text) {
    if (!text) return '';
    // Entferne HTML-Tags
    let clean = text.replace(/<[^>]+>/g, ' ');
    // Bereinige Whitespace
    clean = clean.replace(/\s+/g, ' ').trim();
    return clean;
  }

  /**
   * Sucht Etsy API Endpunkte im OpenAPI-Spec
   */
  async searchEtsyApi(projectName, query, methodFilter = null, showResponseSchema = false) {
    const project = config.projects.find(p => p.name === projectName);
    if (!project) {
      return { content: [{ type: 'text', text: `Projekt nicht gefunden: ${projectName}` }] };
    }

    if (!project.etsy_api_doc) {
      return { content: [{ type: 'text', text: `Keine Etsy API Dokumentation konfiguriert für ${projectName}. Füge "etsy_api_doc" in config.json hinzu.` }] };
    }

    // Spec laden (mit Cache)
    if (!this._etsyApiSpecCache) {
      this._etsyApiSpecCache = {};
    }

    let spec = this._etsyApiSpecCache[projectName];
    if (!spec) {
      try {
        const raw = fs.readFileSync(project.etsy_api_doc, 'utf-8');
        spec = JSON.parse(raw);
        this._etsyApiSpecCache[projectName] = spec;
      } catch (err) {
        return { content: [{ type: 'text', text: `Fehler beim Laden der API-Dokumentation: ${err.message}` }] };
      }
    }

    const queryLower = query.toLowerCase();
    const results = [];

    for (const [pathStr, pathObj] of Object.entries(spec.paths || {})) {
      const httpMethods = ['get', 'post', 'put', 'patch', 'delete'];

      for (const method of httpMethods) {
        const endpoint = pathObj[method];
        if (!endpoint) continue;

        // Method-Filter
        if (methodFilter && method.toUpperCase() !== methodFilter.toUpperCase()) continue;

        // Match gegen path, operationId, description, tags
        const description = this.stripHtml(endpoint.description || '');
        const operationId = endpoint.operationId || '';
        const tags = (endpoint.tags || []).join(' ');

        const searchText = `${pathStr} ${operationId} ${description} ${tags}`.toLowerCase();

        if (!searchText.includes(queryLower)) continue;

        results.push({
          method: method.toUpperCase(),
          path: pathStr,
          operationId,
          description,
          tags: endpoint.tags || [],
          security: endpoint.security || [],
          parameters: endpoint.parameters || [],
          requestBody: endpoint.requestBody || null,
          responses: endpoint.responses || {}
        });

        if (results.length >= 5) break;
      }

      if (results.length >= 5) break;
    }

    if (results.length === 0) {
      return { content: [{ type: 'text', text: `Keine Etsy API Endpunkte gefunden für "${query}"${methodFilter ? ` (${methodFilter})` : ''}` }] };
    }

    let text = `Gefunden: ${results.length} Etsy API Endpunkt${results.length !== 1 ? 'e' : ''}\n\n`;

    for (const ep of results) {
      text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      text += `${ep.method} ${ep.path}\n`;
      text += `operationId: ${ep.operationId}\n`;

      if (ep.tags.length > 0) {
        text += `Tags: ${ep.tags.join(', ')}\n`;
      }

      // OAuth Scopes
      const scopes = [];
      for (const sec of ep.security) {
        if (sec.oauth2) {
          scopes.push(...sec.oauth2);
        }
      }
      if (scopes.length > 0) {
        text += `OAuth Scopes: ${scopes.join(', ')}\n`;
      }

      text += `\n${ep.description}\n`;

      // Parameters
      if (ep.parameters.length > 0) {
        text += `\nParameter:\n`;
        for (const param of ep.parameters) {
          const schema = param.schema || {};
          const required = param.required ? ' *required*' : '';
          const type = schema.type || 'unknown';
          let line = `  • ${param.name} (${param.in}, ${type}${required})`;

          if (schema.enum) {
            line += ` [${schema.enum.join(', ')}]`;
          }
          if (schema.default !== undefined) {
            line += ` default: ${schema.default}`;
          }
          if (schema.minimum !== undefined) {
            line += ` min: ${schema.minimum}`;
          }
          if (schema.maximum !== undefined) {
            line += ` max: ${schema.maximum}`;
          }

          text += line + '\n';

          const paramDesc = this.stripHtml(param.description || schema.description || '');
          if (paramDesc) {
            text += `    ${paramDesc}\n`;
          }
        }
      }

      // Request Body
      if (ep.requestBody) {
        text += `\nRequest Body:\n`;
        const content = ep.requestBody.content || {};
        for (const [contentType, contentObj] of Object.entries(content)) {
          const schema = contentObj.schema || {};
          const requiredFields = schema.required || [];

          if (schema.properties) {
            for (const [propName, propDef] of Object.entries(schema.properties)) {
              const required = requiredFields.includes(propName) ? ' *required*' : '';
              const type = propDef.type || 'unknown';
              let line = `  • ${propName} (${type}${required})`;

              if (propDef.enum) {
                line += ` [${propDef.enum.join(', ')}]`;
              }
              if (propDef.default !== undefined) {
                line += ` default: ${propDef.default}`;
              }

              text += line + '\n';

              const propDesc = this.stripHtml(propDef.description || '');
              if (propDesc) {
                // Kürze lange Beschreibungen
                const truncated = propDesc.length > 150 ? propDesc.substring(0, 150) + '...' : propDesc;
                text += `    ${truncated}\n`;
              }
            }
          }
        }
      }

      // Response Schema
      const successResponse = ep.responses['200'] || ep.responses['201'];
      if (successResponse) {
        const responseContent = successResponse.content?.['application/json'];
        if (responseContent?.schema) {
          const ref = responseContent.schema['$ref'];
          if (ref) {
            const schemaName = ref.split('/').pop();
            text += `\nResponse: ${schemaName}`;

            if (showResponseSchema) {
              const resolved = this.resolveSchemaRef(spec, ref);
              if (resolved?.properties) {
                text += `\n`;
                for (const [propName, propDef] of Object.entries(resolved.properties)) {
                  const type = propDef.type || (propDef['$ref'] ? propDef['$ref'].split('/').pop() : 'object');
                  let line = `  • ${propName} (${type})`;

                  const propDesc = this.stripHtml(propDef.description || '');
                  if (propDesc) {
                    const truncated = propDesc.length > 120 ? propDesc.substring(0, 120) + '...' : propDesc;
                    line += ` - ${truncated}`;
                  }

                  text += line + '\n';
                }
              }
            }
          }
          text += '\n';
        }
      }

      text += '\n';
    }

    if (results.length >= 5) {
      text += `(Ergebnisse auf 5 limitiert - verfeinere die Suche für genauere Treffer)\n`;
    }

    return { content: [{ type: 'text', text }] };
  }

  async refreshCache(projectName) {
    const cleared = [];

    // Clear context cache
    if (this._contextCache) {
      if (projectName === 'all') {
        this._contextCache = {};
        cleared.push('context cache (all projects)');
      } else if (this._contextCache[projectName]) {
        delete this._contextCache[projectName];
        cleared.push(`context cache for "${projectName}"`);
      }
    }

    // Clear Etsy API spec cache
    if (this._etsyApiSpecCache) {
      if (projectName === 'all') {
        this._etsyApiSpecCache = {};
        cleared.push('Etsy API spec cache (all projects)');
      } else if (this._etsyApiSpecCache[projectName]) {
        delete this._etsyApiSpecCache[projectName];
        cleared.push(`Etsy API spec cache for "${projectName}"`);
      }
    }

    const summary = cleared.length > 0
      ? `Cache cleared:\n${cleared.map(c => `  ✓ ${c}`).join('\n')}\n\nAll other data is scanned live on every request.`
      : `Nothing to clear for "${projectName}". All data is already scanned live.`;

    logger.info('refresh_cache', 'Cache cleared', { projectName, cleared });
    return { content: [{ type: 'text', text: summary }] };
  }

  // ============================================================================
  // SERVER STARTEN
  // ============================================================================

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`MCP Project Context Server gestartet`);
    console.error(`Projekte: ${config.projects.map(p => p.name).join(', ')}`);
  }
}

// Server starten
const server = new ProjectContextServer();
server.run().catch(console.error);
