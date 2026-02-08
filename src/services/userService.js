import db from '../database/db.js';
import { logError } from '../utils/logger.js';

class UserService {
  async addUser(userId, username, firstName) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      // SQLite uses INTEGER (0/1) for booleans
      await db.query(
        `INSERT INTO users (user_id, username, first_name, joined_at, is_verified, is_active)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, 0, 1)
         ON CONFLICT (user_id) 
         DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name`,
        [userIdNum, username || null, firstName || null]
      );
      console.log(`[USER] Added/updated user ${userIdNum}`);
    } catch (error) {
      logError('[USER ERROR] Error adding user:', error);
      throw error;
    }
  }

  async getUser(userId) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      const result = await db.query('SELECT * FROM users WHERE user_id = ?', [userIdNum]);
      const user = result.rows[0] || null;
      // Convert SQLite INTEGER booleans (0/1) to JavaScript booleans
      if (user) {
        user.is_verified = user.is_verified === 1;
        user.is_active = user.is_active === 1;
      }
      return user;
    } catch (error) {
      logError('[USER ERROR] Error getting user:', error);
      return null;
    }
  }

  async updateUserVerification(userId, isVerified) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      // SQLite uses INTEGER (0/1) for booleans, not true/false
      const isVerifiedInt = isVerified ? 1 : 0;
      await db.query(
        'UPDATE users SET is_verified = ? WHERE user_id = ?',
        [isVerifiedInt, userIdNum]
      );
      console.log(`[USER] Updated verification status for user ${userIdNum}: ${isVerified}`);
    } catch (error) {
      logError('[USER ERROR] Error updating user verification:', error);
      throw error;
    }
  }

  async isUserVerified(userId) {
    const user = await this.getUser(userId);
    return user ? user.is_verified : false;
  }

  async getAllUserIds() {
    try {
      // SQLite uses INTEGER (0/1) for booleans
      const result = await db.query('SELECT user_id FROM users WHERE is_active = 1');
      return result.rows.map(row => row.user_id);
    } catch (error) {
      logError('[USER ERROR] Error getting all user IDs:', error);
      return [];
    }
  }
}

export default new UserService();
