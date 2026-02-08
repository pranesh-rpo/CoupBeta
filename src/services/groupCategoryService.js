/**
 * Group Category Service
 * Manages group categories and assignments
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class GroupCategoryService {
  /**
   * Create a new category
   */
  async createCategory(accountId, categoryName, color = null) {
    try {
      const result = await db.query(
        `INSERT INTO group_categories (account_id, category_name, color)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id, category_name) DO UPDATE SET color = EXCLUDED.color
         RETURNING *`,
        [accountId, categoryName, color]
      );
      logger.logChange('CATEGORY', accountId, `Created category: ${categoryName}`);
      return { success: true, category: result.rows[0] };
    } catch (error) {
      logger.logError('CATEGORY', accountId, error, 'Failed to create category');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all categories for account
   */
  async getCategories(accountId) {
    try {
      const result = await db.query(
        `SELECT * FROM group_categories WHERE account_id = $1 ORDER BY created_at DESC`,
        [accountId]
      );
      return { success: true, categories: result.rows };
    } catch (error) {
      logger.logError('CATEGORY', accountId, error, 'Failed to get categories');
      return { success: false, error: error.message, categories: [] };
    }
  }

  /**
   * Assign group to category
   */
  async assignGroupToCategory(accountId, groupId, categoryId) {
    try {
      await db.query(
        `INSERT INTO group_category_assignments (account_id, group_id, category_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id, group_id, category_id) DO NOTHING`,
        [accountId, groupId, categoryId]
      );
      logger.logChange('CATEGORY', accountId, `Assigned group ${groupId} to category ${categoryId}`);
      return { success: true };
    } catch (error) {
      logger.logError('CATEGORY', accountId, error, 'Failed to assign group to category');
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove group from category
   */
  async removeGroupFromCategory(accountId, groupId, categoryId) {
    try {
      await db.query(
        `DELETE FROM group_category_assignments 
         WHERE account_id = $1 AND group_id = $2 AND category_id = $3`,
        [accountId, groupId, categoryId]
      );
      logger.logChange('CATEGORY', accountId, `Removed group ${groupId} from category ${categoryId}`);
      return { success: true };
    } catch (error) {
      logger.logError('CATEGORY', accountId, error, 'Failed to remove group from category');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get groups in category
   */
  async getGroupsInCategory(accountId, categoryId) {
    try {
      const result = await db.query(
        `SELECT g.*, gc.category_name 
         FROM groups g
         INNER JOIN group_category_assignments gca ON g.account_id = gca.account_id AND g.group_id = gca.group_id
         INNER JOIN group_categories gc ON gca.category_id = gc.id
         WHERE g.account_id = $1 AND gca.category_id = $2 AND g.is_active = TRUE`,
        [accountId, categoryId]
      );
      return { success: true, groups: result.rows };
    } catch (error) {
      logger.logError('CATEGORY', accountId, error, 'Failed to get groups in category');
      return { success: false, error: error.message, groups: [] };
    }
  }

  /**
   * Delete category
   */
  async deleteCategory(accountId, categoryId) {
    try {
      await db.query(
        `DELETE FROM group_categories WHERE id = $1 AND account_id = $2`,
        [categoryId, accountId]
      );
      logger.logChange('CATEGORY', accountId, `Deleted category ${categoryId}`);
      return { success: true };
    } catch (error) {
      logger.logError('CATEGORY', accountId, error, 'Failed to delete category');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get categories for a group
   */
  async getGroupCategories(accountId, groupId) {
    try {
      const result = await db.query(
        `SELECT gc.* FROM group_categories gc
         INNER JOIN group_category_assignments gca ON gc.id = gca.category_id
         WHERE gca.account_id = $1 AND gca.group_id = $2`,
        [accountId, groupId]
      );
      return { success: true, categories: result.rows };
    } catch (error) {
      logger.logError('CATEGORY', accountId, error, 'Failed to get group categories');
      return { success: false, error: error.message, categories: [] };
    }
  }
}

export default new GroupCategoryService();
