import db from '../database/db.js';
import accountLinker from './accountLinker.js';
import { config } from '../config.js';
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
    // Enhanced validation
    if (!accountId || (typeof accountId === 'string' && isNaN(parseInt(accountId))) || (typeof accountId === 'number' && accountId <= 0)) {
      return { success: false, error: 'Invalid account ID' };
    }
    
    const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
    let client = null;
    try {
      // Connect client on-demand
      client = await accountLinker.getClientAndConnect(null, accountIdNum);
      if (!client) {
        return { success: false, error: 'Account or client not found' };
      }
      console.log(`[GROUPS] Connected client for account ${accountIdNum} to refresh groups`);

      // Enhanced error handling for getDialogs
      let dialogs = [];
      try {
        dialogs = await client.getDialogs();
        if (!Array.isArray(dialogs)) {
          console.warn(`[GROUPS] getDialogs returned non-array result, treating as empty`);
          dialogs = [];
        }
      } catch (dialogError) {
        logError(`[GROUPS ERROR] Error fetching dialogs:`, dialogError);
        // Check if it's a session error
        if (dialogError.errorMessage === 'SESSION_REVOKED' || (dialogError.code === 401 && dialogError.message && dialogError.message.includes('SESSION_REVOKED'))) {
          return { success: false, error: 'Session revoked. Please re-link your account.' };
        }
        throw dialogError;
      }
      
      // Helper function to check if dialog is one of the updates channels
      const isUpdatesChannel = async (dialog) => {
        const updatesChannels = config.getUpdatesChannels();
        if (updatesChannels.length === 0) return false;
        
        try {
          const dialogName = (dialog.name || '').toLowerCase();
          const dialogUsername = (dialog.entity?.username || '').toLowerCase();
          
          // Check against all configured updates channels
          for (const channelConfig of updatesChannels) {
            const updatesChannelName = channelConfig.replace('@', '').toLowerCase();
            if (dialogUsername === updatesChannelName || dialogName === updatesChannelName) {
              return true;
            }
            // Check by entity ID
            try {
              const updatesEntity = await client.getEntity(channelConfig);
              if (updatesEntity && dialog.entity && updatesEntity.id && dialog.entity.id) {
                if (updatesEntity.id.toString() === dialog.entity.id.toString()) {
                  return true;
                }
              }
            } catch (e) {
              // Skip ID check if fails
            }
          }
          return false;
        } catch (error) {
          return false;
        }
      };
      
      // Filter out updates channel from groups
      const groups = [];
      for (const dialog of dialogs) {
        if ((dialog.isGroup || dialog.isChannel)) {
          const isUpdates = await isUpdatesChannel(dialog);
          if (!isUpdates) {
            groups.push(dialog);
          } else {
            console.log(`[GROUPS] Excluding updates channel "${dialog.name}" from refresh`);
          }
        }
      }

      let added = 0;
      let updated = 0;

      for (const group of groups) {
        try {
          const groupId = group.entity.id.toString();
          let groupTitle = group.name || 'Unknown';
          
          // Enhanced validation for group data
          if (!groupId || groupId === '0' || groupId === '') {
            console.warn(`[GROUPS] Skipping group with invalid ID: ${groupId}`);
            continue;
          }
          
          if (!groupTitle || groupTitle.trim().length === 0) {
            groupTitle = 'Unknown Group'; // Default name for groups without title
          }
          
          // Truncate group title if too long (database constraint)
          const maxTitleLength = 255;
          if (groupTitle.length > maxTitleLength) {
            groupTitle = groupTitle.substring(0, maxTitleLength - 3) + '...';
          }

          const existing = await db.query(
            'SELECT id FROM groups WHERE account_id = $1 AND group_id = $2',
            [accountIdNum, groupId]
          );

          if (existing.rows.length > 0) {
            // Update existing group
            await db.query(
              'UPDATE groups SET group_title = $1, is_active = TRUE WHERE account_id = $2 AND group_id = $3',
              [groupTitle, accountIdNum, groupId]
            );
            updated++;
          } else {
            // Add new group
            await db.query(
              `INSERT INTO groups (account_id, group_id, group_title, is_active, last_message_sent)
               VALUES ($1, $2, $3, TRUE, NULL)`,
              [accountIdNum, groupId, groupTitle]
            );
            added++;
          }
        } catch (error) {
          logError(`[GROUPS ERROR] Error saving group ${group.name}:`, error);
        }
      }

      console.log(`[GROUPS] Refreshed groups for account ${accountIdNum}: ${added} added, ${updated} updated, total: ${groups.length}`);
      
      return { success: true, added, updated, total: groups.length };
    } catch (error) {
      logError(`[GROUPS ERROR] Error refreshing groups for account ${accountIdNum}:`, error);
      
      // Enhanced error messages
      let errorMessage = error.message || 'Unknown error';
      if (error.errorMessage === 'SESSION_REVOKED' || (error.code === 401 && error.message && error.message.includes('SESSION_REVOKED'))) {
        errorMessage = 'Session revoked. Please re-link your account.';
      } else if (error.message && error.message.includes('timeout')) {
        errorMessage = 'Request timed out. Please try again.';
      } else if (error.message && error.message.includes('network')) {
        errorMessage = 'Network error. Please check your connection and try again.';
      }
      
      return { success: false, error: errorMessage };
    }
    // NOTE: Client is NOT disconnected here - connection management is handled by
    // autoReplyConnectionManager and accountLinker. Disconnecting here would break
    // auto-reply and other services that depend on persistent connections.
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

  /**
   * Collect group invite links for all groups (returns links, doesn't store)
   * @param {Object} client - Telegram client instance
   * @param {number} accountId - Account ID
   * @param {Array} groups - Array of group dialogs
   * @param {boolean} silent - If true, suppress console logs (default: false)
   * @returns {Promise<Array>} Array of unique group links
   */
  async collectGroupLinks(client, accountId, groups, silent = false) {
    if (!client || !groups || groups.length === 0) {
      return [];
    }

    const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
    const links = new Set(); // Use Set to automatically handle duplicates
    let collected = 0;
    let skipped = 0;

    for (const group of groups) {
      try {
        const groupId = group.entity.id.toString();
        const groupTitle = group.name || 'Unknown';
        let inviteLink = null;

        // First, try username-based link (simplest and most reliable)
        if (group.entity.username) {
          inviteLink = `https://t.me/${group.entity.username}`;
        } else {
          // For groups without username, try to get/create invite link
          try {
            // Try to export a new invite link
            const exportedInvite = await client.invoke(
              new Api.messages.ExportChatInvite({
                peer: group.entity,
                legacyRevokePermanent: false
              })
            );

            if (exportedInvite && exportedInvite.link) {
              inviteLink = exportedInvite.link;
            }
          } catch (exportError) {
            // If export fails, try to get existing invite links
            try {
              const me = await client.getMe();
              const chatInvites = await client.invoke(
                new Api.messages.GetExportedChatInvites({
                  peer: group.entity,
                  adminId: me,
                  limit: 1
                })
              );

              if (chatInvites && chatInvites.invites && chatInvites.invites.length > 0) {
                inviteLink = chatInvites.invites[0].link;
              }
            } catch (getInvitesError) {
              // If we can't get invites, skip this group silently
              skipped++;
              continue;
            }
          }
        }

        // Add the link if we found one (Set automatically handles duplicates)
        if (inviteLink) {
          links.add(inviteLink);
          collected++;
        } else {
          skipped++;
        }
      } catch (error) {
        // Silently skip errors for individual groups
        skipped++;
      }
    }

    if (!silent) {
      console.log(`[GROUP LINKS] Collected ${collected} links from ${groups.length} groups for account ${accountIdNum} (${skipped} skipped)`);
    }
    return Array.from(links); // Return as array
  }

}

export default new GroupService();
