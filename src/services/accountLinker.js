import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import QRCode from 'qrcode';
import { config } from '../config.js';
import db from '../database/db.js';
import logger, { colors, logError } from '../utils/logger.js';
import adminNotifier from './adminNotifier.js';
import { isFloodWaitError, extractWaitTime } from '../utils/floodWaitHandler.js';
import premiumService from './premiumService.js';
import autoReplyHandler from './autoReplyHandler.js';

// Profile tag constants - now loaded from config
const NAME_TAG = config.lastNameTag;
const BIO_TAG = config.bioTag;

/**
 * Setup error handlers for TelegramClient to prevent crashes from MTProto errors
 * @param {TelegramClient} client - The Telegram client instance
 * @param {number} accountId - Account ID for logging (optional)
 */
function setupClientErrorHandlers(client, accountId = null) {
  if (!client) return;
  
  // Add error event handler
  client.on('error', (error) => {
    // Filter out common non-critical errors
    const errorMsg = error?.message || error?.toString() || '';
    const errorStack = error?.stack || '';
    
    // Skip timeout errors (normal)
    if (errorMsg === 'TIMEOUT' || errorMsg.includes('TIMEOUT')) {
      return;
    }
    
    // Skip BinaryReader errors that are recoverable (common MTProto issue)
    if (errorMsg.includes('readUInt32LE') || 
        errorMsg.includes('BinaryReader') || 
        errorMsg.includes('Cannot read properties of undefined') ||
        errorStack.includes('BinaryReader')) {
      const accountInfo = accountId ? `account ${accountId}` : 'client';
      console.log(`[CLIENT ERROR] MTProto BinaryReader error (recoverable) for ${accountInfo}: ${errorMsg.substring(0, 100)}`);
      // Don't log as critical - these are often recoverable and don't affect functionality
      return;
    }
    
    // Skip builder.resolve errors (common MTProto update handler issue)
    if (errorMsg.includes('builder.resolve is not a function') ||
        errorMsg.includes('builder.resolve') ||
        errorStack.includes('_dispatchUpdate') ||
        errorStack.includes('_processUpdate')) {
      const accountInfo = accountId ? `account ${accountId}` : 'client';
      console.log(`[CLIENT ERROR] MTProto update handler error (recoverable) for ${accountInfo}: ${errorMsg.substring(0, 100)}`);
      return; // These are recoverable update processing errors
    }
    
    // Log other errors
    const accountInfo = accountId ? `account ${accountId}` : 'client';
    logError(`[CLIENT ERROR] Telegram client error for ${accountInfo}:`, error);
  });
  
  // Suppress timeout and BinaryReader errors from emit
  const originalEmit = client.emit?.bind(client);
  if (originalEmit) {
    client.emit = function(event, ...args) {
      // Filter out timeout errors from update loop
      if (event === 'error' && args[0]) {
        const errorMsg = args[0].message || args[0].toString() || '';
        const errorStack = args[0].stack || '';
        
        // Skip timeout errors (normal)
        if (errorMsg === 'TIMEOUT' || errorMsg.includes('TIMEOUT')) {
          return false;
        }
        
        // Skip BinaryReader errors (recoverable MTProto errors)
        if (errorMsg.includes('readUInt32LE') || 
            errorMsg.includes('BinaryReader') || 
            errorMsg.includes('Cannot read properties of undefined') ||
            errorStack.includes('BinaryReader')) {
          const accountInfo = accountId ? `account ${accountId}` : 'client';
          console.log(`[CLIENT ERROR] Suppressed recoverable MTProto error for ${accountInfo}: ${errorMsg.substring(0, 100)}`);
          return false; // Don't emit - these are recoverable
        }
        
        // Skip builder.resolve errors (common MTProto update handler issue)
        if (errorMsg.includes('builder.resolve is not a function') ||
            errorMsg.includes('builder.resolve') ||
            errorStack.includes('_dispatchUpdate') ||
            errorStack.includes('_processUpdate')) {
          const accountInfo = accountId ? `account ${accountId}` : 'client';
          console.log(`[CLIENT ERROR] Suppressed MTProto update handler error for ${accountInfo}: ${errorMsg.substring(0, 100)}`);
          return false; // Don't emit - these are recoverable
        }
      }
      
      return originalEmit(event, ...args);
    };
  }
  
  // Note: We don't add a silent update handler here because it can interfere
  // with the client's internal update processing and cause "builder.resolve is not a function" errors.
  // The error handlers above should be sufficient to catch and suppress errors.
}

class AccountLinker {
  constructor() {
    this.linkedAccounts = new Map(); // accountId -> { userId, phone, sessionString, client, isActive }
    this.userAccounts = new Map(); // userId -> Set of accountIds
    this.pendingVerifications = new Map(); // userId -> { phone, phoneCodeHash, client }
    this.pendingPasswordAuth = new Map(); // userId -> { phone, client }
    this.pendingWebLogins = new Map(); // userId -> { client, token, expiresAt }
    this.passwordAttempts = new Map(); // userId -> { attempts: number, cooldownUntil: timestamp }
    this.rateLimitCooldowns = new Map(); // userId -> { cooldownUntil: timestamp, waitSeconds: number }
    // Keep-alive removed - clients connect on-demand
    this.initialized = false;
    
    // OPTIMIZATION: Connection locks to prevent race conditions when multiple calls
    // try to connect the same account simultaneously
    this.connectionLocks = new Map(); // accountId -> Promise (lock)
  }

  async initialize() {
    if (!this.initialized) {
      await this.loadLinkedAccounts();
      this.initialized = true;
    }
  }

  /**
   * Cleanup old pending verifications to prevent memory leaks
   * Removes verifications older than 30 minutes
   */
  cleanupPendingVerifications() {
    const now = Date.now();
    const maxAge = 30 * 60 * 1000; // 30 minutes
    let cleanedCount = 0;
    
    for (const [userId, verification] of this.pendingVerifications.entries()) {
      let shouldRemove = false;
      
      // Check if verification is old using timestamp
      if (verification.createdAt && (now - verification.createdAt) > maxAge) {
        shouldRemove = true;
      } else if (verification.client) {
        // Check if client exists and is disconnected
        try {
          if (!verification.client.connected) {
            shouldRemove = true;
          }
        } catch (e) {
          // Client might be invalid, remove it
          shouldRemove = true;
        }
      } else if (!verification.createdAt) {
        // No timestamp and no client, might be stale
        shouldRemove = true;
      }
      
      if (shouldRemove) {
        // Disconnect client if it exists
        if (verification.client) {
          try {
            verification.client.disconnect().catch(() => {});
          } catch (e) {}
        }
        this.pendingVerifications.delete(userId);
        cleanedCount++;
      }
    }
    
    // Cleanup pending password auth similarly
    for (const [userId, auth] of this.pendingPasswordAuth.entries()) {
      let shouldRemove = false;
      
      if (auth.createdAt && (now - auth.createdAt) > maxAge) {
        shouldRemove = true;
      } else if (auth.client) {
        try {
          if (!auth.client.connected) {
            shouldRemove = true;
          }
        } catch (e) {
          shouldRemove = true;
        }
      } else if (!auth.createdAt) {
        shouldRemove = true;
      }
      
      if (shouldRemove) {
        if (auth.client) {
          try {
            auth.client.disconnect().catch(() => {});
          } catch (e) {}
        }
        this.pendingPasswordAuth.delete(userId);
        cleanedCount++;
      }
    }
    
    if (cleanedCount > 0) {
      console.log(`[CLEANUP] Cleaned up ${cleanedCount} old pending verification(s)`);
    }
    
    // Log memory stats
    const memUsage = process.memoryUsage();
    const memUsageMB = Math.round(memUsage.rss / 1024 / 1024);
    console.log(`[MEMORY] Account linker - Linked accounts: ${this.linkedAccounts.size}, Pending verifications: ${this.pendingVerifications.size}, Pending password auth: ${this.pendingPasswordAuth.size}, RSS: ${memUsageMB}MB`);
  }

  /**
   * Update last used timestamp for an account (for connection management)
   * @param {number} accountId - Account ID
   */
  updateLastUsed(accountId) {
    const accountIdStr = accountId.toString();
    const account = this.linkedAccounts.get(accountIdStr);
    if (account) {
      account.lastUsed = Date.now();
    }
  }

  // Ensure client is connected (reconnect if disconnected)
  // OPTIMIZED: Uses connection lock to prevent race conditions
  async ensureConnected(accountId) {
    const accountIdStr = accountId.toString();
    const account = this.linkedAccounts.get(accountIdStr);
    
    if (!account || !account.client) {
      throw new Error(`Account ${accountId} not found`);
    }
    
    // CRITICAL: Prevent main account from being connected
    if (config.mainAccountPhone && account.phone === config.mainAccountPhone.trim()) {
      throw new Error(`Cannot connect main account (${account.phone}). This account is used to create the bot and APIs.`);
    }
    
    // If already connected, return immediately (fast path)
    if (account.client.connected) {
      // Update last used timestamp
      this.updateLastUsed(accountId);
      
      // Setup auto-reply handler if not already set up
      // This ensures handler is active whenever client is connected
      await autoReplyHandler.setupAutoReply(account.client, accountId);
      
      return account.client;
    }
    
    // OPTIMIZATION: Check if there's already a connection attempt in progress
    // This prevents multiple simultaneous connection attempts for the same account
    const existingLock = this.connectionLocks.get(accountIdStr);
    if (existingLock) {
      console.log(`[CONNECTION] Waiting for existing connection attempt for account ${accountId}...`);
      return existingLock;
    }
    
    // Create a new connection promise and store it as a lock
    const connectionPromise = this._performConnection(accountId, account);
    this.connectionLocks.set(accountIdStr, connectionPromise);
    
    try {
      const result = await connectionPromise;
      return result;
    } finally {
      // Always clean up the lock when done
      this.connectionLocks.delete(accountIdStr);
    }
  }
  
  // Internal method to perform the actual connection with retries
  async _performConnection(accountId, account) {
    const accountIdStr = accountId.toString();
    
    console.log(`[CONNECTION] Connecting client for account ${accountId}...`);
    let retries = 2; // Reduced from 3 to 2 to prevent excessive retries
    let lastError = null;
    
    while (retries > 0) {
      try {
        await account.client.connect();
        console.log(`[CONNECTION] Connected client for account ${accountId}`);
        // Setup auto-reply handler when client connects
        autoReplyHandler.setupAutoReply(account.client, accountId);
        // Update last used timestamp
        this.updateLastUsed(accountId);
        return account.client;
      } catch (error) {
        lastError = error;
        retries--;
        
        const errorCode = error.code || error.errorCode;
        const errorMessage = error.message || error.toString() || '';
        
        // Check for session errors (AUTH_KEY_DUPLICATED, SESSION_REVOKED, etc.)
        const isSessionError = 
          errorCode === 406 || // AUTH_KEY_DUPLICATED
          errorCode === 401 || // SESSION_REVOKED
          errorMessage.includes('AUTH_KEY_DUPLICATED') ||
          errorMessage.includes('SESSION_REVOKED') ||
          errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
          error.errorMessage === 'AUTH_KEY_DUPLICATED' ||
          error.errorMessage === 'SESSION_REVOKED' ||
          error.errorMessage === 'AUTH_KEY_UNREGISTERED';
        
        if (isSessionError) {
          console.log(`[CONNECTION] Session error (${errorCode}) for account ${accountId} - handling revocation`);
          await this.handleSessionRevoked(accountId).catch(err => {
            console.log(`[CONNECTION] Error handling session revocation: ${err.message}`);
          });
          throw error; // Don't retry on session errors
        }
        
        // For other errors, wait before retry (exponential backoff with longer delays)
        if (retries > 0) {
          const waitTime = (3 - retries) * 3000; // 3s, 6s (increased delays)
          console.log(`[CONNECTION] Retry ${2 - retries}/2 in ${waitTime}ms for account ${accountId}...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }
    
    // All retries failed
    logError(`[CONNECTION ERROR] Failed to connect account ${accountId} after 2 attempts:`, lastError);
    throw lastError;
  }

  /**
   * Clean up all account-related data when account is deleted
   * This ensures all related data is properly removed
   */
  async cleanupAccountData(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      
      // Stop any running broadcasts
      const automationService = (await import('./automationService.js')).default;
      const accountQuery = await db.query(
        'SELECT user_id FROM accounts WHERE account_id = $1',
        [accountIdNum]
      );
      
      if (accountQuery.rows.length > 0) {
        const userId = accountQuery.rows[0]?.user_id;
        if (automationService.isBroadcasting(userId, accountIdNum)) {
          await automationService.stopBroadcast(userId, accountIdNum);
          console.log(`[CLEANUP] Stopped broadcast for account ${accountId} during cleanup`);
        }
      }
      
      // Stop auto-reply services
      try {
        const autoReplyPollingService = (await import('./autoReplyPollingService.js')).default;
        autoReplyPollingService.stopPolling(accountIdNum);
      } catch (e) {
        // Ignore if service not initialized
      }
      
      try {
        const autoReplyIntervalService = (await import('./autoReplyIntervalService.js')).default;
        autoReplyIntervalService.stopIntervalCheck(accountIdNum);
      } catch (e) {
        // Ignore if service not initialized
      }
      
      // Disconnect client if still connected
      const accountIdStr = accountIdNum.toString();
      const account = this.linkedAccounts.get(accountIdStr);
      if (account && account.client) {
        try {
          if (account.client.connected) {
            await account.client.disconnect();
            console.log(`[CLEANUP] Disconnected client for account ${accountId}`);
          }
        } catch (e) {
          // Ignore disconnect errors
        }
      }
      
      // Remove from memory
      this.linkedAccounts.delete(accountIdStr);
      
      // Remove from user accounts tracking
      if (account) {
        const userIdStr = account.userId.toString();
        const userAccountIds = this.userAccounts.get(userIdStr);
        if (userAccountIds) {
          userAccountIds.delete(accountIdStr);
          if (userAccountIds.size === 0) {
            this.userAccounts.delete(userIdStr);
          }
        }
      }
      
      console.log(`[CLEANUP] Cleaned up account ${accountId} data`);
    } catch (error) {
      logError(`[CLEANUP ERROR] Error cleaning up account ${accountId}:`, error);
    }
  }

  /**
   * Clean up all user data when user deletes their Telegram account
   * This removes all accounts and related data for the user
   */
  async cleanupUserData(userId) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      const userIdStr = userIdNum.toString();
      
      console.log(`[CLEANUP] Starting cleanup for user ${userId}`);
      
      // Get all accounts for this user
      const accountsQuery = await db.query(
        'SELECT account_id FROM accounts WHERE user_id = $1',
        [userIdNum]
      );
      
      // Clean up each account
      for (const row of accountsQuery.rows) {
        const accountId = row.account_id;
        await this.cleanupAccountData(accountId);
      }
      
      // Delete all accounts (CASCADE will handle related data)
      await db.query('DELETE FROM accounts WHERE user_id = $1', [userIdNum]);
      
      // Delete user record (CASCADE will handle user_roles, premium_subscriptions, etc.)
      await db.query('DELETE FROM users WHERE user_id = $1', [userIdNum]);
      
      // Clean up pending verifications
      await db.query('DELETE FROM pending_verifications WHERE user_id = $1', [userIdNum]);
      
      // Remove from memory
      this.userAccounts.delete(userIdStr);
      
      console.log(`[CLEANUP] Cleaned up all data for user ${userId}`);
      logger.logChange('USER_DELETED', userId, `User ${userId} deleted their Telegram account - all data cleaned up`);
      
      // Notify admins
      adminNotifier.notifyEvent('USER_DELETED', `User ${userId} deleted their Telegram account`, {
        userId,
        details: 'All user data and accounts have been cleaned up.',
      }).catch(() => {});
      
      return { success: true };
    } catch (error) {
      logError(`[CLEANUP ERROR] Error cleaning up user ${userId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if error indicates user deleted their Telegram account
   */
  isUserDeletedError(error) {
    if (!error) return false;
    
    const errorMessage = error.message || error.toString() || '';
    const errorCode = error.code || error.errorCode || error.response?.error_code;
    const errorMsg = error.errorMessage || '';
    
    return (
      errorMsg === 'USER_DEACTIVATED' ||
      errorMessage.includes('USER_DEACTIVATED') ||
      errorMessage.includes('user deactivated') ||
      errorMessage.includes('user is deactivated') ||
      (errorCode === 401 && errorMessage.includes('USER_DEACTIVATED'))
    );
  }

  async handleSessionRevoked(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const accountIdStr = accountId.toString();
      const account = this.linkedAccounts.get(accountIdStr);
      
      // Get account info from database
      let accountInfo = null;
      let userId = null;
      try {
        const accountQuery = await db.query(
          'SELECT account_id, user_id, phone FROM accounts WHERE account_id = $1',
          [accountIdNum]
        );
        if (accountQuery.rows.length > 0) {
          accountInfo = accountQuery.rows[0];
          userId = accountInfo.user_id;
        }
      } catch (error) {
        logError(`[ACCOUNT ERROR] Error fetching account info:`, error);
      }
      
      // PROTECT MAIN ACCOUNT: Never mark main account for re-authentication
      // The main account is the one used to create the bot and APIs
      const phone = accountInfo?.phone || account?.phone || '';
      if (config.mainAccountPhone && phone === config.mainAccountPhone.trim()) {
        console.log(`[ACCOUNT PROTECTION] ⚠️  Main account (${phone}) session revoked - but account is PROTECTED. Not marking for re-auth.`);
        logError(`[ACCOUNT PROTECTION] Main account session revoked but protected from re-auth requirement`, new Error('Main account session revoked'));
        
        // Notify admins of critical issue
        adminNotifier.notifyEvent('MAIN_ACCOUNT_SESSION_REVOKED', `⚠️ CRITICAL: Main account session revoked`, {
          userId,
          accountId,
          phone,
          details: 'Main account (used to create bot/APIs) session was revoked. This is critical - the account needs manual attention.',
        }).catch(() => {});
        
        // Still remove from memory but don't mark session as null
        if (account) {
          try {
            if (account.client && account.client.connected) {
              await account.client.disconnect();
            }
          } catch (error) {
            logError(`[ACCOUNT ERROR] Error disconnecting client:`, error);
          }
          this.linkedAccounts.delete(accountIdStr);
          
          const userIdStr = account.userId.toString();
          const userAccountIds = this.userAccounts.get(userIdStr);
          if (userAccountIds) {
            userAccountIds.delete(accountIdStr);
            if (userAccountIds.size === 0) {
              this.userAccounts.delete(userIdStr);
            }
          }
        }
        
        return { success: true, action: 'protected_main_account', message: 'Main account is protected from session revocation handling' };
      }
      
      // Clean up account data (stop broadcasts, disconnect, remove from memory)
      await this.cleanupAccountData(accountIdNum);
      
      // Instead of deleting the account, mark session as revoked and inactive
      // Use empty string instead of NULL to avoid NOT NULL constraint violation
      // This prevents accounts from being deleted unnecessarily
      const updateResult = await db.query(
        'UPDATE accounts SET session_string = ?, is_active = 0, is_broadcasting = 0 WHERE account_id = ?',
        ['', accountIdNum]
      );
      
      if (updateResult.rowCount > 0) {
        const phone = accountInfo?.phone || account?.phone || 'unknown';
        const userId = accountInfo?.user_id || account?.userId || null;
        console.log(`[ACCOUNT] Session revoked - Marked account ${accountId} (${phone}) for re-authentication. Account preserved.`);
        logger.logChange('SESSION_REVOKED', userId, `Account ${accountId} (${phone}) session revoked - needs re-authentication`);
        
        // Notify admins of session revocation
        adminNotifier.notifyEvent('SESSION_REVOKED', `Account ${accountId} session revoked - needs re-authentication`, {
          userId,
          accountId,
          phone,
          details: 'Session was revoked. Account preserved - user can re-authenticate.',
        }).catch(() => {}); // Silently fail to avoid blocking
        
        return { success: true, action: 'marked_for_reauth' };
      } else {
        console.log(`[ACCOUNT] Account ${accountId} not found in database (may have been already deleted)`);
        return { success: false, error: 'Account not found in database' };
      }
    } catch (error) {
      logError(`[ACCOUNT ERROR] Error handling revoked session for account ${accountId}:`, error);
      logger.logError('SESSION_REVOKED', null, error, `Failed to handle session revocation for account ${accountId}`);
      return { success: false, error: error.message };
    }
  }

  async loadLinkedAccounts() {
    try {
      const result = await db.query('SELECT account_id, user_id, phone, session_string, first_name, is_active FROM accounts ORDER BY account_id');
      
      // First, ensure only one account per user is active in database
      const userActiveAccounts = new Map(); // userId -> accountId
      for (const row of result.rows) {
        const userIdStr = row.user_id.toString();
        if (row.is_active) {
          if (!userActiveAccounts.has(userIdStr)) {
            userActiveAccounts.set(userIdStr, row.account_id);
          } else {
            // Multiple active accounts found - deactivate this one
            await db.query(
              'UPDATE accounts SET is_active = 0 WHERE account_id = ?',
              [row.account_id]
            );
            console.log(`[ACCOUNT] Fixed: Deactivated duplicate active account ${row.account_id} for user ${userIdStr}`);
          }
        }
      }
      
      // For users with no active account, set the first account as active
      const usersWithAccounts = new Map(); // userId -> first accountId
      for (const row of result.rows) {
        const userIdStr = row.user_id.toString();
        if (!usersWithAccounts.has(userIdStr)) {
          usersWithAccounts.set(userIdStr, row.account_id);
        }
      }
      
      for (const [userIdStr, firstAccountId] of usersWithAccounts.entries()) {
        if (!userActiveAccounts.has(userIdStr)) {
          // No active account for this user, activate the first one
          await db.query(
            'UPDATE accounts SET is_active = 1 WHERE account_id = ?',
            [firstAccountId]
          );
          userActiveAccounts.set(userIdStr, firstAccountId);
          console.log(`[ACCOUNT] Fixed: Activated first account ${firstAccountId} for user ${userIdStr} (no active account found)`);
        }
      }
      
      // Load accounts into memory and create clients immediately (pure connection)
      console.log('[ACCOUNT] Loading accounts into memory and connecting clients...');
      
      let connectedCount = 0;
      let skippedCount = 0;
      
      for (const row of result.rows) {
        try {
          // Skip if session string is null (revoked session)
          if (!row.session_string) {
            console.log(`[ACCOUNT] Skipping account ${row.account_id} - session revoked (needs re-authentication)`);
            skippedCount++;
            continue;
          }
          
          const accountId = row.account_id.toString();
          const userIdStr = row.user_id.toString();
          const isActive = userActiveAccounts.get(userIdStr) === row.account_id;
          
          // CRITICAL: Skip main account entirely - it should not be verified or used
          if (config.mainAccountPhone && row.phone === config.mainAccountPhone.trim()) {
            console.log(`[ACCOUNT PROTECTION] ⚠️  Skipping main account ${row.account_id} (${row.phone}) - should not be verified or used for broadcasting`);
            
            this.linkedAccounts.set(accountId, {
              accountId: row.account_id,
              userId: row.user_id,
              phone: row.phone,
              firstName: row.first_name || null,
              sessionString: row.session_string,
              client: null, // No client for main account
              isActive: isActive,
              isMainAccount: true, // Mark as main account
            });
            
            // Track accounts per user
            if (!this.userAccounts.has(userIdStr)) {
              this.userAccounts.set(userIdStr, new Set());
            }
            this.userAccounts.get(userIdStr).add(accountId);
            
            console.log(`[ACCOUNT] Loaded main account ${accountId} (PROTECTED - not verified)`);
            skippedCount++;
            continue; // Skip verification entirely
          }
          
          // Create client immediately (pure connection - no lazy loading)
          const stringSession = new StringSession(row.session_string);
          const accountClient = new TelegramClient(stringSession, config.apiId, config.apiHash, {
            connectionRetries: 3,
            timeout: 10000,
            retryDelay: 5000,
            autoReconnect: false, // CRITICAL: Disable autoReconnect to prevent excessive reconnections
            useWSS: false,
          });
          
          // Setup error handlers to prevent crashes from MTProto errors
          setupClientErrorHandlers(accountClient, row.account_id);
          
          // Connect client immediately
          try {
            await accountClient.connect();
            console.log(`[ACCOUNT] Connected account ${accountId} (${row.phone})`);
            connectedCount++;
            
            // Setup auto-reply handler when client connects
            await autoReplyHandler.setupAutoReply(accountClient, row.account_id);
          } catch (connectError) {
            const errorCode = connectError.code || connectError.errorCode;
            const errorMessage = connectError.message || connectError.toString() || '';
            
            // Check for session errors (AUTH_KEY_DUPLICATED, SESSION_REVOKED, etc.)
            const isSessionError = 
              errorCode === 406 || // AUTH_KEY_DUPLICATED
              errorCode === 401 || // SESSION_REVOKED
              errorMessage.includes('AUTH_KEY_DUPLICATED') ||
              errorMessage.includes('SESSION_REVOKED') ||
              errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
              connectError.errorMessage === 'AUTH_KEY_DUPLICATED' ||
              connectError.errorMessage === 'SESSION_REVOKED';
            
            if (isSessionError) {
              console.log(`[ACCOUNT] Session error (${errorCode}) for account ${accountId} - marking for re-authentication`);
              // CRITICAL: Dispose of client before skipping to prevent memory leaks
              try {
                if (accountClient && typeof accountClient.disconnect === 'function') {
                  await accountClient.disconnect().catch(() => {});
                }
              } catch (disposeError) {
                // Ignore disposal errors
              }
              // Handle session revocation/duplication - mark account for re-auth
              await this.handleSessionRevoked(row.account_id).catch(err => {
                console.log(`[ACCOUNT] Error handling session revocation: ${err.message}`);
              });
              skippedCount++;
              continue; // Skip storing this account
            }
            
            console.log(`[ACCOUNT] Failed to connect account ${accountId} (${row.phone}): ${connectError.message}`);
            // Still store the client for other errors, but mark it as not connected
            // It will be retried when ensureConnected() is called
            logError(`[ACCOUNT] Connection failed for account ${accountId}:`, connectError);
          }
          
          // Store account info with client (pure connection)
          this.linkedAccounts.set(accountId, {
            accountId: row.account_id,
            userId: row.user_id,
            phone: row.phone,
            firstName: row.first_name || null,
            sessionString: row.session_string,
            client: accountClient, // Client created and connected immediately
            isActive: isActive,
            isMainAccount: false,
            createdAt: Date.now(),
            lastUsed: Date.now(),
          });
          
          // Track accounts per user
          if (!this.userAccounts.has(userIdStr)) {
            this.userAccounts.set(userIdStr, new Set());
          }
          this.userAccounts.get(userIdStr).add(accountId);
          
        } catch (error) {
          console.log(`[ACCOUNT] Error loading account ${row.account_id}: ${error.message}`);
          logError(`[ACCOUNT] Error loading account ${row.account_id}:`, error);
          skippedCount++;
          continue;
        }
      }
      
      console.log(`[ACCOUNT] ✅ Loaded ${this.linkedAccounts.size} accounts (${connectedCount} connected, ${skippedCount} skipped)`);
    } catch (error) {
      logError('[ACCOUNT ERROR] Error loading accounts from database:', error);
    }
  }

  async saveLinkedAccount(userId, phone, sessionString, client = null, firstName = null) {
    try {
      // Enhanced validation
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      if (!userIdNum || isNaN(userIdNum) || userIdNum <= 0) {
        throw new Error('Invalid user ID');
      }
      
      if (!phone || typeof phone !== 'string' || phone.trim().length === 0) {
        throw new Error('Invalid phone number');
      }
      
      if (!sessionString || typeof sessionString !== 'string' || sessionString.trim().length === 0) {
        console.error(`[ACCOUNT ERROR] Invalid session string provided: type=${typeof sessionString}, value=${sessionString?.substring(0, 50) || 'null/undefined'}`);
        throw new Error('Invalid session string');
      }
      
      // Normalize phone number (remove spaces, ensure + prefix)
      const normalizedPhone = phone.trim().replace(/\s+/g, '');
      if (!normalizedPhone.startsWith('+')) {
        throw new Error('Phone number must include country code with + prefix');
      }
      
      // Validate session string format (basic check)
      if (sessionString.length < 10) {
        console.error(`[ACCOUNT ERROR] Session string too short: length=${sessionString.length}`);
        throw new Error('Session string appears to be invalid (too short)');
      }
      
      // CRITICAL: Store sessionString in a const to prevent accidental overwriting
      const validSessionString = sessionString.trim();
      console.log(`[ACCOUNT] Saving account for user ${userIdNum}, phone: ${normalizedPhone}, sessionString length: ${validSessionString.length}`);
      
      // Check if this phone number is already linked to a different user
      // This prevents session conflicts where multiple users try to use the same account
      const phoneCheck = await db.query(
        'SELECT account_id, user_id, is_active, is_broadcasting FROM accounts WHERE phone = $1',
        [normalizedPhone]
      );
      
      if (phoneCheck.rows.length > 0) {
        const existingPhoneAccount = phoneCheck.rows[0];
        if (existingPhoneAccount.user_id !== userIdNum) {
          // Phone number belongs to a different user - this will cause session conflicts
          console.log(`[ACCOUNT WARNING] Phone ${normalizedPhone} is already linked to user ${existingPhoneAccount.user_id}, but user ${userIdNum} is trying to link it. This will cause session conflicts.`);
          
          // PROTECT MAIN ACCOUNT: Never allow transfer of main account
          if (config.mainAccountPhone && normalizedPhone === config.mainAccountPhone.trim()) {
            const errorMsg = `Cannot link phone ${normalizedPhone}: This is the main account used to create the bot and APIs. It cannot be transferred or deleted.`;
            console.error(`[ACCOUNT ERROR] ${errorMsg}`);
            logger.logError('ACCOUNT_CONFLICT', userIdNum, new Error(errorMsg), `Phone ${normalizedPhone} conflict - main account protection`);
            
            // Notify admins of critical conflict
            adminNotifier.notifyEvent('ACCOUNT_CONFLICT_BLOCKED', `Main account transfer blocked`, {
              existingUserId: existingPhoneAccount.user_id,
              newUserId: userIdNum,
              accountId: existingPhoneAccount.account_id,
              phone: normalizedPhone,
              reason: 'Main account cannot be transferred',
            }).catch(() => {});
            
            throw new Error(`This phone number belongs to the main account and cannot be linked to another user. Please contact support if you need assistance.`);
          }
          
          // CRITICAL: Check if account is currently broadcasting before any action
          if (existingPhoneAccount.is_broadcasting) {
            const errorMsg = `Cannot link phone ${normalizedPhone}: Account ${existingPhoneAccount.account_id} is currently broadcasting. Please stop the broadcast first or contact support.`;
            console.error(`[ACCOUNT ERROR] ${errorMsg}`);
            logger.logError('ACCOUNT_CONFLICT', userIdNum, new Error(errorMsg), `Phone ${normalizedPhone} conflict - account ${existingPhoneAccount.account_id} is broadcasting`);
            
            // Notify admins of critical conflict
            adminNotifier.notifyEvent('ACCOUNT_CONFLICT_BLOCKED', `Account conflict blocked - account is broadcasting`, {
              existingUserId: existingPhoneAccount.user_id,
              newUserId: userIdNum,
              accountId: existingPhoneAccount.account_id,
              phone: normalizedPhone,
              reason: 'Account is currently broadcasting - cannot delete or transfer',
            }).catch(() => {});
            
            throw new Error(`This phone number is already linked to another account that is currently broadcasting. Please stop the broadcast first or contact support.`);
          }
          
          // CRITICAL: Instead of deleting, transfer ownership to the new user
          // This preserves the account and all its data (groups, settings, etc.)
          console.log(`[ACCOUNT] Transferring ownership of account ${existingPhoneAccount.account_id} from user ${existingPhoneAccount.user_id} to user ${userIdNum}`);
          
          // Transfer ownership by updating user_id
          await db.query(
            'UPDATE accounts SET user_id = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2',
            [userIdNum, existingPhoneAccount.account_id]
          );
          
          // Remove from old user's memory tracking if loaded
          const oldUserIdStr = existingPhoneAccount.user_id.toString();
          const oldUserAccounts = this.userAccounts.get(oldUserIdStr);
          if (oldUserAccounts) {
            const accountIdStr = existingPhoneAccount.account_id.toString();
            oldUserAccounts.delete(accountIdStr);
            if (oldUserAccounts.size === 0) {
              this.userAccounts.delete(oldUserIdStr);
            }
          }
          
          // Remove from linkedAccounts memory if loaded (will be reloaded with new user)
          const accountIdStr = existingPhoneAccount.account_id.toString();
          if (this.linkedAccounts.has(accountIdStr)) {
            const account = this.linkedAccounts.get(accountIdStr);
            if (account.client && account.client.connected) {
              try {
                await account.client.disconnect();
              } catch (e) {
                logError(`[ACCOUNT ERROR] Error disconnecting client during transfer:`, e);
              }
            }
            this.linkedAccounts.delete(accountIdStr);
          }
          
          console.log(`[ACCOUNT] Successfully transferred account ${existingPhoneAccount.account_id} to user ${userIdNum}`);
          logger.logChange('ACCOUNT_TRANSFERRED', userIdNum, `Account ${existingPhoneAccount.account_id} (${normalizedPhone}) transferred from user ${existingPhoneAccount.user_id}`);
          
          // Notify admins of account transfer
          adminNotifier.notifyEvent('ACCOUNT_TRANSFERRED', `Account ownership transferred`, {
            oldUserId: existingPhoneAccount.user_id,
            newUserId: userIdNum,
            accountId: existingPhoneAccount.account_id,
            phone: normalizedPhone,
            reason: 'Phone number conflict - ownership transferred to new user',
          }).catch(() => {});
          
          // Now continue with the normal flow - the account already exists, so we'll update it
          // The existing check below will find this account since we just transferred it to userIdNum
        }
      }
      
      // Check if account already exists for this user and phone
      const existing = await db.query(
        'SELECT account_id, is_active FROM accounts WHERE user_id = $1 AND phone = $2',
        [userIdNum, normalizedPhone]
      );
      
      let accountId;
      let isActive = false;
      
      if (existing.rows.length > 0) {
        // Update existing account
        accountId = existing.rows[0]?.account_id;
        // Convert SQLite INTEGER (0/1) to JavaScript boolean
        isActive = existing.rows[0]?.is_active === 1 || existing.rows[0]?.is_active === true;
        
        // CRITICAL: Validate sessionString again before UPDATE
        if (!sessionString || typeof sessionString !== 'string' || sessionString.trim().length === 0) {
          console.error(`[ACCOUNT ERROR] Session string is invalid before UPDATE: ${typeof sessionString}, length: ${sessionString?.length || 0}`);
          throw new Error('Invalid session string - cannot update account');
        }
        
        console.log(`[ACCOUNT] Updating existing account ${accountId} with sessionString length: ${sessionString.length}`);
        // CRITICAL: Use validSessionString instead of sessionString
        if (!validSessionString || validSessionString.length < 10) {
          console.error(`[ACCOUNT ERROR] Session string invalid before UPDATE: length=${validSessionString?.length || 0}`);
          throw new Error('Invalid session string - cannot update account');
        }
        console.log(`[ACCOUNT] Updating existing account ${accountId} with sessionString length: ${validSessionString.length}`);
        await db.query(
          `UPDATE accounts 
           SET session_string = $1, first_name = $2, updated_at = CURRENT_TIMESTAMP 
           WHERE account_id = $3`,
          [validSessionString, firstName, accountId]
        );
        console.log(`[ACCOUNT] Updated account ${accountId} for user ${userIdNum}`);
      } else {
        // Check if this will be the first account (set as active only if no accounts exist)
        const userAccounts = await db.query(
          'SELECT COUNT(*) as count FROM accounts WHERE user_id = $1',
          [userIdNum]
        );
        const accountCount = parseInt(userAccounts.rows[0]?.count) || 0;
        
        // Only set as active if this is the first account for the user
        // If other accounts exist, ensure they're deactivated first
        if (accountCount === 0) {
          isActive = true;
        } else {
          // New account - set existing accounts to inactive first
          // SQLite uses INTEGER (0/1) for booleans
          await db.query(
            'UPDATE accounts SET is_active = 0 WHERE user_id = ?',
            [userIdNum]
          );
          isActive = true; // Set new account as active
          console.log(`[ACCOUNT] Deactivated ${accountCount} existing account(s) before adding new active account for user ${userIdNum}`);
        }
        
        // Insert new account
        // CRITICAL: Validate sessionString again before INSERT
        if (!sessionString || typeof sessionString !== 'string' || sessionString.trim().length === 0) {
          console.error(`[ACCOUNT ERROR] Session string is invalid before INSERT: ${typeof sessionString}, length: ${sessionString?.length || 0}`);
          throw new Error('Invalid session string - cannot insert account');
        }
        
        // CRITICAL: Use validSessionString instead of sessionString
        if (!validSessionString || validSessionString.length < 10) {
          console.error(`[ACCOUNT ERROR] Session string invalid before INSERT: length=${validSessionString?.length || 0}`);
          throw new Error('Invalid session string - cannot insert account');
        }
        console.log(`[ACCOUNT] Inserting new account with sessionString length: ${validSessionString.length}`);
        // SQLite uses INTEGER (0/1) for booleans
        const isActiveInt = isActive ? 1 : 0;
        const result = await db.query(
          `INSERT INTO accounts (user_id, phone, session_string, first_name, is_active, updated_at)
           VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [userIdNum, normalizedPhone, validSessionString, firstName || null, isActiveInt]
      );
        // Get the account_id from lastInsertRowid
        accountId = result.insertId || result.rows[0]?.account_id;
        console.log(`[ACCOUNT] Created account ${accountId} for user ${userIdNum}, active: ${isActive}`);
        
        // Notify admins of successful account linking
        adminNotifier.notifyEvent('ACCOUNT_LINKED', `New account linked successfully`, {
          userId: userIdNum,
          accountId,
          phone,
          details: `Account ${accountId} linked for user ${userIdNum} (${phone})`,
        }).catch(() => {}); // Silently fail to avoid blocking
        
        // Log to logger bot
        const loggerBotService = (await import('./loggerBotService.js')).default;
        loggerBotService.logAccountLinked(userIdNum, normalizedPhone, accountId).catch(() => {
          // Silently fail - logger bot may not be started or user may have blocked it
        });
      }
      
      // If this is a new account and it's being set as active, deactivate other accounts in memory
      if (isActive && existing.rows.length === 0) {
        const userIdStr = userIdNum.toString();
        const accountIds = this.userAccounts.get(userIdStr);
        if (accountIds) {
          for (const accId of accountIds) {
            const acc = this.linkedAccounts.get(accId);
            if (acc) {
              acc.isActive = false;
            }
          }
        }
      }
      
      // CRITICAL: Prevent main account from being saved
      if (config.mainAccountPhone && normalizedPhone === config.mainAccountPhone.trim()) {
        throw new Error(`Cannot link main account (${normalizedPhone}). This account is used to create the bot and APIs and should not be used for broadcasting.`);
      }
      
      // Use provided client or create new one
      let accountClient = client;
      if (!accountClient) {
        const stringSession = new StringSession(sessionString);
        accountClient = new TelegramClient(stringSession, config.apiId, config.apiHash, {
          connectionRetries: 3, // Reduced from 5 to prevent excessive retries
          timeout: 10000,
          retryDelay: 5000, // Increased from 3000 to 5000 for safety
          autoReconnect: false, // CRITICAL: Disable autoReconnect to prevent excessive reconnections
          useWSS: false,
        });
        
        // Setup error handlers to prevent crashes from MTProto errors
        setupClientErrorHandlers(accountClient, accountId);
        
        // Connect to verify session, then disconnect
        // Add delay before verification to avoid rapid connections
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay
        await accountClient.connect();
        // Skip getMe() verification to reduce API calls - just verify connection works
        await accountClient.disconnect();
        console.log(`[ACCOUNT] Verified new account ${accountId} session (will connect on-demand)`);
      } else {
        // If client was provided (from OTP/password flow), setup error handlers
        // Don't disconnect it yet - setupAccountPostLink will use it and disconnect after setup
        setupClientErrorHandlers(accountClient, accountId);
        // Setup auto-reply handler if client is connected
        if (accountClient.connected) {
          await autoReplyHandler.setupAutoReply(accountClient, accountId);
        }
        console.log(`[ACCOUNT] Client provided for account ${accountId} - will be used for setup`);
      }
      
      const accountIdStr = accountId.toString();
      this.linkedAccounts.set(accountIdStr, {
        accountId,
        userId: userIdNum,
        phone: normalizedPhone,
        firstName: firstName || null,
        sessionString,
        client: accountClient,
        isActive,
        createdAt: Date.now(), // Track creation time for cleanup
        lastUsed: Date.now(), // Track last usage for connection management
      });
      
      const userIdStr = userIdNum.toString();
      if (!this.userAccounts.has(userIdStr)) {
        this.userAccounts.set(userIdStr, new Set());
      }
      this.userAccounts.get(userIdStr).add(accountIdStr);
      
      return { accountId, isActive, client: accountClient };
    } catch (error) {
      logError('[ACCOUNT ERROR] Error saving account to database:', error);
      throw error;
    }
  }

  async deleteLinkedAccount(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const account = this.linkedAccounts.get(accountIdNum.toString());
      
      if (!account) {
        throw new Error(`Account ${accountId} not found`);
      }

      const userId = account.userId;
      const userIdStr = userId.toString();
      const accountIdStr = accountIdNum.toString();
      
      // PROTECT MAIN ACCOUNT: Never allow deletion of main account
      // The main account is the one used to create the bot and APIs
      const phone = account.phone || '';
      if (config.mainAccountPhone && phone === config.mainAccountPhone.trim()) {
        const errorMsg = `Cannot delete main account (${phone}). This account is used to create the bot and APIs and must be preserved.`;
        console.log(`[ACCOUNT PROTECTION] ⚠️  Attempted to delete main account ${accountId} (${phone}) - BLOCKED`);
        logError(`[ACCOUNT PROTECTION] Attempted deletion of main account`, new Error(errorMsg));
        throw new Error(errorMsg);
      }
      
      // Clean up account data (stop broadcasts, disconnect, remove from memory)
      await this.cleanupAccountData(accountIdNum);
      
      // Delete from database (CASCADE will delete related data)
      await db.query('DELETE FROM accounts WHERE account_id = $1', [accountIdNum]);
      
      console.log(`[ACCOUNT] Deleted account ${accountId} for user ${userId}`);
      logger.logChange('DELETE_ACCOUNT', userId, `Account ${accountId} deleted from database`);
      
      return { success: true };
    } catch (error) {
      logError('[ACCOUNT ERROR] Error deleting account from database:', error);
      throw error;
    }
  }

  async savePendingVerification(userId, phone, phoneCodeHash) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      // SQLite uses EXCLUDED to reference values in ON CONFLICT DO UPDATE
      await db.query(
        `INSERT INTO pending_verifications (user_id, phone, phone_code_hash)
         VALUES (?, ?, ?)
         ON CONFLICT (user_id) 
         DO UPDATE SET phone = EXCLUDED.phone, phone_code_hash = EXCLUDED.phone_code_hash, created_at = CURRENT_TIMESTAMP`,
        [userIdNum, phone, phoneCodeHash]
      );
    } catch (error) {
      logError('Error saving pending verification to database:', error);
    }
  }

  async deletePendingVerification(userId) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      await db.query('DELETE FROM pending_verifications WHERE user_id = $1', [userIdNum]);
    } catch (error) {
      logError('Error deleting pending verification from database:', error);
    }
  }

  async loadPendingVerification(userId) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      const result = await db.query(
        'SELECT phone, phone_code_hash FROM pending_verifications WHERE user_id = $1',
        [userIdNum]
      );
      
      if (result.rows.length > 0) {
        return result.rows[0];
      }
      return null;
    } catch (error) {
      logError('Error loading pending verification from database:', error);
      return null;
    }
  }

  async initiateLink(userId, phone) {
    try {
      // Enhanced validation
      if (!userId || (typeof userId === 'string' && isNaN(parseInt(userId))) || (typeof userId === 'number' && userId <= 0)) {
        return { success: false, error: 'Invalid user ID' };
      }
      
      if (!phone || typeof phone !== 'string' || phone.trim().length === 0) {
        return { success: false, error: 'Phone number is required' };
      }
      
      // Normalize phone number - remove all non-digit characters except +
      // This handles cases like "+1 (234) 567-8900" or "+1-234-567-8900"
      let normalizedPhone = phone.trim();
      
      // Remove all characters except + and digits
      normalizedPhone = normalizedPhone.replace(/[^\d+]/g, '');
      
      // Ensure it starts with +
      if (!normalizedPhone.startsWith('+')) {
        // If it doesn't start with +, add it
        normalizedPhone = '+' + normalizedPhone;
      }
      
      // Remove any duplicate + signs (should only be at the start)
      normalizedPhone = normalizedPhone.replace(/^\+{2,}/, '+');
      
      // Validate phone format (E.164: + followed by 1-15 digits, first digit after + should be 1-9)
      const phoneRegex = /^\+[1-9]\d{1,14}$/;
      if (!phoneRegex.test(normalizedPhone)) {
        console.log(`[LINK] Invalid phone format: "${phone}" -> normalized: "${normalizedPhone}"`);
        return { success: false, error: 'Invalid phone number format. Please use international format (e.g., +1234567890)' };
      }
      
      console.log(`[LINK] Phone number normalized: "${phone}" -> "${normalizedPhone}"`);
      
      // Check if user is in password attempt cooldown period
      const attemptData = this.passwordAttempts.get(userId);
      if (attemptData && attemptData.attempts >= 3 && attemptData.cooldownUntil) {
        const now = Date.now();
        const cooldownRemaining = attemptData.cooldownUntil - now;
        
        if (cooldownRemaining > 0) {
          // Still in cooldown period
          const remainingMinutes = Math.ceil(cooldownRemaining / 60000);
          const remainingSeconds = Math.ceil(cooldownRemaining / 1000);
          logError(`[LINK ERROR] User ${userId} attempted to start new login during password cooldown period. ${remainingMinutes} minutes remaining.`);
          
          return { 
            success: false, 
            error: `Too many failed password attempts. Please wait ${remainingMinutes} minute(s) (${remainingSeconds} seconds) before trying to link your account again.` 
          };
        }
      }
      
      // Check if user is in rate limit cooldown period
      const rateLimitData = this.rateLimitCooldowns.get(userId);
      if (rateLimitData && rateLimitData.cooldownUntil) {
        const now = Date.now();
        const cooldownRemaining = rateLimitData.cooldownUntil - now;
        
        if (cooldownRemaining > 0) {
          // Still in cooldown period
          const remainingMinutes = Math.ceil(cooldownRemaining / 60000);
          const remainingSeconds = Math.ceil(cooldownRemaining / 1000);
          logError(`[LINK ERROR] User ${userId} attempted to initiate link during rate limit cooldown. ${remainingMinutes} minute(s) (${remainingSeconds} seconds) remaining.`);
          
          return { 
            success: false, 
            error: `Rate limited by Telegram. Please wait ${remainingMinutes} minute(s) (${remainingSeconds} seconds) before requesting a new code.` 
          };
        } else {
          // Cooldown expired, remove it
          this.rateLimitCooldowns.delete(userId);
        }
      }
      
      // Check if user already has too many pending verifications (prevent abuse)
      const existingPending = this.pendingVerifications.get(userId);
      if (existingPending) {
        const age = Date.now() - (existingPending.createdAt || 0);
        if (age < 60000) { // Less than 1 minute old
          return { success: false, error: 'Verification already in progress. Please wait before requesting a new code.' };
        }
      }
      
      const stringSession = new StringSession('');
      const client = new TelegramClient(stringSession, config.apiId, config.apiHash, {
        connectionRetries: 3, // Reduced from 5
        timeout: 10000,
        retryDelay: 5000, // Increased from 3000
        autoReconnect: false, // CRITICAL: Disable autoReconnect
        useWSS: false,
      });

      // Setup error handlers to prevent crashes from MTProto errors
      setupClientErrorHandlers(client);

      // CRITICAL: Ensure client connects successfully before proceeding
      try {
        await client.connect();
        console.log(`[LINK] Client connected successfully for user ${userId}`);
      } catch (connectError) {
        logError(`[LINK ERROR] Failed to connect client for user ${userId}:`, connectError);
        try {
          await client.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
        return { 
          success: false, 
          error: 'Failed to connect to Telegram. Please check your internet connection and try again.' 
        };
      }
      
      // Log the exact phone number being sent to Telegram API for debugging
      console.log(`[LINK] Sending code to phone: "${normalizedPhone}" (length: ${normalizedPhone.length})`);
      
      const result = await client.sendCode(
        {
          apiId: config.apiId,
          apiHash: config.apiHash,
        },
        normalizedPhone
      );

      // CRITICAL: Validate result and phoneCodeHash
      if (!result || !result.phoneCodeHash || typeof result.phoneCodeHash !== 'string') {
        logError(`[LINK ERROR] Invalid result from sendCode for user ${userId}:`, result);
        try {
          await client.disconnect();
        } catch (e) {}
        return { 
          success: false, 
          error: 'Failed to receive verification code. Please try again.' 
        };
      }

      // Prevent Map from growing too large (limit to 100 entries)
      if (this.pendingVerifications.size > 100) {
        console.warn(`[MEMORY] Pending verifications Map is large (${this.pendingVerifications.size} entries), cleaning up...`);
        this.cleanupPendingVerifications();
      }
      
      this.pendingVerifications.set(userId, {
        phone: normalizedPhone,
        phoneCodeHash: result.phoneCodeHash,
        client,
        createdAt: Date.now() // Add timestamp for cleanup
      });
      
      // Reset password attempts when starting a new verification
      this.passwordAttempts.delete(userId);

      // Save to database
      await this.savePendingVerification(userId, normalizedPhone, result.phoneCodeHash);

      return { success: true, phoneCodeHash: result.phoneCodeHash };
    } catch (error) {
      logError('Error initiating link:', error);
      
      // Handle specific Telegram error codes
      const errorMsg = error.errorMessage || error.message || '';
      const errorCode = error.code || error.errorCode || '';
      
      // Check for flood wait errors
      if (isFloodWaitError(error)) {
        const waitSeconds = extractWaitTime(error) || 60;
        const waitMinutes = Math.ceil(waitSeconds / 60);
        
        // Store rate limit cooldown to prevent repeated attempts
        const cooldownUntil = Date.now() + (waitSeconds * 1000);
        this.rateLimitCooldowns.set(userId, {
          cooldownUntil: cooldownUntil,
          waitSeconds: waitSeconds
        });
        
        // Clean up old rate limit entries periodically (keep only last 50)
        if (this.rateLimitCooldowns.size > 50) {
          const now = Date.now();
          for (const [uid, data] of this.rateLimitCooldowns.entries()) {
            if (data.cooldownUntil && data.cooldownUntil < now) {
              this.rateLimitCooldowns.delete(uid);
            }
          }
        }
        
        logError(`[LINK ERROR] Rate limit detected for user ${userId}. Cooldown until ${new Date(cooldownUntil).toISOString()} (${waitMinutes} minute(s), ${waitSeconds} seconds)`);
        
        return { 
          success: false, 
          error: `Rate limited by Telegram. Please wait ${waitMinutes} minute(s) (${waitSeconds} seconds) before requesting a new code.` 
        };
      }
      
      // Check for invalid phone number errors
      if (errorMsg.includes('PHONE_NUMBER_INVALID') || 
          errorMsg.includes('PHONE_NUMBER_BANNED') ||
          errorMsg.includes('PHONE_NUMBER_FLOOD')) {
        return { 
          success: false, 
          error: 'Invalid phone number. Please check your phone number format and try again.' 
        };
      }
      
      // Clean up on error
      const pending = this.pendingVerifications.get(userId);
      if (pending && pending.client) {
        try {
          await pending.client.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
        this.pendingVerifications.delete(userId);
      }
      await this.deletePendingVerification(userId);
      
      // Return generic error message (don't expose technical details)
      return { 
        success: false, 
        error: 'Failed to send verification code. Please try again later.' 
      };
    }
  }

  async verifyOTP(userId, code) {
    // Enhanced validation
    if (!userId) {
      return { success: false, error: 'Invalid user ID' };
    }
    
    if (!code || (typeof code === 'string' && code.trim().length === 0)) {
      return { success: false, error: 'Verification code is required' };
    }
    
    // Normalize code (remove spaces, convert to string)
    const normalizedCode = typeof code === 'string' ? code.trim().replace(/\s+/g, '') : String(code).trim();
    
    // Validate code format (should be 5 digits)
    if (!/^\d{5}$/.test(normalizedCode)) {
      return { success: false, error: 'Invalid verification code format. Code must be 5 digits.' };
    }
    
    const pending = this.pendingVerifications.get(userId);
    if (!pending) {
      return { success: false, error: 'No pending verification found. Please start the linking process again.' };
    }
    
    // Check if verification expired (older than 10 minutes)
    const verificationAge = Date.now() - (pending.createdAt || 0);
    if (verificationAge > 10 * 60 * 1000) {
      // Clean up expired verification
      if (pending.client) {
        try {
          await pending.client.disconnect();
        } catch (e) {}
      }
      this.pendingVerifications.delete(userId);
      await this.deletePendingVerification(userId);
      return { success: false, error: 'Verification code expired. Please request a new code.' };
    }

    try {
      const { phone, phoneCodeHash, client } = pending;
      
      // CRITICAL: Validate all required data exists
      if (!phone || !phoneCodeHash || !client) {
        logError(`[OTP ERROR] Missing required data for user ${userId}: phone=${!!phone}, phoneCodeHash=${!!phoneCodeHash}, client=${!!client}`);
        this.pendingVerifications.delete(userId);
        await this.deletePendingVerification(userId);
        return { success: false, error: 'Verification data is incomplete. Please start the linking process again.' };
      }
      
      // CRITICAL: Ensure client exists and is valid before using it
      if (!client || typeof client.invoke !== 'function') {
        logError(`[OTP ERROR] Client is invalid for user ${userId}`);
        this.pendingVerifications.delete(userId);
        await this.deletePendingVerification(userId);
        return { success: false, error: 'Connection error. Please start the linking process again.' };
      }
      
      // Ensure client is connected before making API call
      if (!client.connected) {
        console.log(`[OTP] Client not connected, connecting...`);
        try {
          await client.connect();
        } catch (connectError) {
          logError(`[OTP ERROR] Failed to connect client for user ${userId}:`, connectError);
          this.pendingVerifications.delete(userId);
          await this.deletePendingVerification(userId);
          return { success: false, error: 'Connection error. Please try again.' };
        }
      }
      
      // Validate phoneCodeHash format
      if (typeof phoneCodeHash !== 'string' || phoneCodeHash.trim().length === 0) {
        logError(`[OTP ERROR] Invalid phoneCodeHash for user ${userId}`);
        this.pendingVerifications.delete(userId);
        await this.deletePendingVerification(userId);
        return { success: false, error: 'Verification code expired. Please request a new code.' };
      }
      
      // Use proper MTProto API request
      const result = await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: phoneCodeHash,
          phoneCode: normalizedCode,
        })
      );
      
      // CRITICAL: Validate result exists
      if (!result) {
        logError(`[OTP ERROR] Empty result from SignIn for user ${userId}`);
        return { success: false, error: 'Invalid response from Telegram. Please try again.' };
      }

      // Check if account requires sign-up (new account)
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        // Clean up verification
        if (pending.client) {
          try {
            await pending.client.disconnect();
          } catch (e) {}
        }
        this.pendingVerifications.delete(userId);
        await this.deletePendingVerification(userId);
        return { success: false, error: 'Account requires sign up. Please use Telegram app first to create your account.' };
      }

      // Check if 2FA password is required - Telegram returns this as a specific error type
      // Check for password requirement BEFORE checking successful authorization
      if (result instanceof Api.auth.Authorization && result.user) {
        // Successfully signed in
        // CRITICAL: Validate result.user exists and has required properties
        if (!result.user || typeof result.user !== 'object') {
          logError(`[OTP ERROR] Invalid user object in result for user ${userId}:`, result);
          this.pendingVerifications.delete(userId);
          await this.deletePendingVerification(userId);
          return { success: false, error: 'Invalid response from Telegram. Please try again.' };
        }
        
        // CRITICAL: Ensure client is connected before saving session
        if (!client.connected) {
          console.log(`[OTP] Client not connected, connecting...`);
          try {
            await client.connect();
          } catch (connectError) {
            logError(`[OTP ERROR] Failed to connect client for user ${userId}:`, connectError);
            this.pendingVerifications.delete(userId);
            await this.deletePendingVerification(userId);
            return { success: false, error: 'Connection error. Please try again.' };
          }
        }
        
        // Save session string - ensure it's not null
        let sessionString = null;
        try {
          sessionString = client.session.save();
        } catch (sessionError) {
          logError(`[OTP ERROR] Failed to save session for user ${userId}:`, sessionError);
          this.pendingVerifications.delete(userId);
          await this.deletePendingVerification(userId);
          return { success: false, error: 'Failed to save session. Please try again.' };
        }
        
        if (!sessionString || typeof sessionString !== 'string' || sessionString.trim().length === 0) {
          // Try to get session string from session object directly
          if (client.session && typeof client.session.save === 'function') {
            try {
              sessionString = client.session.save();
            } catch (e) {
              // Ignore
            }
          }
          // If still null, try alternative method
          if (!sessionString && client.session && client.session.sessionString) {
            sessionString = client.session.sessionString;
          }
          // If still null, throw error
          if (!sessionString || typeof sessionString !== 'string' || sessionString.trim().length === 0) {
            logError(`[OTP ERROR] Session string is invalid for user ${userId}`);
            this.pendingVerifications.delete(userId);
            await this.deletePendingVerification(userId);
            return { success: false, error: 'Failed to save session. Please try again.' };
          }
        }
        
        console.log(`[OTP] Session string saved successfully (length: ${sessionString.length})`);
        const userIdStr = userId.toString();
        const firstName = (result.user && result.user.firstName) ? result.user.firstName : null;

        this.pendingVerifications.delete(userId);
        
        // Save to database (pass client to avoid duplicate connection)
        const saveResult = await this.saveLinkedAccount(userId, phone, sessionString, client, firstName);
        await this.deletePendingVerification(userId);

        // Set profile tags and join updates channel (async, don't block)
        this.setupAccountPostLink(saveResult.client, saveResult.accountId).catch(err => {
          logError(`[SETUP ERROR] Error setting up account ${saveResult.accountId}:`, err);
        });

        return { success: true, accountId: saveResult.accountId, isActive: saveResult.isActive };
      } else {
        return { success: false, error: 'Unexpected response from Telegram' };
      }
    } catch (error) {
      logError(`[OTP ERROR] Error verifying OTP for user ${userId}:`, error);
      
      // Check if 2FA password is required - Telegram throws SESSION_PASSWORD_NEEDED error
      // Also check for various error formats that indicate password requirement
      const errorMsg = error.errorMessage || error.message || error.toString() || '';
      const errorCode = error.code || error.errorCode || '';
      const errorName = error.name || '';
      
      // Comprehensive check for password requirement
      const isPasswordRequired = 
        errorMsg === 'SESSION_PASSWORD_NEEDED' ||
        errorMsg.includes('SESSION_PASSWORD_NEEDED') ||
        errorMsg.includes('PASSWORD_NEEDED') ||
        errorMsg.includes('password required') ||
        errorMsg.includes('two-step verification') ||
        errorMsg.includes('two step verification') ||
        errorMsg.includes('2FA') ||
        (errorCode === 401 && (errorMsg.includes('password') || errorMsg.includes('SESSION'))) ||
        (errorName === 'SessionPasswordNeededError') ||
        (error instanceof Error && error.message && error.message.includes('SESSION_PASSWORD_NEEDED'));
      
      if (isPasswordRequired) {
        console.log(`[2FA] Password required for user ${userId} - OTP was correct`);
        
        // OTP was verified successfully, now password is needed
        // Don't disconnect client - we need it for password authentication
        // Clean up OTP verification since it's complete (password is next step)
        this.pendingVerifications.delete(userId);
        await this.deletePendingVerification(userId);
        
        // Store client for password authentication
        // Prevent Map from growing too large (limit to 100 entries)
        if (this.pendingPasswordAuth.size > 100) {
          console.warn(`[MEMORY] Pending password auth Map is large (${this.pendingPasswordAuth.size} entries), cleaning up...`);
          this.cleanupPendingVerifications();
        }
        
        // CRITICAL: Ensure client exists and is connected before storing for password auth
        if (!pending || !pending.client) {
          logError(`[2FA ERROR] Client lost during OTP verification for user ${userId}`);
          return { success: false, error: 'Connection error. Please start the linking process again.' };
        }
        
        if (!pending.client.connected) {
          console.log(`[2FA] Client disconnected, reconnecting for password auth...`);
          try {
            await pending.client.connect();
          } catch (connectError) {
            logError(`[2FA ERROR] Failed to reconnect client for password auth:`, connectError);
            return { success: false, error: 'Connection error. Please try again.' };
          }
        }
        
        this.pendingPasswordAuth.set(userId, {
          phone: pending.phone,
          client: pending.client,
          createdAt: Date.now() // Add timestamp for cleanup
        });
        
        // Reset password attempts when starting new password auth
        this.passwordAttempts.delete(userId);
        
        // OTP verification is complete, password is the next step
        return { 
          success: false, 
          error: 'PASSWORD_NEEDED',
          requiresPassword: true 
        };
      }
      
      // Check error type to determine if we should keep pending verification
      // Handle all Telegram error codes properly
      const isInvalidCode = 
        errorMsg.includes('PHONE_CODE_INVALID') || 
        errorMsg.includes('PHONE_CODE_EMPTY') ||
        (errorMsg.includes('code') && errorMsg.includes('invalid')) ||
        errorCode === 400 && errorMsg.includes('code');
      
      const isExpired = 
        errorMsg.includes('PHONE_CODE_EXPIRED') || 
        errorMsg.includes('expired') || 
        errorMsg.includes('timeout') ||
        errorCode === 400 && errorMsg.includes('expired');
      
      const isFloodWait = 
        errorMsg.includes('FLOOD_WAIT') ||
        errorMsg.includes('FLOOD') ||
        isFloodWaitError(error);
      
      const isPhoneInvalid = 
        errorMsg.includes('PHONE_NUMBER_INVALID') ||
        errorMsg.includes('PHONE_NUMBER_BANNED') ||
        errorMsg.includes('PHONE_NUMBER_FLOOD');
      
      // Handle flood wait errors
      if (isFloodWait) {
        const waitSeconds = extractWaitTime(error) || 60;
        const waitMinutes = Math.ceil(waitSeconds / 60);
        logError(`[OTP ERROR] Flood wait during OTP verification for user ${userId}: ${waitSeconds}s wait required`, error);
        // Clean up verification on flood wait
        if (pending.client) {
          try {
            await pending.client.disconnect();
          } catch (e) {}
        }
        this.pendingVerifications.delete(userId);
        await this.deletePendingVerification(userId);
        return { 
          success: false, 
          error: `Rate limited by Telegram. Please wait ${waitMinutes} minute(s) (${waitSeconds} seconds) before requesting a new code.` 
        };
      }
      
      // Handle phone number errors
      if (isPhoneInvalid) {
        logError(`[OTP ERROR] Invalid phone number for user ${userId}:`, error);
        if (pending.client) {
          try {
            await pending.client.disconnect();
          } catch (e) {}
        }
        this.pendingVerifications.delete(userId);
        await this.deletePendingVerification(userId);
        return { 
          success: false, 
          error: 'Invalid phone number. Please check your phone number and try again.' 
        };
      }
      
      // Only clean up verification for critical errors (expired, not invalid code)
      // Keep pending verification for wrong code so user can try again
      if (isExpired) {
        console.log(`[OTP] Code expired - cleaning up verification for user ${userId}`);
        // Clean up failed verification for expired codes
        if (pending.client) {
          try {
            await pending.client.disconnect();
          } catch (e) {
            // Ignore disconnect errors
          }
        }
        this.pendingVerifications.delete(userId);
        await this.deletePendingVerification(userId);
        return { 
          success: false, 
          error: 'Verification code expired. Please request a new code.' 
        };
      } else if (isInvalidCode) {
        // Wrong code - keep pending verification so user can try again
        console.log(`[OTP] Invalid code entered - keeping pending verification for retry (user ${userId})`);
        return { 
          success: false, 
          error: 'Invalid verification code. Please check the code and try again.' 
        };
      } else {
        // Other errors - clean up and return generic error
        console.log(`[OTP] Other error - cleaning up verification for user ${userId}: ${errorMsg}`);
        if (pending.client) {
          try {
            await pending.client.disconnect();
          } catch (e) {}
        }
        this.pendingVerifications.delete(userId);
        await this.deletePendingVerification(userId);
        return { 
          success: false, 
          error: 'An error occurred during verification. Please try again.' 
        };
      }
    }
  }

  async verifyPassword(userId, password) {
    console.log(`[2FA] verifyPassword called for user ${userId}`);
    
    // CRITICAL: Validate password input
    if (!password || typeof password !== 'string' || password.trim().length === 0) {
      logError(`[2FA ERROR] Empty or invalid password provided for user ${userId}`);
      return { success: false, error: 'Password is required' };
    }
    
    // Validate password length (Telegram passwords are typically 8+ characters)
    const trimmedPassword = password.trim();
    if (trimmedPassword.length < 1) {
      return { success: false, error: 'Password cannot be empty' };
    }
    
    const pending = this.pendingPasswordAuth.get(userId);
    if (!pending) {
      logError(`[2FA ERROR] No pending password authentication found for user ${userId}`);
      return { success: false, error: 'No pending password authentication found. Please start the linking process again.' };
    }
    
    // CRITICAL: Validate pending data
    if (!pending.phone || !pending.client) {
      logError(`[2FA ERROR] Invalid pending data for user ${userId}: phone=${!!pending.phone}, client=${!!pending.client}`);
      this.pendingPasswordAuth.delete(userId);
      return { success: false, error: 'Authentication data is incomplete. Please start the linking process again.' };
    }

    // Check password attempt limit (max 3 attempts)
    const MAX_PASSWORD_ATTEMPTS = 3;
    const COOLDOWN_MINUTES = 5; // 5 minutes cooldown after 3 failed attempts
    const COOLDOWN_MS = COOLDOWN_MINUTES * 60 * 1000;
    
    const attemptData = this.passwordAttempts.get(userId) || { attempts: 0, cooldownUntil: null };
    
    // Check if user is in cooldown period
    if (attemptData.attempts >= MAX_PASSWORD_ATTEMPTS && attemptData.cooldownUntil) {
      const now = Date.now();
      const cooldownRemaining = attemptData.cooldownUntil - now;
      
      if (cooldownRemaining > 0) {
        // Still in cooldown period
        const remainingMinutes = Math.ceil(cooldownRemaining / 60000);
        const remainingSeconds = Math.ceil(cooldownRemaining / 1000);
        logError(`[2FA ERROR] User ${userId} attempted password during cooldown period. ${remainingMinutes} minutes remaining.`);
        
        return { 
          success: false, 
          error: `Too many failed attempts. Please wait ${remainingMinutes} minute(s) (${remainingSeconds} seconds) before trying again.`,
          maxAttemptsReached: true,
          cooldownRemaining: cooldownRemaining,
          cooldownMinutes: remainingMinutes,
          cooldownSeconds: remainingSeconds
        };
      } else {
        // Cooldown expired, reset attempts
        console.log(`[2FA] Cooldown expired for user ${userId}, resetting attempts`);
        attemptData.attempts = 0;
        attemptData.cooldownUntil = null;
        this.passwordAttempts.set(userId, attemptData);
      }
    }

    try {
      const { phone, client } = pending;
      
      // CRITICAL: Ensure client exists before using it
      if (!client) {
        logError(`[2FA ERROR] Client is null for user ${userId}`);
        this.pendingPasswordAuth.delete(userId);
        return { success: false, error: 'Connection error. Please start the linking process again.' };
      }
      
      // Ensure client is connected before making API call
      if (!client.connected) {
        console.log(`[2FA] Client not connected, connecting...`);
        try {
          await client.connect();
        } catch (connectError) {
          logError(`[2FA ERROR] Failed to connect client for user ${userId}:`, connectError);
          this.pendingPasswordAuth.delete(userId);
          return { success: false, error: 'Connection error. Please try again.' };
        }
      }
      
      console.log(`[2FA] Verifying password for user ${userId}, phone: ${phone}`);
      
      // Use signInWithPassword method with proper callbacks
      // Password must be a function that returns a promise resolving to the password string
      const result = await client.signInWithPassword({
        apiId: config.apiId,
        apiHash: config.apiHash,
      }, {
        password: async () => {
          console.log(`[2FA] Password function called for user ${userId}`);
          // Password is already validated above, but double-check here
          if (!trimmedPassword || trimmedPassword.length === 0) {
            logError(`[2FA ERROR] Password is empty in callback for user ${userId}`);
            throw new Error('Password is required');
          }
          return trimmedPassword;
        },
        onError: async (err) => {
          // Return false to retry, true to cancel
          // Check if it's a flood wait error - if so, cancel retries to prevent repeated attempts
          if (isFloodWaitError(err)) {
            const waitSeconds = extractWaitTime(err);
            logError(`[2FA ERROR] Password verification flood wait for user ${userId}: ${waitSeconds}s wait required`, err);
            return true; // Cancel retries - flood wait needs to be handled externally
          }
          logError(`[2FA ERROR] Password verification error for user ${userId}:`, err);
          return false; // Don't cancel, let the error propagate for other errors
        },
      });

      // signInWithPassword returns User object directly (not wrapped in Authorization like signIn)
      if (result && result.id) {
        console.log(`[2FA] Password verified successfully for user ${userId}`);
        
        // CRITICAL: Validate result exists and has required properties
        if (!result || typeof result !== 'object' || !result.id) {
          logError(`[2FA ERROR] Invalid result object for user ${userId}:`, result);
          this.pendingPasswordAuth.delete(userId);
          return { success: false, error: 'Invalid response from Telegram. Please try again.' };
        }
        
        // CRITICAL: Ensure client is connected before saving session
        if (!client.connected) {
          console.log(`[2FA] Client not connected, connecting...`);
          try {
            await client.connect();
          } catch (connectError) {
            logError(`[2FA ERROR] Failed to connect client for user ${userId}:`, connectError);
            this.pendingPasswordAuth.delete(userId);
            return { success: false, error: 'Connection error. Please try again.' };
          }
        }
        
        // Save session string - ensure it's not null
        let sessionString = null;
        try {
          sessionString = client.session.save();
        } catch (sessionError) {
          logError(`[2FA ERROR] Failed to save session for user ${userId}:`, sessionError);
          this.pendingPasswordAuth.delete(userId);
          return { success: false, error: 'Failed to save session. Please try again.' };
        }
        
        if (!sessionString || typeof sessionString !== 'string' || sessionString.trim().length === 0) {
          // Try to get session string from session object directly
          if (client.session && typeof client.session.save === 'function') {
            try {
              sessionString = client.session.save();
            } catch (e) {
              // Ignore
            }
          }
          // If still null, try alternative method
          if (!sessionString && client.session && client.session.sessionString) {
            sessionString = client.session.sessionString;
          }
          // If still null, return error
          if (!sessionString || typeof sessionString !== 'string' || sessionString.trim().length === 0) {
            logError(`[2FA ERROR] Session string is invalid for user ${userId}`);
            this.pendingPasswordAuth.delete(userId);
            return { success: false, error: 'Failed to save session. Please try again.' };
          }
        }
        
        console.log(`[2FA] Session string saved successfully (length: ${sessionString.length})`);
        const userIdStr = userId.toString();
        const firstName = (result.firstName) ? result.firstName : null;
        
        // Get phone number - always use pending phone (has + prefix) if available
        // result.phone might not have + prefix, so we prefer pending phone
        let actualPhone = phone; // Use pending phone which we know has + prefix
        if (!actualPhone || !actualPhone.startsWith('+')) {
          // If pending phone is not available or invalid, use result.phone and ensure + prefix
          if (result.phone) {
            actualPhone = result.phone.startsWith('+') ? result.phone : `+${result.phone}`;
          } else {
            throw new Error('Phone number not available from authentication result');
          }
        }
        const isWebLogin = pending.isWebLogin || false;

        this.pendingPasswordAuth.delete(userId);
        this.pendingVerifications.delete(userId);
        // Reset password attempts on success
        this.passwordAttempts.delete(userId);
        
        // Save to database (pass client to avoid duplicate connection)
        // Note: Don't disconnect the client yet - let setupAccountPostLink use it
        // The client is already authenticated and connected, so we can use it directly
        const saveResult = await this.saveLinkedAccount(userId, actualPhone, sessionString, client, firstName);
        await this.deletePendingVerification(userId);

        // Set profile tags and join updates channel (async, don't block)
        this.setupAccountPostLink(saveResult.client, saveResult.accountId).catch(err => {
          logError(`[SETUP ERROR] Error setting up account ${saveResult.accountId}:`, err);
        });

        // Log success for web login
        if (isWebLogin) {
          logger.logSuccess('WEB_LOGIN', userId, `Account ${saveResult.accountId} linked successfully via web login with 2FA`);
          console.log(`[WEB_LOGIN] Account ${saveResult.accountId} linked successfully for user ${userId} (with 2FA)`);
        }

        return { success: true, accountId: saveResult.accountId, isActive: saveResult.isActive };
      } else {
        return { success: false, error: 'Unexpected response from Telegram' };
      }
    } catch (error) {
      // Handle AUTH_USER_CANCEL gracefully (user cancelled, not an error)
      const errorMsg = error.errorMessage || error.message || '';
      if (errorMsg.includes('AUTH_USER_CANCEL') || errorMsg.includes('USER_CANCEL')) {
        console.log(`[2FA] User ${userId} cancelled password authentication`);
        this.pendingPasswordAuth.delete(userId);
        // Don't increment attempts for user cancellation
        return { success: false, error: 'AUTH_USER_CANCEL', cancelled: true };
      }

      // Check for flood wait errors and provide better error message
      if (isFloodWaitError(error)) {
        const waitSeconds = extractWaitTime(error);
        const waitMinutes = waitSeconds ? Math.ceil(waitSeconds / 60) : 0;
        logError(`[2FA ERROR] Flood wait during password verification for user ${userId}: ${waitSeconds}s wait required`, error);
        // Clean up failed password authentication
        if (pending.client) {
          try {
            await pending.client.disconnect();
          } catch (e) {
            // Ignore disconnect errors
          }
        }
        this.pendingPasswordAuth.delete(userId);
        if (this.pendingVerifications.has(userId)) {
          this.pendingVerifications.delete(userId);
          await this.deletePendingVerification(userId);
        }
        return { 
          success: false, 
          error: `Rate limited by Telegram. Please wait ${waitMinutes} minute(s) (${waitSeconds} seconds) before trying again.` 
        };
      }
      
      logError(`[2FA ERROR] Error verifying password for user ${userId}:`, error);
      
      // Increment password attempt counter
      attemptData.attempts += 1;
      const remainingAttempts = MAX_PASSWORD_ATTEMPTS - attemptData.attempts;
      
      // Check if max attempts reached
      if (attemptData.attempts >= MAX_PASSWORD_ATTEMPTS) {
        // Set cooldown period
        attemptData.cooldownUntil = Date.now() + COOLDOWN_MS;
        this.passwordAttempts.set(userId, attemptData);
        
        // Don't clean up - allow retry after cooldown
        return { 
          success: false, 
          error: `Maximum password attempts (${MAX_PASSWORD_ATTEMPTS}) reached. Please wait ${COOLDOWN_MINUTES} minutes before trying again.`,
          maxAttemptsReached: true,
          cooldownRemaining: COOLDOWN_MS,
          cooldownMinutes: COOLDOWN_MINUTES,
          cooldownSeconds: COOLDOWN_MINUTES * 60
        };
      }
      
      // Save attempt count
      this.passwordAttempts.set(userId, attemptData);
      
      // Don't delete pendingVerifications here - allow user to retry
      // Return error with remaining attempts info
      return { 
        success: false, 
        error: error.message,
        remainingAttempts: remainingAttempts,
        attempts: attemptData.attempts
      };
    }
  }

  isPasswordRequired(userId) {
    return this.pendingPasswordAuth.has(userId);
  }

  /**
   * Cancel any pending authentication for a user
   * Cleans up OTP verification, password auth, and web login states
   * @param {number} userId - User ID
   */
  async cancelAuth(userId) {
    let cleaned = false;
    
    // Clean up pending OTP verification
    const pendingVerification = this.pendingVerifications.get(userId);
    if (pendingVerification) {
      if (pendingVerification.client) {
        try {
          await pendingVerification.client.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      }
      this.pendingVerifications.delete(userId);
      await this.deletePendingVerification(userId);
      cleaned = true;
      console.log(`[AUTH_CANCEL] Cleaned up pending OTP verification for user ${userId}`);
    }
    
    // Clean up pending password auth
    const pendingPassword = this.pendingPasswordAuth.get(userId);
    if (pendingPassword) {
      if (pendingPassword.client) {
        try {
          await pendingPassword.client.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      }
      this.pendingPasswordAuth.delete(userId);
      cleaned = true;
      console.log(`[AUTH_CANCEL] Cleaned up pending password auth for user ${userId}`);
    }
    
    // Clean up pending web login
    const pendingWebLogin = this.pendingWebLogins.get(userId);
    if (pendingWebLogin) {
      pendingWebLogin.cancelled = true;
      if (pendingWebLogin.client) {
        try {
          await pendingWebLogin.client.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      }
      this.pendingWebLogins.delete(userId);
      cleaned = true;
      console.log(`[AUTH_CANCEL] Cleaned up pending web login for user ${userId}`);
    }
    
    // Reset password attempts
    this.passwordAttempts.delete(userId);
    
    if (cleaned) {
      console.log(`[AUTH_CANCEL] Auth cancelled for user ${userId}`);
    }
    
    return { success: true, cleaned };
  }

  async initiateWebLogin(userId, chatId = null) {
    try {
      // Enhanced validation
      if (!userId || (typeof userId === 'string' && isNaN(parseInt(userId))) || (typeof userId === 'number' && userId <= 0)) {
        return { success: false, error: 'Invalid user ID' };
      }

      // Reset password attempts when starting a new web login
      this.passwordAttempts.delete(userId);
      
      // Check if user already has a pending web login
      const existingWebLogin = this.pendingWebLogins.get(userId);
      if (existingWebLogin) {
        const age = Date.now() - (existingWebLogin.createdAt || 0);
        if (age < 300000) { // Less than 5 minutes old
          // Reuse existing QR code
          return { success: true, qrCode: existingWebLogin.qrCode };
        } else {
          // Clean up old web login
          if (existingWebLogin.client) {
            try {
              await existingWebLogin.client.disconnect();
            } catch (e) {
              // Ignore disconnect errors
            }
          }
          this.pendingWebLogins.delete(userId);
        }
      }

      const stringSession = new StringSession('');
      const client = new TelegramClient(stringSession, config.apiId, config.apiHash, {
        connectionRetries: 3, // Reduced from 5
        timeout: 10000,
        retryDelay: 5000, // Increased from 3000
        autoReconnect: false, // CRITICAL: Disable autoReconnect for web login
        useWSS: false,
      });

      // Setup error handlers
      setupClientErrorHandlers(client);

      await client.connect();

      // Export login token for QR code
      const result = await client.invoke(
        new Api.auth.ExportLoginToken({
          apiId: config.apiId,
          apiHash: config.apiHash,
          exceptIds: [],
        })
      );

      if (result instanceof Api.auth.LoginToken) {
        // Generate QR code using Telegram's login token format
        // result.token is a Buffer, convert to base64url (URL-safe base64) for tg:// protocol
        const tokenBase64 = result.token.toString('base64');
        // Convert to base64url: replace + with -, / with _, and remove padding =
        const tokenBase64Url = tokenBase64
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=/g, '');
        
        // Use tg:// protocol for mobile app login (this is what Telegram mobile apps scan)
        const qrData = `tg://login?token=${tokenBase64Url}`;
        const qrCode = await QRCode.toDataURL(qrData, {
          errorCorrectionLevel: 'M',
          type: 'image/png',
          width: 300,
          margin: 1,
        });

        // Convert data URL to buffer for Telegram
        const base64Data = qrCode.split(',')[1];
        const qrBuffer = Buffer.from(base64Data, 'base64');

        // Store pending web login
        const expiresAt = Date.now() + (result.expires * 1000); // Convert to milliseconds
        this.pendingWebLogins.set(userId, {
          client,
          token: result.token,
          expiresAt,
          createdAt: Date.now(),
          qrCode: qrBuffer,
          chatId: chatId, // Store chatId for notifications
          cancelled: false, // Flag to stop polling when cancelled
        });

        // Start polling for login completion
        this.pollWebLogin(userId).catch(err => {
          logError(`[WEB_LOGIN] Error polling web login for user ${userId}:`, err);
        });

        return { success: true, qrCode: qrBuffer };
      } else if (result instanceof Api.auth.LoginTokenSuccess) {
        // Already logged in - this shouldn't happen but handle it
        await client.disconnect();
        return { success: false, error: 'Already logged in' };
      } else {
        await client.disconnect();
        return { success: false, error: 'Unexpected response from Telegram' };
      }
    } catch (error) {
      logError('Error initiating web login:', error);
      return { success: false, error: error.message };
    }
  }

  async pollWebLogin(userId) {
    const pending = this.pendingWebLogins.get(userId);
    if (!pending) {
      return;
    }

    const maxWaitTime = pending.expiresAt - Date.now();
    const pollInterval = 2000; // Poll every 2 seconds
    const maxPolls = Math.floor(maxWaitTime / pollInterval);

    let polls = 0;
    const poll = async () => {
      // Check if cancelled
      const currentPending = this.pendingWebLogins.get(userId);
      if (!currentPending || currentPending.cancelled) {
        console.log(`[WEB_LOGIN] Polling stopped - web login cancelled for user ${userId}`);
        return;
      }
      
      if (polls >= maxPolls || Date.now() >= pending.expiresAt) {
        // Timeout - clean up
        console.log(`[WEB_LOGIN] QR code expired for user ${userId}`);
        if (pending.client) {
          try {
            // Disable autoReconnect before disconnecting
            if (pending.client._connection && pending.client._connection.autoReconnect) {
              pending.client._connection.autoReconnect = false;
            }
            await pending.client.disconnect();
          } catch (e) {
            // Ignore disconnect errors
          }
        }
        this.pendingWebLogins.delete(userId);
        return;
      }

      try {
        // Ensure client is connected
        if (!pending.client.connected) {
          try {
            await pending.client.connect();
          } catch (e) {
            // Connection failed, continue polling
            polls++;
            setTimeout(poll, pollInterval);
            return;
          }
        }

        // Check if client is authorized by trying to get user info
        // When QR code is scanned, the client becomes authorized
        try {
          const me = await pending.client.getMe();
          if (me && me.id) {
            // Login successful! Client is authorized
            console.log(`[WEB_LOGIN] QR code scanned successfully for user ${userId}`);
            const sessionString = pending.client.session.save();
            const firstName = me.firstName || null;
            const phone = me.phone || '';

            // Clean up
            this.pendingWebLogins.delete(userId);

            // Save account
            const saveResult = await this.saveLinkedAccount(userId, phone, sessionString, pending.client, firstName);

            // Set profile tags and join updates channel (async, don't block)
            this.setupAccountPostLink(saveResult.client, saveResult.accountId).catch(err => {
              logError(`[SETUP ERROR] Error setting up account ${saveResult.accountId}:`, err);
            });

            // Notify that login is complete
            logger.logSuccess('WEB_LOGIN', userId, `Account ${saveResult.accountId} linked successfully via web login`);
            console.log(`[WEB_LOGIN] Account ${saveResult.accountId} linked successfully for user ${userId}`);
            return;
          }
        } catch (error) {
          // Check error type to determine if user hasn't scanned yet or if 2FA is needed
          const errorMsg = error.errorMessage || error.message || '';
          const errorCode = error.code || '';
          
          // Check if 2FA password is required
          if (errorMsg === 'SESSION_PASSWORD_NEEDED' || 
              (errorCode === 401 && errorMsg.includes('PASSWORD'))) {
            console.log(`[WEB_LOGIN] 2FA password required for user ${userId} after QR scan`);
            
            // Get phone number from pending web login if available, or try to get from error
            // For web login, we might not have phone yet, so we'll use a placeholder
            // The phone will be available after password verification
            const phone = pending.phone || 'web_login';
            
            // Store client for password authentication
            if (this.pendingPasswordAuth.size > 100) {
              console.warn(`[MEMORY] Pending password auth Map is large (${this.pendingPasswordAuth.size} entries), cleaning up...`);
              this.cleanupPendingVerifications();
            }
            
            // Reset password attempts when starting new password auth (web login)
            this.passwordAttempts.delete(userId);
            this.pendingPasswordAuth.set(userId, {
              phone: phone,
              client: pending.client,
              createdAt: Date.now(),
              isWebLogin: true, // Flag to identify web login
              chatId: pending.chatId, // Store chatId for notification
            });
            
            // Clean up web login polling
            this.pendingWebLogins.delete(userId);
            
            // Signal that password is needed - handler will check and notify user
            console.log(`[WEB_LOGIN] Stopped polling, waiting for 2FA password for user ${userId}`);
            return; // Stop polling, password handler will take over
          }
          
          // If it's AUTH_KEY_UNREGISTERED or similar, user hasn't scanned yet - continue polling
          if (errorMsg.includes('AUTH_KEY_UNREGISTERED') || 
              errorMsg.includes('AUTH_KEY_INVALID') ||
              (errorCode === 401 && !errorMsg.includes('PASSWORD')) ||
              (errorMsg.includes('PHONE') && errorMsg.includes('UNOCCUPIED'))) {
            // Not authorized yet, continue polling
            polls++;
            setTimeout(poll, pollInterval);
            return;
          }
          
          // For other errors, log and continue polling (might be temporary connection issues)
          if (polls % 10 === 0) { // Only log every 10th poll to avoid spam
            console.log(`[WEB_LOGIN] Polling for user ${userId}, error: ${errorMsg || errorCode || 'Unknown'}`);
          }
          polls++;
          setTimeout(poll, pollInterval);
          return;
        }
      } catch (error) {
        // Check error type
        const errorMsg = error.errorMessage || error.message || '';
        
        // If it's a timeout or connection error, retry
        if (errorMsg.includes('TIMEOUT') || errorMsg.includes('Not connected')) {
          polls++;
          setTimeout(poll, pollInterval);
          return;
        }
        
        // If it's AUTH_KEY_UNREGISTERED, the token hasn't been used yet - continue polling
        if (errorMsg.includes('AUTH_KEY_UNREGISTERED') || errorMsg.includes('AUTH_KEY_INVALID')) {
          polls++;
          setTimeout(poll, pollInterval);
          return;
        }
        
        // Other errors - log and continue polling (might be temporary)
        console.log(`[WEB_LOGIN] Error polling for user ${userId}: ${errorMsg}`);
        polls++;
        setTimeout(poll, pollInterval);
      }
    };

    // Start polling after a short delay
    setTimeout(poll, pollInterval);
  }

  async cancelWebLogin(userId) {
    const pending = this.pendingWebLogins.get(userId);
    if (pending) {
      // Mark as cancelled to stop polling
      pending.cancelled = true;
      
      if (pending.client) {
        try {
          // Disable autoReconnect to prevent reconnection attempts
          if (pending.client._connection && pending.client._connection.autoReconnect !== undefined) {
            pending.client._connection.autoReconnect = false;
          }
          
          // Disconnect the client
          if (pending.client.connected) {
            await pending.client.disconnect();
          }
          
          // Remove all event listeners to prevent errors
          if (pending.client.removeAllListeners) {
            pending.client.removeAllListeners();
          }
        } catch (e) {
          // Ignore disconnect errors - client might already be disconnected
          console.log(`[WEB_LOGIN] Error during cancellation cleanup (expected): ${e.message}`);
        }
      }
      
      // Remove from pending web logins
      this.pendingWebLogins.delete(userId);
      logger.logChange('WEB_LOGIN', userId, 'Web login cancelled');
    }
  }

  async checkWebLoginStatus(userId) {
    const pending = this.pendingWebLogins.get(userId);
    if (!pending) {
      return { success: false, error: 'No pending web login found' };
    }

    // Check if expired
    if (Date.now() >= pending.expiresAt) {
      await this.cancelWebLogin(userId);
      return { success: false, error: 'QR code expired. Please try again.' };
    }

    // Check if login completed by checking if account was created
    const accounts = await this.getAccounts(userId);
    // This is a simple check - in a real implementation, you'd track which account was created via web login
    return { success: true, pending: true };
  }

  isWebLoginPasswordRequired(userId) {
    const pending = this.pendingPasswordAuth.get(userId);
    return pending && pending.isWebLogin === true;
  }

  getWebLoginPasswordNotification(userId) {
    const pending = this.pendingPasswordAuth.get(userId);
    if (pending && pending.isWebLogin === true && pending.chatId) {
      return { chatId: pending.chatId, notified: pending.notified || false };
    }
    return null;
  }

  markWebLoginPasswordNotified(userId) {
    const pending = this.pendingPasswordAuth.get(userId);
    if (pending && pending.isWebLogin === true) {
      pending.notified = true;
    }
  }

  getClient(userId, accountId = null) {
    if (accountId) {
      // Get specific account (userId can be null for admin operations)
      const accountIdStr = accountId.toString();
      const account = this.linkedAccounts.get(accountIdStr);
      if (account) {
        // If userId is provided, verify it matches; if null, allow access (admin operation)
        if (userId === null || account.userId.toString() === userId.toString()) {
          // Update last used timestamp
          this.updateLastUsed(accountId);
          return account.client;
        }
      }
      return null;
    }
    
    // Get active account for user (userId must be provided)
    if (userId === null) {
      return null;
    }
    
    const userIdStr = userId.toString();
    const accountIds = this.userAccounts.get(userIdStr);
    if (!accountIds || accountIds.size === 0) {
      return null;
    }
    
    for (const accId of accountIds) {
      const account = this.linkedAccounts.get(accId);
      if (account && account.isActive) {
        // Update last used timestamp
        this.updateLastUsed(account.accountId);
        return account.client;
      }
    }
    
    // If no active account, return first account
    const firstAccId = Array.from(accountIds)[0];
    const account = this.linkedAccounts.get(firstAccId);
    if (account) {
      // Update last used timestamp
      this.updateLastUsed(account.accountId);
    }
    return account ? account.client : null;
  }

  // Get client and ensure it's connected (for use when sending messages)
  async getClientAndConnect(userId, accountId = null) {
    // If accountId is provided, use it directly (userId can be null for admin operations)
    const targetAccountId = accountId || (userId ? this.getActiveAccountId(userId) : null);
    if (!targetAccountId) {
      return null;
    }
    
    const account = this.linkedAccounts.get(targetAccountId.toString());
    if (!account) {
      return null;
    }
    
    // CRITICAL: Prevent main account from being used for broadcasting
    if (config.mainAccountPhone && account.phone === config.mainAccountPhone.trim()) {
      const errorMsg = `Cannot use main account (${account.phone}) for broadcasting. This account is used to create the bot and APIs.`;
      console.log(`[ACCOUNT PROTECTION] ⚠️  Attempted to use main account ${targetAccountId} (${account.phone}) for broadcasting - BLOCKED`);
      logError(`[ACCOUNT PROTECTION] Attempted to use main account for broadcasting`, new Error(errorMsg));
      throw new Error(errorMsg);
    }
    
    const client = this.getClient(userId, targetAccountId);
    if (!client) {
      return null;
    }
    
    return await this.ensureConnected(targetAccountId);
  }

  getActiveAccountId(userId) {
    const userIdStr = userId.toString();
    const accountIds = this.userAccounts.get(userIdStr);
    if (!accountIds || accountIds.size === 0) {
      return null;
    }
    
    // Find the active account
    for (const accId of accountIds) {
      const account = this.linkedAccounts.get(accId);
      if (account && account.isActive) {
        return account.accountId;
      }
    }
    
    // No active account found - this shouldn't happen after loadLinkedAccounts fix
    // But if it does, return null instead of falling back to first account
    console.log(`[ACCOUNT] Warning: No active account found for user ${userIdStr}, but accounts exist`);
    return null;
  }

  async getAccounts(userId) {
    const userIdStr = userId.toString();
    const accountIds = this.userAccounts.get(userIdStr);
    if (!accountIds || accountIds.size === 0) {
      return [];
    }
    
    const accounts = [];
    for (const accId of accountIds) {
      const account = this.linkedAccounts.get(accId);
      if (account) {
        accounts.push({
          accountId: account.accountId,
          phone: account.phone,
          firstName: account.firstName || null,
          isActive: account.isActive,
        });
      }
    }
    
    return accounts;
  }

  async switchActiveAccount(userId, accountId) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const userIdStr = userIdNum.toString();
      
      // Verify account belongs to user
      const account = this.linkedAccounts.get(accountIdNum.toString());
      if (!account || account.userId.toString() !== userIdStr) {
        return { success: false, error: 'Account not found or does not belong to user' };
      }
      
      // Set all accounts for this user to inactive (ensure only one active)
      await db.query(
        'UPDATE accounts SET is_active = FALSE WHERE user_id = $1',
        [userIdNum]
      );
      
      // Set selected account as active
      await db.query(
        'UPDATE accounts SET is_active = TRUE WHERE account_id = $1',
        [accountIdNum]
      );
      
      // Update in-memory cache - set all to false first, then set selected to true
      const accountIds = this.userAccounts.get(userIdStr);
      if (accountIds) {
        for (const accId of accountIds) {
          const acc = this.linkedAccounts.get(accId);
          if (acc) {
            acc.isActive = false;
          }
        }
      }
      
      // Set only the selected account as active
      account.isActive = true;
      
      // Verify only one account is active (safety check)
      let activeCount = 0;
      if (accountIds) {
        for (const accId of accountIds) {
          const acc = this.linkedAccounts.get(accId);
          if (acc && acc.isActive) {
            activeCount++;
          }
        }
      }
      
      if (activeCount !== 1) {
        logError(`[ACCOUNT ERROR] Multiple accounts active after switch! Active count: ${activeCount} for user ${userIdNum}`);
      }
      
      console.log(`[ACCOUNT] Switched active account to ${accountIdNum} for user ${userIdNum} (${activeCount} active account(s))`);
      logger.logChange('SWITCH_ACCOUNT', userIdNum, `Switched to account ${accountIdNum}`);
      return { success: true };
    } catch (error) {
      logError('[ACCOUNT ERROR] Error switching active account:', error);
      return { success: false, error: error.message };
    }
  }

  isLinked(userId) {
    const userIdStr = userId.toString();
    return this.userAccounts.has(userIdStr) && this.userAccounts.get(userIdStr).size > 0;
  }

  async disconnect(userId, accountId = null) {
    if (accountId) {
      await this.deleteLinkedAccount(accountId);
    } else {
      // Disconnect all accounts for user
    const userIdStr = userId.toString();
      const accountIds = this.userAccounts.get(userIdStr);
      if (accountIds) {
        for (const accId of accountIds) {
          await this.deleteLinkedAccount(accId);
        }
      }
    }
  }

  async setupAccountPostLink(client, accountId) {
    try {
      console.log(`[SETUP] Setting up account ${accountId} - tags and updates channel`);
      
      // Ensure client is connected for setup
      // If client is already connected (from password verification), use it directly
      if (!client.connected) {
        try {
          await client.connect();
          console.log(`[SETUP] Connected client for account ${accountId} setup`);
        } catch (error) {
          // If connection fails, wait a moment and retry (session might need time to be ready)
          const errorMsg = error.errorMessage || error.message || '';
          if (errorMsg.includes('SESSION_PASSWORD_NEEDED') || errorMsg.includes('AUTH_KEY')) {
            console.log(`[SETUP] Session not ready yet for account ${accountId}, waiting before retry...`);
            await new Promise(resolve => setTimeout(resolve, 1500)); // Wait 1.5 seconds
            await client.connect();
            console.log(`[SETUP] Connected client for account ${accountId} setup (after retry)`);
          } else {
            throw error; // Re-throw other errors
          }
        }
      }
      
      // Add delays between setup operations to prevent rapid API calls
      // Set profile tags
      await this.setProfileTags(client, accountId);
      
      // Wait 2 seconds before next operation
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Join updates channel
      await this.joinUpdatesChannel(client, accountId);
      
      // Wait 2 seconds before next operation
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Fetch and save groups
      await this.fetchAndSaveGroups(client, accountId);
      
      console.log(`[SETUP] Account ${accountId} setup completed`);
    } catch (error) {
      logError(`[SETUP ERROR] Error setting up account ${accountId}:`, error);
    } finally {
      // Disconnect client after setup (accounts only active when needed)
      if (client && client.connected) {
        try {
          await client.disconnect();
          console.log(`[SETUP] Disconnected client for account ${accountId} after setup`);
        } catch (disconnectError) {
          logError(`[SETUP ERROR] Error disconnecting client:`, disconnectError);
        }
      }
    }
  }

  async setProfileTags(client, accountId) {
    try {
      // Check if user has premium subscription (skip tags for premium users)
      const account = this.linkedAccounts.get(accountId.toString());
      if (account && account.userId) {
        const isPremium = await premiumService.isPremium(account.userId);
        if (isPremium) {
          console.log(`[TAGS] Skipping tag setting for premium user ${account.userId}, account ${accountId}`);
          // Update tags_last_verified timestamp to indicate tags are "verified" (skipped)
          await db.query(
            'UPDATE accounts SET tags_last_verified = CURRENT_TIMESTAMP WHERE account_id = ?',
            [accountId]
          );
          return;
        }
      }

      console.log(`[TAGS] Setting profile tags for account ${accountId}`);
      
      // Get current profile
      const me = await client.getMe();
      const fullUser = await client.invoke(
        new Api.users.GetFullUser({
          id: me.id,
        })
      );
      
      // Use firstname from config if set, otherwise clean legacy tags from current first name
      let cleanedFirstName;
      if (config.firstName && config.firstName.trim()) {
        cleanedFirstName = config.firstName.trim();
      } else {
        cleanedFirstName = me.firstName || '';
        cleanedFirstName = cleanedFirstName
          .replace('| Ora Ads', '')
          .replace(' | Ora Ads', '')
          .replace('| Lux Cast', '')
          .replace(' | Lux Cast', '')
          .replace('| Coup Bot', '')
          .replace(' | Coup Bot', '')
          .replace('| CoupBot', '')
          .replace(' | CoupBot', '')
          .trim();
      }
      
      // Update profile with tags
      await client.invoke(
        new Api.account.UpdateProfile({
          firstName: cleanedFirstName,
          lastName: NAME_TAG,
          about: BIO_TAG,
        })
      );
      
      // Wait a bit for update to propagate
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Verify tags were set
      const meUpdated = await client.getMe();
      const fullUserUpdated = await client.invoke(
        new Api.users.GetFullUser({
          id: meUpdated.id,
        })
      );
      
      const bioUpdated = fullUserUpdated.fullUser.about || '';
      const hasNameTag = meUpdated.lastName && meUpdated.lastName.includes(NAME_TAG);
      const hasBioTag = this.bioMatches(bioUpdated);
      
      if (hasNameTag && hasBioTag) {
        console.log(`[TAGS] Profile tags set successfully for account ${accountId}`);
        // Update tags_last_verified timestamp
        // SQLite uses ? placeholders
        await db.query(
          'UPDATE accounts SET tags_last_verified = CURRENT_TIMESTAMP WHERE account_id = ?',
          [accountId]
        );
      } else {
        console.warn(`[TAGS] Tags set but verification failed for account ${accountId} - name: ${hasNameTag}, bio: ${hasBioTag}`);
      }
    } catch (error) {
      logError(`[TAGS ERROR] Error setting profile tags for account ${accountId}:`, error);
    }
  }

  /**
   * Remove profile tags from account (for premium users)
   * @param {TelegramClient} client - Telegram client
   * @param {number} accountId - Account ID
   */
  async removeProfileTags(client, accountId) {
    try {
      if (!client) {
        return { success: false, error: 'Client not available' };
      }

      console.log(`[TAGS] Removing profile tags for account ${accountId}`);
      
      // Ensure client is connected
      if (!client.connected) {
        await client.connect();
      }

      // Get current profile to preserve firstName
      const me = await client.getMe();
      const fullUser = await client.invoke(
        new Api.users.GetFullUser({
          id: me.id,
        })
      );

      // Clean firstName (remove any existing tags)
      let cleanedFirstName = me.firstName || '';
      cleanedFirstName = cleanedFirstName
        .replace('| Ora Ads', '')
        .replace(' | Ora Ads', '')
        .replace('| Lux Cast', '')
        .replace(' | Lux Cast', '')
        .replace('| Coup Bot', '')
        .replace(' | Coup Bot', '')
        .replace('| CoupBot', '')
        .replace(' | CoupBot', '')
        .trim();

      // Remove tags: set lastName to empty and about to empty
      await client.invoke(
        new Api.account.UpdateProfile({
          firstName: cleanedFirstName,
          lastName: '', // Remove lastName tag
          about: '', // Remove bio tag
        })
      );

      // Wait for update to propagate
      await new Promise(resolve => setTimeout(resolve, 2000));

      console.log(`[TAGS] Profile tags removed successfully for account ${accountId}`);
      
      // Update tags_last_verified timestamp
      await db.query(
        'UPDATE accounts SET tags_last_verified = CURRENT_TIMESTAMP WHERE account_id = ?',
        [accountId]
      );

      return { success: true };
    } catch (error) {
      logError(`[TAGS ERROR] Error removing profile tags for account ${accountId}:`, error);
      return { success: false, error: error.message };
    }
  }

  bioMatches(bio) {
    if (!bio) return false;
    const normalized = bio.toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    // Check for "powered by @coupbot" (case insensitive, flexible spacing)
    const hasPoweredBy = normalized.includes('powered by');
    const hasHandle = normalized.includes('@coupbot');
    const hasEmojis = bio.includes('🤖') && bio.includes('🚀');
    
    // More lenient check: if bio contains the exact BIO_TAG (case insensitive), accept it
    const bioTagNormalized = BIO_TAG.toLowerCase().replace(/\s+/g, ' ').trim();
    const bioContainsTag = normalized.includes(bioTagNormalized);
    
    // Return true if either the strict check passes OR the bio contains the tag
    return (hasPoweredBy && hasHandle && hasEmojis) || bioContainsTag;
  }

  // Check if account has required tags
  async checkAccountTags(accountId) {
    try {
      const account = this.linkedAccounts.get(accountId.toString());
      if (!account || !account.client) {
        return { hasTags: false, error: 'Account or client not found' };
      }

      // Check if user has premium subscription (skip tag check for premium users)
      if (account.userId) {
        const isPremium = await premiumService.isPremium(account.userId);
        if (isPremium) {
          console.log(`[TAGS] Skipping tag check for premium user ${account.userId}, account ${accountId}`);
          return {
            hasTags: true,
            hasNameTag: true,
            hasBioTag: true,
            lastName: '[Premium - Tags Skipped]',
            bio: '[Premium - Tags Skipped]',
            isPremium: true
          };
        }
      }

      const client = account.client;
      
      // Ensure client is connected
      if (!client.connected) {
        await client.connect();
      }

      // Get current profile
      const me = await client.getMe();
      const fullUser = await client.invoke(
        new Api.users.GetFullUser({
          id: me.id,
        })
      );

      const lastName = me.lastName || '';
      const bio = fullUser.fullUser.about || '';

      const hasNameTag = lastName.includes(NAME_TAG);
      const hasBioTag = this.bioMatches(bio);

      return {
        hasTags: hasNameTag && hasBioTag,
        hasNameTag,
        hasBioTag,
        lastName,
        bio,
      };
    } catch (error) {
      logError(`[TAGS CHECK] Error checking tags for account ${accountId}:`, error);
      return { hasTags: false, error: error.message };
    }
  }

  // Apply tags to account profile (public method for manual application)
  async applyAccountTags(accountId) {
    try {
      const account = this.linkedAccounts.get(accountId.toString());
      if (!account || !account.client) {
        return { success: false, error: 'Account or client not found' };
      }

      // Check if user has premium subscription (skip tags for premium users)
      if (account.userId) {
        const isPremium = await premiumService.isPremium(account.userId);
        if (isPremium) {
          console.log(`[TAGS] Skipping tag application for premium user ${account.userId}, account ${accountId}`);
          // Update tags_last_verified timestamp to indicate tags are "verified" (skipped)
          await db.query(
            'UPDATE accounts SET tags_last_verified = CURRENT_TIMESTAMP WHERE account_id = ?',
            [accountId]
          );
          return { success: true, skipped: true, reason: 'Premium user - tags not required' };
        }
      }

      const client = account.client;
      
      // Ensure client is connected
      if (!client.connected) {
        await client.connect();
      }

      // Use the existing setProfileTags method
      await this.setProfileTags(client, accountId);
      
      // Verify tags were set with retry logic (Telegram API can be slow to propagate)
      let tagsCheck;
      const maxRetries = 5; // Increased from 3 to 5 for better reliability
      let retries = maxRetries;
      let lastCheck;
      let attemptNumber = 0;
      
      while (retries > 0) {
        attemptNumber++;
        // Wait before checking (increasing wait time for each retry: 3s, 5s, 7s, 9s, 11s)
        const waitTime = (maxRetries - retries) * 2000 + 1000; // 3s, 5s, 7s, 9s, 11s
        if (waitTime > 0) {
          console.log(`[TAGS] Waiting ${waitTime/1000}s before verification attempt ${attemptNumber}/${maxRetries}...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        tagsCheck = await this.checkAccountTags(accountId);
        
        // Log detailed verification info
        console.log(`[TAGS] Verification attempt ${attemptNumber}/${maxRetries} for account ${accountId}:`);
        console.log(`[TAGS]   - Last Name: "${tagsCheck.lastName || '(empty)'}" (has tag: ${tagsCheck.hasNameTag})`);
        console.log(`[TAGS]   - Bio: "${tagsCheck.bio || '(empty)'}" (has tag: ${tagsCheck.hasBioTag})`);
        console.log(`[TAGS]   - Expected Last Name Tag: "${NAME_TAG}"`);
        console.log(`[TAGS]   - Expected Bio Tag: "${BIO_TAG}"`);
        
        if (tagsCheck.hasTags) {
          console.log(`[TAGS] ✅ Profile tags applied and verified for account ${accountId} (attempt ${attemptNumber}/${maxRetries})`);
          return { success: true };
        }
        
        lastCheck = tagsCheck;
        retries--;
        
        if (retries > 0) {
          console.log(`[TAGS] ⚠️ Verification attempt ${attemptNumber}/${maxRetries} failed for account ${accountId} - name: ${tagsCheck.hasNameTag}, bio: ${tagsCheck.hasBioTag}. Retrying...`);
        }
      }
      
      // All retries failed - provide detailed error message
      console.warn(`[TAGS] ❌ Tags applied but verification failed after ${maxRetries} attempts for account ${accountId}`);
      console.warn(`[TAGS] Final check - Last Name: "${lastCheck.lastName || '(empty)'}", Bio: "${lastCheck.bio || '(empty)'}"`);
      
      const missingTags = [];
      if (!lastCheck.hasNameTag) {
        missingTags.push(`Last Name tag (expected: "${NAME_TAG}", got: "${lastCheck.lastName || '(empty)'}")`);
      }
      if (!lastCheck.hasBioTag) {
        missingTags.push(`Bio tag (expected: "${BIO_TAG}", got: "${lastCheck.bio || '(empty)'}")`);
      }
      
      const errorMessage = missingTags.length > 0 
        ? `Tags applied but verification failed after ${maxRetries} attempts. Missing: ${missingTags.join('; ')}. This may be due to Telegram API delays or profile restrictions. Please wait a moment and try again, or set tags manually.`
        : 'Tags applied but verification failed. Please try again or set tags manually in your Telegram profile.';
      
      return { success: false, error: errorMessage, details: lastCheck };
    } catch (error) {
      logError(`[TAGS ERROR] Error applying profile tags for account ${accountId}:`, error);
      return { success: false, error: error.message || 'Unknown error occurred while applying tags' };
    }
  }

  /**
   * Join ALL configured updates channels for an account
   * Accounts must join ALL channels (not just one) to ensure they stay connected
   * This is called automatically when an account is linked
   */
  async joinUpdatesChannel(client, accountId) {
    try {
      const updatesChannels = config.getUpdatesChannels();
      
      if (updatesChannels.length === 0) {
        console.log(`[UPDATES] No updates channels configured, skipping for account ${accountId}`);
        return;
      }
      
      console.log(`[UPDATES] Joining ALL ${updatesChannels.length} updates channel(s) for account ${accountId}`);
      
      let joinedCount = 0;
      let alreadyInCount = 0;
      let failedCount = 0;
      
      // Join each updates channel (must join ALL of them)
      for (const channelConfig of updatesChannels) {
        try {
          let target = channelConfig.trim();
          
          // Normalize channel identifier
          if (target.startsWith('http')) {
            target = target.split('/').pop();
          }
          target = target.replace('joinchat/', '').replace('t.me/', '').trim();
          
          if (channelConfig.toLowerCase().includes('joinchat') || target.startsWith('+')) {
            // Invite link
            const inviteHash = target.replace('+', '').split('/').pop();
            await client.invoke(
              new Api.messages.ImportChatInvite({
                hash: inviteHash,
              })
            );
            console.log(`[UPDATES] Successfully joined updates channel via invite link for account ${accountId}`);
            joinedCount++;
          } else {
            // Username-based channel
            if (!target.startsWith('@')) {
              target = `@${target}`;
            }
            const entity = await client.getEntity(target);
            await client.invoke(
              new Api.channels.JoinChannel({
                channel: entity,
              })
            );
            console.log(`[UPDATES] Successfully joined updates channel ${target} for account ${accountId}`);
            joinedCount++;
          }
        } catch (error) {
          if (error.errorMessage && error.errorMessage.includes('USER_ALREADY_PARTICIPANT')) {
            console.log(`[UPDATES] Already in updates channel "${channelConfig}" for account ${accountId}`);
            alreadyInCount++;
          } else {
            logError(`[UPDATES ERROR] Error joining updates channel "${channelConfig}" for account ${accountId}:`, error);
            failedCount++;
            // Continue with other channels even if one fails
          }
        }
      }
      
      console.log(`[UPDATES] Finished joining updates channels for account ${accountId}: ${joinedCount} joined, ${alreadyInCount} already in, ${failedCount} failed`);
      
      if (failedCount > 0) {
        console.warn(`[UPDATES] Warning: Failed to join ${failedCount} out of ${updatesChannels.length} updates channel(s) for account ${accountId}`);
      }
    } catch (error) {
      logError(`[UPDATES ERROR] Error in joinUpdatesChannel for account ${accountId}:`, error);
    }
  }

  /**
   * Check if a dialog is one of the updates channels (should be excluded from groups)
   */
  async isUpdatesChannel(dialog, client) {
    const updatesChannels = config.getUpdatesChannels();
    
    if (updatesChannels.length === 0) {
      return false;
    }
    
    try {
      const dialogName = (dialog.name || '').toLowerCase();
      const dialogUsername = (dialog.entity?.username || '').toLowerCase();
      
      // Check against all configured updates channels
      for (const channelConfig of updatesChannels) {
        const updatesChannelName = channelConfig.replace('@', '').toLowerCase();
        
        // Check by username or name
        if (dialogUsername === updatesChannelName || dialogName === updatesChannelName) {
          return true;
        }
        
        // Check by entity ID if we can resolve the updates channel
        try {
          const updatesEntity = await client.getEntity(channelConfig);
          if (updatesEntity && dialog.entity && updatesEntity.id && dialog.entity.id) {
            const updatesId = updatesEntity.id.toString();
            const dialogId = dialog.entity.id.toString();
            if (updatesId === dialogId) {
              return true;
            }
          }
        } catch (e) {
          // If we can't resolve, skip ID check for this channel
        }
      }
      
      return false;
    } catch (error) {
      // If check fails, don't exclude (safer to include than exclude incorrectly)
      return false;
    }
  }

  async fetchAndSaveGroups(client, accountId) {
    try {
      console.log(`[GROUPS] Fetching groups for account ${accountId}`);
      
      const dialogs = await client.getDialogs();
      
      // Filter out updates channel from groups
      const groups = [];
      for (const dialog of dialogs) {
        if ((dialog.isGroup || dialog.isChannel)) {
          // Skip updates channel
          const isUpdates = await this.isUpdatesChannel(dialog, client);
          if (!isUpdates) {
            groups.push(dialog);
          } else {
            console.log(`[GROUPS] Excluding updates channel "${dialog.name}" from groups list`);
          }
        }
      }
      
      console.log(`[GROUPS] Found ${groups.length} groups for account ${accountId} (updates channel excluded)`);
      
      // Save groups to database
      for (const group of groups) {
        try {
          const groupId = group.entity.id.toString();
          const groupTitle = group.name || 'Unknown';
          
          // SQLite uses INTEGER (0/1) for booleans and EXCLUDED for ON CONFLICT
          await db.query(
            `INSERT INTO groups (account_id, group_id, group_title, is_active, last_message_sent)
             VALUES (?, ?, ?, 1, NULL)
             ON CONFLICT (account_id, group_id) 
             DO UPDATE SET group_title = EXCLUDED.group_title, is_active = 1`,
            [accountId, groupId, groupTitle]
          );
        } catch (error) {
          logError(`[GROUPS ERROR] Error saving group ${group.name} for account ${accountId}:`, error);
        }
      }
      
      console.log(`[GROUPS] Saved ${groups.length} groups for account ${accountId}`);
    } catch (error) {
      logError(`[GROUPS ERROR] Error fetching groups for account ${accountId}:`, error);
    }
  }
}

export default new AccountLinker();
