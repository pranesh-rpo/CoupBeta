/**
 * Audit Log Service
 * Tracks all user actions for audit purposes
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class AuditLogService {
  /**
   * Log an action
   */
  async logAction(userId, accountId, action, resourceType = null, resourceId = null, details = {}, ipAddress = null, userAgent = null) {
    try {
      await db.query(
        `INSERT INTO audit_logs (user_id, account_id, action, resource_type, resource_id, details, ip_address, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [userId, accountId, action, resourceType, resourceId, JSON.stringify(details), ipAddress, userAgent]
      );
      return { success: true };
    } catch (error) {
      logger.logError('AUDIT', accountId, error, 'Failed to log action');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get audit logs
   */
  async getLogs(accountId = null, userId = null, limit = 100) {
    try {
      let query = `SELECT * FROM audit_logs WHERE 1=1`;
      const params = [];
      let paramCount = 0;
      
      if (accountId) {
        paramCount++;
        query += ` AND account_id = $${paramCount}`;
        params.push(accountId);
      }
      
      if (userId) {
        paramCount++;
        query += ` AND user_id = $${paramCount}`;
        params.push(userId);
      }
      
      query += ` ORDER BY created_at DESC LIMIT $${paramCount + 1}`;
      params.push(limit);
      
      const result = await db.query(query, params);
      const logs = result.rows.map(row => ({
        ...row,
        details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details
      }));
      return { success: true, logs };
    } catch (error) {
      logger.logError('AUDIT', accountId, error, 'Failed to get audit logs');
      return { success: false, error: error.message, logs: [] };
    }
  }

  /**
   * Search audit logs
   */
  async searchLogs(accountId, searchTerm, limit = 100) {
    try {
      const result = await db.query(
        `SELECT * FROM audit_logs 
         WHERE account_id = $1 AND (action ILIKE $2 OR resource_type ILIKE $2)
         ORDER BY created_at DESC LIMIT $3`,
        [accountId, `%${searchTerm}%`, limit]
      );
      const logs = result.rows.map(row => ({
        ...row,
        details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details
      }));
      return { success: true, logs };
    } catch (error) {
      logger.logError('AUDIT', accountId, error, 'Failed to search audit logs');
      return { success: false, error: error.message, logs: [] };
    }
  }
}

export default new AuditLogService();
