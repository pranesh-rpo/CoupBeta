/**
 * Auto Reply Connection Manager
 * Uses smart polling instead of persistent connection to avoid keeping account online
 * Provides near real-time auto-reply (1-2 second delay) without showing as "online"
 */

import configService from './configService.js';
import autoReplyPollingService from './autoReplyPollingService.js';
import { logError } from '../utils/logger.js';

class AutoReplyConnectionManager {
  constructor() {
    this.connectedAccounts = new Set(); // accountId -> true (for tracking)
  }

  /**
   * Start polling for account (connects briefly, checks, disconnects)
   * This avoids keeping account online while still providing near real-time auto-reply
   */
  async keepAccountConnected(accountId) {
    try {
      const settings = await configService.getAccountSettings(accountId);
      if (!settings) return;

      const hasAutoReply = (settings.autoReplyDmEnabled && settings.autoReplyDmMessage) ||
                          (settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage);

      if (!hasAutoReply) {
        // Auto-reply not enabled - stop polling
        this.disconnectAccount(accountId);
        return;
      }

      // Start polling (connects briefly every 2 seconds, then disconnects)
      await autoReplyPollingService.startPolling(accountId);
      this.connectedAccounts.add(accountId.toString());
      console.log(`[AUTO_REPLY_CONN] ✅ Started polling for account ${accountId} (near real-time, no persistent connection)`);
    } catch (error) {
      logError(`[AUTO_REPLY_CONN] Error starting polling for account ${accountId}:`, error);
    }
  }

  /**
   * Stop polling for account if no longer needed for auto-reply
   */
  async disconnectAccount(accountId) {
    const accountIdStr = accountId.toString();
    if (!this.connectedAccounts.has(accountIdStr)) return;

    try {
      autoReplyPollingService.stopPolling(accountId);
      this.connectedAccounts.delete(accountIdStr);
      console.log(`[AUTO_REPLY_CONN] Stopped polling for account ${accountId}`);
    } catch (error) {
      logError(`[AUTO_REPLY_CONN] Error stopping polling for account ${accountId}:`, error);
    }
  }

  /**
   * Check all accounts and keep them connected if needed
   */
  async checkAllAccounts() {
    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query(
        `SELECT account_id FROM accounts 
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1)`
      );

      console.log(`[AUTO_REPLY_CONN] Found ${result.rows.length} accounts with auto-reply enabled`);
      
      for (const row of result.rows) {
        console.log(`[AUTO_REPLY_CONN] Checking account ${row.account_id}...`);
        await this.keepAccountConnected(row.account_id);
      }

      // Check connected accounts and reconnect if disconnected
      for (const accountIdStr of this.connectedAccounts) {
        const accountId = parseInt(accountIdStr);
        const settings = await configService.getAccountSettings(accountId);
        if (!settings) {
          this.connectedAccounts.delete(accountIdStr);
          continue;
        }

        const hasAutoReply = (settings.autoReplyDmEnabled && settings.autoReplyDmMessage) ||
                            (settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage);

        if (!hasAutoReply) {
          await this.disconnectAccount(accountId);
          continue;
        }

        // Polling will automatically retry on next interval if connection fails
        // No need to manually reconnect
      }
    } catch (error) {
      logError('[AUTO_REPLY_CONN] Error checking all accounts:', error);
    }
  }

  /**
   * Start connection manager (uses smart polling - connects briefly, checks, disconnects)
   */
  start() {
    // Check immediately on startup to set up initial polling
    console.log('[AUTO_REPLY_CONN] Starting smart polling for all accounts with auto-reply...');
    this.checkAllAccounts().catch(error => {
      logError('[AUTO_REPLY_CONN] Error in initial checkAllAccounts:', error);
    });

    console.log('[AUTO_REPLY_CONN] Started connection manager (smart polling mode - no persistent connection)');
  }

  /**
   * Stop connection manager
   */
  stop() {
    autoReplyPollingService.stopAll();
    this.connectedAccounts.clear();
    console.log('[AUTO_REPLY_CONN] Stopped connection manager');
  }

  /**
   * Manually trigger connection check (for when settings change)
   * This is event-driven - only called when needed
   */
  async refreshConnections() {
    console.log('[AUTO_REPLY_CONN] Manually refreshing connections...');
    await this.checkAllAccounts();
  }
}

export default new AutoReplyConnectionManager();

