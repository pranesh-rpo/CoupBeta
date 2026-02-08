import Database from 'better-sqlite3';
import { config } from '../config.js';
import { logError } from '../utils/logger.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DatabaseWrapper {
  constructor() {
    this.db = null;
  }

  connect() {
    if (this.db) {
      return this.db;
    }

    try {
      // Use database path from config or default to ./data/bot.db
      const dbPath = config.dbPath || path.join(__dirname, '../../data/bot.db');
      
      // Ensure directory exists
      const dbDir = path.dirname(dbPath);
      if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
      }

      this.db = new Database(dbPath);
      
      // Enable foreign keys
      this.db.pragma('foreign_keys = ON');
      
      // Enable WAL mode for better concurrency
      this.db.pragma('journal_mode = WAL');
      
      console.log('✅ SQLite database connected successfully');
      return this.db;
    } catch (error) {
      logError('❌ Database connection error:', error);
      throw error;
    }
  }

  // Helper function to convert PostgreSQL placeholders ($1, $2, etc.) to SQLite placeholders (?)
  convertPlaceholders(sql) {
    // Replace $1, $2, etc. with ?
    // This handles both $1 and $N patterns
    return sql.replace(/\$(\d+)/g, '?');
  }

  // Helper to sanitize parameters for SQLite (convert booleans to integers, handle undefined)
  sanitizeParams(params) {
    if (!params || !Array.isArray(params)) {
      return [];
    }
    return params.map(param => {
      // Convert booleans to integers (0/1) for SQLite
      if (typeof param === 'boolean') {
        return param ? 1 : 0;
      }
      // Convert undefined to null
      if (param === undefined) {
        return null;
      }
      return param;
    });
  }

  async query(text, params = []) {
    if (!this.db) {
      this.connect();
    }
    
    try {
      // Convert PostgreSQL-style $1, $2, etc. to SQLite ? placeholders
      let convertedSql = this.convertPlaceholders(text);
      
      // Convert ILIKE to SQLite-compatible syntax (SQLite doesn't support ILIKE)
      // ILIKE is case-insensitive LIKE - convert to UPPER() comparison
      // Pattern: column ILIKE pattern -> UPPER(column) LIKE UPPER(pattern)
      // Handle both ? and $N placeholders (before and after placeholder conversion)
      convertedSql = convertedSql.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?)\s+ILIKE\s+(\?|\$\d+)/gi, (match, column, placeholder) => {
        // For SQLite, use UPPER() on both sides for case-insensitive comparison
        return `UPPER(${column}) LIKE UPPER(${placeholder})`;
      });
      
      // Handle RETURNING clause (SQLite doesn't support RETURNING, use lastInsertRowid instead)
      const hasReturning = /RETURNING\s+\w+/i.test(convertedSql);
      let returningColumn = null;
      if (hasReturning) {
        // Extract the column name from RETURNING clause
        const returningMatch = convertedSql.match(/RETURNING\s+(\w+)/i);
        returningColumn = returningMatch ? returningMatch[1] : 'id';
        
        // Remove RETURNING clause for SQLite
        convertedSql = convertedSql.replace(/\s+RETURNING\s+\w+/i, '');
      }
      
      const stmt = this.db.prepare(convertedSql);
      const sanitizedParams = this.sanitizeParams(params);
      
      // Handle different query types
      const upperText = convertedSql.trim().toUpperCase();
      
      // Handle PRAGMA statements (they return data like SELECT)
      if (upperText.startsWith('PRAGMA')) {
        if (sanitizedParams && sanitizedParams.length > 0) {
          const result = stmt.all(sanitizedParams);
          return { rows: result, rowCount: result.length };
        } else {
          const result = stmt.all();
          return { rows: result, rowCount: result.length };
        }
      } else if (upperText.startsWith('SELECT') || upperText.startsWith('WITH')) {
        if (sanitizedParams && sanitizedParams.length > 0) {
          const result = stmt.all(sanitizedParams);
          return { rows: result, rowCount: result.length };
        } else {
          const result = stmt.all();
          return { rows: result, rowCount: result.length };
        }
      } else if (upperText.startsWith('INSERT') || upperText.startsWith('UPDATE') || upperText.startsWith('DELETE')) {
        if (sanitizedParams && sanitizedParams.length > 0) {
          const result = stmt.run(sanitizedParams);
          
          // If INSERT had RETURNING clause, query back to get the row
          if (hasReturning && upperText.startsWith('INSERT') && result.lastInsertRowid) {
            const tableMatch = convertedSql.match(/INSERT\s+INTO\s+(\w+)/i);
            if (tableMatch) {
              const tableName = tableMatch[1];
              try {
                // Use rowid to fetch the inserted row - this is the most reliable way in SQLite
                // lastInsertRowid always corresponds to the rowid of the last insert
                const selectStmt = this.db.prepare(`SELECT * FROM ${tableName} WHERE rowid = ?`);
                const row = selectStmt.get(result.lastInsertRowid);
                return {
                  rows: row ? [row] : [],
                  rowCount: result.changes,
                  insertId: result.lastInsertRowid
                };
              } catch (selectError) {
                // If select fails, just return insertId
                return {
                  rows: [{ id: result.lastInsertRowid }],
                  rowCount: result.changes,
                  insertId: result.lastInsertRowid
                };
              }
            }
          }
          
          return { 
            rows: [], 
            rowCount: result.changes,
            insertId: result.lastInsertRowid 
          };
        } else {
          const result = stmt.run();
          
          // If INSERT had RETURNING clause, query back to get the row
          if (hasReturning && upperText.startsWith('INSERT') && result.lastInsertRowid) {
            const tableMatch = convertedSql.match(/INSERT\s+INTO\s+(\w+)/i);
            if (tableMatch) {
              const tableName = tableMatch[1];
              try {
                // Use rowid to fetch the inserted row
                const selectStmt = this.db.prepare(`SELECT * FROM ${tableName} WHERE rowid = ?`);
                const row = selectStmt.get(result.lastInsertRowid);
                return {
                  rows: row ? [row] : [],
                  rowCount: result.changes,
                  insertId: result.lastInsertRowid
                };
              } catch (selectError) {
                // If select fails, just return insertId
                return {
                  rows: [{ id: result.lastInsertRowid }],
                  rowCount: result.changes,
                  insertId: result.lastInsertRowid
                };
              }
            }
          }
          
          return { 
            rows: [], 
            rowCount: result.changes,
            insertId: result.lastInsertRowid 
          };
        }
      } else {
        // For other queries (CREATE, ALTER, etc.)
        if (sanitizedParams && sanitizedParams.length > 0) {
          stmt.run(sanitizedParams);
        } else {
          stmt.run();
        }
        return { rows: [], rowCount: 0 };
      }
    } catch (error) {
      // Don't log duplicate column errors - these are expected during schema migrations
      // SQLite error messages can vary: "duplicate column", "duplicate column name", "duplicate column: column_name"
      const errorMessage = (error?.message || '').toLowerCase();
      const isDuplicateColumnError = 
        errorMessage.includes('duplicate column') ||
        errorMessage.includes('duplicate column name') ||
        errorMessage.includes('duplicate column:') ||
        errorMessage.includes('sqlite_error') && errorMessage.includes('duplicate');
      
      if (!isDuplicateColumnError) {
        logError('[DB] Query error:', error);
      }
      throw error;
    }
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

export default new DatabaseWrapper();
