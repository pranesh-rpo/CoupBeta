/**
 * Payment Verification Service
 * Handles manual payment verification
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';
import premiumService from './premiumService.js';
import userService from './userService.js';

class PaymentVerificationService {
  /**
   * Submit payment for verification (manual)
   * @param {number} userId - User ID
   * @param {Object} paymentData - Payment information
   * @returns {Promise<{success: boolean, error?: string, submission?: Object, autoVerified?: boolean, subscription?: Object}>}
   */
  async submitPayment(userId, paymentData) {
    try {
      const transactionId = paymentData.transactionId?.trim() || paymentData.orderId?.trim();
      const orderId = paymentData.orderId || null;
      const amount = parseFloat(paymentData.amount) || 30.0;
      const currency = paymentData.currency || 'INR';
      const paymentMethod = paymentData.paymentMethod || 'manual';
      const paymentGateway = null; // Only manual payments supported
      const screenshotFileId = paymentData.screenshotFileId || null;
      const screenshotPath = paymentData.screenshotPath || null;

      if (!transactionId) {
        return { success: false, error: 'Transaction ID or Order ID is required' };
      }

      // Check if transaction ID already exists
      const existing = await db.query(
        `SELECT * FROM payment_submissions WHERE transaction_id = $1 OR order_id = $1`,
        [transactionId]
      );

      if (existing.rows.length > 0) {
        const existingSubmission = existing.rows[0];
        if (existingSubmission.status === 'verified') {
          return { 
            success: false, 
            error: 'This transaction has already been verified. Please contact support if this is an error.' 
          };
        }
        if (existingSubmission.user_id !== userId) {
          return { 
            success: false, 
            error: 'This transaction belongs to another user. Please check your transaction ID.' 
          };
        }
      }

      // Create payment submission
      const result = await db.query(
        `INSERT INTO payment_submissions 
         (user_id, transaction_id, order_id, amount, currency, payment_method, payment_gateway, screenshot_file_id, screenshot_path, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
         ON CONFLICT(transaction_id) DO UPDATE SET
           amount = $4,
           currency = $5,
           payment_method = $6,
           payment_gateway = $7,
           screenshot_file_id = $8,
           screenshot_path = $9,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, transactionId, orderId, amount, currency, paymentMethod, paymentGateway, screenshotFileId, screenshotPath]
      );

      const submission = result.rows[0];
      logger.logChange('PAYMENT', userId, `Payment submitted: ${transactionId}, Amount: ${amount}, Gateway: ${paymentGateway || 'manual'}`);

      // Attempt automatic verification
      const verificationResult = await this.verifyPayment(submission.id, userId);

      if (verificationResult.autoVerified) {
        return {
          success: true,
          submission,
          autoVerified: true,
          subscription: verificationResult.subscription
        };
      }

      return {
        success: true,
        submission,
        autoVerified: false,
        message: 'Payment submitted. Admin will verify shortly.'
      };
    } catch (error) {
      logger.logError('PAYMENT', userId, error, 'Failed to submit payment');
      return { success: false, error: error.message };
    }
  }

  /**
   * Verify payment (manual)
   * @param {number} submissionId - Submission ID
   * @param {number} userId - User ID
   * @returns {Promise<{autoVerified: boolean, subscription?: Object, reason?: string}>}
   */
  async verifyPayment(submissionId, userId) {
    try {
      const submission = await db.query(
        `SELECT * FROM payment_submissions WHERE id = $1`,
        [submissionId]
      );

      if (submission.rows.length === 0) {
        return { autoVerified: false, reason: 'Submission not found' };
      }

      const sub = submission.rows[0];

      if (sub.status !== 'pending') {
        return { autoVerified: false, reason: 'Already processed' };
      }

      // Manual verification with risk scoring
      return await this.verifyManualPayment(sub, userId);
    } catch (error) {
      logger.logError('PAYMENT', userId, error, 'Failed to verify payment');
      return { autoVerified: false, reason: error.message };
    }
  }

  /**
   * Verify manual payment using risk scoring
   * @param {Object} submission - Payment submission
   * @param {number} userId - User ID
   * @returns {Promise<{autoVerified: boolean, subscription?: Object, reason?: string}>}
   */
  async verifyManualPayment(submission, userId) {
    try {
      let score = 0;
      const reasons = [];

      // +30 points: Valid transaction ID format
      if (this.validateTransactionId(submission.transaction_id)) {
        score += 30;
        reasons.push('Valid format');
      }

      // +20 points: Amount matches expected (₹30)
      if (Math.abs(submission.amount - 30.0) < 0.01) {
        score += 20;
        reasons.push('Amount matches');
      }

      // +20 points: No duplicate transaction
      const duplicateCheck = await this.checkDuplicateUserSubmission(userId, submission.transaction_id);
      if (!duplicateCheck.isDuplicate) {
        score += 20;
        reasons.push('No duplicate');
      }

      // +15 points: Screenshot provided
      if (submission.screenshot_file_id) {
        score += 15;
        reasons.push('Screenshot provided');
      }

      // +10 points: Established user account
      const user = await userService.getUser(userId);
      if (user) {
        const accountAge = new Date() - new Date(user.joined_at);
        const daysOld = accountAge / (1000 * 60 * 60 * 24);
        if (daysOld > 7) {
          score += 10;
          reasons.push('Established account');
        }
      }

      // Penalties
      if (duplicateCheck.isDuplicate) {
        score -= 30;
        reasons.push('DUPLICATE');
      }

      if (!this.validateTransactionId(submission.transaction_id)) {
        score -= 20;
        reasons.push('Invalid format');
      }

      if (Math.abs(submission.amount - 30.0) >= 0.01) {
        score -= 15;
        reasons.push('Amount mismatch');
      }

      // Auto-verify if score >= 70
      if (score >= 70) {
        // Mark as verified
        await db.query(
          `UPDATE payment_submissions 
           SET status = 'verified', 
               verification_method = 'auto_manual',
               verified_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = $1`,
          [submission.id]
        );

        // Activate premium subscription
        const premiumResult = await premiumService.createSubscription(userId, {
          amount: submission.amount,
          currency: submission.currency,
          paymentMethod: submission.payment_method || 'manual',
          paymentReference: `MANUAL: ${submission.transaction_id}`
        });

        if (premiumResult.success) {
          logger.logChange('PAYMENT', userId, `Manual payment auto-verified and premium activated: ${submission.transaction_id}`);
          return {
            autoVerified: true,
            subscription: premiumResult.subscription
          };
        } else {
          await db.query(
            `UPDATE payment_submissions SET status = 'pending', verification_method = NULL WHERE id = $1`,
            [submission.id]
          );
          return { autoVerified: false, reason: 'Premium activation failed' };
        }
      }

      // Log why verification failed
      logger.logChange('PAYMENT', userId, `Manual verification failed (score: ${score}): ${reasons.join(', ')}`);
      return {
        autoVerified: false,
        reason: `Verification score too low (${score}/100). Needs admin review.`,
        score,
        reasons
      };
    } catch (error) {
      logger.logError('PAYMENT', userId, error, 'Manual verification failed');
      return { autoVerified: false, reason: error.message };
    }
  }

  /**
   * Validate transaction ID format
   * @param {string} transactionId - Transaction ID
   * @returns {boolean}
   */
  validateTransactionId(transactionId) {
    if (!transactionId || typeof transactionId !== 'string') {
      return false;
    }

    const trimmed = transactionId.trim();
    
    // Check length (8-50 characters)
    if (trimmed.length < 8 || trimmed.length > 50) {
      return false;
    }

    // Check against common patterns
    const validPatterns = [
      /^[A-Z0-9]{8,20}$/i,           // Generic alphanumeric
      /^TXN\d{10,}$/i,               // TXN prefix
      /^UPI\d{12,}$/i,               // UPI reference
      /^REF\d{10,}$/i,               // REF reference
      /^[A-Z]{2,4}\d{8,}$/i,         // 2-4 letters + 8+ digits
      /^[0-9]{12,20}$/,              // Pure numeric
      /^PREMIUM_\d+_\d+$/i           // Order ID format
    ];
    
    return validPatterns.some(pattern => pattern.test(trimmed));
  }

  /**
   * Check for duplicate user submissions
   * @param {number} userId - User ID
   * @param {string} transactionId - Transaction ID
   * @returns {Promise<{isDuplicate: boolean, count: number}>}
   */
  async checkDuplicateUserSubmission(userId, transactionId) {
    try {
      const result = await db.query(
        `SELECT COUNT(*) as count FROM payment_submissions 
         WHERE user_id = $1 AND transaction_id != $2 AND status = 'verified'
         AND created_at > datetime('now', '-24 hours')`,
        [userId, transactionId]
      );

      const count = parseInt(result.rows[0]?.count) || 0;
      return {
        isDuplicate: count > 0,
        count
      };
    } catch (error) {
      return { isDuplicate: false, count: 0 };
    }
  }

  /**
   * Get payment submission status
   * @param {number} userId - User ID
   * @returns {Promise<Object|null>}
   */
  async getSubmissionStatus(userId) {
    try {
      const result = await db.query(
        `SELECT * FROM payment_submissions 
         WHERE user_id = $1 
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0];
    } catch (error) {
      logger.logError('PAYMENT', userId, error, 'Failed to get submission status');
      return null;
    }
  }

  /**
   * Get pending submissions for admin review
   * @returns {Promise<Array>}
   */
  async getPendingSubmissions() {
    try {
      const result = await db.query(
        `SELECT ps.*, u.username, u.first_name 
         FROM payment_submissions ps
         JOIN users u ON ps.user_id = u.user_id
         WHERE ps.status = 'pending'
         ORDER BY ps.created_at ASC`
      );
      return result.rows;
    } catch (error) {
      logger.logError('PAYMENT', null, error, 'Failed to get pending submissions');
      return [];
    }
  }

  /**
   * Admin verify payment manually
   * @param {number} submissionId - Submission ID
   * @param {number} adminUserId - Admin user ID
   * @returns {Promise<{success: boolean, subscription?: Object, error?: string}>}
   */
  async adminVerifyPayment(submissionId, adminUserId) {
    try {
      const submission = await db.query(
        `SELECT * FROM payment_submissions WHERE id = $1`,
        [submissionId]
      );

      if (submission.rows.length === 0) {
        return { success: false, error: 'Submission not found' };
      }

      const sub = submission.rows[0];

      if (sub.status === 'verified') {
        return { success: false, error: 'Payment already verified' };
      }

      // Mark as verified
      await db.query(
        `UPDATE payment_submissions 
         SET status = 'verified',
             verification_method = 'admin_manual',
             verified_by = $1,
             verified_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [adminUserId, submissionId]
      );

      // Activate premium subscription
      const premiumResult = await premiumService.createSubscription(sub.user_id, {
        amount: sub.amount,
        currency: sub.currency,
        paymentMethod: sub.payment_method || 'manual',
        paymentReference: `ADMIN: ${adminUserId} - ${sub.transaction_id}`
      });

      if (premiumResult.success) {
        logger.logChange('PAYMENT', sub.user_id, `Payment verified by admin ${adminUserId}: ${sub.transaction_id}`);
        return {
          success: true,
          subscription: premiumResult.subscription
        };
      }

      return { success: false, error: 'Premium activation failed' };
    } catch (error) {
      logger.logError('PAYMENT', null, error, 'Admin verification failed');
      return { success: false, error: error.message };
    }
  }

  /**
   * Admin reject payment
   * @param {number} submissionId - Submission ID
   * @param {number} adminUserId - Admin user ID
   * @param {string} reason - Rejection reason
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async adminRejectPayment(submissionId, adminUserId, reason) {
    try {
      await db.query(
        `UPDATE payment_submissions 
         SET status = 'rejected',
             verification_method = 'admin_manual',
             verified_by = $1,
             rejection_reason = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = $3`,
        [adminUserId, reason, submissionId]
      );

      logger.logChange('PAYMENT', null, `Payment rejected by admin ${adminUserId}: ${reason}`);
      return { success: true };
    } catch (error) {
      logger.logError('PAYMENT', null, error, 'Admin rejection failed');
      return { success: false, error: error.message };
    }
  }
}

export default new PaymentVerificationService();

