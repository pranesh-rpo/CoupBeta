import db from '../database/db.js';
import accountLinker from './accountLinker.js';
import { Api } from 'telegram/tl/index.js';
import { logError } from '../utils/logger.js';

class GroupService {
  async getGroups(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const result = await db.query(
        'SELECT * FROM groups WHERE account_id = $1 AND is_active = TRUE ORDER BY group_title',
        [accountIdNum]
      );
      return result.rows;
    } catch (error) {
      logError(`[GROUPS ERROR] Error getting groups for account ${accountId}:`, error);
      return [];
    }
  }

  async getActiveGroupsCount(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const result = await db.query(
        'SELECT COUNT(*) as count FROM groups WHERE account_id = $1 AND is_active = TRUE',
        [accountIdNum]
      );
      return parseInt(result.rows[0].count) || 0;
    } catch (error) {
      logError(`[GROUPS ERROR] Error getting active groups count for account ${accountId}:`, error);
      return 0;
    }
  }

  async refreshGroups(accountId) {
    let client = null;
    try {
      // Connect client on-demand
      client = await accountLinker.getClientAndConnect(null, accountId);
      if (!client) {
        return { success: false, error: 'Account or client not found' };
      }
      console.log(`[GROUPS] Connected client for account ${accountId} to refresh groups`);

      const dialogs = await client.getDialogs();
      const groups = dialogs.filter(
        (dialog) => dialog.isGroup || dialog.isChannel
      );

      let added = 0;
      let updated = 0;

      for (const group of groups) {
        try {
          const groupId = group.entity.id.toString();
          const groupTitle = group.name || 'Unknown';

          const existing = await db.query(
            'SELECT id FROM groups WHERE account_id = $1 AND group_id = $2',
            [accountId, groupId]
          );

          if (existing.rows.length > 0) {
            // Update existing group
            await db.query(
              'UPDATE groups SET group_title = $1, is_active = TRUE WHERE account_id = $2 AND group_id = $3',
              [groupTitle, accountId, groupId]
            );
            updated++;
          } else {
            // Add new group
            await db.query(
              `INSERT INTO groups (account_id, group_id, group_title, is_active, last_message_sent)
               VALUES ($1, $2, $3, TRUE, NULL)`,
              [accountId, groupId, groupTitle]
            );
            added++;
          }
        } catch (error) {
          logError(`[GROUPS ERROR] Error saving group ${group.name}:`, error);
        }
      }

      console.log(`[GROUPS] Refreshed groups for account ${accountId}: ${added} added, ${updated} updated, total: ${groups.length}`);
      return { success: true, added, updated, total: groups.length };
    } catch (error) {
      logError(`[GROUPS ERROR] Error refreshing groups for account ${accountId}:`, error);
      return { success: false, error: error.message };
    } finally {
      // Disconnect client after refreshing groups
      if (client && client.connected) {
        try {
          await client.disconnect();
          console.log(`[GROUPS] Disconnected client for account ${accountId} after refreshing groups`);
        } catch (disconnectError) {
          logError(`[GROUPS ERROR] Error disconnecting client:`, disconnectError);
        }
      }
    }
  }

  async markGroupInactive(accountId, groupId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const groupIdNum = typeof groupId === 'string' ? parseInt(groupId) : groupId;
      
      await db.query(
        'UPDATE groups SET is_active = FALSE WHERE account_id = $1 AND group_id = $2',
        [accountIdNum, groupIdNum]
      );
      
      console.log(`[GROUPS] Marked group ${groupIdNum} as inactive for account ${accountIdNum}`);
      return { success: true };
    } catch (error) {
      logError(`[GROUPS ERROR] Error marking group inactive:`, error);
      return { success: false, error: error.message };
    }
  }

  async updateGroupLastMessage(accountId, groupId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const groupIdNum = typeof groupId === 'string' ? parseInt(groupId) : groupId;
      
      await db.query(
        'UPDATE groups SET last_message_sent = CURRENT_TIMESTAMP WHERE account_id = $1 AND group_id = $2',
        [accountIdNum, groupIdNum]
      );
    } catch (error) {
      logError(`[GROUPS ERROR] Error updating last message time:`, error);
    }
  }

}

export default new GroupService();
