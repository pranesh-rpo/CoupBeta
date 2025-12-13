/**
 * Group Filter Service
 * Handles whitelist/blacklist filtering for groups
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class GroupFilterService {
  /**
   * Add group to whitelist
   */
  async addToWhitelist(accountId, groupId, groupName = null) {
    try {
      await db.query(
        `INSERT INTO group_filters (account_id, filter_type, group_id, group_name_pattern, is_active)
         VALUES ($1, 'whitelist', $2, $3, TRUE)
         ON CONFLICT DO NOTHING`,
        [accountId, groupId, groupName]
      );
      logger.logChange('FILTER', accountId, `Added group ${groupId} to whitelist`);
      return { success: true };
    } catch (error) {
      logger.logError('FILTER', accountId, error, 'Failed to add to whitelist');
      return { success: false, error: error.message };
    }
  }

  /**
   * Add group to blacklist
   */
  async addToBlacklist(accountId, groupId, groupName = null) {
    try {
      await db.query(
        `INSERT INTO group_filters (account_id, filter_type, group_id, group_name_pattern, is_active)
         VALUES ($1, 'blacklist', $2, $3, TRUE)
         ON CONFLICT DO NOTHING`,
        [accountId, groupId, groupName]
      );
      logger.logChange('FILTER', accountId, `Added group ${groupId} to blacklist`);
      return { success: true };
    } catch (error) {
      logger.logError('FILTER', accountId, error, 'Failed to add to blacklist');
      return { success: false, error: error.message };
    }
  }

  /**
   * Add pattern to whitelist/blacklist
   */
  async addPattern(accountId, filterType, pattern) {
    try {
      if (!['whitelist', 'blacklist'].includes(filterType)) {
        return { success: false, error: 'Invalid filter type' };
      }
      await db.query(
        `INSERT INTO group_filters (account_id, filter_type, group_name_pattern, is_active)
         VALUES ($1, $2, $3, TRUE)`,
        [accountId, filterType, pattern]
      );
      logger.logChange('FILTER', accountId, `Added pattern "${pattern}" to ${filterType}`);
      return { success: true };
    } catch (error) {
      logger.logError('FILTER', accountId, error, 'Failed to add pattern');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all filters for account
   */
  async getFilters(accountId) {
    try {
      const result = await db.query(
        `SELECT * FROM group_filters WHERE account_id = $1 AND is_active = TRUE ORDER BY created_at DESC`,
        [accountId]
      );
      return { success: true, filters: result.rows };
    } catch (error) {
      logger.logError('FILTER', accountId, error, 'Failed to get filters');
      return { success: false, error: error.message, filters: [] };
    }
  }

  /**
   * Remove filter
   */
  async removeFilter(accountId, filterId) {
    try {
      await db.query(
        `UPDATE group_filters SET is_active = FALSE WHERE id = $1 AND account_id = $2`,
        [filterId, accountId]
      );
      logger.logChange('FILTER', accountId, `Removed filter ${filterId}`);
      return { success: true };
    } catch (error) {
      logger.logError('FILTER', accountId, error, 'Failed to remove filter');
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if group should be filtered
   */
  async shouldFilterGroup(accountId, groupId, groupName) {
    try {
      const filters = await this.getFilters(accountId);
      if (!filters.success) return { shouldFilter: false };

      const activeFilters = filters.filters;
      
      // Check blacklist first
      const blacklisted = activeFilters.some(f => 
        f.filter_type === 'blacklist' && 
        (f.group_id === groupId || (f.group_name_pattern && groupName && groupName.includes(f.group_name_pattern)))
      );
      
      if (blacklisted) {
        return { shouldFilter: true, reason: 'blacklisted' };
      }

      // Check whitelist (if whitelist exists, only whitelisted groups are allowed)
      const hasWhitelist = activeFilters.some(f => f.filter_type === 'whitelist');
      if (hasWhitelist) {
        const whitelisted = activeFilters.some(f => 
          f.filter_type === 'whitelist' && 
          (f.group_id === groupId || (f.group_name_pattern && groupName && groupName.includes(f.group_name_pattern)))
        );
        return { shouldFilter: !whitelisted, reason: whitelisted ? null : 'not_whitelisted' };
      }

      return { shouldFilter: false };
    } catch (error) {
      logger.logError('FILTER', accountId, error, 'Failed to check filter');
      return { shouldFilter: false };
    }
  }

  /**
   * Filter groups list
   */
  async filterGroups(accountId, groups) {
    try {
      const filteredGroups = [];
      for (const group of groups) {
        const filterCheck = await this.shouldFilterGroup(
          accountId, 
          group.entity?.id || group.id, 
          group.name || group.title
        );
        if (!filterCheck.shouldFilter) {
          filteredGroups.push(group);
        }
      }
      return filteredGroups;
    } catch (error) {
      logger.logError('FILTER', accountId, error, 'Failed to filter groups');
      return groups; // Return all groups on error
    }
  }
}

export default new GroupFilterService();
