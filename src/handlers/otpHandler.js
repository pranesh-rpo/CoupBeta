import accountLinker from '../services/accountLinker.js';

export function createOTPKeypad() {
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
      ],
    },
  };
}

export class OTPHandler {
  constructor() {
    this.otpCodes = new Map(); // userId -> current OTP code string
  }

  handleOTPInput(userId, digit) {
    if (!this.otpCodes.has(userId)) {
      this.otpCodes.set(userId, '');
    }

    const currentCode = this.otpCodes.get(userId);
    
    if (digit === 'backspace') {
      this.otpCodes.set(userId, currentCode.slice(0, -1));
    } else if (digit === 'submit') {
      return { action: 'submit', code: currentCode };
    } else {
      if (currentCode.length < 5) {
        this.otpCodes.set(userId, currentCode + digit);
      }
    }

    return { action: 'update', code: this.otpCodes.get(userId) };
  }

  clearOTP(userId) {
    this.otpCodes.delete(userId);
  }

  getCurrentCode(userId) {
    return this.otpCodes.get(userId) || '';
  }
}

export default new OTPHandler();
