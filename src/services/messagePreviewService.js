/**
 * Message Preview Service
 * Provides message preview functionality
 */

import messageTemplateService from './messageTemplateService.js';
import messageService from './messageService.js';
import logger from '../utils/logger.js';

class MessagePreviewService {
  /**
   * Preview message for group
   */
  async previewMessage(accountId, groupName, groupId, messageText = null, templateName = null) {
    try {
      let previewText = messageText;

      // If template name provided, render template
      if (templateName) {
        const templateResult = await messageTemplateService.renderTemplateForGroup(
          accountId,
          templateName,
          groupName,
          groupId
        );
        if (templateResult.success) {
          previewText = templateResult.message;
        }
      }

      // If no message text, get current message
      if (!previewText) {
        const messages = await messageService.getABMessages(accountId);
        previewText = messages.messageA || messages.messageB || 'No message set';
      }

      // Replace variables if any
      const variables = {
        group_name: groupName,
        group_id: groupId,
        date: new Date().toLocaleDateString(),
        time: new Date().toLocaleTimeString(),
        datetime: new Date().toLocaleString()
      };

      let rendered = previewText;
      rendered = rendered.replace(/\{(\w+)\}/g, (match, key) => {
        return variables[key] !== undefined ? String(variables[key]) : match;
      });

      return { success: true, preview: rendered };
    } catch (error) {
      logger.logError('PREVIEW', accountId, error, 'Failed to preview message');
      return { success: false, error: error.message };
    }
  }

  /**
   * Preview multiple groups
   */
  async previewForGroups(accountId, groups, messageText = null, templateName = null) {
    try {
      const previews = [];
      for (const group of groups.slice(0, 10)) { // Limit to 10 for preview
        const groupName = group.name || group.title || 'Unknown';
        const groupId = group.entity?.id || group.id || 'unknown';
        const preview = await this.previewMessage(accountId, groupName, groupId, messageText, templateName);
        if (preview.success) {
          previews.push({
            groupName,
            preview: preview.preview
          });
        }
      }
      return { success: true, previews };
    } catch (error) {
      logger.logError('PREVIEW', accountId, error, 'Failed to preview for groups');
      return { success: false, error: error.message, previews: [] };
    }
  }
}

export default new MessagePreviewService();
