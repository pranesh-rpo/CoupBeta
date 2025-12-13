/**
 * Bulk Operations Service
 * Handles bulk group management operations
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import groupService from './groupService.js';

class BulkOperationsService {
  /**
   * Bulk activate/deactivate groups
   */
  async bulkToggleGroups(accountId, groupIds, isActive) {
    try {
      if (!Array.isArray(groupIds) || groupIds.length === 0) {
        return { success: false, error: 'Invalid group IDs' };
      }

      const placeholders = groupIds.map((_, i) => `$${i + 2}`).join(',');
      const result = await db.query(
        `UPDATE groups SET is_active = $1 
         WHERE account_id = $2 AND group_id IN (${placeholders})`,
        [isActive, accountId, ...groupIds]
      );

      logger.logChange('BULK', accountId, `Bulk ${isActive ? 'activated' : 'deactivated'} ${result.rowCount} groups`);
      return { success: true, updated: result.rowCount };
    } catch (error) {
      logger.logError('BULK', accountId, error, 'Failed to bulk toggle groups');
      return { success: false, error: error.message };
    }
  }

  /**
   * Bulk assign to category
   */
  async bulkAssignCategory(accountId, groupIds, categoryId) {
    try {
      if (!Array.isArray(groupIds) || groupIds.length === 0) {
        return { success: false, error: 'Invalid group IDs' };
      }

      let assigned = 0;
      for (const groupId of groupIds) {
        try {
          await db.query(
            `INSERT INTO group_category_assignments (account_id, group_id, category_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (account_id, group_id, category_id) DO NOTHING`,
            [accountId, groupId, categoryId]
          );
          assigned++;
        } catch (error) {
          logger.logError('BULK', accountId, error, `Failed to assign group ${groupId}`);
        }
      }

      logger.logChange('BULK', accountId, `Bulk assigned ${assigned} groups to category`);
      return { success: true, assigned };
    } catch (error) {
      logger.logError('BULK', accountId, error, 'Failed to bulk assign category');
      return { success: false, error: error.message };
    }
  }

  /**
   * Bulk add to filter
   */
  async bulkAddToFilter(accountId, groupIds, filterType) {
    try {
      if (!Array.isArray(groupIds) || groupIds.length === 0) {
        return { success: false, error: 'Invalid group IDs' };
      }

      let added = 0;
      for (const groupId of groupIds) {
        try {
          await db.query(
            `INSERT INTO group_filters (account_id, filter_type, group_id, is_active)
             VALUES ($1, $2, $3, TRUE)
             ON CONFLICT DO NOTHING`,
            [accountId, filterType, groupId]
          );
          added++;
        } catch (error) {
          logger.logError('BULK', accountId, error, `Failed to add group ${groupId} to filter`);
        }
      }

      logger.logChange('BULK', accountId, `Bulk added ${added} groups to ${filterType}`);
      return { success: true, added };
    } catch (error) {
      logger.logError('BULK', accountId, error, 'Failed to bulk add to filter');
      return { success: false, error: error.message };
    }
  }
}

export default new BulkOperationsService();
