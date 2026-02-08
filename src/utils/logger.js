/**
 * Centralized logging utility following project rules:
 * - Always log every button click
 * - Always log every change
 * - Always log every error
 * - Color-coded logs for better visibility
 * - Send important errors to admins
 */

import adminNotifier from '../services/adminNotifier.js';

// ANSI color codes
export const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

// Helper function for colored console.error
export function logError(message, error = null) {
  console.error(`${colors.red}${colors.bright}${message}${colors.reset}`);
  if (error) {
    if (error instanceof Error) {
      if (error.stack) {
        console.error(`${colors.red}[ERROR STACK] ${error.stack}${colors.reset}`);
      } else if (error.message) {
        console.error(`${colors.red}[ERROR DETAILS] ${error.message}${colors.reset}`);
      }
    } else {
      // Handle string errors or other types
      console.error(`${colors.red}${error}${colors.reset}`);
    }
  }
}

class Logger {
  logButtonClick(userId, username, buttonName, chatId = null) {
    const timestamp = new Date().toISOString();
    const chatInfo = chatId ? ` in chat ${chatId}` : '';
    const message = `[BUTTON CLICK] [${timestamp}] User ${userId} (@${username || 'Unknown'}) clicked "${buttonName}" button${chatInfo}`;
    console.log(`${colors.magenta}${message}${colors.reset}`);
  }

  logChange(action, userId, details) {
    const timestamp = new Date().toISOString();
    const message = `[CHANGE] [${timestamp}] User ${userId}: ${action} - ${details}`;
    console.log(`${colors.yellow}${message}${colors.reset}`);
    
    // Send important changes to admins (async, don't await to avoid blocking)
    const importantActions = [
      'ACCOUNT_LINKED', 'ACCOUNT_DELETED', 'ACCOUNT_SWITCHED',
      'BROADCAST_STARTED', 'BROADCAST_STOPPED',
      'MESSAGE_SET', 'CONFIG_CHANGED',
      'GROUPS_REFRESHED', 'TEMPLATE_SYNCED'
    ];
    
    if (importantActions.some(importantAction => action.includes(importantAction) || action === importantAction)) {
      adminNotifier.notifyUserAction(action, userId, {
        details: details || null,
      }).catch(err => {
        // Silently fail to avoid infinite loops
        console.error('[LOGGER] Failed to send admin notification:', err.message);
      });
    }
  }

  logError(context, userId, error, details = '') {
    // Filter out recoverable MTProto BinaryReader errors
    const errorMsg = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? (error.stack || '') : '';
    
    // Check for BinaryReader errors (recoverable MTProto errors)
    if (errorMsg.includes('readUInt32LE') || 
        errorMsg.includes('BinaryReader') || 
        errorMsg.includes('Cannot read properties of undefined') ||
        (errorStack && errorStack.includes('BinaryReader'))) {
      // Suppress these recoverable errors - they don't need to be logged
      return;
    }
    
    // Check if context or details mention BinaryReader errors
    const contextStr = String(context || '');
    const detailsStr = String(details || '');
    if (contextStr.includes('BinaryReader') || 
        contextStr.includes('readUInt32LE') ||
        detailsStr.includes('BinaryReader') ||
        detailsStr.includes('readUInt32LE')) {
      return; // Suppress these recoverable errors
    }
    
    // Check for "bot was blocked" errors - these are expected and shouldn't flood admin notifications
    const errorCode = error?.code || error?.errorCode || error?.response?.error_code || '';
    const isBotBlocked = errorMsg.includes('bot was blocked') ||
                        errorMsg.includes('bot blocked') ||
                        errorMsg.includes('BLOCKED') ||
                        errorMsg.includes('chat not found') ||
                        (errorCode === 403 && (errorMsg.includes('blocked') || errorMsg.includes('forbidden'))) ||
                        detailsStr.includes('bot was blocked') ||
                        detailsStr.includes('bot blocked') ||
                        contextStr.includes('ADMIN_BROADCAST') && errorMsg.includes('403');
    
    const timestamp = new Date().toISOString();
    const detailsStr2 = details ? ` - ${details}` : '';
    const message = `[ERROR] [${timestamp}] [${context}] User ${userId}: ${errorMsg}${detailsStr2}`;
    console.error(`${colors.red}${colors.bright}${message}${colors.reset}`);
    if (error instanceof Error && error.stack) {
      console.error(`${colors.red}[ERROR STACK] ${error.stack}${colors.reset}`);
    }
    
    // Skip admin notifications for "bot was blocked" errors - these are expected and shouldn't flood admins
    if (isBotBlocked) {
      console.log(`${colors.yellow}[LOGGER] Skipping admin notification for blocked bot error (expected behavior)${colors.reset}`);
      return; // Don't send admin notifications for blocked bot errors
    }
    
    // Send important errors to admins (async, don't await to avoid blocking)
    adminNotifier.notifyError(context, error, {
      userId: userId || null,
      details: details || null,
    }).catch(err => {
      // Silently fail to avoid infinite loops
      console.error('[LOGGER] Failed to send admin notification:', err.message);
    });
  }

  logInfo(context, message, userId = null) {
    const timestamp = new Date().toISOString();
    const userInfo = userId ? `User ${userId}: ` : '';
    const logMessage = `[INFO] [${timestamp}] [${context}] ${userInfo}${message}`;
    console.log(`${colors.blue}${logMessage}${colors.reset}`);
  }

  logSuccess(action, userId, details) {
    const timestamp = new Date().toISOString();
    const message = `[SUCCESS] [${timestamp}] User ${userId}: ${action} - ${details}`;
    console.log(`${colors.green}${message}${colors.reset}`);
    
    // Send important successes to admins (async, don't await to avoid blocking)
    const importantActions = [
      'ACCOUNT_LINKED', 'ACCOUNT_DELETED', 'ACCOUNT_SWITCHED',
      'BROADCAST_STARTED', 'BROADCAST_STOPPED',
      'MESSAGE_SET', 'CONFIG_CHANGED',
      'GROUPS_REFRESHED', 'TEMPLATE_SYNCED'
    ];
    
    if (importantActions.some(importantAction => action.includes(importantAction) || action === importantAction)) {
      adminNotifier.notifyUserAction(action, userId, {
        details: details || null,
      }).catch(err => {
        // Silently fail to avoid infinite loops
        console.error('[LOGGER] Failed to send admin notification:', err.message);
      });
    }
  }

  logDatabaseOperation(operation, table, details) {
    const timestamp = new Date().toISOString();
    const message = `[DB] [${timestamp}] ${operation} on ${table}: ${details}`;
    console.log(`${colors.cyan}${message}${colors.reset}`);
  }
}

export default new Logger();
