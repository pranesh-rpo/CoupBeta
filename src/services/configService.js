/**
 * Config Service
 * Manages account configuration settings: rate limits, quiet hours, daily cap, schedules, A/B testing
 * Following project rules: always log changes and errors
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class ConfigService {
  /**
   * Get account settings from database
   */
  async getAccountSettings(accountId) {
    try {
      const result = await db.query(
        `SELECT 
          manual_interval,
          daily_cap,
          daily_sent,
          cap_reset_date,
          quiet_start,
          quiet_end,
          ab_mode,
          ab_mode_type,
          ab_last_variant,
          saved_template_slot,
          auto_mention,
          mention_count
         FROM accounts 
         WHERE account_id = $1`,
        [accountId]
      );
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const row = result.rows[0];
      return {
        manualInterval: row.manual_interval,
        dailyCap: row.daily_cap || 50,
        dailySent: row.daily_sent || 0,
        capResetDate: row.cap_reset_date,
        quietStart: row.quiet_start,
        quietEnd: row.quiet_end,
        abMode: row.ab_mode || false,
        abModeType: row.ab_mode_type || 'single',
        abLastVariant: row.ab_last_variant || 'A',
        savedTemplateSlot: row.saved_template_slot !== null && row.saved_template_slot !== undefined ? row.saved_template_slot : null,
        autoMention: row.auto_mention || false,
        mentionCount: [1, 3, 5].includes(row.mention_count) ? row.mention_count : 5,
      };
    } catch (error) {
      logger.logError('CONFIG', null, error, `Failed to get account settings for account ${accountId}`);
      throw error;
    }
  }

  /**
   * Update manual interval (rate limit preset)
   * @param {number} accountId - Account ID
   * @param {number|null} intervalMinutes - Interval in minutes (null for default)
   */
  async setManualInterval(accountId, intervalMinutes) {
    try {
      await db.query(
        'UPDATE accounts SET manual_interval = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2',
        [intervalMinutes, accountId]
      );
      
      const preset = this.intervalToPreset(intervalMinutes);
      logger.logChange('CONFIG', accountId, `Manual interval set to ${intervalMinutes || 'default'} minutes (preset: ${preset})`);
      
      return { success: true, preset };
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to set manual interval');
      throw error;
    }
  }

  /**
   * Set rate limit preset
   * @param {number} accountId - Account ID
   * @param {string} preset - '1', '3', '5', 'default', or 'custom'
   */
  async setRateLimitPreset(accountId, preset) {
    let intervalMinutes = null;
    
    switch (preset) {
      case '1':
        intervalMinutes = 60; // 1 message/hour
        break;
      case '3':
        intervalMinutes = 20; // 3 messages/hour
        break;
      case '5':
        intervalMinutes = 12; // 5 messages/hour
        break;
      case 'default':
        intervalMinutes = null; // Use default (12 minutes)
        break;
      default:
        return { success: false, error: 'Invalid preset' };
    }
    
    return await this.setManualInterval(accountId, intervalMinutes);
  }

  /**
   * Convert interval to preset name
   */
  intervalToPreset(intervalMinutes) {
    if (intervalMinutes === null || intervalMinutes === undefined) {
      return 'default';
    }
    if (intervalMinutes <= 12) {
      return '5'; // 5 messages/hour
    }
    if (intervalMinutes <= 20) {
      return '3'; // 3 messages/hour
    }
    if (intervalMinutes >= 60) {
      return '1'; // 1 message/hour
    }
    return 'custom';
  }

  /**
   * Set daily message cap
   * @param {number} accountId - Account ID
   * @param {number} cap - Daily cap (1-1000)
   */
  async setDailyCap(accountId, cap) {
    try {
      if (cap < 1 || cap > 1000) {
        return { success: false, error: 'Daily cap must be between 1 and 1000' };
      }
      
      await db.query(
        'UPDATE accounts SET daily_cap = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2',
        [cap, accountId]
      );
      
      logger.logChange('CONFIG', accountId, `Daily cap set to ${cap}`);
      return { success: true };
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to set daily cap');
      throw error;
    }
  }

  /**
   * Set quiet hours
   * @param {number} accountId - Account ID
   * @param {string|null} startTime - Start time in HH:MM format (IST) or null to clear
   * @param {string|null} endTime - End time in HH:MM format (IST) or null to clear
   */
  async setQuietHours(accountId, startTime, endTime) {
    try {
      await db.query(
        'UPDATE accounts SET quiet_start = $1, quiet_end = $2, updated_at = CURRENT_TIMESTAMP WHERE account_id = $3',
        [startTime, endTime, accountId]
      );
      
      if (startTime && endTime) {
        logger.logChange('CONFIG', accountId, `Quiet hours set: ${startTime} - ${endTime} IST`);
      } else {
        logger.logChange('CONFIG', accountId, 'Quiet hours cleared');
      }
      
      return { success: true };
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to set quiet hours');
      throw error;
    }
  }

  /**
   * Set auto-mention settings
   * @param {number} accountId - Account ID
   * @param {boolean} enabled - Enable auto-mention
   * @param {number} mentionCount - Number of users to mention (1-10)
   */
  async setAutoMention(accountId, enabled, mentionCount = 5) {
    try {
      // Only allow 1, 3, or 5 users
      if (![1, 3, 5].includes(mentionCount)) {
        return { success: false, error: 'Mention count must be 1, 3, or 5' };
      }

      await db.query(
        `UPDATE accounts 
         SET auto_mention = $1, mention_count = $2, updated_at = CURRENT_TIMESTAMP
         WHERE account_id = $3`,
        [enabled, mentionCount, accountId]
      );

      logger.logSuccess('CONFIG', null, `Auto-mention ${enabled ? 'enabled' : 'disabled'} (${mentionCount} mentions)`);
      return { success: true };
    } catch (error) {
      logger.logError('CONFIG', null, error, 'Failed to set auto-mention');
      return { success: false, error: error.message };
    }
  }

  /**
   * Set A/B testing mode
   * @param {number} accountId - Account ID
   * @param {boolean} enabled - Enable A/B testing
   * @param {string} modeType - 'single', 'rotate', or 'split'
   */
  async setABMode(accountId, enabled, modeType = 'single') {
    try {
      if (!['single', 'rotate', 'split'].includes(modeType)) {
        return { success: false, error: 'Invalid A/B mode type' };
      }
      
      await db.query(
        'UPDATE accounts SET ab_mode = $1, ab_mode_type = $2, updated_at = CURRENT_TIMESTAMP WHERE account_id = $3',
        [enabled, modeType, accountId]
      );
      
      logger.logChange('CONFIG', accountId, `A/B mode ${enabled ? 'enabled' : 'disabled'} (type: ${modeType})`);
      return { success: true };
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to set A/B mode');
      throw error;
    }
  }

  /**
   * Update A/B last variant (for rotate mode)
   * @param {number} accountId - Account ID
   * @param {string} variant - 'A' or 'B'
   */
  async updateABLastVariant(accountId, variant) {
    try {
      if (!['A', 'B'].includes(variant)) {
        return { success: false, error: 'Invalid variant' };
      }
      
      await db.query(
        'UPDATE accounts SET ab_last_variant = $1 WHERE account_id = $2',
        [variant, accountId]
      );
      
      return { success: true };
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to update A/B last variant');
      throw error;
    }
  }

  /**
   * Set saved template slot
   * @param {number} accountId - Account ID
   * @param {number|null} slot - Slot number (1, 2, 3) or null for none
   */
  async setSavedTemplateSlot(accountId, slot) {
    try {
      if (slot !== null && ![1, 2, 3].includes(slot)) {
        return { success: false, error: 'Invalid slot number' };
      }
      
      await db.query(
        'UPDATE accounts SET saved_template_slot = $1, updated_at = CURRENT_TIMESTAMP WHERE account_id = $2',
        [slot, accountId]
      );
      
      logger.logChange('CONFIG', accountId, `Saved template slot set to ${slot || 'none'}`);
      return { success: true };
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to set saved template slot');
      throw error;
    }
  }

  /**
   * Check if current time is within quiet hours (IST)
   * @param {number} accountId - Account ID
   * @returns {Promise<boolean>}
   */
  async isWithinQuietHours(accountId) {
    try {
      const settings = await this.getAccountSettings(accountId);
      if (!settings || !settings.quietStart || !settings.quietEnd) {
        return false;
      }
      
      const now = new Date();
      const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const currentHour = istTime.getHours();
      const currentMinute = istTime.getMinutes();
      const currentTimeMinutes = currentHour * 60 + currentMinute;
      
      const [startHour, startMinute] = settings.quietStart.split(':').map(Number);
      const [endHour, endMinute] = settings.quietEnd.split(':').map(Number);
      const startTimeMinutes = startHour * 60 + startMinute;
      const endTimeMinutes = endHour * 60 + endMinute;
      
      // Handle quiet hours spanning midnight
      if (startTimeMinutes > endTimeMinutes) {
        return currentTimeMinutes >= startTimeMinutes || currentTimeMinutes <= endTimeMinutes;
      }
      
      return currentTimeMinutes >= startTimeMinutes && currentTimeMinutes <= endTimeMinutes;
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to check quiet hours');
      return false;
    }
  }

  /**
   * Get active schedule for account
   * @param {number} accountId - Account ID
   * @returns {Promise<Object|null>}
   */
  async getSchedule(accountId) {
    try {
      const result = await db.query(
        `SELECT * FROM schedules 
         WHERE account_id = $1 AND is_active = TRUE 
         ORDER BY id DESC 
         LIMIT 1`,
        [accountId]
      );
      
      if (result.rows.length === 0) {
        return null;
      }
      
      const row = result.rows[0];
      return {
        id: row.id,
        startTime: row.start_time,
        endTime: row.end_time,
        minInterval: row.min_interval,
        maxInterval: row.max_interval,
        scheduleType: row.schedule_type,
        schedulePattern: row.schedule_pattern,
        customSettings: row.custom_settings,
        isActive: row.is_active,
      };
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to get schedule');
      return null;
    }
  }

  /**
   * Set schedule for account
   * @param {number} accountId - Account ID
   * @param {string} startTime - Start time in HH:MM format (IST)
   * @param {string} endTime - End time in HH:MM format (IST)
   * @param {number} minInterval - Minimum interval in minutes (default: 5)
   * @param {number} maxInterval - Maximum interval in minutes (default: 15)
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async setSchedule(accountId, startTime, endTime, minInterval = 5, maxInterval = 15) {
    try {
      // Validate time format
      const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
      if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
        return { success: false, error: 'Invalid time format. Use HH:MM (24-hour format)' };
      }

      // Validate intervals
      if (minInterval < 1 || minInterval > 60) {
        return { success: false, error: 'Minimum interval must be between 1 and 60 minutes' };
      }
      if (maxInterval < minInterval || maxInterval > 60) {
        return { success: false, error: 'Maximum interval must be between minimum interval and 60 minutes' };
      }

      // Deactivate existing schedules
      await db.query(
        'UPDATE schedules SET is_active = FALSE WHERE account_id = $1',
        [accountId]
      );

      // Insert new schedule
      await db.query(
        `INSERT INTO schedules (account_id, start_time, end_time, min_interval, max_interval, schedule_type, is_active)
         VALUES ($1, $2, $3, $4, $5, 'normal', TRUE)`,
        [accountId, startTime, endTime, minInterval, maxInterval]
      );

      logger.logChange('CONFIG', accountId, `Schedule set: ${startTime} - ${endTime} IST (interval: ${minInterval}-${maxInterval} min)`);
      return { success: true };
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to set schedule');
      return { success: false, error: error.message };
    }
  }

  /**
   * Clear schedule for account
   * @param {number} accountId - Account ID
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async clearSchedule(accountId) {
    try {
      await db.query(
        'UPDATE schedules SET is_active = FALSE WHERE account_id = $1',
        [accountId]
      );

      logger.logChange('CONFIG', accountId, 'Schedule cleared');
      return { success: true };
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to clear schedule');
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if current time is within schedule window (IST)
   * @param {number} accountId - Account ID
   * @returns {Promise<boolean>}
   */
  async isWithinSchedule(accountId) {
    try {
      const schedule = await this.getSchedule(accountId);
      if (!schedule) {
        return true; // No schedule means always active
      }

      const now = new Date();
      const istTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const currentHour = istTime.getHours();
      const currentMinute = istTime.getMinutes();
      const currentTimeMinutes = currentHour * 60 + currentMinute;

      // Parse schedule times (format: HH:MM:SS or HH:MM)
      const startTimeStr = schedule.startTime.toString();
      const endTimeStr = schedule.endTime.toString();
      const [startHour, startMinute] = startTimeStr.split(':').map(Number);
      const [endHour, endMinute] = endTimeStr.split(':').map(Number);
      
      const startTimeMinutes = startHour * 60 + startMinute;
      const endTimeMinutes = endHour * 60 + endMinute;

      // Handle schedule spanning midnight
      if (startTimeMinutes > endTimeMinutes) {
        return currentTimeMinutes >= startTimeMinutes || currentTimeMinutes <= endTimeMinutes;
      }

      return currentTimeMinutes >= startTimeMinutes && currentTimeMinutes <= endTimeMinutes;
    } catch (error) {
      logger.logError('CONFIG', accountId, error, 'Failed to check schedule');
      return true; // Default to active if check fails
    }
  }
}

export default new ConfigService();
