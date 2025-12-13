/**
 * Auto-Leave Service
 * Automatically leaves inactive groups
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import accountLinker from './accountLinker.js';
import groupService from './groupService.js';

class AutoLeaveService {
  /**
   * Check and leave inactive groups
   */
  async checkAndLeaveInactive(accountId, daysInactive = 30) {
    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysInactive);

      const result = await db.query(
        `SELECT group_id, group_title, last_message_sent 
         FROM groups 
         WHERE account_id = $1 
           AND is_active = TRUE
           AND (last_message_sent IS NULL OR last_message_sent < $2)`,
        [accountId, cutoffDate]
      );

      const inactiveGroups = result.rows;
      let leftCount = 0;

      for (const group of inactiveGroups) {
        try {
          const userId = await this.getUserIdFromAccountId(accountId);
          if (!userId) continue;

          const client = await accountLinker.getClient(userId, accountId);
          if (!client) continue;

          await client.invoke(new (await import('telegram/tl/index.js')).Api.channels.LeaveChannel({
            channel: await client.getEntity(group.group_id)
          }));

          // Mark as inactive
          await db.query(
            `UPDATE groups SET is_active = FALSE WHERE account_id = $1 AND group_id = $2`,
            [accountId, group.group_id]
          );

          leftCount++;
          logger.logChange('AUTO_LEAVE', accountId, `Left inactive group: ${group.group_title}`);
        } catch (error) {
          logger.logError('AUTO_LEAVE', accountId, error, `Failed to leave group ${group.group_id}`);
        }
      }

      return { success: true, leftCount, totalInactive: inactiveGroups.length };
    } catch (error) {
      logger.logError('AUTO_LEAVE', accountId, error, 'Failed to check and leave inactive groups');
      return { success: false, error: error.message };
    }
  }

  async getUserIdFromAccountId(accountId) {
    try {
      const result = await db.query(
        'SELECT user_id FROM accounts WHERE account_id = $1',
        [accountId]
      );
      return result.rows[0]?.user_id || null;
    } catch (error) {
      return null;
    }
  }
}

export default new AutoLeaveService();
