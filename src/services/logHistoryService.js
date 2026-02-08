/**
 * Log History Service
 * Provides searchable logs and history
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import loggingService from './loggingService.js';

class LogHistoryService {
  /**
   * Get logs with filters
   */
  async getLogs(accountId, filters = {}) {
    try {
      let query = `SELECT * FROM logs WHERE account_id = $1`;
      const params = [accountId];
      let paramCount = 1;

      if (filters.logType) {
        paramCount++;
        query += ` AND log_type = $${paramCount}`;
        params.push(filters.logType);
      }

      if (filters.status) {
        paramCount++;
        query += ` AND status = $${paramCount}`;
        params.push(filters.status);
      }

      if (filters.startDate) {
        paramCount++;
        query += ` AND timestamp >= $${paramCount}`;
        params.push(filters.startDate);
      }

      if (filters.endDate) {
        paramCount++;
        query += ` AND timestamp <= $${paramCount}`;
        params.push(filters.endDate);
      }

      if (filters.search) {
        paramCount++;
        query += ` AND message ILIKE $${paramCount}`;
        params.push(`%${filters.search}%`);
      }

      // SECURITY: Use parameterized query for LIMIT to prevent SQL injection
      paramCount++;
      const sanitizedLimit = Math.min(Math.max(1, parseInt(filters.limit) || 100), 1000); // Between 1 and 1000
      query += ` ORDER BY timestamp DESC LIMIT $${paramCount}`;
      params.push(sanitizedLimit);

      const result = await db.query(query, params);
      return { success: true, logs: result.rows };
    } catch (error) {
      logger.logError('LOG_HISTORY', accountId, error, 'Failed to get logs');
      return { success: false, error: error.message, logs: [] };
    }
  }

  /**
   * Search logs
   */
  async searchLogs(accountId, searchTerm, limit = 100) {
    try {
      const result = await db.query(
        `SELECT * FROM logs 
         WHERE account_id = $1 AND message ILIKE $2
         ORDER BY timestamp DESC LIMIT $3`,
        [accountId, `%${searchTerm}%`, limit]
      );
      return { success: true, logs: result.rows };
    } catch (error) {
      logger.logError('LOG_HISTORY', accountId, error, 'Failed to search logs');
      return { success: false, error: error.message, logs: [] };
    }
  }

  /**
   * Export logs to CSV
   */
  async exportLogs(accountId, filters = {}) {
    try {
      const logs = await this.getLogs(accountId, { ...filters, limit: 10000 });
      if (!logs.success) {
        return { success: false, error: logs.error };
      }

      let csv = 'Timestamp,Type,Status,Message\n';
      logs.logs.forEach(log => {
        csv += `${log.timestamp},${log.log_type},${log.status || 'N/A'},"${(log.message || '').replace(/"/g, '""')}"\n`;
      });

      return { success: true, csv };
    } catch (error) {
      logger.logError('LOG_HISTORY', accountId, error, 'Failed to export logs');
      return { success: false, error: error.message };
    }
  }
}

export default new LogHistoryService();
