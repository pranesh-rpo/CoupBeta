/**
 * Text and HTML helper utilities
 * Shared across the application to avoid code duplication
 */

/**
 * Escape HTML entities in text to prevent HTML tags from being rendered
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text
 */
export function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip HTML tags from text to convert HTML formatted messages to plain text
 * This is useful when users forward messages with Telegram formatting
 * @param {string} text - Text with HTML tags
 * @returns {string} - Plain text without HTML tags
 */
export function stripHtmlTags(text) {
  if (!text) return '';
  
  // Ensure we're working with a string
  let workingText = String(text);
  
  // First decode HTML entities
  let decoded = workingText
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  
  // Then strip HTML tags (including Telegram-specific formatting)
  // Remove common HTML tags like <b>, </b>, <i>, </i>, <code>, </code>, <pre>, </pre>, <a>, etc.
  let stripped = decoded.replace(/<[^>]+>/g, '');
  
  // Decode any remaining HTML entities (in case some were nested)
  stripped = stripped
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
  
  return stripped.trim();
}

/**
 * Sanitize text for use in Telegram inline keyboard buttons
 * Ensures the text is valid UTF-8 and removes any invalid characters
 * @param {string} text - Text to sanitize
 * @returns {string} - Sanitized UTF-8 text safe for button text
 */
export function sanitizeButtonText(text) {
  if (!text) return '';
  
  try {
    // Convert to string first
    let str = String(text);
    
    // Remove any null bytes and other control characters that might cause issues
    // Keep common whitespace characters (space, tab, newline) but remove others
    str = str.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
    
    // Ensure valid UTF-8 encoding by encoding and decoding
    // Use 'utf8' encoding which will replace invalid sequences with replacement characters
    // Then filter out replacement characters (U+FFFD)
    const buffer = Buffer.from(str, 'utf8');
    let sanitized = buffer.toString('utf8');
    
    // Remove replacement characters (invalid UTF-8 sequences that were replaced)
    sanitized = sanitized.replace(/\uFFFD/g, '');
    
    // Telegram button text has a max length of 64 bytes, but we'll limit by characters
    // to be safe (some characters might be multi-byte)
    // Limit to 60 characters to leave room for emojis/prefixes
    if (sanitized.length > 60) {
      sanitized = sanitized.substring(0, 60);
    }
    
    return sanitized;
  } catch (error) {
    // If encoding fails, return a safe fallback
    console.error('[sanitizeButtonText] Error sanitizing text:', error);
    try {
      // Try to extract safe ASCII and basic Unicode characters
      return String(text)
        .replace(/[^\x20-\x7E\u00A0-\uD7FF\uE000-\uFFFF]/g, '')
        .substring(0, 60);
    } catch (fallbackError) {
      // Last resort: return empty string or a placeholder
      return '...';
    }
  }
}

/**
 * Truncate text to a maximum length with ellipsis
 * @param {string} text - Text to truncate
 * @param {number} maxLength - Maximum length (default: 100)
 * @param {string} suffix - Suffix to add when truncated (default: '...')
 * @returns {string} - Truncated text
 */
export function truncateText(text, maxLength = 100, suffix = '...') {
  if (!text) return '';
  const str = String(text);
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - suffix.length) + suffix;
}
