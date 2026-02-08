import accountLinker from '../services/accountLinker.js';

/**
 * Create an enhanced OTP keypad with visual code display
 * @param {string} currentCode - Current entered code (for display)
 * @returns {Object} Telegram inline keyboard markup
 */
export function createOTPKeypad(currentCode = '') {
  // Create visual display of entered digits (● for entered, ○ for remaining)
  const codeLength = 5; // Telegram uses 5-digit OTP codes
  const displayDigits = [];
  
  for (let i = 0; i < codeLength; i++) {
    if (i < currentCode.length) {
      displayDigits.push(currentCode[i]); // Show actual digit
    } else {
      displayDigits.push('○'); // Empty slot
    }
  }
  
  const codeDisplay = displayDigits.join(' ');
  const isComplete = currentCode.length === codeLength;
  
  return {
    reply_markup: {
      inline_keyboard: [
        // Code display row
        [
          { text: `┌─────────────────────┐`, callback_data: 'otp_display' }
        ],
        [
          { text: `│    ${codeDisplay}    │`, callback_data: 'otp_display' }
        ],
        [
          { text: `└─────────────────────┘`, callback_data: 'otp_display' }
        ],
        // Number pad rows
        [
          { text: '1️⃣', callback_data: 'otp_1' },
          { text: '2️⃣', callback_data: 'otp_2' },
          { text: '3️⃣', callback_data: 'otp_3' },
        ],
        [
          { text: '4️⃣', callback_data: 'otp_4' },
          { text: '5️⃣', callback_data: 'otp_5' },
          { text: '6️⃣', callback_data: 'otp_6' },
        ],
        [
          { text: '7️⃣', callback_data: 'otp_7' },
          { text: '8️⃣', callback_data: 'otp_8' },
          { text: '9️⃣', callback_data: 'otp_9' },
        ],
        [
          { text: '🗑️ Clear', callback_data: 'otp_clear' },
          { text: '0️⃣', callback_data: 'otp_0' },
          { text: '⌫', callback_data: 'otp_backspace' },
        ],
        // Submit row - highlight when complete
        [
          { 
            text: isComplete ? '✅ Submit Code' : '📝 Enter 5-digit code', 
            callback_data: isComplete ? 'otp_submit' : 'otp_info' 
          }
        ],
        // Cancel row
        [
          { text: '❌ Cancel Linking', callback_data: 'otp_cancel' }
        ],
      ],
    },
  };
}

/**
 * Create a simple OTP keypad (for backwards compatibility)
 * @returns {Object} Telegram inline keyboard markup
 */
export function createSimpleOTPKeypad() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '1', callback_data: 'otp_1' },
          { text: '2', callback_data: 'otp_2' },
          { text: '3', callback_data: 'otp_3' },
        ],
        [
          { text: '4', callback_data: 'otp_4' },
          { text: '5', callback_data: 'otp_5' },
          { text: '6', callback_data: 'otp_6' },
        ],
        [
          { text: '7', callback_data: 'otp_7' },
          { text: '8', callback_data: 'otp_8' },
          { text: '9', callback_data: 'otp_9' },
        ],
        [
          { text: '⌫', callback_data: 'otp_backspace' },
          { text: '0', callback_data: 'otp_0' },
          { text: '✓', callback_data: 'otp_submit' },
        ],
        [
          { text: '❌ Cancel', callback_data: 'otp_cancel' }
        ],
      ],
    },
  };
}

export class OTPHandler {
  constructor() {
    this.otpCodes = new Map(); // userId -> current OTP code string
    this.OTP_LENGTH = 5; // Telegram uses 5-digit OTP codes
  }

  /**
   * Handle OTP digit input
   * @param {number} userId - User ID
   * @param {string} digit - Digit pressed or action (backspace, submit, clear)
   * @returns {Object} Result with action and current code
   */
  handleOTPInput(userId, digit) {
    if (!this.otpCodes.has(userId)) {
      this.otpCodes.set(userId, '');
    }

    const currentCode = this.otpCodes.get(userId);
    
    if (digit === 'backspace') {
      // Remove last digit
      this.otpCodes.set(userId, currentCode.slice(0, -1));
      return { action: 'update', code: this.otpCodes.get(userId) };
    } else if (digit === 'clear') {
      // Clear entire code
      this.otpCodes.set(userId, '');
      return { action: 'update', code: '' };
    } else if (digit === 'submit') {
      // Validate code length before submitting
      if (currentCode.length !== this.OTP_LENGTH) {
        return { 
          action: 'error', 
          code: currentCode, 
          error: `Please enter all ${this.OTP_LENGTH} digits` 
        };
      }
      return { action: 'submit', code: currentCode };
    } else if (digit === 'display' || digit === 'info') {
      // Ignore clicks on display area
      return { action: 'ignore', code: currentCode };
    } else if (digit === 'cancel') {
      // Cancel linking process
      this.otpCodes.delete(userId);
      return { action: 'cancel', code: '' };
    } else {
      // Add digit if not at max length
      if (currentCode.length < this.OTP_LENGTH) {
        const newCode = currentCode + digit;
        this.otpCodes.set(userId, newCode);
        
        // Auto-detect when code is complete
        if (newCode.length === this.OTP_LENGTH) {
          return { action: 'complete', code: newCode };
        }
        return { action: 'update', code: newCode };
      } else {
        // Already at max length
        return { action: 'full', code: currentCode };
      }
    }
  }

  /**
   * Clear OTP code for a user
   * @param {number} userId - User ID
   */
  clearOTP(userId) {
    this.otpCodes.delete(userId);
  }

  /**
   * Get current OTP code for a user
   * @param {number} userId - User ID
   * @returns {string} Current code or empty string
   */
  getCurrentCode(userId) {
    return this.otpCodes.get(userId) || '';
  }

  /**
   * Check if code is complete (5 digits)
   * @param {number} userId - User ID
   * @returns {boolean} True if code is complete
   */
  isCodeComplete(userId) {
    const code = this.getCurrentCode(userId);
    return code.length === this.OTP_LENGTH;
  }

  /**
   * Get remaining digits needed
   * @param {number} userId - User ID
   * @returns {number} Number of digits still needed
   */
  getRemainingDigits(userId) {
    const code = this.getCurrentCode(userId);
    return Math.max(0, this.OTP_LENGTH - code.length);
  }
}

export default new OTPHandler();
