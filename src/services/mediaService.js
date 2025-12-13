/**
 * Media Service
 * Handles media attachments (images, videos, documents)
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class MediaService {
  /**
   * Attach media to message
   */
  async attachMedia(accountId, messageId, fileId, fileType, fileName = null, fileSize = null, mimeType = null) {
    try {
      const result = await db.query(
        `INSERT INTO media_attachments (account_id, message_id, file_id, file_type, file_name, file_size, mime_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [accountId, messageId, fileId, fileType, fileName, fileSize, mimeType]
      );
      logger.logChange('MEDIA', accountId, `Attached media: ${fileType}`);
      return { success: true, attachment: result.rows[0] };
    } catch (error) {
      logger.logError('MEDIA', accountId, error, 'Failed to attach media');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get media for message
   */
  async getMediaForMessage(accountId, messageId) {
    try {
      const result = await db.query(
        `SELECT * FROM media_attachments 
         WHERE account_id = $1 AND message_id = $2`,
        [accountId, messageId]
      );
      return { success: true, attachments: result.rows };
    } catch (error) {
      logger.logError('MEDIA', accountId, error, 'Failed to get media');
      return { success: false, error: error.message, attachments: [] };
    }
  }

  /**
   * Delete media
   */
  async deleteMedia(accountId, attachmentId) {
    try {
      await db.query(
        `DELETE FROM media_attachments WHERE id = $1 AND account_id = $2`,
        [attachmentId, accountId]
      );
      logger.logChange('MEDIA', accountId, `Deleted media ${attachmentId}`);
      return { success: true };
    } catch (error) {
      logger.logError('MEDIA', accountId, error, 'Failed to delete media');
      return { success: false, error: error.message };
    }
  }
}

export default new MediaService();
