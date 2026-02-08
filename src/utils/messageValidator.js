/**
 * Message Validation Utility
 * Validates messages before sending to prevent Telegram violations
 * Following project rules: always log changes and errors
 */

import logger from './logger.js';

/**
 * Validate message content before sending
 * @param {string} message - Message text to validate
 * @param {Object} options - Validation options
 * @returns {Object} { valid: boolean, error?: string, sanitized?: string }
 */
export function validateMessageContent(message, options = {}) {
  const {
    maxLength = 4096, // Telegram's maximum message length
    minLength = 1,
    allowEmpty = false,
    trimWhitespace = true
  } = options;

  // Check if message exists
  if (!message) {
    if (allowEmpty) {
      return { valid: true, sanitized: '' };
    }
    return { valid: false, error: 'Message cannot be empty' };
  }

  // Convert to string if not already
  let messageText = String(message);

  // Trim whitespace if requested
  if (trimWhitespace) {
    messageText = messageText.trim();
  }

  // Check minimum length
  if (messageText.length < minLength) {
    if (!allowEmpty || messageText.length > 0) {
      return { valid: false, error: `Message must be at least ${minLength} character(s)` };
    }
  }

  // Check maximum length (Telegram limit)
  if (messageText.length > maxLength) {
    return { 
      valid: false, 
      error: `Message exceeds maximum length of ${maxLength} characters (current: ${messageText.length})` 
    };
  }

  // Check for only whitespace
  if (!allowEmpty && messageText.length === 0) {
    return { valid: false, error: 'Message cannot be empty or only whitespace' };
  }

  // Check for potentially problematic patterns (spam indicators)
  // Note: Exclude whitespace from repeated-char check - multiple spaces/newlines can be legitimate formatting
  const spamPatterns = [
    /([^\s])\1{20,}/, // Repeated non-whitespace characters (more than 20) - e.g. aaaaaaaaaaaaaaaaaaaa
    /(http[s]?:\/\/){3,}/, // Multiple URLs
    /(@\w+\s*){10,}/, // Too many mentions
  ];

  for (const pattern of spamPatterns) {
    if (pattern.test(messageText)) {
      logger.logInfo('MESSAGE_VALIDATION', 'Spam pattern detected - user should set a new message', null);
      return { valid: false, error: 'Please set a new message - current message may be flagged as spam' };
    }
  }

  return { valid: true, sanitized: messageText };
}

/**
 * Sanitize message content to prevent injection and ensure compliance
 * @param {string} message - Message text to sanitize
 * @returns {string} Sanitized message
 */
export function sanitizeMessage(message) {
  if (!message) return '';

  let sanitized = String(message);

  // Remove null bytes and control characters (except newlines and tabs)
  sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');

  // Normalize whitespace (preserve intentional formatting)
  sanitized = sanitized.replace(/\r\n/g, '\n'); // Normalize line endings
  sanitized = sanitized.replace(/\r/g, '\n');

  // Trim excessive whitespace (more than 3 consecutive spaces)
  sanitized = sanitized.replace(/ {4,}/g, '   ');

  // Trim excessive newlines (more than 3 consecutive)
  sanitized = sanitized.replace(/\n{4,}/g, '\n\n\n');

  return sanitized;
}

/**
 * Validate message entities
 * @param {Array} entities - Message entities array
 * @returns {Object} { valid: boolean, error?: string }
 */
export function validateMessageEntities(entities) {
  if (!entities || !Array.isArray(entities)) {
    return { valid: true }; // Entities are optional
  }

  // Check entity count (Telegram limit is ~100 entities per message)
  if (entities.length > 100) {
    return { valid: false, error: 'Too many entities (maximum 100 allowed)' };
  }

  // Validate each entity
  for (const entity of entities) {
    if (!entity || typeof entity !== 'object') {
      return { valid: false, error: 'Invalid entity format' };
    }

    // Check required fields
    if (typeof entity.offset !== 'number' || entity.offset < 0) {
      return { valid: false, error: 'Entity offset must be a non-negative number' };
    }

    if (typeof entity.length !== 'number' || entity.length <= 0) {
      return { valid: false, error: 'Entity length must be a positive number' };
    }

    if (!entity.type || typeof entity.type !== 'string') {
      return { valid: false, error: 'Entity type must be a string' };
    }

    // Validate custom emoji ID if present
    if (entity.type === 'custom_emoji' && entity.custom_emoji_id) {
      const emojiId = entity.custom_emoji_id;
      // Should be a valid number or string representation of a number
      if (isNaN(Number(emojiId)) && typeof emojiId !== 'string') {
        return { valid: false, error: 'Invalid custom emoji ID format' };
      }
    }
  }

  return { valid: true };
}

/**
 * Comprehensive message validation before sending
 * @param {string} message - Message text
 * @param {Array} entities - Message entities (optional)
 * @param {Object} options - Validation options
 * @returns {Object} { valid: boolean, error?: string, sanitized?: string }
 */
export function validateMessage(message, entities = null, options = {}) {
  // First validate message content
  const contentValidation = validateMessageContent(message, options);
  if (!contentValidation.valid) {
    return contentValidation;
  }

  // Sanitize message
  const sanitized = sanitizeMessage(contentValidation.sanitized || message);

  // Validate entities if provided
  if (entities) {
    const entityValidation = validateMessageEntities(entities);
    if (!entityValidation.valid) {
      return entityValidation;
    }
  }

  // Final length check after sanitization
  if (sanitized.length > 4096) {
    return { 
      valid: false, 
      error: `Message exceeds maximum length after sanitization (${sanitized.length} characters)` 
    };
  }

  return { valid: true, sanitized };
}

