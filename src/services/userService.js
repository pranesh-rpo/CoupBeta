import db from '../database/db.js';
import { logError } from '../utils/logger.js';

class UserService {
  async addUser(userId, username, firstName) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      await db.query(
        `INSERT INTO users (user_id, username, first_name, joined_at, is_verified, is_active)
         VALUES ($1, $2, $3, CURRENT_TIMESTAMP, FALSE, TRUE)
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
      const result = await db.query('SELECT * FROM users WHERE user_id = $1', [userIdNum]);
      return result.rows[0] || null;
    } catch (error) {
      logError('[USER ERROR] Error getting user:', error);
      return null;
    }
  }

  async updateUserVerification(userId, isVerified) {
    try {
      const userIdNum = typeof userId === 'string' ? parseInt(userId) : userId;
      await db.query(
        'UPDATE users SET is_verified = $1 WHERE user_id = $2',
        [isVerified, userIdNum]
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
      const result = await db.query('SELECT user_id FROM users WHERE is_active = TRUE');
      return result.rows.map(row => row.user_id);
    } catch (error) {
      logError('[USER ERROR] Error getting all user IDs:', error);
      return [];
    }
  }
}

export default new UserService();
