/**
 * FloodWaitError and rate limiting error handler utility
 * Extracts wait times from Telegram errors and handles them properly
 * Following project rules: always log changes and errors
 */

import { logError } from './logger.js';

/**
 * Check if an error is a network error that should be retried
 * @param {Error} error - The error object
 * @returns {boolean} - True if it's a retryable network error
 */
export function isNetworkError(error) {
  if (!error) return false;
  
  const errorMessage = (error.message || error.toString() || '').toLowerCase();
  const errorCode = error.code || error.errorCode;
  const errorName = error.name || '';
  const errorCause = error.cause || error.error || null;
  const errorStack = error.stack || '';
  
  // Check for AggregateError (from request-promise-core)
  if (errorName === 'AggregateError' || errorName === 'RequestError') {
    return true;
  }
  
  // Check for common network error codes
  const networkErrorCodes = [
    'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT',
    'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH'
  ];
  
  if (networkErrorCodes.includes(errorCode)) {
    return true;
  }
  
  // Check error message for network-related keywords
  const networkKeywords = [
    'network', 'timeout', 'connection', 'socket', 'econnreset',
    'econnrefused', 'etimedout', 'enotfound', 'aggregateerror',
    'requesterror', 'disconnected', 'not connected', 'failed to connect'
  ];
  
  if (networkKeywords.some(keyword => errorMessage.includes(keyword))) {
    return true;
  }
  
  // Check error cause
  if (errorCause) {
    const causeCode = errorCause.code || errorCause.errorCode;
    const causeMessage = (errorCause.message || errorCause.toString() || '').toLowerCase();
    
    if (networkErrorCodes.includes(causeCode) || 
        networkKeywords.some(keyword => causeMessage.includes(keyword))) {
      return true;
    }
  }
  
  // Check stack trace for network errors
  if (errorStack && networkKeywords.some(keyword => errorStack.toLowerCase().includes(keyword))) {
    return true;
  }
  
  return false;
}

/**
 * Check if an error is a FloodWaitError or rate limiting error
 * @param {Error} error - The error object
 * @returns {boolean} - True if it's a rate limiting error
 */
export function isFloodWaitError(error) {
  if (!error) return false;
  
  const errorMessage = (error.message || error.toString() || '').toLowerCase();
  const errorCode = error.code || error.errorCode || error.response?.error_code;
  const errorDescription = (error.description || error.response?.description || '').toLowerCase();
  
  // Check for flood wait indicators
  return (
    // Error codes
    errorCode === 429 ||
    errorCode === 'FLOOD_WAIT' ||
    // Error properties
    error.seconds !== undefined ||
    error.response?.parameters?.retry_after !== undefined ||
    // Error messages (case insensitive)
    errorMessage.includes('flood') ||
    errorMessage.includes('rate limit') ||
    errorMessage.includes('rate_limit') ||
    errorMessage.includes('too many requests') ||
    errorMessage.includes('wait of') ||
    errorMessage.includes('retry after') ||
    errorMessage.includes('slowmode') ||
    errorMessage.includes('slow mode') ||
    // Error descriptions
    errorDescription.includes('flood') ||
    errorDescription.includes('rate limit') ||
    errorDescription.includes('too many requests') ||
    errorDescription.includes('retry after')
  );
}

/**
 * Extract wait time in seconds from FloodWaitError
 * @param {Error} error - The error object
 * @returns {number|null} - Wait time in seconds, or null if not found
 */
export function extractWaitTime(error) {
  if (!error) return null;
  
  // Check if error has a seconds property (FloodWaitError from telegram library)
  if (error.seconds !== undefined && error.seconds !== null && typeof error.seconds === 'number' && error.seconds > 0) {
    return error.seconds;
  }
  
  // Check error.errorMessage for MTProto errors (e.g., "FLOOD_WAIT_261")
  if (error.errorMessage) {
    const waitMatch = error.errorMessage.match(/flood_wait[_\s](\d+)/i);
    if (waitMatch && waitMatch[1]) {
      const seconds = parseInt(waitMatch[1], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
  }
  
  // Check response parameters (Telegram Bot API format)
  if (error.response?.parameters?.retry_after) {
    const seconds = parseInt(error.response.parameters.retry_after, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds;
    }
  }
  
  // Check error.parameters (alternative format)
  if (error.parameters?.retry_after) {
    const seconds = parseInt(error.parameters.retry_after, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds;
    }
  }
  
  // Check error.code for MTProto errors (sometimes contains wait time)
  if (error.code && typeof error.code === 'string' && error.code.includes('FLOOD_WAIT')) {
    const waitMatch = error.code.match(/flood_wait[_\s](\d+)/i);
    if (waitMatch && waitMatch[1]) {
      const seconds = parseInt(waitMatch[1], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
  }
  
  // Parse wait time from error message (multiple formats)
  if (error.message) {
    const errorMsg = String(error.message);
    
    // Format: "A wait of 261 seconds is required"
    let waitMatch = errorMsg.match(/wait of (\d+)\s+seconds?/i);
    if (waitMatch && waitMatch[1]) {
      const seconds = parseInt(waitMatch[1], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
    
    // Format: "FLOOD_WAIT_261" or "FLOOD_WAIT 261"
    waitMatch = errorMsg.match(/flood_wait[_\s](\d+)/i);
    if (waitMatch && waitMatch[1]) {
      const seconds = parseInt(waitMatch[1], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
    
    // Format: "retry after 261" or "retry_after: 261"
    waitMatch = errorMsg.match(/retry[_\s]?after[:\s]+(\d+)/i);
    if (waitMatch && waitMatch[1]) {
      const seconds = parseInt(waitMatch[1], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
    
    // Format: "Please wait 261 seconds"
    waitMatch = errorMsg.match(/wait (\d+)\s+seconds?/i);
    if (waitMatch && waitMatch[1]) {
      const seconds = parseInt(waitMatch[1], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
    
    // Format: "ETELEGRAM: 420 FLOOD_WAIT_261"
    waitMatch = errorMsg.match(/etelegram[:\s]+(\d+)[\s\w]*flood_wait[_\s](\d+)/i);
    if (waitMatch && waitMatch[2]) {
      const seconds = parseInt(waitMatch[2], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
  }
  
  // Check error description
  if (error.description) {
    const desc = String(error.description);
    const waitMatch = desc.match(/(\d+)\s+seconds?/i);
    if (waitMatch && waitMatch[1]) {
      const seconds = parseInt(waitMatch[1], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
    
    // Also check for FLOOD_WAIT format in description
    const waitMatch2 = desc.match(/flood_wait[_\s](\d+)/i);
    if (waitMatch2 && waitMatch2[1]) {
      const seconds = parseInt(waitMatch2[1], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
  }
  
  // Check toString() output as last resort
  try {
    const errorString = error.toString();
    const waitMatch = errorString.match(/flood_wait[_\s](\d+)/i);
    if (waitMatch && waitMatch[1]) {
      const seconds = parseInt(waitMatch[1], 10);
      if (!isNaN(seconds) && seconds > 0) {
        return seconds;
      }
    }
  } catch (e) {
    // Ignore toString errors
  }
  
  return null;
}

/**
 * Wait for the specified time from a FloodWaitError
 * @param {Error} error - The FloodWaitError
 * @param {number} bufferSeconds - Additional buffer time in seconds (default: 1)
 * @returns {Promise<void>} - Promise that resolves after waiting
 */
export async function waitForFloodError(error, bufferSeconds = 1) {
  const waitSeconds = extractWaitTime(error);
  
  if (waitSeconds !== null && waitSeconds > 0) {
    const totalWait = waitSeconds + bufferSeconds;
    console.log(`[FLOOD_WAIT] ⚠️ FloodWaitError detected: Telegram requires ${waitSeconds}s wait. Waiting ${totalWait}s before continuing...`);
    await new Promise((resolve) => setTimeout(resolve, totalWait * 1000));
  } else {
    // Fallback: wait a default amount if we can't extract wait time
    console.log(`[FLOOD_WAIT] ⚠️ Rate limit detected but couldn't extract wait time. Waiting 60s as fallback...`);
    await new Promise((resolve) => setTimeout(resolve, 60000));
  }
}

/**
 * Handle FloodWaitError with automatic retry logic
 * @param {Function} operation - The async operation to retry
 * @param {Object} options - Options for retry behavior
 * @param {number} options.maxRetries - Maximum number of retries (default: 3)
 * @param {number} options.bufferSeconds - Buffer time in seconds (default: 1)
 * @param {Function} options.onRetry - Callback called before each retry
 * @returns {Promise<*>} - Result of the operation
 */
export async function handleFloodWaitWithRetry(operation, options = {}) {
  const {
    maxRetries = 3,
    bufferSeconds = 1,
    onRetry = null,
  } = options;
  
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      
      // Only retry if it's a FloodWaitError
      if (isFloodWaitError(error) && attempt < maxRetries) {
        const waitSeconds = extractWaitTime(error);
        
        if (waitSeconds !== null && waitSeconds > 0) {
          const totalWait = waitSeconds + bufferSeconds;
          console.log(`[FLOOD_WAIT] ⚠️ Attempt ${attempt + 1}/${maxRetries + 1}: FloodWaitError - waiting ${totalWait}s before retry...`);
          
          if (onRetry) {
            onRetry(attempt + 1, waitSeconds);
          }
          
          await new Promise((resolve) => setTimeout(resolve, totalWait * 1000));
          continue; // Retry
        }
      }
      
      // If not a FloodWaitError or max retries reached, throw the error
      throw error;
    }
  }
  
  // Should never reach here, but just in case
  throw lastError || new Error('Operation failed after retries');
}

/**
 * Safe wrapper for bot API calls that automatically handles flood waits
 * This should be used for all bot API calls to prevent bans
 * @param {Function} apiCall - The bot API call function (e.g., () => bot.sendMessage(...))
 * @param {Object} options - Options for retry behavior
 * @param {number} options.maxRetries - Maximum number of retries (default: 5)
 * @param {number} options.bufferSeconds - Buffer time in seconds (default: 2)
 * @param {boolean} options.throwOnFailure - Whether to throw error on final failure (default: false)
 * @returns {Promise<*>} - Result of the API call, or null if throwOnFailure is false and all retries failed
 */
export async function safeBotApiCall(apiCall, options = {}) {
  const {
    maxRetries = 5,
    bufferSeconds = 2, // Increased buffer to be safer
    throwOnFailure = false,
  } = options;
  
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await apiCall();
    } catch (error) {
      lastError = error;
      
      // Check if it's a flood wait error
      if (isFloodWaitError(error)) {
        const waitSeconds = extractWaitTime(error);
        
        if (waitSeconds !== null && waitSeconds > 0 && attempt < maxRetries) {
          const totalWait = waitSeconds + bufferSeconds;
          console.log(`[FLOOD_WAIT] ⚠️ Bot API call rate limited. Attempt ${attempt + 1}/${maxRetries + 1}. Telegram requires ${waitSeconds}s wait. Waiting ${totalWait}s before retry...`);
          
          // Wait for the required time plus buffer
          await new Promise((resolve) => setTimeout(resolve, totalWait * 1000));
          continue; // Retry
        } else if (waitSeconds === null && attempt < maxRetries) {
          // Couldn't extract wait time, use conservative fallback
          const fallbackWait = 60 + bufferSeconds; // 60 seconds fallback
          console.log(`[FLOOD_WAIT] ⚠️ Bot API call rate limited but couldn't extract wait time. Attempt ${attempt + 1}/${maxRetries + 1}. Waiting ${fallbackWait}s as fallback...`);
          await new Promise((resolve) => setTimeout(resolve, fallbackWait * 1000));
          continue; // Retry
        }
      }
      
      // Check if it's a network error (retryable)
      if (isNetworkError(error) && attempt < maxRetries) {
        // Use exponential backoff for network errors: 2s, 4s, 8s, etc.
        const backoffSeconds = Math.min(2 ** attempt * 2, 30); // Cap at 30 seconds
        console.log(`[NETWORK_ERROR] ⚠️ Network error detected (${error.name || error.code || 'unknown'}). Attempt ${attempt + 1}/${maxRetries + 1}. Retrying after ${backoffSeconds}s...`);
        
        await new Promise((resolve) => setTimeout(resolve, backoffSeconds * 1000));
        continue; // Retry
      }
      
      // If max retries reached, handle accordingly
      if (attempt >= maxRetries) {
        if (isFloodWaitError(error)) {
          console.error(`[FLOOD_WAIT] ❌ Bot API call failed after ${maxRetries + 1} attempts due to rate limiting. This may indicate severe rate limiting.`);
          logError('FLOOD_WAIT', null, error, `Bot API call failed after ${maxRetries + 1} attempts`);
        } else if (isNetworkError(error)) {
          console.error(`[NETWORK_ERROR] ❌ Bot API call failed after ${maxRetries + 1} attempts due to network errors.`);
          logError('NETWORK_ERROR', null, error, `Bot API call failed after ${maxRetries + 1} attempts`);
        }
        
        if (throwOnFailure) {
          throw error;
        }
        return null;
      }
      
      // For non-retryable errors, throw immediately (don't retry)
      throw error;
    }
  }
  
  // Should never reach here
  if (throwOnFailure) {
    throw lastError || new Error('Bot API call failed after retries');
  }
  return null;
}

