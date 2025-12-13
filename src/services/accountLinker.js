import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { Api } from 'telegram/tl/index.js';
import { config } from '../config.js';
import db from '../database/db.js';
import logger, { colors, logError } from '../utils/logger.js';
import adminNotifier from './adminNotifier.js';

// Profile tag constants
const NAME_TAG = '| OraAdbot 🪽';
const BIO_TAG = 'Powered by @OraAdbot  🤖🚀';

class AccountLinker {
  constructor() {
    this.linkedAccounts = new Map(); // accountId -> { userId, phone, sessionString, client, isActive }
    this.userAccounts = new Map(); // userId -> Set of accountIds
    this.pendingVerifications = new Map(); // userId -> { phone, phoneCodeHash, client }
    this.pendingPasswordAuth = new Map(); // userId -> { phone, client }
    // Keep-alive removed - clients connect on-demand
    this.initialized = false;
  }

  async initialize() {
    if (!this.initialized) {
      await this.loadLinkedAccounts();
      this.initialized = true;
    }
  }

  // Ensure client is connected (connect on-demand)
  async ensureConnected(accountId) {
    const accountIdStr = accountId.toString();
    const account = this.linkedAccounts.get(accountIdStr);
    
    if (!account || !account.client) {
      throw new Error(`Account ${accountId} not found`);
    }
    
    if (!account.client.connected) {
      console.log(`[CONNECTION] Connecting client for account ${accountId}...`);
      try {
        await account.client.connect();
        console.log(`[CONNECTION] Connected client for account ${accountId}`);
      } catch (error) {
        logError(`[CONNECTION ERROR] Failed to connect account ${accountId}:`, error);
        // Check if session is revoked
        if (error.errorMessage === 'SESSION_REVOKED' || (error.code === 401 && error.message && error.message.includes('SESSION_REVOKED'))) {
          await this.handleSessionRevoked(accountId);
        }
        throw error;
      }
    }
    
    return account.client;
  }

  async handleSessionRevoked(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const accountIdStr = accountId.toString();
      const account = this.linkedAccounts.get(accountIdStr);
      
      // Get account info from database before deletion (for logging)
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
        logError(`[ACCOUNT ERROR] Error fetching account info before deletion:`, error);
      }
      
      // Note: Broadcast stopping is handled in handleDeleteAccount handler
      // to avoid circular dependency. Session revocation will be caught during
      // sendSingleMessageToAllGroups and broadcast will be stopped there.
      
      // No keep-alive intervals to clear (removed)
      
      if (account) {
        // Disconnect the client
        try {
          if (account.client && account.client.connected) {
            await account.client.disconnect();
            console.log(`[ACCOUNT] Disconnected client for account ${accountId}`);
          }
        } catch (error) {
          logError(`[ACCOUNT ERROR] Error disconnecting client:`, error);
        }
        
        // Remove from memory
        this.linkedAccounts.delete(accountIdStr);
        console.log(`[ACCOUNT] Removed account ${accountId} from memory`);
        
        // Remove from user accounts tracking
        const userIdStr = account.userId.toString();
        const userAccountIds = this.userAccounts.get(userIdStr);
        if (userAccountIds) {
          userAccountIds.delete(accountIdStr);
          // If user has no more accounts, remove the user entry
          if (userAccountIds.size === 0) {
            this.userAccounts.delete(userIdStr);
          }
        }
      }
      
      // Delete account from database (CASCADE will delete related data)
      const deleteResult = await db.query(
        'DELETE FROM accounts WHERE account_id = $1',
        [accountIdNum]
      );
      
      if (deleteResult.rowCount > 0) {
        const phone = accountInfo?.phone || account?.phone || 'unknown';
        const userId = accountInfo?.user_id || account?.userId || null;
        console.log(`[ACCOUNT] Session revoked - Deleted account ${accountId} (${phone}) from database. All related data has been removed.`);
        logger.logChange('SESSION_REVOKED', userId, `Account ${accountId} (${phone}) deleted due to revoked session`);
        
        // Notify admins of session revocation
        adminNotifier.notifyEvent('SESSION_REVOKED', `Account ${accountId} session revoked and deleted`, {
          userId,
          accountId,
          phone,
          details: 'Session was revoked by user, account and all related data deleted',
        }).catch(() => {}); // Silently fail to avoid blocking
        
        return { success: true };
      } else {
        console.log(`[ACCOUNT] Account ${accountId} not found in database (may have been already deleted)`);
        return { success: false, error: 'Account not found in database' };
      }
    } catch (error) {
      logError(`[ACCOUNT ERROR] Error handling revoked session for account ${accountId}:`, error);
      logger.logError('SESSION_REVOKED', null, error, `Failed to delete account ${accountId}`);
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
              'UPDATE accounts SET is_active = FALSE WHERE account_id = $1',
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
            'UPDATE accounts SET is_active = TRUE WHERE account_id = $1',
            [firstAccountId]
          );
          userActiveAccounts.set(userIdStr, firstAccountId);
          console.log(`[ACCOUNT] Fixed: Activated first account ${firstAccountId} for user ${userIdStr} (no active account found)`);
        }
      }
      
      // Restore clients from saved sessions
      for (const row of result.rows) {
        try {
          // Skip if session string is null (revoked session)
          if (!row.session_string) {
            console.log(`[ACCOUNT] Skipping account ${row.account_id} - session revoked (needs re-authentication)`);
            continue;
          }
          
          const stringSession = new StringSession(row.session_string);
          const client = new TelegramClient(stringSession, config.apiId, config.apiHash, {
            connectionRetries: 5,
            timeout: 10000,
            retryDelay: 3000,
            autoReconnect: true,
            useWSS: false,
          });
          
          // Connect client to verify session is valid, then disconnect
          await client.connect();
          
          // Suppress timeout errors from update loop (these are normal and expected)
          // The update loop times out when there are no updates, which is fine
          const originalEmit = client.emit?.bind(client);
          if (originalEmit) {
            client.emit = function(event, ...args) {
              // Filter out timeout errors from update loop
              if (event === 'error' && args[0] && args[0].message === 'TIMEOUT') {
                // Don't emit timeout errors - they're normal
                return false;
              }
              return originalEmit(event, ...args);
            };
          }
          
          // Disconnect after verifying session - clients will connect on-demand when needed
          await client.disconnect();
          console.log(`[ACCOUNT] Verified and disconnected account ${row.account_id} (will connect on-demand)`);
          
          // Wrap client methods to catch SESSION_REVOKED errors
          const originalInvoke = client.invoke.bind(client);
          const accountIdForRevoke = row.account_id; // Capture account ID for closure
          const self = this; // Capture 'this' for use in closure
          client.invoke = async function(...args) {
            try {
              return await originalInvoke(...args);
            } catch (error) {
              if (error.errorMessage === 'SESSION_REVOKED' || (error.code === 401 && error.message && error.message.includes('SESSION_REVOKED'))) {
                logError(`[ACCOUNT ERROR] Session revoked detected for account ${accountIdForRevoke} during API call`);
                await self.handleSessionRevoked(accountIdForRevoke);
                throw error;
              }
              throw error;
            }
          };
          
          const accountId = row.account_id.toString();
          const userIdStr = row.user_id.toString();
          // Use the corrected active status from userActiveAccounts
          const isActive = userActiveAccounts.get(userIdStr) === row.account_id;
          
          this.linkedAccounts.set(accountId, {
            accountId: row.account_id,
            userId: row.user_id,
            phone: row.phone,
            firstName: row.first_name || null,
            sessionString: row.session_string,
            client,
            isActive: isActive,
          });
          
          // Track accounts per user
          if (!this.userAccounts.has(userIdStr)) {
            this.userAccounts.set(userIdStr, new Set());
          }
          this.userAccounts.get(userIdStr).add(accountId);
          
          console.log(`[ACCOUNT] Loaded account ${accountId} for user ${userIdStr}, phone: ${row.phone}, first_name: ${row.first_name || 'N/A'}, active: ${isActive}`);
        } catch (error) {
          // Check if it's a SESSION_REVOKED error
          if (error.errorMessage === 'SESSION_REVOKED' || (error.code === 401 && error.message && error.message.includes('SESSION_REVOKED'))) {
            logError(`[ACCOUNT ERROR] Session revoked for account ${row.account_id} during load`);
            await this.handleSessionRevoked(row.account_id);
          } else {
            logError(`[ACCOUNT ERROR] Error restoring client for account ${row.account_id}:`, error);
          }
        }
      }
    } catch (error) {
      logError('[ACCOUNT ERROR] Error loading accounts from database:', error);
    }
  }

  async saveLinkedAccount(userId, phone, sessionString, client = null, firstName = null) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      
      // Check if account already exists
      const existing = await db.query(
        'SELECT account_id, is_active FROM accounts WHERE user_id = $1 AND phone = $2',
        [userIdNum, phone]
      );
      
      let accountId;
      let isActive = false;
      
      if (existing.rows.length > 0) {
        // Update existing account
        accountId = existing.rows[0].account_id;
        isActive = existing.rows[0].is_active;
        await db.query(
          `UPDATE accounts 
           SET session_string = $1, first_name = $2, updated_at = CURRENT_TIMESTAMP 
           WHERE account_id = $3`,
          [sessionString, firstName, accountId]
        );
        console.log(`[ACCOUNT] Updated account ${accountId} for user ${userIdNum}`);
      } else {
        // Check if this will be the first account (set as active only if no accounts exist)
        const userAccounts = await db.query(
          'SELECT COUNT(*) as count FROM accounts WHERE user_id = $1',
          [userIdNum]
        );
        const accountCount = parseInt(userAccounts.rows[0].count);
        
        // Only set as active if this is the first account for the user
        // If other accounts exist, ensure they're deactivated first
        if (accountCount === 0) {
          isActive = true;
        } else {
          // New account - set existing accounts to inactive first
          await db.query(
            'UPDATE accounts SET is_active = FALSE WHERE user_id = $1',
            [userIdNum]
          );
          isActive = true; // Set new account as active
          console.log(`[ACCOUNT] Deactivated ${accountCount} existing account(s) before adding new active account for user ${userIdNum}`);
        }
        
        // Insert new account
        const result = await db.query(
          `INSERT INTO accounts (user_id, phone, session_string, first_name, is_active, updated_at)
           VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
           RETURNING account_id`,
          [userIdNum, phone, sessionString, firstName, isActive]
      );
        accountId = result.rows[0].account_id;
        console.log(`[ACCOUNT] Created account ${accountId} for user ${userIdNum}, active: ${isActive}`);
        
        // Notify admins of successful account linking
        adminNotifier.notifyEvent('ACCOUNT_LINKED', `New account linked successfully`, {
          userId: userIdNum,
          accountId,
          phone,
          details: `Account ${accountId} linked for user ${userIdNum} (${phone})`,
        }).catch(() => {}); // Silently fail to avoid blocking
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
      
      // Use provided client or create new one
      let accountClient = client;
      if (!accountClient) {
        const stringSession = new StringSession(sessionString);
        accountClient = new TelegramClient(stringSession, config.apiId, config.apiHash, {
          connectionRetries: 5,
          timeout: 10000,
          retryDelay: 3000,
          autoReconnect: true,
          useWSS: false,
        });
        
        // Suppress timeout errors from update loop (these are normal and expected)
        const originalEmit = accountClient.emit?.bind(accountClient);
        if (originalEmit) {
          accountClient.emit = function(event, ...args) {
            // Filter out timeout errors from update loop
            if (event === 'error' && args[0] && args[0].message === 'TIMEOUT') {
              // Don't emit timeout errors - they're normal
              return false;
            }
            return originalEmit(event, ...args);
          };
        }
        
        // Connect to verify session, then disconnect
        await accountClient.connect();
        await accountClient.disconnect();
        console.log(`[ACCOUNT] Verified new account ${accountId} session (will connect on-demand)`);
      } else {
        // If client was provided (from OTP/password flow), add error filtering and disconnect it
        const originalEmit = accountClient.emit?.bind(accountClient);
        if (originalEmit) {
          accountClient.emit = function(event, ...args) {
            // Filter out timeout errors from update loop
            if (event === 'error' && args[0] && args[0].message === 'TIMEOUT') {
              // Don't emit timeout errors - they're normal
              return false;
            }
            return originalEmit(event, ...args);
          };
        }
        
        try {
          if (accountClient.connected) {
            await accountClient.disconnect();
            console.log(`[ACCOUNT] Disconnected provided client for account ${accountId} (will connect on-demand)`);
          }
        } catch (error) {
          logError(`[ACCOUNT ERROR] Error disconnecting provided client:`, error);
        }
      }
      
      const accountIdStr = accountId.toString();
      this.linkedAccounts.set(accountIdStr, {
        accountId,
        userId: userIdNum,
        phone,
        firstName: firstName || null,
        sessionString,
        client: accountClient,
        isActive,
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
      
      // Disconnect client if connected
      if (account.client) {
        try {
          if (account.client.connected) {
            await account.client.disconnect();
            console.log(`[DELETE ACCOUNT] Disconnected client for account ${accountId}`);
          }
        } catch (e) {
          logError(`[ACCOUNT ERROR] Error disconnecting client for account ${accountId}:`, e);
        }
      }
      
      // Delete from database (CASCADE will delete related data)
      await db.query('DELETE FROM accounts WHERE account_id = $1', [accountIdNum]);
      
      // Remove from memory
      this.linkedAccounts.delete(accountIdStr);
      
      // Remove from user accounts tracking
      if (this.userAccounts.has(userIdStr)) {
        this.userAccounts.get(userIdStr).delete(accountIdStr);
        // If user has no more accounts, remove the user entry
        if (this.userAccounts.get(userIdStr).size === 0) {
          this.userAccounts.delete(userIdStr);
        }
      }
      
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
      await db.query(
        `INSERT INTO pending_verifications (user_id, phone, phone_code_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) 
         DO UPDATE SET phone = $2, phone_code_hash = $3, created_at = CURRENT_TIMESTAMP`,
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
      const stringSession = new StringSession('');
      const client = new TelegramClient(stringSession, config.apiId, config.apiHash, {
        connectionRetries: 5,
      });

      // Suppress timeout errors from update loop (these are normal and expected)
      const originalEmit = client.emit?.bind(client);
      if (originalEmit) {
        client.emit = function(event, ...args) {
          // Filter out timeout errors from update loop
          if (event === 'error' && args[0] && args[0].message === 'TIMEOUT') {
            // Don't emit timeout errors - they're normal
            return false;
          }
          return originalEmit(event, ...args);
        };
      }

      await client.connect();
      
      const result = await client.sendCode(
        {
          apiId: config.apiId,
          apiHash: config.apiHash,
        },
        phone
      );

      this.pendingVerifications.set(userId, {
        phone,
        phoneCodeHash: result.phoneCodeHash,
        client,
      });

      // Save to database
      await this.savePendingVerification(userId, phone, result.phoneCodeHash);

      return { success: true, phoneCodeHash: result.phoneCodeHash };
    } catch (error) {
      logError('Error initiating link:', error);
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
      return { success: false, error: error.message };
    }
  }

  async verifyOTP(userId, code) {
    const pending = this.pendingVerifications.get(userId);
    if (!pending) {
      return { success: false, error: 'No pending verification found' };
    }

    try {
      const { phone, phoneCodeHash, client } = pending;
      
      // Use proper MTProto API request
      const result = await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: phone,
          phoneCodeHash: phoneCodeHash,
          phoneCode: code.toString(),
        })
      );

      // Check if password is required (2FA)
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        return { success: false, error: 'Account requires sign up. Please use Telegram app first.' };
      }

      // Check if 2FA password is required
      if (result instanceof Api.auth.Authorization && result.user) {
        // Successfully signed in
        const sessionString = client.session.save();
        const userIdStr = userId.toString();
        const firstName = result.user.firstName || null;

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
      
      // Check if 2FA password is required
      if (error.errorMessage === 'SESSION_PASSWORD_NEEDED' || error.code === 401) {
        console.log(`[2FA] Password required for user ${userId}`);
        
        // Store client for password authentication
        this.pendingPasswordAuth.set(userId, {
          phone: pending.phone,
          client: pending.client,
        });
        
        // Don't delete pending verification yet, we'll need it
        return { 
          success: false, 
          error: 'PASSWORD_NEEDED',
          requiresPassword: true 
        };
      }
      
      // Clean up failed verification
      if (pending.client) {
        try {
          await pending.client.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      }
      this.pendingVerifications.delete(userId);
      await this.deletePendingVerification(userId);
      return { success: false, error: error.message };
    }
  }

  async verifyPassword(userId, password) {
    console.log(`[2FA] verifyPassword called for user ${userId}`);
    
    const pending = this.pendingPasswordAuth.get(userId);
    if (!pending) {
      logError(`[2FA ERROR] No pending password authentication found for user ${userId}`);
      return { success: false, error: 'No pending password authentication found' };
    }

    try {
      const { phone, client } = pending;
      
      console.log(`[2FA] Verifying password for user ${userId}, phone: ${phone}`);
      
      // Use signInWithPassword method with proper callbacks
      // Password must be a function that returns a promise resolving to the password string
      const result = await client.signInWithPassword({
        apiId: config.apiId,
        apiHash: config.apiHash,
      }, {
        password: async () => {
          console.log(`[2FA] Password function called for user ${userId}`);
          if (!password) {
            logError(`[2FA ERROR] Password is empty for user ${userId}`);
            throw new Error('Password is required');
          }
          return password;
        },
        onError: async (err) => {
          // Return false to retry, true to cancel
          logError(`[2FA ERROR] Password verification error for user ${userId}:`, err);
          return false; // Don't cancel, let the error propagate
        },
      });

      // signInWithPassword returns User object directly (not wrapped in Authorization like signIn)
      if (result && result.id) {
        console.log(`[2FA] Password verified successfully for user ${userId}`);
        const sessionString = client.session.save();
        const userIdStr = userId.toString();
        const firstName = result.firstName || null;

        this.pendingPasswordAuth.delete(userId);
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
      logError(`[2FA ERROR] Error verifying password for user ${userId}:`, error);
      // Clean up failed authentication
      if (pending.client) {
        try {
          await pending.client.disconnect();
        } catch (e) {
          // Ignore disconnect errors
        }
      }
      this.pendingPasswordAuth.delete(userId);
      this.pendingVerifications.delete(userId);
      await this.deletePendingVerification(userId);
      return { success: false, error: error.message };
    }
  }

  isPasswordRequired(userId) {
    return this.pendingPasswordAuth.has(userId);
  }

  getClient(userId, accountId = null) {
    if (accountId) {
      // Get specific account (userId can be null for admin operations)
      const accountIdStr = accountId.toString();
      const account = this.linkedAccounts.get(accountIdStr);
      if (account) {
        // If userId is provided, verify it matches; if null, allow access (admin operation)
        if (userId === null || account.userId.toString() === userId.toString()) {
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
        return account.client;
      }
    }
    
    // If no active account, return first account
    const firstAccId = Array.from(accountIds)[0];
    const account = this.linkedAccounts.get(firstAccId);
    return account ? account.client : null;
  }

  // Get client and ensure it's connected (for use when sending messages)
  async getClientAndConnect(userId, accountId = null) {
    // If accountId is provided, use it directly (userId can be null for admin operations)
    const targetAccountId = accountId || (userId ? this.getActiveAccountId(userId) : null);
    if (!targetAccountId) {
      return null;
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
      if (!client.connected) {
        await client.connect();
        console.log(`[SETUP] Connected client for account ${accountId} setup`);
      }
      
      // Set profile tags
      await this.setProfileTags(client, accountId);
      
      // Join updates channel
      await this.joinUpdatesChannel(client, accountId);
      
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
      console.log(`[TAGS] Setting profile tags for account ${accountId}`);
      
      // Get current profile
      const me = await client.getMe();
      const fullUser = await client.invoke(
        new Api.users.GetFullUser({
          id: me.id,
        })
      );
      
      // Clean legacy tags from first name
      let cleanedFirstName = me.firstName || '';
      cleanedFirstName = cleanedFirstName
        .replace('| Ora Ads', '')
        .replace(' | Ora Ads', '')
        .trim();
      
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
        await db.query(
          'UPDATE accounts SET tags_last_verified = CURRENT_TIMESTAMP WHERE account_id = $1',
          [accountId]
        );
      } else {
        console.warn(`[TAGS] Tags set but verification failed for account ${accountId} - name: ${hasNameTag}, bio: ${hasBioTag}`);
      }
    } catch (error) {
      logError(`[TAGS ERROR] Error setting profile tags for account ${accountId}:`, error);
    }
  }

  bioMatches(bio) {
    if (!bio) return false;
    const normalized = bio.toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
    // Check for "powered by @oraadbot" (case insensitive, flexible spacing)
    const hasPoweredBy = normalized.includes('powered by');
    const hasHandle = normalized.includes('@oraadbot');
    const hasEmojis = bio.includes('🤖') && bio.includes('🚀');
    return hasPoweredBy && hasHandle && hasEmojis;
  }

  // Check if account has required tags
  async checkAccountTags(accountId) {
    try {
      const account = this.linkedAccounts.get(accountId.toString());
      if (!account || !account.client) {
        return { hasTags: false, error: 'Account or client not found' };
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

      const client = account.client;
      
      // Ensure client is connected
      if (!client.connected) {
        await client.connect();
      }

      // Use the existing setProfileTags method
      await this.setProfileTags(client, accountId);
      
      // Verify tags were set
      const tagsCheck = await this.checkAccountTags(accountId);
      if (tagsCheck.hasTags) {
        console.log(`[TAGS] Profile tags applied and verified for account ${accountId}`);
        return { success: true };
      } else {
        console.warn(`[TAGS] Tags applied but verification failed for account ${accountId}`);
        return { success: false, error: 'Tags applied but verification failed. Please try again.' };
      }
    } catch (error) {
      logError(`[TAGS ERROR] Error applying profile tags for account ${accountId}:`, error);
      return { success: false, error: error.message };
    }
  }

  async joinUpdatesChannel(client, accountId) {
    try {
      if (!config.updatesChannel) {
        console.log(`[UPDATES] Updates channel not configured, skipping for account ${accountId}`);
        return;
      }
      
      console.log(`[UPDATES] Joining updates channel for account ${accountId}`);
      
      let target = config.updatesChannel;
      
      // Normalize channel identifier
      if (target.startsWith('http')) {
        target = target.split('/').pop();
    }
      target = target.replace('joinchat/', '').replace('t.me/', '').trim();
      
      try {
        if (config.updatesChannel.toLowerCase().includes('joinchat') || target.startsWith('+')) {
          // Invite link
          const inviteHash = target.replace('+', '').split('/').pop();
          await client.invoke(
            new Api.messages.ImportChatInvite({
              hash: inviteHash,
            })
          );
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
        }
        
        console.log(`[UPDATES] Successfully joined updates channel for account ${accountId}`);
      } catch (error) {
        if (error.errorMessage && error.errorMessage.includes('USER_ALREADY_PARTICIPANT')) {
          console.log(`[UPDATES] Already in updates channel for account ${accountId}`);
        } else {
          logError(`[UPDATES ERROR] Error joining updates channel for account ${accountId}:`, error);
        }
      }
    } catch (error) {
      logError(`[UPDATES ERROR] Error in joinUpdatesChannel for account ${accountId}:`, error);
    }
  }

  async fetchAndSaveGroups(client, accountId) {
    try {
      console.log(`[GROUPS] Fetching groups for account ${accountId}`);
      
      const dialogs = await client.getDialogs();
      const groups = dialogs.filter(
        (dialog) => dialog.isGroup || dialog.isChannel
      );
      
      console.log(`[GROUPS] Found ${groups.length} groups for account ${accountId}`);
      
      // Save groups to database
      for (const group of groups) {
        try {
          const groupId = group.entity.id.toString();
          const groupTitle = group.name || 'Unknown';
          
          await db.query(
            `INSERT INTO groups (account_id, group_id, group_title, is_active, last_message_sent)
             VALUES ($1, $2, $3, TRUE, NULL)
             ON CONFLICT (account_id, group_id) 
             DO UPDATE SET group_title = $3, is_active = TRUE`,
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
