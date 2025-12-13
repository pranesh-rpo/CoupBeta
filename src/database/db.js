import pg from 'pg';
const { Pool } = pg;
import { config } from '../config.js';
import { logError } from '../utils/logger.js';

class Database {
  constructor() {
    this.pool = null;
  }

  async connect() {
    if (this.pool) {
      return this.pool;
    }

    this.pool = new Pool({
      host: config.dbHost,
      port: config.dbPort,
      database: config.dbName,
      user: config.dbUser,
      password: config.dbPassword,
      ssl: config.dbSsl ? { rejectUnauthorized: false } : false,
    });

    // Test connection
    try {
      const client = await this.pool.connect();
      console.log('✅ Database connected successfully');
      client.release();
    } catch (error) {
      logError('❌ Database connection error:', error);
      throw error;
    }

    return this.pool;
  }

  async query(text, params) {
    if (!this.pool) {
      await this.connect();
    }
    
    try {
      return await this.pool.query(text, params);
    } catch (error) {
      // Check if it's a connection error that requires reconnection
      const isConnectionError = 
        error.code === 'ECONNREFUSED' || 
        error.code === 'ETIMEDOUT' ||
        error.code === 'ENOTFOUND' ||
        error.message?.includes('Connection terminated') ||
        error.message?.includes('Connection closed') ||
        error.message?.includes('server closed the connection');
      
      if (isConnectionError) {
        console.log('[DB] Connection lost, attempting reconnect...');
        logError('[DB] Connection error detected:', error);
        
        // Reset pool to force reconnection
        try {
          if (this.pool) {
            await this.pool.end();
          }
        } catch (endError) {
          // Ignore errors when ending pool
        }
        this.pool = null;
        
        // Reconnect
        await this.connect();
        
        // Retry query once
        try {
          return await this.pool.query(text, params);
        } catch (retryError) {
          logError('[DB] Query retry failed after reconnect:', retryError);
          throw retryError;
        }
      }
      
      // For other errors, throw as-is
      throw error;
    }
  }

  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}

export default new Database();
