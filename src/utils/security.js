/**
 * Security Utilities
 * Input validation, sanitization, and security helpers
 */

/**
 * Sanitize string input to prevent injection attacks
 * @param {string} input - Input string to sanitize
 * @param {number} maxLength - Maximum allowed length
 * @returns {string} Sanitized string
 */
export function sanitizeString(input, maxLength = 1000) {
  if (typeof input !== 'string') {
    return '';
  }
  
  // Remove null bytes and control characters (except newlines and tabs)
  let sanitized = input.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, '');
  
  // Trim whitespace
  sanitized = sanitized.trim();
  
  // Limit length
  if (sanitized.length > maxLength) {
    sanitized = sanitized.substring(0, maxLength);
  }
  
  return sanitized;
}

/**
 * Validate and sanitize user ID
 * @param {any} userId - User ID to validate
 * @returns {number|null} Validated user ID or null
 */
export function validateUserId(userId) {
  if (userId === null || userId === undefined) {
    return null;
  }
  
  const userIdNum = typeof userId === 'string' ? parseInt(userId, 10) : Number(userId);
  
  if (isNaN(userIdNum) || userIdNum <= 0 || !Number.isInteger(userIdNum)) {
    return null;
  }
  
  // Telegram user IDs are typically 32-bit integers, but can be larger
  // Check reasonable bounds (1 to 2^53 - 1, JavaScript's safe integer limit)
  if (userIdNum > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  
  return userIdNum;
}

/**
 * Validate and sanitize account ID
 * @param {any} accountId - Account ID to validate
 * @returns {number|null} Validated account ID or null
 */
export function validateAccountId(accountId) {
  if (accountId === null || accountId === undefined) {
    return null;
  }
  
  const accountIdNum = typeof accountId === 'string' ? parseInt(accountId, 10) : Number(accountId);
  
  if (isNaN(accountIdNum) || accountIdNum <= 0 || !Number.isInteger(accountIdNum)) {
    return null;
  }
  
  return accountIdNum;
}

/**
 * Validate phone number format (E.164)
 * @param {string} phone - Phone number to validate
 * @returns {boolean} True if valid
 */
export function validatePhoneNumber(phone) {
  if (typeof phone !== 'string') {
    return false;
  }
  
  // E.164 format: + followed by 1-15 digits
  const phoneRegex = /^\+[1-9]\d{1,14}$/;
  return phoneRegex.test(phone.trim());
}

/**
 * Sanitize callback data to prevent injection
 * @param {string} data - Callback data
 * @returns {string} Sanitized callback data
 */
export function sanitizeCallbackData(data) {
  if (typeof data !== 'string') {
    return '';
  }
  
  // Only allow alphanumeric, underscore, dash, and specific prefixes
  // Max length 64 bytes (Telegram limit)
  const sanitized = data.replace(/[^a-zA-Z0-9_\-]/g, '').substring(0, 64);
  
  return sanitized;
}

/**
 * Validate callback data format
 * @param {string} data - Callback data to validate
 * @returns {boolean} True if valid format
 */
export function validateCallbackData(data) {
  if (typeof data !== 'string' || data.length === 0 || data.length > 64) {
    return false;
  }
  
  // Only allow safe characters
  return /^[a-zA-Z0-9_\-]+$/.test(data);
}

/**
 * Sanitize SQL limit value to prevent injection
 * @param {any} limit - Limit value
 * @param {number} maxLimit - Maximum allowed limit
 * @returns {number} Validated limit
 */
export function sanitizeLimit(limit, maxLimit = 1000) {
  const limitNum = typeof limit === 'string' ? parseInt(limit, 10) : Number(limit);
  
  if (isNaN(limitNum) || limitNum <= 0 || !Number.isInteger(limitNum)) {
    return 100; // Default limit
  }
  
  // Ensure limit doesn't exceed maximum
  return Math.min(limitNum, maxLimit);
}

/**
 * Validate table name against whitelist (prevents SQL injection)
 * @param {string} tableName - Table name to validate
 * @param {string[]} allowedTables - Whitelist of allowed table names
 * @returns {boolean} True if valid
 */
export function validateTableName(tableName, allowedTables) {
  if (typeof tableName !== 'string') {
    return false;
  }
  
  // Only allow alphanumeric and underscore
  if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {
    return false;
  }
  
  // Check against whitelist
  return allowedTables.includes(tableName);
}

/**
 * Get user-friendly error message (never shows technical details)
 * @param {Error|string} error - Optional error object or message to map to user-friendly message
 * @returns {string} User-friendly error message
 */
export function getUserFriendlyErrorMessage(error = null) {
  // If no error provided, return generic message
  if (!error) {
    return 'An error occurred. Please try again later or contact support if the problem persists.';
  }

  // Extract error message
  let errorMessage = '';
  if (error instanceof Error) {
    errorMessage = error.message || '';
  } else if (typeof error === 'string') {
    errorMessage = error;
  } else {
    return 'An error occurred. Please try again later or contact support if the problem persists.';
  }

  // Normalize error message for comparison (case-insensitive)
  const normalizedError = errorMessage.toLowerCase().trim();

  // Map specific errors to user-friendly messages
  const errorMappings = [
    {
      // Phone number already linked to another account that is broadcasting
      pattern: /phone number.*already linked.*another account.*broadcasting/i,
      message: '⚠️ <b>Account Already in Use</b>\n\nThis phone number is already linked to another account that is currently broadcasting.\n\n📝 <b>What to do:</b>\n1. Stop the broadcast on the other account first\n2. Or contact support for assistance\n\nYou can try linking again after stopping the broadcast.'
    },
    {
      // Phone number already linked (general)
      pattern: /phone number.*already linked/i,
      message: '⚠️ <b>Phone Number Already Linked</b>\n\nThis phone number is already linked to another account.\n\n📝 <b>What to do:</b>\n• If this is your account, try using a different phone number\n• Or contact support for assistance'
    },
    {
      // Account conflict
      pattern: /account.*conflict|already.*broadcasting/i,
      message: '⚠️ <b>Account Conflict</b>\n\nThis account is already in use by another user or is currently broadcasting.\n\n📝 <b>What to do:</b>\n• Stop any active broadcasts first\n• Or contact support for assistance'
    },
    {
      // Password verification failed (generic)
      pattern: /password.*verification.*failed|invalid.*password|incorrect.*password/i,
      message: '❌ <b>Password Incorrect</b>\n\nThe 2FA password you entered is incorrect.\n\n📝 <b>What to do:</b>\n• Double-check your password and try again\n• Make sure you\'re entering the correct 2FA password for this account'
    },
    {
      // Rate limited / flood wait - check for specific wait time
      pattern: /rate.*limit.*wait|rate.*limited.*wait/i,
      message: (errorMsg) => {
        // Extract wait time from error message
        // Format: "Rate limited by Telegram. Please wait 1 minute(s) (60 seconds) before requesting a new code."
        const minuteMatch = errorMsg.match(/(\d+)\s*minute/i);
        const secondMatch = errorMsg.match(/(\d+)\s*second/i);
        const waitMinutes = minuteMatch ? parseInt(minuteMatch[1]) : null;
        const waitSeconds = secondMatch ? parseInt(secondMatch[1]) : null;
        
        if (waitMinutes !== null || waitSeconds !== null) {
          // Prefer showing minutes if available, otherwise show seconds
          let displayTime;
          if (waitMinutes !== null) {
            displayTime = `${waitMinutes} minute${waitMinutes !== 1 ? 's' : ''}`;
            if (waitSeconds !== null && waitSeconds % 60 !== 0) {
              displayTime += ` (${waitSeconds} seconds)`;
            }
          } else {
            displayTime = `${waitSeconds} second${waitSeconds !== 1 ? 's' : ''}`;
          }
          return `⏳ <b>Rate Limited</b>\n\nTelegram has rate limited your requests.\n\n⏰ <b>Wait Time:</b> ${displayTime}\n\n📝 <b>What to do:</b>\n• Please wait the specified time before trying again\n• Do not repeatedly click the link button\n• Telegram limits how often you can request verification codes`;
        }
        return '⏳ <b>Too Many Requests</b>\n\nYou\'ve made too many requests too quickly.\n\n📝 <b>What to do:</b>\n• Please wait a few minutes before trying again\n• Telegram limits how often you can perform certain actions';
      }
    },
    {
      // Rate limited / flood wait (generic fallback)
      pattern: /rate.*limit|flood.*wait|too.*many.*requests/i,
      message: '⏳ <b>Too Many Requests</b>\n\nYou\'ve made too many requests too quickly.\n\n📝 <b>What to do:</b>\n• Please wait a few minutes before trying again\n• Telegram limits how often you can perform certain actions'
    },
    {
      // Connection errors
      pattern: /connection.*error|network.*error|failed.*to.*connect/i,
      message: '🔌 <b>Connection Error</b>\n\nUnable to connect to Telegram servers.\n\n📝 <b>What to do:</b>\n• Check your internet connection\n• Wait a moment and try again\n• If the problem persists, contact support'
    },
    {
      // Session errors
      pattern: /session.*expired|session.*invalid|session.*error/i,
      message: '🔐 <b>Session Error</b>\n\nYour session has expired or is invalid.\n\n📝 <b>What to do:</b>\n• Please start the account linking process again\n• Make sure you\'re using the correct phone number'
    },
    {
      // Code expired
      pattern: /code.*expired|verification.*code.*expired/i,
      message: '⏰ <b>Code Expired</b>\n\nThe verification code has expired.\n\n📝 <b>What to do:</b>\n• Request a new verification code\n• Enter the code quickly after receiving it'
    },
    {
      // Invalid code
      pattern: /invalid.*code|wrong.*code|incorrect.*code/i,
      message: '❌ <b>Invalid Code</b>\n\nThe verification code you entered is incorrect.\n\n📝 <b>What to do:</b>\n• Double-check the code from Telegram\n• Make sure you\'re entering all digits correctly\n• Request a new code if needed'
    },
    {
      // Phone number invalid
      pattern: /invalid.*phone|phone.*number.*invalid/i,
      message: '📱 <b>Invalid Phone Number</b>\n\nThe phone number format is incorrect.\n\n📝 <b>What to do:</b>\n• Use international format: +1234567890\n• Include country code with + prefix\n• Make sure there are no spaces or special characters'
    }
  ];

  // Check each mapping pattern
  for (const mapping of errorMappings) {
    if (mapping.pattern.test(normalizedError)) {
      // If message is a function, call it with the error message
      if (typeof mapping.message === 'function') {
        return mapping.message(errorMessage);
      }
      return mapping.message;
    }
  }

  // If no specific mapping found, check for common technical terms and provide generic guidance
  if (normalizedError.includes('database') || normalizedError.includes('sql')) {
    return '💾 <b>Database Error</b>\n\nA database error occurred.\n\n📝 <b>What to do:</b>\n• Please try again in a moment\n• If the problem persists, contact support';
  }

  if (normalizedError.includes('timeout') || normalizedError.includes('timed out')) {
    return '⏱️ <b>Request Timeout</b>\n\nThe request took too long to complete.\n\n📝 <b>What to do:</b>\n• Check your internet connection\n• Try again in a moment\n• If the problem persists, contact support';
  }

  // Default: return generic message (don't expose technical details)
  return '❌ <b>Something Went Wrong</b>\n\nAn error occurred during the operation.\n\n📝 <b>What to do:</b>\n• Please try again in a moment\n• Make sure you\'re following the correct steps\n• If the problem persists, contact support for assistance';
}

/**
 * Sanitize error message to prevent information leakage
 * @param {Error|string} error - Error object or message
 * @param {boolean} includeDetails - Whether to include error details (for admin/internal use)
 * @param {boolean} forUser - If true, always return generic message (default: false for backward compatibility)
 * @returns {string} Sanitized error message
 */
export function sanitizeErrorMessage(error, includeDetails = false, forUser = false) {
  // If this is for a user, always return generic message
  if (forUser || !includeDetails) {
    return getUserFriendlyErrorMessage();
  }
  
  let message = '';
  
  if (error instanceof Error) {
    message = error.message || 'An error occurred';
  } else if (typeof error === 'string') {
    message = error;
  } else {
    return 'An unknown error occurred';
  }
  
  // Remove sensitive information patterns
  const sensitivePatterns = [
    /password/gi,
    /token/gi,
    /secret/gi,
    /api[_-]?key/gi,
    /auth[_-]?key/gi,
    /session/gi,
    /private[_-]?key/gi,
  ];
  
  let sanitized = message;
  for (const pattern of sensitivePatterns) {
    sanitized = sanitized.replace(pattern, '[REDACTED]');
  }
  
  // Remove file paths that might expose system structure
  sanitized = sanitized.replace(/\/[^\s]+/g, '[PATH]');
  
  // Remove code snippets, stack traces, and technical details
  sanitized = sanitized.replace(/at\s+.*?\(.*?\)/g, '[STACK]');
  sanitized = sanitized.replace(/Error:\s*/gi, '');
  sanitized = sanitized.replace(/TypeError|ReferenceError|SyntaxError/gi, 'Error');
  
  // Limit length
  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 197) + '...';
  }
  
  // For user-facing errors, be generic
  if (sanitized.toLowerCase().includes('sql') || sanitized.toLowerCase().includes('database')) {
    return 'Database error occurred. Please try again.';
  }
  if (sanitized.toLowerCase().includes('connection') || sanitized.toLowerCase().includes('network')) {
    return 'Connection error occurred. Please try again.';
  }
  
  return sanitized;
}

/**
 * Rate limiting tracker for commands
 */
class RateLimiter {
  constructor() {
    this.attempts = new Map(); // userId -> { count, resetTime }
  }
  
  /**
   * Check if user has exceeded rate limit
   * @param {number} userId - User ID
   * @param {number} maxAttempts - Maximum attempts allowed
   * @param {number} windowMs - Time window in milliseconds
   * @returns {Object} { allowed: boolean, remaining: number, resetIn: number }
   */
  checkRateLimit(userId, maxAttempts = 10, windowMs = 60000) {
    const now = Date.now();
    const userAttempts = this.attempts.get(userId);
    
    if (!userAttempts || now > userAttempts.resetTime) {
      // Reset or initialize
      this.attempts.set(userId, {
        count: 1,
        resetTime: now + windowMs
      });
      return { allowed: true, remaining: maxAttempts - 1, resetIn: windowMs };
    }
    
    if (userAttempts.count >= maxAttempts) {
      const resetIn = userAttempts.resetTime - now;
      return { allowed: false, remaining: 0, resetIn: Math.max(0, resetIn) };
    }
    
    userAttempts.count++;
    return { 
      allowed: true, 
      remaining: maxAttempts - userAttempts.count, 
      resetIn: userAttempts.resetTime - now 
    };
  }
  
  /**
   * Reset rate limit for user
   * @param {number} userId - User ID
   */
  reset(userId) {
    this.attempts.delete(userId);
  }
  
  /**
   * Cleanup old entries
   */
  cleanup() {
    const now = Date.now();
    for (const [userId, attempts] of this.attempts.entries()) {
      if (now > attempts.resetTime) {
        this.attempts.delete(userId);
      }
    }
  }
}

// Global rate limiters for different command types
export const commandRateLimiter = new RateLimiter();
export const adminCommandRateLimiter = new RateLimiter();
export const broadcastRateLimiter = new RateLimiter();

// Cleanup rate limiters every 5 minutes
setInterval(() => {
  commandRateLimiter.cleanup();
  adminCommandRateLimiter.cleanup();
  broadcastRateLimiter.cleanup();
}, 5 * 60 * 1000);

/**
 * Verify account ownership
 * @param {number} userId - User ID
 * @param {number} accountId - Account ID
 * @param {Function} dbQuery - Database query function
 * @returns {Promise<boolean>} True if user owns the account
 */
export async function verifyAccountOwnership(userId, accountId, dbQuery) {
  try {
    const validatedUserId = validateUserId(userId);
    const validatedAccountId = validateAccountId(accountId);
    
    if (!validatedUserId || !validatedAccountId) {
      return false;
    }
    
    const result = await dbQuery(
      'SELECT user_id FROM accounts WHERE account_id = $1 AND user_id = $2',
      [validatedAccountId, validatedUserId]
    );
    
    return result.rows.length > 0;
  } catch (error) {
    console.error('[SECURITY] Error verifying account ownership:', error);
    return false;
  }
}

/**
 * Validate HTML content to prevent XSS
 * @param {string} html - HTML string to validate
 * @returns {string} Sanitized HTML
 */
export function sanitizeHTML(html) {
  if (typeof html !== 'string') {
    return '';
  }
  
  // Remove script tags and event handlers
  let sanitized = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '')
    .replace(/on\w+\s*=\s*[^\s>]*/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/data:text\/html/gi, '');
  
  // Limit length
  if (sanitized.length > 4096) {
    sanitized = sanitized.substring(0, 4093) + '...';
  }
  
  return sanitized;
}

