import db from '../database/db.js';
import { logError } from '../utils/logger.js';

class LoggingService {
  async addLog(accountId, logType, message, status = 'info', userId = null) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const userIdNum = userId ? (typeof userId === 'string' ? parseInt(userId) : userId) : null;
      
      await db.query(
        `INSERT INTO logs (account_id, user_id, log_type, message, status, timestamp)
         VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)`,
        [accountIdNum, userIdNum, logType, message, status]
      );
      
      console.log(`[LOG] [${status.toUpperCase()}] [${logType}] Account ${accountIdNum}: ${message}`);
    } catch (error) {
      logError('[LOG ERROR] Error adding log:', error);
    }
  }

  async getLogs(accountId, limit = 20) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const result = await db.query(
        `SELECT * FROM logs 
         WHERE account_id = $1 
         ORDER BY timestamp DESC 
         LIMIT $2`,
        [accountIdNum, limit]
      );
      return result.rows;
    } catch (error) {
      logError(`[LOG ERROR] Error getting logs for account ${accountId}:`, error);
      return [];
    }
  }

  async getRecentLogs(accountId, hours = 24) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      // SQLite uses datetime() function instead of NOW() and INTERVAL syntax
      const result = await db.query(
        `SELECT * FROM logs 
         WHERE account_id = ? 
         AND timestamp >= datetime('now', '-${hours} hours')
         ORDER BY timestamp DESC`,
        [accountIdNum]
      );
      return result.rows;
    } catch (error) {
      logError(`[LOG ERROR] Error getting recent logs for account ${accountId}:`, error);
      return [];
    }
  }

  async cleanupOldLogs(days = 1) {
    try {
      // SQLite uses datetime() function instead of NOW() and INTERVAL syntax
      const result = await db.query(
        `DELETE FROM logs 
         WHERE timestamp < datetime('now', '-${days} days')`
      );
      
      console.log(`[LOG CLEANUP] Deleted ${result.rowCount} old log entries`);
      return { success: true, deleted: result.rowCount };
    } catch (error) {
      logError('[LOG ERROR] Error cleaning up old logs:', error);
      return { success: false, error: error.message };
    }
  }

  // Convenience methods for different log types
  async logBroadcast(accountId, message, status = 'info') {
    await this.addLog(accountId, 'broadcast', message, status);
  }

  async logError(accountId, message, userId = null) {
    await this.addLog(accountId, 'error', message, 'error', userId);
  }

  async logSuccess(accountId, message, userId = null) {
    await this.addLog(accountId, 'success', message, 'success', userId);
  }

  async logInfo(accountId, message, userId = null) {
    await this.addLog(accountId, 'info', message, 'info', userId);
  }

  async logWarning(accountId, message, userId = null) {
    await this.addLog(accountId, 'warning', message, 'warning', userId);
  }

  async logSettings(accountId, message, userId = null) {
    await this.addLog(accountId, 'settings', message, 'info', userId);
  }

  async logGroups(accountId, message, userId = null) {
    await this.addLog(accountId, 'groups', message, 'info', userId);
  }
}

export default new LoggingService();
