/**
 * User Role Service
 * Manages user roles and permissions
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class UserRoleService {
  /**
   * Set user role
   */
  async setRole(userId, role, permissions = {}) {
    try {
      if (!['admin', 'moderator', 'user'].includes(role)) {
        return { success: false, error: 'Invalid role' };
      }
      
      const result = await db.query(
        `INSERT INTO user_roles (user_id, role, permissions)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE
         SET role = EXCLUDED.role, permissions = EXCLUDED.permissions, updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, role, JSON.stringify(permissions)]
      );
      
      logger.logChange('ROLE', null, `Set role ${role} for user ${userId}`);
      return { success: true, userRole: result.rows[0] };
    } catch (error) {
      logger.logError('ROLE', null, error, 'Failed to set role');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get user role
   */
  async getRole(userId) {
    try {
      const result = await db.query(
        `SELECT * FROM user_roles WHERE user_id = $1`,
        [userId]
      );
      
      if (result.rows.length === 0) {
        return { success: true, role: 'user', permissions: {} };
      }
      
      const userRole = result.rows[0];
      userRole.permissions = typeof userRole.permissions === 'string' 
        ? JSON.parse(userRole.permissions) 
        : userRole.permissions;
      
      return { success: true, ...userRole };
    } catch (error) {
      logger.logError('ROLE', null, error, 'Failed to get role');
      return { success: false, error: error.message, role: 'user' };
    }
  }

  /**
   * Check if user has permission
   */
  async hasPermission(userId, permission) {
    try {
      const roleData = await this.getRole(userId);
      if (!roleData.success) return false;
      
      // Admins have all permissions
      if (roleData.role === 'admin') return true;
      
      // Check specific permission
      return roleData.permissions && roleData.permissions[permission] === true;
    } catch (error) {
      logger.logError('ROLE', null, error, 'Failed to check permission');
      return false;
    }
  }

  /**
   * Check if user is admin
   */
  async isAdmin(userId) {
    try {
      const roleData = await this.getRole(userId);
      return roleData.success && roleData.role === 'admin';
    } catch (error) {
      return false;
    }
  }
}

export default new UserRoleService();
