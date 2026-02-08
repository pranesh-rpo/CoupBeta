/**
 * Message Template Service
 * Manages message templates with variables
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

class MessageTemplateService {
  /**
   * Create a template
   */
  async createTemplate(accountId, templateName, templateText, variables = {}) {
    try {
      const result = await db.query(
        `INSERT INTO message_templates (account_id, template_name, template_text, variables, is_active)
         VALUES ($1, $2, $3, $4, TRUE)
         ON CONFLICT (account_id, template_name) DO UPDATE 
         SET template_text = EXCLUDED.template_text, 
             variables = EXCLUDED.variables,
             updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [accountId, templateName, templateText, JSON.stringify(variables)]
      );
      logger.logChange('TEMPLATE', accountId, `Created template: ${templateName}`);
      return { success: true, template: result.rows[0] };
    } catch (error) {
      logger.logError('TEMPLATE', accountId, error, 'Failed to create template');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all templates
   */
  async getTemplates(accountId) {
    try {
      const result = await db.query(
        `SELECT * FROM message_templates WHERE account_id = $1 ORDER BY created_at DESC`,
        [accountId]
      );
      const templates = result.rows.map(row => ({
        ...row,
        variables: typeof row.variables === 'string' ? JSON.parse(row.variables) : row.variables
      }));
      return { success: true, templates };
    } catch (error) {
      logger.logError('TEMPLATE', accountId, error, 'Failed to get templates');
      return { success: false, error: error.message, templates: [] };
    }
  }

  /**
   * Get template by name
   */
  async getTemplate(accountId, templateName) {
    try {
      const result = await db.query(
        `SELECT * FROM message_templates WHERE account_id = $1 AND template_name = $2 AND is_active = TRUE`,
        [accountId, templateName]
      );
      if (result.rows.length === 0) {
        return { success: false, error: 'Template not found' };
      }
      const template = result.rows[0];
      template.variables = typeof template.variables === 'string' ? JSON.parse(template.variables) : template.variables;
      return { success: true, template };
    } catch (error) {
      logger.logError('TEMPLATE', accountId, error, 'Failed to get template');
      return { success: false, error: error.message };
    }
  }

  /**
   * Render template with variables
   */
  renderTemplate(templateText, variables = {}, context = {}) {
    let rendered = templateText;
    
    // Default variables (using IST timezone)
    const istOptions = { timeZone: 'Asia/Kolkata' };
    const now = new Date();
    const defaultVars = {
      date: now.toLocaleDateString('en-IN', istOptions),
      time: now.toLocaleTimeString('en-IN', istOptions),
      datetime: now.toLocaleString('en-IN', istOptions),
      ...context
    };
    
    const allVars = { ...defaultVars, ...variables };
    
    // Replace {variable} patterns
    rendered = rendered.replace(/\{(\w+)\}/g, (match, key) => {
      return allVars[key] !== undefined ? String(allVars[key]) : match;
    });
    
    return rendered;
  }

  /**
   * Render template for group
   */
  async renderTemplateForGroup(accountId, templateName, groupName, groupId, customVars = {}) {
    try {
      const templateResult = await this.getTemplate(accountId, templateName);
      if (!templateResult.success) {
        return { success: false, error: templateResult.error };
      }
      
      const variables = {
        group_name: groupName,
        group_id: groupId,
        ...customVars
      };
      
      const rendered = this.renderTemplate(templateResult.template.template_text, variables);
      return { success: true, message: rendered };
    } catch (error) {
      logger.logError('TEMPLATE', accountId, error, 'Failed to render template');
      return { success: false, error: error.message };
    }
  }

  /**
   * Delete template
   */
  async deleteTemplate(accountId, templateName) {
    try {
      await db.query(
        `UPDATE message_templates SET is_active = FALSE 
         WHERE account_id = $1 AND template_name = $2`,
        [accountId, templateName]
      );
      logger.logChange('TEMPLATE', accountId, `Deleted template: ${templateName}`);
      return { success: true };
    } catch (error) {
      logger.logError('TEMPLATE', accountId, error, 'Failed to delete template');
      return { success: false, error: error.message };
    }
  }
}

export default new MessageTemplateService();
