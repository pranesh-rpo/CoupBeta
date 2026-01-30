/**
 * Group Blacklist Service
 * Manages group blacklist functionality
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class GroupBlacklistService {
  /**
   * Search groups by keyword
   */
  async searchGroups(accountId, keyword) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const keywordLower = keyword.toLowerCase();
      
      const result = await db.query(
        `SELECT id, group_id, group_title 
         FROM groups 
         WHERE account_id = $1 
           AND is_active = TRUE 
           AND LOWER(group_title) LIKE $2
         ORDER BY group_title
         LIMIT 20`,
        [accountIdNum, `%${keywordLower}%`]
      );
      
      return { success: true, groups: result.rows };
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to search groups');
      return { success: false, error: error.message, groups: [] };
    }
  }

  /**
   * Add group to blacklist
   */
  async addToBlacklist(accountId, groupId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const groupIdNum = typeof groupId === 'string' ? parseInt(groupId) : groupId;
      
      // Get group title
      const groupResult = await db.query(
        'SELECT group_title FROM groups WHERE account_id = $1 AND group_id = $2',
        [accountIdNum, groupIdNum]
      );
      
      if (groupResult.rows.length === 0) {
        return { success: false, error: 'Group not found' };
      }
      
      const groupTitle = groupResult.rows[0].group_title;
      
      // Check if already blacklisted
      const existing = await db.query(
        'SELECT id FROM group_filters WHERE account_id = $1 AND group_id = $2 AND filter_type = $3',
        [accountIdNum, groupIdNum, 'blacklist']
      );
      
      if (existing.rows.length > 0) {
        return { success: false, error: 'Group already blacklisted' };
      }
      
      // Add to blacklist
      await db.query(
        `INSERT INTO group_filters (account_id, filter_type, group_id, is_active)
         VALUES ($1, 'blacklist', $2, 1)`,
        [accountIdNum, groupIdNum]
      );
      
      logger.logChange('BLACKLIST', accountId, `Added group "${groupTitle}" to blacklist`);
      return { success: true, groupTitle };
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to add to blacklist');
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove group from blacklist
   */
  async removeFromBlacklist(accountId, groupId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const groupIdNum = typeof groupId === 'string' ? parseInt(groupId) : groupId;
      
      await db.query(
        `UPDATE group_filters 
         SET is_active = 0 
         WHERE account_id = $1 AND group_id = $2 AND filter_type = 'blacklist'`,
        [accountIdNum, groupIdNum]
      );
      
      logger.logChange('BLACKLIST', accountId, `Removed group from blacklist`);
      return { success: true };
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to remove from blacklist');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all blacklisted groups
   */
  async getBlacklistedGroups(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      
      const result = await db.query(
        `SELECT gf.group_id, g.group_title
         FROM group_filters gf
         LEFT JOIN groups g ON gf.account_id = g.account_id AND gf.group_id = g.group_id
         WHERE gf.account_id = $1 
           AND gf.filter_type = 'blacklist' 
           AND gf.is_active = 1
         ORDER BY g.group_title`,
        [accountIdNum]
      );
      
      return { success: true, groups: result.rows };
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to get blacklisted groups');
      return { success: false, error: error.message, groups: [] };
    }
  }

  /**
   * Check if group is blacklisted
   */
  async isBlacklisted(accountId, groupId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const groupIdNum = typeof groupId === 'string' ? parseInt(groupId) : groupId;
      
      const result = await db.query(
        `SELECT 1 FROM group_filters 
         WHERE account_id = $1 
           AND group_id = $2 
           AND filter_type = 'blacklist' 
           AND is_active = 1`,
        [accountIdNum, groupIdNum]
      );
      
      return result.rows.length > 0;
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to check blacklist');
      return false;
    }
  }
}

export default new GroupBlacklistService();

