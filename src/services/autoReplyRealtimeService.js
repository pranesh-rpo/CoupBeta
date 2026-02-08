/**
 * Auto Reply Service — Native Away Message + Fallback Event-Driven
 *
 * DM auto-reply: Uses Telegram's native Away Message API (account.UpdateBusinessAwayMessage).
 *   - Telegram's servers handle replies — no persistent connection needed.
 *   - Account stays truly offline.
 *   - Requires Telegram Premium/Business. Falls back to event-driven if unavailable.
 *
 * Group auto-reply: Uses event-driven handler (Away Messages only work in DMs).
 *   - Persistent connection only when group auto-reply is enabled.
 */

import accountLinker from './accountLinker.js';
import configService from './configService.js';
import autoReplyHandler from './autoReplyHandler.js';
import { Api } from 'telegram/tl/index.js';

class AutoReplyRealtimeService {
  constructor() {
    // Accounts with persistent connection (group auto-reply or DM fallback)
    this.connectedAccounts = new Map(); // accountId -> { client, userId, accountId, mode }

    // Accounts using native away message (no persistent connection)
    this.nativeAwayAccounts = new Set(); // accountId strings

    // Track the message text used for native away (to detect changes)
    this.nativeAwayMessages = new Map(); // accountId -> messageText

    // Offline status loop for fallback accounts only
    this.offlineInterval = null;
    this.OFFLINE_INTERVAL_MIN = 8000;
    this.OFFLINE_INTERVAL_MAX = 12000;

    // Health check for fallback/group accounts
    this.healthCheckInterval = null;
    this.HEALTH_CHECK_INTERVAL = 120000;

    // Periodic refresh
    this.refreshInterval = null;
    this.REFRESH_INTERVAL = 5 * 60 * 1000;
  }

  // ──────────────────────────────────────────────
  // NATIVE AWAY MESSAGE (Telegram Business API)
  // ──────────────────────────────────────────────

  /**
   * Set up native Away Message for DM auto-reply.
   * Connects briefly, creates quick-reply shortcut, sets away message, then disconnects.
   * Returns true if native mode was set up, false if not available (non-premium).
   */
  async setupAwayMessage(accountId, messageText) {
    let client = null;
    try {
      // Skip re-creation if native mode is already active with same message
      const currentSettings = await configService.getAccountSettings(accountId);
      const accountIdStr = accountId.toString();
      if (currentSettings?.autoReplyNativeMode && currentSettings?.autoReplyShortcutId &&
          this.nativeAwayAccounts.has(accountIdStr) &&
          this.nativeAwayMessages.get(accountIdStr) === messageText) {
        // Already set up with native mode and same message — no need to recreate
        return true;
      }

      const db = (await import('../database/db.js')).default;
      const result = await db.query('SELECT user_id FROM accounts WHERE account_id = ?', [accountId]);
      if (!result.rows || result.rows.length === 0) return false;
      const userId = result.rows[0]?.user_id;

      client = await accountLinker.getClientAndConnect(userId, accountId);
      if (!client || !client.connected) {
        console.error(`[AUTO_REPLY] Could not connect account ${accountId} for away message setup`);
        return false;
      }

      // Step 1: Delete existing away shortcut if present
      const settings = currentSettings;
      if (settings?.autoReplyShortcutId) {
        try {
          await client.invoke(new Api.messages.DeleteQuickReplyShortcut({
            shortcutId: settings.autoReplyShortcutId
          }));
          console.log(`[AUTO_REPLY] Deleted old quick reply shortcut ${settings.autoReplyShortcutId}`);
        } catch (e) {
          // Shortcut may not exist anymore
        }
      }

      // Step 2: Create quick reply shortcut with the auto-reply message
      await client.invoke(new Api.messages.SendMessage({
        peer: new Api.InputPeerSelf(),
        message: messageText,
        randomId: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)),
        quickReplyShortcut: new Api.InputQuickReplyShortcut({ shortcut: 'auto_away' })
      }));

      // Step 3: Get the shortcut ID
      const shortcuts = await client.invoke(new Api.messages.GetQuickReplies({
        hash: BigInt(0)
      }));

      const awayShortcut = shortcuts.quickReplies?.find(qr => qr.shortcut === 'auto_away');
      if (!awayShortcut) {
        console.error(`[AUTO_REPLY] Could not find 'auto_away' shortcut after creation`);
        return false;
      }
      const shortcutId = awayShortcut.shortcutId;

      // Step 4: Set the away message via Telegram Business API
      await client.invoke(new Api.account.UpdateBusinessAwayMessage({
        message: new Api.InputBusinessAwayMessage({
          offlineOnly: true,
          shortcutId: shortcutId,
          schedule: new Api.BusinessAwayMessageScheduleAlways(),
          recipients: new Api.InputBusinessRecipients({
            existingChats: true,
            newChats: true,
            contacts: true,
            nonContacts: true,
          })
        })
      }));

      // Step 5: Set offline, remove event handler (ensureConnected auto-registers one), save state
      await this.setOfflineStatus(client, accountId);
      try { autoReplyHandler.removeAutoReply(client); } catch (e) {}
      await configService.setAutoReplyNativeMode(accountId, true, shortcutId);
      this.nativeAwayAccounts.add(accountIdStr);
      this.nativeAwayMessages.set(accountIdStr, messageText);

      console.log(`[AUTO_REPLY] ✅ Native away message set for account ${accountId} (shortcut ${shortcutId})`);
      return true;
    } catch (error) {
      const msg = error.message || '';
      const errorCode = error.code || error.errorCode || 0;
      // These errors indicate the account is not Premium/Business
      if (msg.includes('PREMIUM_ACCOUNT_REQUIRED') || msg.includes('BUSINESS') ||
          msg.includes('USER_NOT_PREMIUM') || msg.includes('QUICK_REPLY') ||
          (errorCode === 400 && !msg.includes('TIMEOUT'))) {
        console.log(`[AUTO_REPLY] Account ${accountId} not Premium/Business — falling back to event-driven mode`);
      } else {
        console.error(`[AUTO_REPLY] Error setting away message for account ${accountId}:`, msg);
      }
      await configService.setAutoReplyNativeMode(accountId, false, null);
      this.nativeAwayMessages.delete(accountId.toString());
      return false;
    }
  }

  /**
   * Clear native Away Message (when disabling DM auto-reply).
   */
  async clearAwayMessage(accountId) {
    let client = null;
    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query('SELECT user_id FROM accounts WHERE account_id = ?', [accountId]);
      if (!result.rows || result.rows.length === 0) return;
      const userId = result.rows[0]?.user_id;

      client = await accountLinker.getClientAndConnect(userId, accountId);
      if (!client || !client.connected) return;

      // Clear the away message
      await client.invoke(new Api.account.UpdateBusinessAwayMessage({}));

      // Delete the shortcut
      const settings = await configService.getAccountSettings(accountId);
      if (settings?.autoReplyShortcutId) {
        try {
          await client.invoke(new Api.messages.DeleteQuickReplyShortcut({
            shortcutId: settings.autoReplyShortcutId
          }));
        } catch (e) {
          // Ignore
        }
      }

      await configService.setAutoReplyNativeMode(accountId, false, null);
      this.nativeAwayAccounts.delete(accountId.toString());
      this.nativeAwayMessages.delete(accountId.toString());

      console.log(`[AUTO_REPLY] ✅ Native away message cleared for account ${accountId}`);
    } catch (error) {
      console.error(`[AUTO_REPLY] Error clearing away message for account ${accountId}:`, error.message);
    }
  }

  // ──────────────────────────────────────────────
  // FALLBACK EVENT-DRIVEN (for non-premium DMs + group replies)
  // ──────────────────────────────────────────────

  async setOfflineStatus(client, accountId) {
    try {
      if (client && client.connected) {
        await client.invoke(new Api.account.UpdateStatus({ offline: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        await client.invoke(new Api.account.UpdateStatus({ offline: true }));
      }
    } catch (error) {
      // Silently ignore
    }
  }

  /**
   * Connect account for event-driven auto-reply (groups, or DM fallback).
   * This keeps a persistent connection — only used when native away message is unavailable.
   */
  async connectAccountFallback(accountId, mode = 'fallback') {
    const accountIdStr = accountId.toString();

    try {
      const settings = await configService.getAccountSettings(accountId);
      if (!settings) {
        await this.disconnectAccount(accountId);
        return false;
      }

      const hasDm = settings.autoReplyDmEnabled && settings.autoReplyDmMessage?.trim().length > 0;
      const hasGroups = settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage?.trim().length > 0;
      if (!hasDm && !hasGroups) {
        await this.disconnectAccount(accountId);
        return false;
      }

      const db = (await import('../database/db.js')).default;
      const result = await db.query('SELECT user_id FROM accounts WHERE account_id = ?', [accountId]);
      if (!result.rows || result.rows.length === 0) return false;
      const userId = result.rows[0]?.user_id;

      const existing = this.connectedAccounts.get(accountIdStr);
      let client = null;

      if (existing?.client?.connected) {
        client = existing.client;
        try { autoReplyHandler.removeAutoReply(client); } catch (e) {}
      } else {
        client = await accountLinker.getClientAndConnect(userId, accountId);
        if (!client || !client.connected) {
          console.error(`[AUTO_REPLY] Could not connect account ${accountId}`);
          return false;
        }
      }

      await this.setOfflineStatus(client, accountId);

      try { autoReplyHandler.removeAutoReply(client); } catch (e) {}
      await new Promise(resolve => setTimeout(resolve, 100));

      await autoReplyHandler.setupAutoReply(client, accountId);

      const handlerExists = await this.verifyHandlerRegistered(client, accountId);
      if (!handlerExists) {
        await new Promise(resolve => setTimeout(resolve, 200));
        await autoReplyHandler.setupAutoReply(client, accountId);
      }

      await this.setOfflineStatus(client, accountId);

      this.connectedAccounts.set(accountIdStr, {
        client, userId, accountId, mode,
        lastHealthCheck: Date.now(),
      });

      console.log(`[AUTO_REPLY] ✅ Account ${accountId} connected (${mode} mode, appears OFFLINE)`);
      return true;
    } catch (error) {
      console.error(`[AUTO_REPLY] Error connecting account ${accountId} (${mode}):`, error.message);
      try { await this.disconnectAccount(accountId); } catch (e) {}
      return false;
    }
  }

  async disconnectAccount(accountId) {
    const accountIdStr = accountId.toString();
    const account = this.connectedAccounts.get(accountIdStr);

    if (account) {
      try { autoReplyHandler.removeAutoReply(account.client); } catch (e) {}
      this.connectedAccounts.delete(accountIdStr);
      console.log(`[AUTO_REPLY] Account ${accountId} disconnected`);
    }
  }

  async verifyHandlerRegistered(client, accountId) {
    try {
      const { NewMessage } = await import('telegram/events/index.js');
      const handlers = client.listEventHandlers(NewMessage);
      return handlers && handlers.length > 0;
    } catch (error) {
      return false;
    }
  }

  // ──────────────────────────────────────────────
  // MAIN ENTRY: setupAccount — decides native vs fallback
  // ──────────────────────────────────────────────

  /**
   * Set up auto-reply for an account. Decides:
   * - DM: try native away message first, fall back to event-driven
   * - Groups: always event-driven (away messages don't work in groups)
   */
  async setupAccount(accountId) {
    const settings = await configService.getAccountSettings(accountId);
    if (!settings) return;

    const hasDm = settings.autoReplyDmEnabled && settings.autoReplyDmMessage?.trim().length > 0;
    const hasGroups = settings.autoReplyGroupsEnabled && settings.autoReplyGroupsMessage?.trim().length > 0;

    if (!hasDm && !hasGroups) {
      // Nothing enabled — clean up
      await this.clearAwayMessage(accountId);
      await this.disconnectAccount(accountId);
      return;
    }

    let dmUsingNative = false;

    // DM auto-reply: try native first
    if (hasDm) {
      dmUsingNative = await this.setupAwayMessage(accountId, settings.autoReplyDmMessage);
    } else {
      // DM disabled — clear away message if it was set
      if (this.nativeAwayAccounts.has(accountId.toString())) {
        await this.clearAwayMessage(accountId);
      }
    }

    // Determine if we need a persistent connection
    const needsPersistentConnection = hasGroups || (hasDm && !dmUsingNative);

    if (needsPersistentConnection) {
      const mode = hasGroups && (hasDm && !dmUsingNative) ? 'groups+dm_fallback'
                 : hasGroups ? 'groups'
                 : 'dm_fallback';
      await this.connectAccountFallback(accountId, mode);
    } else {
      // No persistent connection needed — disconnect if connected
      await this.disconnectAccount(accountId);
    }
  }

  // ──────────────────────────────────────────────
  // SERVICE LIFECYCLE
  // ──────────────────────────────────────────────

  getRandomOfflineInterval() {
    return Math.floor(Math.random() * (this.OFFLINE_INTERVAL_MAX - this.OFFLINE_INTERVAL_MIN + 1)) + this.OFFLINE_INTERVAL_MIN;
  }

  async performHealthCheck() {
    for (const [accountIdStr, account] of this.connectedAccounts.entries()) {
      try {
        const accountId = parseInt(accountIdStr);
        if (!account.client || !account.client.connected) {
          console.log(`[AUTO_REPLY] Health check: account ${accountIdStr} disconnected, reconnecting...`);
          await this.connectAccountFallback(accountId, account.mode || 'fallback');
        } else {
          const handlerExists = await this.verifyHandlerRegistered(account.client, accountId);
          if (!handlerExists) {
            console.log(`[AUTO_REPLY] Health check: handler missing for ${accountIdStr}, re-registering...`);
            await autoReplyHandler.setupAutoReply(account.client, accountId);
            await this.setOfflineStatus(account.client, accountId);
          }
          account.lastHealthCheck = Date.now();
        }
      } catch (error) {
        console.error(`[AUTO_REPLY] Health check error for ${accountIdStr}:`, error.message);
      }
    }
  }

  startHealthCheckLoop() {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    // Only run health check if there are persistent connections
    this.healthCheckInterval = setInterval(async () => {
      if (this.connectedAccounts.size > 0) {
        await this.performHealthCheck();
      }
    }, this.HEALTH_CHECK_INTERVAL);
  }

  startOfflineStatusLoop() {
    if (this.offlineInterval) clearTimeout(this.offlineInterval);

    const scheduleNext = () => {
      const nextInterval = this.getRandomOfflineInterval();
      this.offlineInterval = setTimeout(async () => {
        for (const [accountIdStr, account] of this.connectedAccounts.entries()) {
          try {
            if (account.client?.connected) {
              await this.setOfflineStatus(account.client, account.accountId);
            }
          } catch (e) {
            // Ignore
          }
        }
        scheduleNext();
      }, nextInterval);
    };
    scheduleNext();
  }

  startPeriodicRefreshLoop() {
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = setInterval(async () => {
      try {
        await this.refresh();
      } catch (error) {
        console.error('[AUTO_REPLY] Periodic refresh error:', error.message);
      }
    }, this.REFRESH_INTERVAL);
  }

  async start() {
    console.log('[AUTO_REPLY] Starting auto-reply service (native away message + event-driven fallback)...');

    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query(
        `SELECT account_id FROM accounts
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1)`
      );

      if (result.rows.length === 0) {
        console.log('[AUTO_REPLY] No accounts with auto-reply enabled');
      } else {
        console.log(`[AUTO_REPLY] Setting up ${result.rows.length} account(s)...`);
        for (const row of result.rows) {
          await this.setupAccount(row.account_id);
        }
      }

      // Start maintenance loops (only needed for fallback/group connections)
      this.startOfflineStatusLoop();
      this.startHealthCheckLoop();
      this.startPeriodicRefreshLoop();

    } catch (error) {
      console.error('[AUTO_REPLY] Error starting service:', error.message);
    }

    const nativeCount = this.nativeAwayAccounts.size;
    const fallbackCount = this.connectedAccounts.size;
    console.log(`[AUTO_REPLY] ✅ Service started — ${nativeCount} native away, ${fallbackCount} persistent connections`);
  }

  stop() {
    console.log('[AUTO_REPLY] Stopping service...');

    if (this.offlineInterval) { clearTimeout(this.offlineInterval); this.offlineInterval = null; }
    if (this.healthCheckInterval) { clearInterval(this.healthCheckInterval); this.healthCheckInterval = null; }
    if (this.refreshInterval) { clearInterval(this.refreshInterval); this.refreshInterval = null; }

    for (const [accountIdStr] of this.connectedAccounts.entries()) {
      this.disconnectAccount(parseInt(accountIdStr));
    }
    this.connectedAccounts.clear();
    this.nativeAwayAccounts.clear();
    this.nativeAwayMessages.clear();
    console.log('[AUTO_REPLY] Service stopped');
  }

  /**
   * Refresh — re-evaluate all accounts. Called after settings changes.
   */
  async refresh() {
    try {
      const db = (await import('../database/db.js')).default;
      const result = await db.query(
        `SELECT account_id FROM accounts
         WHERE (auto_reply_dm_enabled = 1 OR auto_reply_groups_enabled = 1)
         AND (auto_reply_dm_message IS NOT NULL AND auto_reply_dm_message != ''
              OR auto_reply_groups_message IS NOT NULL AND auto_reply_groups_message != '')`
      );

      const enabledIds = new Set(result.rows.map(r => r.account_id.toString()));

      // Disconnect accounts that no longer have auto-reply enabled
      for (const [accountIdStr] of this.connectedAccounts.entries()) {
        if (!enabledIds.has(accountIdStr)) {
          await this.disconnectAccount(parseInt(accountIdStr));
        }
      }
      // Clear native away for accounts that no longer need it
      for (const accountIdStr of this.nativeAwayAccounts) {
        if (!enabledIds.has(accountIdStr)) {
          await this.clearAwayMessage(parseInt(accountIdStr));
        }
      }

      // Set up all enabled accounts
      for (const row of result.rows) {
        await this.setupAccount(row.account_id);
      }

      console.log(`[AUTO_REPLY] Refresh complete — ${this.nativeAwayAccounts.size} native, ${this.connectedAccounts.size} persistent`);
      return true;
    } catch (error) {
      console.error('[AUTO_REPLY] Refresh error:', error.message);
      return false;
    }
  }

  // Legacy compatibility
  async startPolling(accountId) { return this.setupAccount(accountId); }
  stopPolling(accountId) { return this.disconnectAccount(accountId); }
  get pollingAccounts() { return this.connectedAccounts; }
  // Alias used by configHandlers
  async connectAccount(accountId) { return this.setupAccount(accountId); }
}

export default new AutoReplyRealtimeService();
