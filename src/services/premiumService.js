/**
 * Premium Service
 * Manages premium subscriptions for users
 * Premium users skip tag verification and setting
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import userService from './userService.js';

class PremiumService {
  /**
   * Check if user has active premium subscription
   * @param {number} userId - User ID
   * @returns {Promise<boolean>}
   */
  async isPremium(userId) {
    try {
      const result = await db.query(
        `SELECT expires_at, status FROM premium_subscriptions 
         WHERE user_id = $1 AND status = 'active' 
         ORDER BY expires_at DESC LIMIT 1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return false;
      }

      const subscription = result.rows[0];
      const expiresAt = new Date(subscription.expires_at);
      const now = new Date();

      // Check if subscription has expired
      if (expiresAt < now) {
        // Auto-expire subscription
        await this.expireSubscription(userId);
        return false;
      }

      return true;
    } catch (error) {
      logger.logError('PREMIUM', userId, error, 'Failed to check premium status');
      return false;
    }
  }

  /**
   * Get premium subscription details
   * @param {number} userId - User ID
   * @returns {Promise<Object|null>}
   */
  async getSubscription(userId) {
    try {
      const result = await db.query(
        `SELECT * FROM premium_subscriptions 
         WHERE user_id = $1 
         ORDER BY expires_at DESC LIMIT 1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      const sub = result.rows[0];
      const expiresAt = new Date(sub.expires_at);
      const now = new Date();

      // Check if expired
      if (expiresAt < now && sub.status === 'active') {
        await this.expireSubscription(userId);
        return { ...sub, status: 'expired', isExpired: true };
      }

      return {
        ...sub,
        isActive: sub.status === 'active' && expiresAt >= now,
        isExpired: expiresAt < now,
        daysRemaining: Math.max(0, Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24)))
      };
    } catch (error) {
      logger.logError('PREMIUM', userId, error, 'Failed to get subscription');
      return null;
    }
  }

  /**
   * Create or renew premium subscription
   * @param {number} userId - User ID
   * @param {Object} paymentData - Payment information
   * @returns {Promise<{success: boolean, error?: string, subscription?: Object}>}
   */
  async createSubscription(userId, paymentData = {}) {
    try {
      const amount = paymentData.amount || 30.0;
      const currency = paymentData.currency || 'INR';
      const paymentMethod = paymentData.paymentMethod || 'manual';
      const paymentReference = paymentData.paymentReference || null;

      // Ensure user exists in users table (required for foreign key constraint)
      const user = await userService.getUser(userId);
      if (!user) {
        // Create user if they don't exist
        // Use provided user info or defaults
        const username = paymentData.username || null;
        const firstName = paymentData.firstName || paymentData.first_name || null;
        await userService.addUser(userId, username, firstName);
        logger.logChange('PREMIUM', userId, 'User created automatically when adding premium');
      }

      // Calculate expiry date (30 days from now)
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      // Check if user already has a subscription
      const existing = await this.getSubscription(userId);
      
      if (existing && existing.status === 'active' && !existing.isExpired) {
        // Extend existing subscription
        const currentExpiresAt = new Date(existing.expires_at);
        const newExpiresAt = new Date(currentExpiresAt);
        newExpiresAt.setDate(newExpiresAt.getDate() + 30);

        await db.query(
          `UPDATE premium_subscriptions 
           SET expires_at = $1, 
               amount = $2,
               payment_method = $3,
               payment_reference = $4,
               updated_at = CURRENT_TIMESTAMP
           WHERE user_id = $5 AND status = 'active'`,
          [newExpiresAt.toISOString(), amount, paymentMethod, paymentReference, userId]
        );

        logger.logChange('PREMIUM', userId, `Premium subscription extended until ${newExpiresAt.toISOString()}`);
      } else {
        // Check if subscription row exists (even if expired/cancelled)
        // Due to UNIQUE constraint, we need to UPDATE or use INSERT OR REPLACE
        if (existing) {
          // Update existing subscription to make it active again
          await db.query(
            `UPDATE premium_subscriptions 
             SET status = 'active', 
                 amount = $1,
                 currency = $2,
                 payment_method = $3,
                 payment_reference = $4,
                 expires_at = $5,
                 cancelled_at = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE user_id = $6`,
            [amount, currency, paymentMethod, paymentReference, expiresAt.toISOString(), userId]
          );
          logger.logChange('PREMIUM', userId, `Premium subscription reactivated until ${expiresAt.toISOString()}`);
        } else {
          // Create new subscription (user doesn't have any subscription yet)
          await db.query(
            `INSERT INTO premium_subscriptions 
             (user_id, status, amount, currency, payment_method, payment_reference, expires_at)
             VALUES ($1, 'active', $2, $3, $4, $5, $6)`,
            [userId, amount, currency, paymentMethod, paymentReference, expiresAt.toISOString()]
          );
          logger.logChange('PREMIUM', userId, `Premium subscription created until ${expiresAt.toISOString()}`);
        }
      }

      const subscription = await this.getSubscription(userId);
      
      // CRITICAL: Remove profile tags from all linked accounts when premium is activated
      // Premium users don't need tags
      try {
        const accountLinker = (await import('./accountLinker.js')).default;
        const accounts = await accountLinker.getAccounts(userId);
        
        if (accounts && accounts.length > 0) {
          console.log(`[PREMIUM] Removing profile tags from ${accounts.length} account(s) for premium user ${userId}`);
          
          for (const account of accounts) {
            try {
              const accountId = account.accountId;
              const client = accountLinker.getClient(userId, accountId);
              
              if (client) {
                // Ensure client is connected
                try {
                  await accountLinker.ensureConnected(accountId);
                  // Remove tags from this account
                  await accountLinker.removeProfileTags(client, accountId);
                  console.log(`[PREMIUM] Removed tags from account ${accountId}`);
                } catch (connectError) {
                  console.log(`[PREMIUM] Could not connect account ${accountId} to remove tags: ${connectError.message}`);
                  // Continue with other accounts
                }
              }
            } catch (accountError) {
              console.error(`[PREMIUM] Error removing tags from account ${account.accountId}:`, accountError);
              // Continue with other accounts
            }
            
            // Small delay between accounts
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      } catch (tagsError) {
        // Log but don't fail premium activation if tag removal fails
        console.error(`[PREMIUM] Error removing tags from accounts:`, tagsError);
        logger.logError('PREMIUM', userId, tagsError, 'Failed to remove tags from accounts');
      }
      
      return { success: true, subscription };
    } catch (error) {
      logger.logError('PREMIUM', userId, error, 'Failed to create subscription');
      return { success: false, error: error.message };
    }
  }

  /**
   * Expire a subscription
   * @param {number} userId - User ID
   * @returns {Promise<void>}
   */
  async expireSubscription(userId) {
    try {
      await db.query(
        `UPDATE premium_subscriptions 
         SET status = 'expired', updated_at = CURRENT_TIMESTAMP 
         WHERE user_id = $1 AND status = 'active'`,
        [userId]
      );
      logger.logChange('PREMIUM', userId, 'Premium subscription expired');
    } catch (error) {
      logger.logError('PREMIUM', userId, error, 'Failed to expire subscription');
    }
  }

  /**
   * Cancel a subscription
   * @param {number} userId - User ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async cancelSubscription(userId) {
    try {
      await db.query(
        `UPDATE premium_subscriptions 
         SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
         WHERE user_id = $1 AND status = 'active'`,
        [userId]
      );
      logger.logChange('PREMIUM', userId, 'Premium subscription cancelled');
      return { success: true };
    } catch (error) {
      logger.logError('PREMIUM', userId, error, 'Failed to cancel subscription');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all active premium subscriptions
   * @returns {Promise<Array>}
   */
  async getAllActiveSubscriptions() {
    try {
      const result = await db.query(
        `SELECT ps.*, u.username, u.first_name 
         FROM premium_subscriptions ps
         JOIN users u ON ps.user_id = u.user_id
         WHERE ps.status = 'active' AND ps.expires_at > CURRENT_TIMESTAMP
         ORDER BY ps.expires_at ASC`
      );
      return result.rows;
    } catch (error) {
      logger.logError('PREMIUM', null, error, 'Failed to get all active subscriptions');
      return [];
    }
  }

  /**
   * Get all subscriptions (for admin monitoring)
   * @returns {Promise<Array>}
   */
  async getAllSubscriptions() {
    try {
      const result = await db.query(
        `SELECT ps.*, u.username, u.first_name 
         FROM premium_subscriptions ps
         JOIN users u ON ps.user_id = u.user_id
         ORDER BY ps.created_at DESC
         LIMIT 100`
      );
      return result.rows;
    } catch (error) {
      logger.logError('PREMIUM', null, error, 'Failed to get all subscriptions');
      return [];
    }
  }

  /**
   * Get expiring subscriptions (expires in next 7 days)
   * @returns {Promise<Array>}
   */
  async getExpiringSubscriptions() {
    try {
      const result = await db.query(
        `SELECT ps.*, u.username, u.first_name 
         FROM premium_subscriptions ps
         JOIN users u ON ps.user_id = u.user_id
         WHERE ps.status = 'active' 
         AND ps.expires_at BETWEEN CURRENT_TIMESTAMP AND datetime('now', '+7 days')
         ORDER BY ps.expires_at ASC`
      );
      return result.rows;
    } catch (error) {
      logger.logError('PREMIUM', null, error, 'Failed to get expiring subscriptions');
      return [];
    }
  }

  /**
   * Get subscription statistics
   * @returns {Promise<Object>}
   */
  async getStatistics() {
    try {
      // Run all queries in parallel for better performance
      const [active, expired, cancelled, totalRevenue] = await Promise.all([
        db.query(
          `SELECT COUNT(*) as count FROM premium_subscriptions 
           WHERE status = 'active' AND expires_at > CURRENT_TIMESTAMP`
        ),
        db.query(
          `SELECT COUNT(*) as count FROM premium_subscriptions 
           WHERE status = 'expired' OR expires_at < CURRENT_TIMESTAMP`
        ),
        db.query(
          `SELECT COUNT(*) as count FROM premium_subscriptions 
           WHERE status = 'cancelled'`
        ),
        db.query(
          `SELECT SUM(amount) as total FROM premium_subscriptions 
           WHERE status = 'active' OR (status = 'expired' AND expires_at > datetime('now', '-30 days'))`
        )
      ]);

      return {
        active: parseInt(active.rows[0]?.count) || 0,
        expired: parseInt(expired.rows[0]?.count) || 0,
        cancelled: parseInt(cancelled.rows[0]?.count) || 0,
        totalRevenue: parseFloat(totalRevenue.rows[0]?.total) || 0
      };
    } catch (error) {
      logger.logError('PREMIUM', null, error, 'Failed to get statistics');
      return { active: 0, expired: 0, cancelled: 0, totalRevenue: 0 };
    }
  }
}

export default new PremiumService();

