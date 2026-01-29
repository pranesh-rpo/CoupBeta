import accountLinker from '../services/accountLinker.js';
import automationService from '../services/automationService.js';
import messageManager from '../services/messageManager.js';
import messageService from '../services/messageService.js';
import savedTemplatesService from '../services/savedTemplatesService.js';
import userService from '../services/userService.js';
import groupService from '../services/groupService.js';
import configService from '../services/configService.js';
import adminNotifier from '../services/adminNotifier.js';
import premiumService from '../services/premiumService.js';
import otpHandler, { createOTPKeypad } from './otpHandler.js';
import { createMainMenu, createBackButton, createStopButton, createAccountSwitchKeyboard, createGroupsMenu, createConfigMenu, createQuietHoursKeyboard, createABModeKeyboard, createScheduleKeyboard, createABMessagesKeyboard, createSavedTemplatesKeyboard, generateStatusText, createLoginOptionsKeyboard } from './keyboardHandler.js';
import { config } from '../config.js';
import logger, { logError } from '../utils/logger.js';
import { safeEditMessage, safeAnswerCallback } from '../utils/safeEdit.js';
import { safeBotApiCall } from '../utils/floodWaitHandler.js';
import { Api } from 'telegram/tl/index.js';

// Store reference to pending phone numbers set for setting pending state
// This will be set by index.js
let pendingPhoneNumbersSet = null;

/**
 * Set the pending phone numbers set reference (called from index.js)
 * This allows commandHandler to set pending state when redirecting to link account
 */
export function setPendingPhoneNumbersReference(pendingSet) {
  pendingPhoneNumbersSet = pendingSet;
}

/**
 * Add user to pending phone numbers (called from commandHandler when redirecting to link)
 */
function addPendingPhoneNumber(userId) {
  if (pendingPhoneNumbersSet) {
    pendingPhoneNumbersSet.add(userId);
    // Set timeout to clear after 5 minutes
    setTimeout(() => {
      if (pendingPhoneNumbersSet.has(userId)) {
        pendingPhoneNumbersSet.delete(userId);
        console.log(`[CLEANUP] Cleared pending phone number state for user ${userId} after timeout`);
      }
    }, 5 * 60 * 1000);
  }
}

/**
 * Escape HTML entities in text to prevent HTML tags from being rendered
 */
function escapeHtml(text) {
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
 */
function stripHtmlTags(text) {
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
  
  console.log(`[STRIP_HTML] Original length: ${workingText.length}, Stripped length: ${stripped.length}`);
  console.log(`[STRIP_HTML] Original: ${workingText.substring(0, 100)}...`);
  console.log(`[STRIP_HTML] Stripped: ${stripped.substring(0, 100)}...`);
  
  return stripped.trim();
}

// Helper function to check if user is verified
async function checkUserVerification(bot, userId) {
  // If no updates channel configured, allow access
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length === 0) {
    return { verified: true };
  }

  const isVerifiedInDb = await userService.isUserVerified(userId);
  
  // If marked as verified in DB, do a real-time check to ensure they're still in ALL channels
  if (isVerifiedInDb) {
    const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
    
    // Real-time check: verify user is still in ALL channels (not just one)
    let isStillMemberOfAll = true;
    for (const channelUsername of channelUsernames) {
      if (!channelUsername || typeof channelUsername !== 'string') {
        continue; // Skip invalid channel names
      }

      try {
        // CRITICAL: Use safeBotApiCall to prevent rate limiting and bot deletion
        // getChat and getChatMember can trigger rate limits if called too frequently
        const chat = await safeBotApiCall(
          () => bot.getChat(`@${channelUsername}`),
          { maxRetries: 3, bufferSeconds: 1, throwOnFailure: false }
        );
        
        // Validate chat response
        if (!chat || !chat.id) {
          console.warn(`[VERIFICATION] Invalid chat response for @${channelUsername}`);
          isStillMemberOfAll = false;
          break;
        }

        const channelId = chat.id;
        
        // CRITICAL: Use safeBotApiCall for getChatMember to prevent rate limiting
        const member = await safeBotApiCall(
          () => bot.getChatMember(channelId, userId),
          { maxRetries: 3, bufferSeconds: 1, throwOnFailure: false }
        );
        
        // Validate member response
        if (!member || !member.status) {
          console.warn(`[VERIFICATION] Invalid member response for user ${userId} in @${channelUsername}`);
          isStillMemberOfAll = false;
          break;
        }

        const isMember = member.status === 'member' || 
                        member.status === 'administrator' || 
                        member.status === 'creator';
        
        if (!isMember) {
          // User is not in this channel - they must be in ALL channels
          console.log(`[VERIFICATION] User ${userId} is not in @${channelUsername} (required channel)`);
          isStillMemberOfAll = false;
          break;
        }
      } catch (checkError) {
        const errorMessage = checkError.message || checkError.toString() || '';
        const errorCode = checkError.response?.error_code || checkError.code;
        
        // Handle different error types
        if (errorCode === 400 && errorMessage.includes('chat not found')) {
          console.warn(`[VERIFICATION] Channel @${channelUsername} not found or inaccessible`);
          isStillMemberOfAll = false;
          break;
        } else if (errorCode === 403 && errorMessage.includes('not enough rights')) {
          console.warn(`[VERIFICATION] Bot is not admin of @${channelUsername} - cannot verify membership`);
          isStillMemberOfAll = false;
          break;
        } else if (errorCode === 400 && (errorMessage.includes('user not found') || errorMessage.includes('chat not found'))) {
          // User is likely not a member
          console.log(`[VERIFICATION] Real-time check: User ${userId} not in @${channelUsername}`);
          isStillMemberOfAll = false;
          break;
        } else {
          // Other errors - log and mark as not verified
          console.log(`[VERIFICATION] Real-time check error for user ${userId} in @${channelUsername}: ${errorMessage}`);
          isStillMemberOfAll = false;
          break;
        }
      }
    }
    
    // If user is not in all channels, revoke verification immediately
    if (!isStillMemberOfAll) {
      console.log(`[VERIFICATION] User ${userId} not in all required channels, revoking verification`);
      try {
        await userService.updateUserVerification(userId, false);
      } catch (error) {
        console.error(`[VERIFICATION] Error revoking verification for user ${userId}:`, error.message);
        // Continue anyway - return unverified status
      }
      return { verified: false, channelUsernames };
    }
    
    return { verified: true };
  }

  // Return all channel usernames for verification
  const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
  return { verified: false, channelUsernames };
}

// Helper function to create channel buttons keyboard
function createChannelButtonsKeyboard(channelUsernames) {
  // Handle both single string (backward compatibility) and array
  const channels = Array.isArray(channelUsernames) ? channelUsernames : [channelUsernames];
  
  // Create buttons: Verify button on first row, then one button per channel
  const keyboard = [
    [{ text: '✅ Verify Channel', callback_data: 'btn_verify_channel' }]
  ];
  
  // Add one button per channel
  for (const channelUsername of channels) {
    keyboard.push([{ text: `📢 Join @${channelUsername}`, url: `https://t.me/${channelUsername}` }]);
  }
  
  return keyboard;
}

// Helper function to show verification required message with multiple channel buttons
async function showVerificationRequired(bot, chatId, channelUsernames) {
  // Handle both single string (backward compatibility) and array
  const channels = Array.isArray(channelUsernames) ? channelUsernames : [channelUsernames];
  
  // Build channel list text
  const channelList = channels.map(ch => `📢 @${ch}`).join('\n');
  
  const verificationMessage = `
🔐 <b>Channel Verification Required</b>

To use this bot, you must join our updates channel(s) first.

${channelList}

After joining, click the "✅ Verify Channel" button below.
  `;
  
  return await bot.sendMessage(chatId, verificationMessage, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: createChannelButtonsKeyboard(channels)
    }
  });
}

// Helper function to add user's linked account to updates channel automatically
// Uses the linked account's MTProto client to join the channel
async function addUserToUpdatesChannel(bot, userId) {
  if (!config.updatesChannel) {
    return { success: false, error: 'Updates channel not configured' };
  }

  try {
    // Get the user's active linked account
    const accountId = accountLinker.getActiveAccountId(userId);
    if (!accountId) {
      console.log(`[CHANNEL] No linked account found for user ${userId}, cannot auto-join channel`);
      return { success: false, error: 'No linked account found' };
    }

    // Get the MTProto client for the linked account
    const client = await accountLinker.getClientAndConnect(userId, accountId);
    if (!client) {
      console.log(`[CHANNEL] Could not get client for account ${accountId}`);
      return { success: false, error: 'Client not available' };
    }

    const channelUsername = config.updatesChannel.replace('@', '');
    
    // Get channel entity
    const channelEntity = await client.getEntity(`@${channelUsername}`);
    
    // Automatically join the channel using the linked account
    // This will add the linked account (user's Telegram account) to the channel
    await client.invoke(
      new Api.channels.JoinChannel({
        channel: channelEntity,
      })
    );
    
    console.log(`[CHANNEL] Successfully added linked account ${accountId} (user ${userId}) to updates channel @${channelUsername}`);
    return { success: true };
  } catch (error) {
    // Log error but don't fail the account linking process
    const channelUsername = config.updatesChannel.replace('@', '');
    const errorMsg = error.message || error.errorMessage || error.toString();
    console.log(`[CHANNEL] Failed to auto-join channel @${channelUsername} for user ${userId}: ${errorMsg}`);
    logger.logError('CHANNEL_INVITE', userId, error, 'Failed to auto-join updates channel');
    
    // Common errors:
    // - Already member: "USER_ALREADY_PARTICIPANT"
    // - Channel not found: "CHANNEL_INVALID"
    // - No access: "CHANNEL_PRIVATE"
    if ((error.errorMessage && error.errorMessage.includes('USER_ALREADY_PARTICIPANT')) ||
        (errorMsg && errorMsg.includes('USER_ALREADY_PARTICIPANT'))) {
      console.log(`[CHANNEL] Linked account already in channel @${channelUsername}`);
      return { success: true, alreadyMember: true };
    }
    
    return { success: false, error: errorMsg };
  }
}

export async function handleStart(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const username = msg.from.username || 'Unknown';
  const firstName = msg.from.first_name || '';

  logger.logInfo('START', `User ${userId} (@${username}) started the bot`, userId);

  // Add/update user in database
  try {
    await userService.addUser(userId, username, firstName);
    logger.logChange('USER_ADDED', userId, `Username: ${username}, FirstName: ${firstName}`);
  } catch (error) {
    logger.logError('START', userId, error, 'Failed to add user to database');
    // Notify admins of start errors
    adminNotifier.notifyUserError('USER_START_ERROR', userId, error, {
      username,
      firstName,
      details: 'Failed to add user to database',
    }).catch(() => {}); // Silently fail to avoid blocking
  }

  // Check channel verification requirement (mandatory if updates channel is configured)
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const verification = await checkUserVerification(bot, userId);
    
    if (!verification.verified) {
      // Show verification requirement message with all channels
      await showVerificationRequired(bot, chatId, verification.channelUsernames || updatesChannels.map(ch => ch.replace('@', '')));
      return;
    }
  }

  const statusText = await generateStatusText(userId);
  const welcomeMessage = `
✨ <b>Welcome to Coup Bot</b> ✨

Manage your Telegram broadcasts with ease!${statusText}

Select an option from the menu below:
  `;

  try {
    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML', ...await createMainMenu(userId) });
    logger.logInfo('START', `Welcome message sent to user ${userId}`, userId);
  } catch (error) {
    logger.logError('START', userId, error, 'Failed to send welcome message');
    // Don't throw - user already started the bot successfully
  }
}

export async function handleMainMenu(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Back to Menu', chatId);

  // Check verification requirement
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const verification = await checkUserVerification(bot, userId);
    
    if (!verification.verified) {
      await showVerificationRequired(bot, chatId, verification.channelUsernames || updatesChannels.map(ch => ch.replace('@', '')));
      return;
    }
  }

  const statusText = await generateStatusText(userId);
  const welcomeMessage = `
👋 <b>Coup Bot</b>${statusText}
  `;

  await safeEditMessage(bot, chatId, callbackQuery.message.message_id, welcomeMessage, { parse_mode: 'HTML', ...await createMainMenu(userId) });
  logger.logInfo('BUTTON_CLICK', `Main menu displayed to user ${userId}`, userId);
}

export async function handleLink(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Allow users to link multiple accounts
  try {
    await bot.sendMessage(
      chatId,
      `📱 <b>Link Account</b>\n\nPlease send your phone number in international format:\n\n<b>Format:</b> <code>+1234567890</code> or <code>+1 234 567 8900</code>\n<b>Example:</b> <code>+1234567890</code>`,
      { parse_mode: 'HTML', ...createBackButton() }
    );
  } catch (error) {
    logger.logError('LINK', userId, error, 'Failed to send link account message');
  }
}

export async function handleLinkButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Link Account', chatId);

  // Check verification requirement
  if (config.updatesChannel) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsername = config.updatesChannel.replace('@', '');
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsername);
      return false;
    }
  }

  // Show login options menu
  logger.logChange('LINK', userId, 'Showing login options');
  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    `📱 <b>Link Account</b>\n\nChoose your preferred login method:\n\n🌐 <b>Web Login:</b> Scan QR code with Telegram app\n📱 <b>Share Phone:</b> Share your phone number via button\n⌨️ <b>Type Phone:</b> Enter phone number manually\n\n`,
    { parse_mode: 'HTML', ...createLoginOptionsKeyboard() }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
  return false; // Don't set pending state yet - user needs to choose option
}

export async function handleLoginWeb(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Web Login', chatId);
  logger.logChange('LINK', userId, 'Initiating web login (QR code)');

  await safeAnswerCallback(bot, callbackQuery.id);

  try {
    // Show connecting status
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      '🔌 Connecting to Telegram...',
      { parse_mode: 'HTML' }
    );

    // Initiate web login (pass chatId for 2FA notifications)
    const result = await accountLinker.initiateWebLogin(userId, chatId);
    
    if (result.success) {
      // Send QR code image (result.qrCode is a Buffer)
      await bot.sendPhoto(
        chatId,
        result.qrCode,
        {
          caption: '📱 <b>Web Login</b>\n\n1. Open Telegram on your phone\n2. Go to Settings → Devices → Link Desktop Device\n3. Scan this QR code\n\n⏳ Waiting for you to scan and authorize...',
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔄 Refresh QR Code', callback_data: 'btn_login_web' }],
              [{ text: '◀️ Cancel', callback_data: 'btn_login_cancel' }],
            ],
          },
        }
      );
      
      // Delete the previous message
      try {
        await bot.deleteMessage(chatId, callbackQuery.message.message_id);
      } catch (e) {
        // Ignore if message already deleted
      }
    } else {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `❌ <b>Web Login Failed</b>\n\n<b>Error:</b> ${result.error}\n\nPlease try another login method.`,
        { parse_mode: 'HTML', ...createLoginOptionsKeyboard() }
      );
    }
  } catch (error) {
    logger.logError('LINK', userId, error, 'Web login error');
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      `❌ <b>Web Login Error</b>\n\n<b>Error:</b> ${error.message}\n\nPlease try another login method.`,
      { parse_mode: 'HTML', ...createLoginOptionsKeyboard() }
    );
  }
}

export async function handleLoginSharePhone(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Share Phone', chatId);
  logger.logChange('LINK', userId, 'Requesting phone number via share button');

  await safeAnswerCallback(bot, callbackQuery.id);

  // Send message with request contact keyboard directly (skip intermediate step)
  await bot.sendMessage(
    chatId,
    '📱 <b>Share Your Phone Number</b>\n\nPlease tap the button below to share your phone number:',
    {
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: [
          [{
            text: '📱 Share My Phone Number',
            request_contact: true
          }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );

  // Delete the previous message (login options menu)
  try {
    await bot.deleteMessage(chatId, callbackQuery.message.message_id);
  } catch (e) {
    // Ignore if message already deleted
  }
}

export async function handleSharePhoneConfirm(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Share Phone Confirm', chatId);

  await safeAnswerCallback(bot, callbackQuery.id);

  // Send message with request contact keyboard
  await bot.sendMessage(
    chatId,
    '📱 <b>Share Your Phone Number</b>\n\nPlease tap the button below to share your phone number:',
    {
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: [
          [{
            text: '📱 Share My Phone Number',
            request_contact: true
          }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );

  // Delete the previous message
  try {
    await bot.deleteMessage(chatId, callbackQuery.message.message_id);
  } catch (e) {
    // Ignore if message already deleted
  }
}

export async function handleLoginTypePhone(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Type Phone', chatId);
  logger.logChange('LINK', userId, 'Requesting phone number input for new account');

  await safeAnswerCallback(bot, callbackQuery.id);

  // Allow users to link multiple accounts - no restriction here
  // The saveLinkedAccount method will handle duplicate phone numbers
  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    `📱 <b>Link Account</b>\n\nPlease send your phone number in international format:\n\n<b>Format:</b> <code>+1234567890</code> or <code>+1 234 567 8900</code>\n<b>Example:</b> <code>+1234567890</code>`,
    { parse_mode: 'HTML', ...createBackButton() }
  );
  
  return true; // Signal that phone number input is expected
}

export async function handleLoginCancel(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  await safeAnswerCallback(bot, callbackQuery.id);

  // Cancel web login if in progress
  await accountLinker.cancelWebLogin(userId);

  // Show login options again
  await bot.sendMessage(
    chatId,
    `📱 <b>Link Account</b>\n\nChoose your preferred login method:\n\n🌐 <b>Web Login:</b> Scan QR code with Telegram app\n📱 <b>Share Phone:</b> Share your phone number via button\n⌨️ <b>Type Phone:</b> Enter phone number manually\n\n`,
    { parse_mode: 'HTML', ...createLoginOptionsKeyboard() }
  );

  // Delete the previous message
  try {
    await bot.deleteMessage(chatId, callbackQuery.message.message_id);
  } catch (e) {
    // Ignore if message already deleted
  }
}

export async function handlePhoneNumber(bot, msg, phoneNumber) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const username = msg.from.username || 'Unknown';

  // Mask phone number for logging (show first 3 and last 4 digits)
  // Handle edge case where phone number might be shorter than expected
  let maskedPhone = phoneNumber;
  if (phoneNumber.length >= 7) {
    maskedPhone = phoneNumber.replace(/(.{3})(.{3})(.{4})/, '$1***$3');
  } else if (phoneNumber.length >= 4) {
    maskedPhone = phoneNumber.substring(0, 3) + '***' + phoneNumber.substring(phoneNumber.length - 1);
  } else {
    maskedPhone = '***' + phoneNumber.substring(phoneNumber.length - 1);
  }
  logger.logChange('PHONE_INPUT', userId, `Phone number provided: ${maskedPhone}`);

  try {
    // Show connecting status
    const connectingMsg = await bot.sendMessage(
      chatId,
      '🔌 Connecting to Telegram...',
      { parse_mode: 'HTML' }
    );
    console.log(`[LINK] Showing connecting status for user ${userId}`);
    logger.logInfo('LINK', `Initiating account link for user ${userId}`, userId);
    
    // Update to sending status
    await bot.editMessageText(
      '📤 Sending verification code...',
      {
        chat_id: chatId,
        message_id: connectingMsg.message_id,
        parse_mode: 'HTML'
      }
    );
    console.log(`[LINK] Showing sending code status for user ${userId}`);
    
    const result = await accountLinker.initiateLink(userId, phoneNumber);
    
    if (result.success) {
      logger.logSuccess('LINK', userId, 'Verification code sent successfully');
      otpHandler.clearOTP(userId);
      
      // Update message to show success and OTP keypad
      await bot.editMessageText(
        '✅ Verification code sent!\n\nPlease enter the code using the keypad below:',
        {
          chat_id: chatId,
          message_id: connectingMsg.message_id,
          reply_markup: createOTPKeypad().reply_markup
        }
      );
      console.log(`[LINK] Verification code sent successfully to user ${userId}`);
    } else {
      logger.logError('LINK', userId, new Error(result.error), 'Failed to initiate link');
      // Notify admins of link errors
      adminNotifier.notifyUserError('LINK_ERROR', userId, result.error, {
        username,
        phone: phoneNumber,
        details: 'Failed to initiate account linking',
      }).catch(() => {}); // Silently fail to avoid blocking
      
      // Try to edit the status message, or send new one if it fails
      try {
        let errorMessage = `❌ <b>Account Linking Failed</b>\n\n`;
        errorMessage += `<b>Error:</b> ${result.error}\n\n`;
        
        // Add helpful guidance based on error type
        if (result.error.includes('Too many failed password attempts') || result.error.includes('wait') && result.error.includes('minute')) {
          // Cooldown message - already has wait time, just add context
          errorMessage += `🔒 <b>Security Cooldown:</b> This prevents too many login attempts.\n\n`;
        } else if (result.error.includes('PHONE_PASSWORD_FLOOD') || (result.error.includes('FLOOD') && result.error.includes('PASSWORD'))) {
          errorMessage += `⏳ <b>Rate Limited:</b> Too many login attempts. Please wait 5-10 minutes before trying again.\n\n`;
        } else if (result.error.includes('PHONE') || result.error.includes('phone')) {
        } else if (result.error.includes('FLOOD') || result.error.includes('rate')) {
        } else if (result.error.includes('invalid') || result.error.includes('Invalid')) {
        }
        
        errorMessage += `Click "🔗 Link Account" to try again.`;
        
        await bot.editMessageText(
          errorMessage,
          {
            chat_id: chatId,
            message_id: connectingMsg.message_id,
            parse_mode: 'HTML',
            ...await createMainMenu(userId)
          }
        );
      } catch (editError) {
        await bot.sendMessage(
          chatId,
          `❌ <b>Account Linking Failed</b>\n\n<b>Error:</b> ${result.error}\n\nPlease try again using the "Link Account" button.`,
          { parse_mode: 'HTML', ...await createMainMenu(userId) }
        );
      }
    }
  } catch (error) {
    logger.logError('LINK', userId, error, 'Exception during account linking');
    console.log(`[LINK] Error during account linking for user ${userId}: ${error.message}`);
    // Notify admins of link errors
    adminNotifier.notifyUserError('LINK_ERROR', userId, error, {
      username,
      phone: phoneNumber,
      details: 'Exception during account linking',
    }).catch(() => {}); // Silently fail to avoid blocking
    
    // Send error message with better formatting
    try {
      await bot.sendMessage(
        chatId,
        `❌ <b>Account Linking Error</b>\n\n<b>Error:</b> ${error.message}\n\nClick "🔗 Link Account" to retry.`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
    } catch (sendError) {
      logger.logError('LINK', userId, sendError, 'Failed to send error message to user');
    }
  }
}

export async function handleOTPCallback(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const digit = data.replace('otp_', '');

  const result = otpHandler.handleOTPInput(userId, digit);

  if (result.action === 'submit') {
    const code = result.code;
    // Validate OTP code: must be exactly 5 digits
    if (code.length !== 5 || !/^\d{5}$/.test(code)) {
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please enter a valid 5-digit numeric code',
        show_alert: true,
      });
      return false;
    }

    logger.logChange('OTP', userId, 'OTP code submitted');
    console.log(`[OTP] User ${userId} submitted OTP code`);
    
    // Show verifying status
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      '🔍 Verifying code...',
      { parse_mode: 'HTML' }
    );
    console.log(`[OTP] Showing verifying status for user ${userId}`);
    
    const verifyResult = await accountLinker.verifyOTP(userId, code);
    
    if (verifyResult.success) {
      // Show connecting account status
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '🔌 Connecting account...',
        { parse_mode: 'HTML' }
      );
      console.log(`[OTP] Showing connecting account status for user ${userId}`);
      
      logger.logSuccess('ACCOUNT_LINKED', userId, `Account ${verifyResult.accountId} linked successfully`);
      console.log(`[OTP] Account ${verifyResult.accountId} linked successfully for user ${userId}`);
      
      // Note: Updates channel joining is handled by accountLinker.joinUpdatesChannel()
      // which is called automatically during account linking, so we don't need to call it here
      if (config.updatesChannel) {
        // Mark user as verified since account is linked
        await userService.updateUserVerification(userId, true);
      }
      
      // Notify admins
      adminNotifier.notifyUserAction('ACCOUNT_LINKED', userId, {
        username: callbackQuery.from.username || null,
        accountId: verifyResult.accountId || null,
        details: `Account linked successfully via OTP`,
      }).catch(() => {}); // Silently fail to avoid blocking
      
      otpHandler.clearOTP(userId);
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `✅ <b>Account Linked Successfully!</b>\n\n🎉 Your account is now connected and ready to use.`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
      await safeAnswerCallback(bot, callbackQuery.id);
      console.log(`[OTP] Account linking completed successfully for user ${userId}`);
      return false;
    } else if (verifyResult.requiresPassword) {
      logger.logChange('2FA', userId, 'Password authentication required');
      otpHandler.clearOTP(userId);
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '🔐 Your account has 2FA enabled.\n\nPlease send your 2FA password:',
        createBackButton()
      );
      await safeAnswerCallback(bot, callbackQuery.id);
      return true; // Signal that password input is expected
    } else {
      logger.logError('OTP', userId, new Error(verifyResult.error), 'OTP verification failed');
      // Notify admins of OTP errors
      adminNotifier.notifyUserError('OTP_ERROR', userId, verifyResult.error, {
        username: callbackQuery.from.username || 'Unknown',
        details: 'OTP verification failed',
      }).catch(() => {}); // Silently fail to avoid blocking
      // Provide helpful error message
      let errorText = `❌ Verification Failed\n\n${verifyResult.error}`;
      if (verifyResult.error.includes('code') || verifyResult.error.includes('invalid')) {
      } else if (verifyResult.error.includes('expired') || verifyResult.error.includes('timeout')) {
      }
      
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: errorText,
        show_alert: true,
      });
      
      // Show error in message too
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `❌ <b>Verification Failed</b>\n\n<b>Error:</b> ${verifyResult.error}\n\nPlease check your code and try again, or click "Link Account" to start over.`,
        { 
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔗 Try Again', callback_data: 'btn_link' }],
              [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
            ]
          }
        }
      );
      return false;
    }
  } else {
    // Update the message with current OTP code
    const currentCode = otpHandler.getCurrentCode(userId);
    const displayCode = currentCode.padEnd(5, '_').split('').join(' ');
    
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      `Enter verification code:\n\n\`${displayCode}\`\n\nUse the keypad below:`,
      {
        reply_markup: createOTPKeypad().reply_markup,
        parse_mode: 'Markdown',
      }
    );
    
    await safeAnswerCallback(bot, callbackQuery.id);
    return false;
  }
}

export async function handleSetStartMessage(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  console.log(`[handleSetStartMessage] Processing message from user ${userId}, text: ${msg.text?.substring(0, 50) || 'empty'}...`);

  if (!accountLinker.isLinked(userId)) {
    await bot.sendMessage(
      chatId,
      '❌ Please link an account first!',
      await createMainMenu(userId)
    );
    console.log(`[handleSetStartMessage] User ${userId} not linked, returning false`);
    return false;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await bot.sendMessage(
      chatId,
      '❌ No active account found!',
      await createMainMenu(userId)
    );
    console.log(`[handleSetStartMessage] User ${userId} has no active account, returning false`);
    return false;
  }

  let text = msg.text?.trim();
  
  if (!text) {
    await bot.sendMessage(
      chatId,
      `📝 <b>Set Broadcast Message</b>\n\nPlease send your broadcast message:`,
      { parse_mode: 'HTML', ...createBackButton() }
    );
    console.log(`[handleSetStartMessage] User ${userId} sent empty message, keeping pending state`);
    return false; // Keep pending state so user can retry
  }

  // Extract entities (for premium emoji support)
  let messageEntities = null;
  if (msg.entities && msg.entities.length > 0) {
    messageEntities = msg.entities.map(e => ({
      type: e.type,
      offset: e.offset,
      length: e.length,
      language: e.language,
      url: e.url,
      user: e.user,
      custom_emoji_id: e.custom_emoji_id, // For premium emojis
    }));
    console.log(`[handleSetStartMessage] Extracted ${messageEntities.length} entities from message (including premium emojis)`);
  }

  // Check if message contains HTML tags (from forwarded messages with formatting)
  // Strip HTML tags to prevent them from showing in broadcasts
  if (text.includes('<') && text.includes('>')) {
    console.log(`[handleSetStartMessage] Detected HTML tags in message from user ${userId}, stripping them...`);
    text = stripHtmlTags(text);
    console.log(`[handleSetStartMessage] HTML tags stripped, new length: ${text.length}`);
  }

  // Validate message length (Telegram limit is 4096 characters)
  if (text.length > 4096) {
    await bot.sendMessage(
      chatId,
      '❌ Message is too long. Telegram messages have a maximum length of 4096 characters.\n\nPlease shorten your message and try again.',
      createBackButton()
    );
    console.log(`[handleSetStartMessage] User ${userId} sent message that's too long: ${text.length} characters`);
    return false; // Keep pending state so user can retry
  }

  logger.logChange('MESSAGE_SET', userId, `Broadcast message set: ${text.substring(0, 50)}...`);
  const result = await messageService.saveMessage(accountId, text, 'A', messageEntities);
  
  if (result.success) {
    // Notify admins
    adminNotifier.notifyUserAction('MESSAGE_SET', userId, {
      username: msg.from.username || null,
      accountId: accountId || null,
      message: text,
      details: `Broadcast message set successfully`,
    }).catch(() => {}); // Silently fail to avoid blocking
    
    await bot.sendMessage(
      chatId,
      `✅ <b>Broadcast Message Set Successfully!</b>`,
      { parse_mode: 'HTML', ...await createMainMenu(userId) }
    );
    console.log(`[handleSetStartMessage] User ${userId} successfully set message, returning true`);
    return true; // Success - clear pending state
  } else {
    let errorMessage = `❌ <b>Failed to Save Message</b>\n\n<b>Error:</b> ${result.error}\n\n`;
    if (result.error.includes('database') || result.error.includes('Database')) {
    } else {
    }
    errorMessage += `Your message is still saved - you can retry.`;
    
    await bot.sendMessage(
      chatId,
      errorMessage,
      { parse_mode: 'HTML', ...createBackButton() }
    );
    console.log(`[handleSetStartMessage] User ${userId} failed to save message: ${result.error}, returning false`);
    return false; // Keep pending state so user can retry
  }
}


export async function handlePasswordInput(bot, msg, password) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const username = msg.from.username || 'Unknown';

  logger.logChange('2FA', userId, '2FA password provided');
  console.log(`[2FA] User ${userId} provided password for 2FA authentication`);

  let verifyingMsg = null;
  try {
    // Show verifying password status
    verifyingMsg = await bot.sendMessage(
      chatId,
      '🔍 Verifying password...',
      { parse_mode: 'HTML' }
    );
    console.log(`[2FA] Showing verifying password status for user ${userId}`);
    
    const result = await accountLinker.verifyPassword(userId, password);
    
    if (result.success) {
      // Show connecting account status
      await bot.editMessageText(
        '🔌 Connecting account...',
        {
          chat_id: chatId,
          message_id: verifyingMsg.message_id,
          parse_mode: 'HTML'
        }
      );
      console.log(`[2FA] Showing connecting account status for user ${userId}`);
      
      logger.logSuccess('ACCOUNT_LINKED', userId, `Account ${result.accountId} linked successfully via 2FA`);
      
      // Note: Updates channel joining is handled by accountLinker.joinUpdatesChannel()
      // which is called automatically during account linking, so we don't need to call it here
      if (config.updatesChannel) {
        // Mark user as verified since account is linked
        await userService.updateUserVerification(userId, true);
      }
      
      // Notify admins
      adminNotifier.notifyUserAction('ACCOUNT_LINKED', userId, {
        username: username || null,
        accountId: result.accountId || null,
        details: `Account linked successfully via 2FA password`,
      }).catch(() => {}); // Silently fail to avoid blocking
      
      await bot.editMessageText(
        `✅ <b>Account Linked Successfully!</b>\n\n🎉 Your account is now connected and ready to use.`,
        {
          chat_id: chatId,
          message_id: verifyingMsg.message_id,
          parse_mode: 'HTML',
          ...await createMainMenu(userId)
        }
      );
      console.log(`[2FA] Account linking completed successfully for user ${userId}`);
    } else {
      logger.logError('2FA', userId, new Error(result.error), 'Password verification failed');
      console.log(`[2FA] Password verification failed for user ${userId}: ${result.error}`);
      // Notify admins of 2FA errors
      adminNotifier.notifyUserError('2FA_ERROR', userId, result.error, {
        username,
        details: 'Password verification failed',
      }).catch(() => {}); // Silently fail to avoid blocking
      
      // Check if max attempts reached
      if (result.maxAttemptsReached) {
        let errorMessage = `❌ <b>Maximum Password Attempts Reached</b>\n\n`;
        errorMessage += `You have exceeded the maximum number of password attempts (3 tries).\n\n`;
        
        // Show cooldown information if available
        if (result.cooldownRemaining && result.cooldownRemaining > 0) {
          const minutes = result.cooldownMinutes || Math.ceil(result.cooldownRemaining / 60000);
          const seconds = result.cooldownSeconds || Math.ceil(result.cooldownRemaining / 1000);
          errorMessage += `⏳ <b>Please wait:</b> ${minutes} minute(s) (${seconds} seconds)\n\n`;
          errorMessage += `After the wait period, you can try entering your password again.\n\n`;
        } else {
          errorMessage += `⏳ Please wait a few minutes before trying again.\n\n`;
        }
        
        errorMessage += `You can try again after the wait period.`;
        
        try {
          await bot.editMessageText(
            errorMessage,
            {
              chat_id: chatId,
              message_id: verifyingMsg.message_id,
              parse_mode: 'HTML',
              ...await createMainMenu(userId)
            }
          );
        } catch (editError) {
          await bot.sendMessage(
            chatId,
            errorMessage,
            { parse_mode: 'HTML', ...await createMainMenu(userId) }
          );
        }
      } else {
        // Show remaining attempts
        const remainingAttempts = result.remainingAttempts !== undefined ? result.remainingAttempts : 2;
        const attempts = result.attempts !== undefined ? result.attempts : 1;
        
        // Try to edit the status message, or send new one if it fails
        let errorMessage = `❌ <b>Password Verification Failed</b>\n\n<b>Error:</b> ${result.error}\n\n`;
        errorMessage += `⚠️ <b>Attempts:</b> ${attempts}/3\n`;
        errorMessage += `🔄 <b>Remaining:</b> ${remainingAttempts} ${remainingAttempts === 1 ? 'try' : 'tries'}\n\n`;
        
        if (result.error.includes('password') || result.error.includes('incorrect')) {
        } else if (result.error.includes('FLOOD') || result.error.includes('rate')) {
        }
        
        if (remainingAttempts > 0) {
          errorMessage += `Please try entering your password again.`;
        } else {
          errorMessage += `You can try entering your password again after the wait period.`;
        }
        
        try {
          await bot.editMessageText(
            errorMessage,
            {
              chat_id: chatId,
              message_id: verifyingMsg.message_id,
              parse_mode: 'HTML',
              ...await createMainMenu(userId)
            }
          );
        } catch (editError) {
          await bot.sendMessage(
            chatId,
            errorMessage,
            { parse_mode: 'HTML', ...await createMainMenu(userId) }
          );
        }
      }
    }
  } catch (error) {
    logger.logError('2FA', userId, error, 'Exception during password verification');
    console.log(`[2FA] Error during password verification for user ${userId}: ${error.message}`);
    // Notify admins of 2FA errors
    adminNotifier.notifyUserError('2FA_ERROR', userId, error, {
      username,
      details: 'Exception during password verification',
    }).catch(() => {}); // Silently fail to avoid blocking
    
    // Send error message with better formatting
    try {
      await bot.sendMessage(
        chatId,
        `❌ <b>Password Verification Error</b>\n\n<b>Error:</b> ${error.message}\n\nClick "🔗 Link Account" to retry.`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
    } catch (sendError) {
      logger.logError('2FA', userId, sendError, 'Failed to send error message to user');
    }
  }
}

export async function handleSetStartMessageButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  // Check verification requirement
  if (config.updatesChannel) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsername = config.updatesChannel.replace('@', '');
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsername);
      return;
    }
  }

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Please link an account first!',
      show_alert: true,
    });
    return;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const currentMessage = await messageService.getActiveMessage(accountId);
  const prompt = currentMessage 
    ? `📝 <b>Set Broadcast Message</b>\n\n<b>Current message:</b>\n<i>"${escapeHtml(currentMessage.length > 100 ? currentMessage.substring(0, 100) + '...' : currentMessage)}"</i>\n\nSend your new message to replace it:`
    : `📝 <b>Set Broadcast Message</b>\n\nPlease send your broadcast message:`;

  await safeEditMessage(bot, chatId, callbackQuery.message.message_id, prompt, { parse_mode: 'HTML', ...createBackButton() });
  await safeAnswerCallback(bot, callbackQuery.id);
}


export async function handleStartBroadcast(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Check verification requirement
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await bot.sendMessage(
        chatId,
        '❌ Please verify by joining our updates channel(s) first!',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: createChannelButtonsKeyboard(channelUsernames)
          }
        }
      );
      return;
    }
  }

  if (!accountLinker.isLinked(userId)) {
    await bot.sendMessage(
      chatId,
      `❌ <b>Account Not Linked</b>\n\nPlease link an account first to start broadcasting.`,
      { parse_mode: 'HTML', ...await createMainMenu(userId) }
    );
    return;
  }

  // Check if broadcast is running for the current active account
  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await bot.sendMessage(
      chatId,
      `❌ <b>No Active Account</b>\n\nPlease switch to an account or link a new one.`,
      { parse_mode: 'HTML', ...await createMainMenu(userId) }
    );
    return;
  }

  if (automationService.isBroadcasting(userId, accountId)) {
    await bot.sendMessage(
      chatId,
      `⚠️ <b>Broadcast Already Running</b>\n\n📢 A broadcast is already active for this account.`,
      { parse_mode: 'HTML', ...await createMainMenu(userId) }
    );
    return;
  }

  // automationService.startBroadcast will get message from messageService if not provided
  const result = await automationService.startBroadcast(userId, null);

  if (result.success) {
    const accountId = accountLinker.getActiveAccountId(userId);
    logger.logSuccess('BROADCAST_STARTED', userId, `Broadcast started for account ${accountId}`);
    
    // Notify admins
    adminNotifier.notifyUserAction('BROADCAST_STARTED', userId, {
      username: msg.from.username || null,
      accountId: accountId || null,
      details: `Broadcast started successfully`,
    }).catch(() => {}); // Silently fail to avoid blocking
    
    await bot.sendMessage(
      chatId,
      `✅ Broadcast started!\n\nBroadcast is now running. Messages will be sent automatically.\n\nUse the button below to stop:`,
      createStopButton()
    );
  } else if (result.error === 'TAGS_REQUIRED') {
    // Show tags required message with quick apply button
    const tagsMessage = `🔒 <b>Profile Tags Required</b>\n\n` +
      `To start broadcasting, your account profile must have:\n\n` +
      `• <b>Last Name:</b> ${escapeHtml(config.lastNameTag)}\n` +
      `• <b>Bio:</b> ${escapeHtml(config.bioTag)}\n\n` +
      `Click "⚡ Quick Apply" to set these tags automatically.`;
    
    await bot.sendMessage(
      chatId,
      tagsMessage,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚡ Quick Apply Tags', callback_data: 'btn_apply_tags' }],
            [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
          ]
        }
      }
    );
  } else {
    let errorMessage = `❌ <b>Failed to Start Broadcast</b>\n\n<b>Error:</b> ${result.error}\n\n`;
    
    if (result.error.includes('message') || result.error.includes('Message')) {
    } else if (result.error.includes('account') || result.error.includes('Account')) {
    } else {
    }
    
    await bot.sendMessage(
      chatId,
      errorMessage,
      { parse_mode: 'HTML', ...await createMainMenu(userId) }
    );
  }
}

export async function handleStartBroadcastButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  // Check verification requirement
  if (config.updatesChannel) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsername = config.updatesChannel.replace('@', '');
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsername);
      return;
    }
  }

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Please link your account first!',
      show_alert: true,
    });
    const linkResult = await handleLinkButton(bot, callbackQuery);
    // Set pending state for phone number input
    if (linkResult) {
      addPendingPhoneNumber(userId);
      logger.logChange('PHONE_INPUT', userId, 'Waiting for phone number input (redirected from start broadcast)');
    }
    return;
  }

  // Get current active account
  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  // Answer callback immediately for better UX
  await safeAnswerCallback(bot, callbackQuery.id);
  
  // Toggle behavior: if broadcasting for this account, stop it; if not, start it
  if (automationService.isBroadcasting(userId, accountId)) {
    // Optimistically update UI immediately
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      '⏳ Stopping broadcast...',
      await createMainMenu(userId)
    );
    
    // Process stop in background
    (async () => {
      try {
        const result = await automationService.stopBroadcast(userId, accountId);

        if (result.success) {
          logger.logSuccess('BROADCAST_STOPPED', userId, `Broadcast stopped for account ${accountId}`);
          console.log(`[BROADCAST_STOP] Broadcast successfully stopped for user ${userId}, account ${accountId}`);
          
          // Notify admins
          adminNotifier.notifyUserAction('BROADCAST_STOPPED', userId, {
            username: callbackQuery.from.username || null,
            accountId: accountId || null,
            details: `Broadcast stopped successfully`,
          }).catch(err => {
            console.log(`[SILENT_FAIL] Admin notification failed: ${err.message}`);
          });
          
          // Get status text with updated broadcast state
          const statusText = await generateStatusText(userId);
          
          await safeEditMessage(
            bot,
            chatId,
            callbackQuery.message.message_id,
            `✅ <b>Broadcast Stopped</b>\n\n📢 Broadcasting has been stopped successfully.${statusText}`,
            { parse_mode: 'HTML', ...await createMainMenu(userId) }
          );
          
          console.log(`[BROADCAST_STOP] UI updated with menu showing "▶️ Start Broadcast" button for user ${userId}`);
        } else if (result.error === 'TAGS_REQUIRED') {
          // Show tags required message with quick apply button
          const tagsMessage = `🔒 <b>Profile Tags Required</b>\n\n` +
            `To stop broadcasting, your account profile must have:\n\n` +
            `• <b>Last Name:</b> ${escapeHtml(config.lastNameTag)}\n` +
            `• <b>Bio:</b> ${escapeHtml(config.bioTag)}\n\n` +
            `Click "⚡ Quick Apply" to set these tags automatically.`;
          
          await safeEditMessage(
            bot,
            chatId,
            callbackQuery.message.message_id,
            tagsMessage,
            {
              parse_mode: 'HTML',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '⚡ Quick Apply Tags', callback_data: 'btn_apply_tags' }],
                  [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
                ]
              }
            }
          );
        } else {
          let errorMessage = `❌ <b>Failed to Stop Broadcast</b>\n\n<b>Error:</b> ${result.error}\n\n`;
          
          await safeEditMessage(
            bot,
            chatId,
            callbackQuery.message.message_id,
            errorMessage,
            { parse_mode: 'HTML', ...await createMainMenu(userId) }
          );
        }
      } catch (error) {
        logger.logError('BROADCAST_STOP', userId, error, 'Error stopping broadcast');
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          `❌ <b>Error Stopping Broadcast</b>\n\n<b>Error:</b> ${error.message}`,
          { parse_mode: 'HTML', ...await createMainMenu(userId) }
        );
      }
    })().catch(err => {
      logger.logError('BACKGROUND_TASK', userId, err, 'Unhandled error in broadcast stop background task');
      console.error(`[CRITICAL] Unhandled error in broadcast stop background task: ${err.message}`, err);
    });
    return;
  }

  // Optimistically update UI immediately for start
  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    '⏳ Starting broadcast...',
    await createMainMenu(userId)
  );
  
  // Process start in background
  (async () => {
    try {
      // Validate accountId exists before proceeding
      if (!accountId) {
        throw new Error('No active account found');
      }

      const result = await automationService.startBroadcast(userId, null);

      if (result.success) {
        logger.logSuccess('BROADCAST_STARTED', userId, `Broadcast started for account ${accountId}`);
        console.log(`[BROADCAST_START] Broadcast successfully started for user ${userId}, account ${accountId}`);
        
        // Notify admins
        adminNotifier.notifyUserAction('BROADCAST_STARTED', userId, {
          username: callbackQuery.from.username || null,
          accountId: accountId || null,
          details: `Broadcast started successfully`,
        }).catch(err => {
          console.log(`[SILENT_FAIL] Admin notification failed: ${err.message}`);
        });
        
        // Get status text with updated broadcast state
        const statusText = await generateStatusText(userId);
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          `✅ <b>Broadcast Started Successfully!</b>\n\n📢 <b>Status:</b> Active\n⏱️ <b>Interval:</b> Custom (per cycle)\n⏰ <b>Duration:</b> Until you stop it${statusText}`,
          { parse_mode: 'HTML', ...await createMainMenu(userId) }
        );
        
        console.log(`[BROADCAST_START] UI updated with menu showing "✅ Started" button for user ${userId}`);
      } else if (result.error === 'TAGS_REQUIRED') {
        // Show tags required message with quick apply button
        const tagsMessage = `🔒 <b>Profile Tags Required</b>\n\n` +
          `To start broadcasting, your account profile must have:\n\n` +
          `• <b>Last Name:</b> ${escapeHtml(config.lastNameTag)}\n` +
          `• <b>Bio:</b> ${escapeHtml(config.bioTag)}\n\n` +
          `Click "⚡ Quick Apply" to set these tags automatically.`;
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          tagsMessage,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '⚡ Quick Apply Tags', callback_data: 'btn_apply_tags' }],
                [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
              ]
            }
          }
        );
      } else {
        let errorMessage = `❌ <b>Failed to Start Broadcast</b>\n\n<b>Error:</b> ${result.error}\n\n`;
        if (result.error.includes('message') || result.error.includes('Message')) {
        } else {
        }
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          errorMessage,
          { parse_mode: 'HTML', ...await createMainMenu(userId) }
        );
      }
    } catch (error) {
      logger.logError('BROADCAST_START', userId, error, 'Error starting broadcast');
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `❌ <b>Error Starting Broadcast</b>\n\n<b>Error:</b> ${error.message}`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
    }
  })().catch(err => {
    logger.logError('BACKGROUND_TASK', userId, err, 'Unhandled error in broadcast start background task');
    console.error(`[CRITICAL] Unhandled error in broadcast start background task: ${err.message}`, err);
  });
}

export async function handleStopBroadcast(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Check verification requirement
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await bot.sendMessage(
        chatId,
        '❌ Please verify by joining our updates channel(s) first!',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: createChannelButtonsKeyboard(channelUsernames)
          }
        }
      );
      return;
    }
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await bot.sendMessage(
      chatId,
      '❌ No active account found!',
      await createMainMenu(userId)
    );
    return;
  }

  const result = await automationService.stopBroadcast(userId, accountId);

  if (result.success) {
    logger.logSuccess('BROADCAST_STOPPED', userId, `Broadcast stopped for account ${accountId}`);
    
    // Notify admins
    adminNotifier.notifyUserAction('BROADCAST_STOPPED', userId, {
      username: msg.from.username || null,
      accountId: accountId || null,
      details: `Broadcast stopped successfully`,
    }).catch(() => {}); // Silently fail to avoid blocking
    
    await bot.sendMessage(
      chatId,
      '✅ Broadcast stopped successfully!',
      await createMainMenu(userId)
    );
  } else if (result.error === 'TAGS_REQUIRED') {
    // Show tags required message with quick apply button
    const tagsMessage = `🔒 <b>Profile Tags Required</b>\n\n` +
      `To stop broadcasting, your account profile must have:\n\n` +
      `• <b>Last Name:</b> ${escapeHtml(config.lastNameTag)}\n` +
      `• <b>Bio:</b> ${escapeHtml(config.bioTag)}\n\n` +
      `Click "⚡ Quick Apply" to set these tags automatically.`;
    
    await bot.sendMessage(
      chatId,
      tagsMessage,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚡ Quick Apply Tags', callback_data: 'btn_apply_tags' }],
            [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
          ]
        }
      }
    );
  } else {
    await bot.sendMessage(
      chatId,
      `❌ ${result.error}`,
      await createMainMenu(userId)
    );
  }
}

export async function handleStopBroadcastButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const result = await automationService.stopBroadcast(userId, accountId);

  if (result.success) {
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      '✅ Broadcast stopped successfully!',
      await createMainMenu(userId)
    );
    await safeAnswerCallback(bot, callbackQuery.id);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: result.error,
      show_alert: true,
    });
  }
}

export async function handleStopCallback(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const result = await automationService.stopBroadcast(userId, accountId);

  if (result.success) {
    logger.logSuccess('BROADCAST_STOPPED', userId, `Broadcast stopped for account ${accountId}`);
    
    // Notify admins
    adminNotifier.notifyUserAction('BROADCAST_STOPPED', userId, {
      username: callbackQuery.from.username || null,
      accountId: accountId || null,
      details: `Broadcast stopped successfully`,
    }).catch(() => {}); // Silently fail to avoid blocking
    
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      '✅ Broadcast stopped successfully!',
      await createMainMenu(userId)
    );
    await safeAnswerCallback(bot, callbackQuery.id);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: result.error,
      show_alert: true,
    });
  }
}

export async function handleStatus(bot, msg) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Check verification requirement
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await bot.sendMessage(
        chatId,
        '❌ Please verify by joining our updates channel(s) first!',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: createChannelButtonsKeyboard(channelUsernames)
          }
        }
      );
      return;
    }
  }

  const isLinked = accountLinker.isLinked(userId);
  const accounts = await accountLinker.getAccounts(userId);
  const activeAccountId = accountLinker.getActiveAccountId(userId);
  
  // Check if broadcast is running for the current active account
  const isBroadcasting = activeAccountId ? automationService.isBroadcasting(userId, activeAccountId) : false;
  const broadcastingAccountId = automationService.getBroadcastingAccountId(userId);

  // Minimal account status - just account info
  let statusMessage = '<b>Account</b>\n\n';
  
  if (isLinked && accounts.length > 0) {
    const activeAccount = accounts.find(acc => acc.accountId === activeAccountId);
    const displayName = activeAccount ? (activeAccount.firstName || activeAccount.phone) : 'None';
    statusMessage += `Active: ${escapeHtml(displayName)}\n`;
    
    if (isBroadcasting) {
      statusMessage += `Broadcast: Active\n`;
    } else {
      statusMessage += `Broadcast: Inactive\n`;
    }
  } else {
    statusMessage += `Not linked\n`;
  }

  await bot.sendMessage(chatId, statusMessage, { parse_mode: 'HTML', ...await createMainMenu(userId) });
}

export async function handleStatusButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  // Check verification requirement
  if (config.updatesChannel) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsername = config.updatesChannel.replace('@', '');
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsername);
      return;
    }
  }

  const isLinked = accountLinker.isLinked(userId);
  const accounts = await accountLinker.getAccounts(userId);
  const activeAccountId = accountLinker.getActiveAccountId(userId);
  
  // Check if broadcast is running for the current active account
  const isBroadcasting = activeAccountId ? automationService.isBroadcasting(userId, activeAccountId) : false;
  const broadcastingAccountId = automationService.getBroadcastingAccountId(userId);

  // Minimal account status - just account info
  let statusMessage = '<b>Account</b>\n\n';
  
  if (isLinked && accounts.length > 0) {
    const activeAccount = accounts.find(acc => acc.accountId === activeAccountId);
    const displayName = activeAccount ? (activeAccount.firstName || activeAccount.phone) : 'None';
    statusMessage += `Active: ${escapeHtml(displayName)}\n`;
    
    if (isBroadcasting) {
      statusMessage += `Broadcast: Active\n`;
    } else {
      statusMessage += `Broadcast: Inactive\n`;
    }
  } else {
    statusMessage += `Not linked\n`;
  }
  
  await safeEditMessage(
    bot, 
    chatId, 
    callbackQuery.message.message_id, 
    statusMessage, 
    { parse_mode: 'HTML', ...await createMainMenu(userId) }
  );
  await safeAnswerCallback(bot, callbackQuery.id);
}

// Unified account management handler
export async function handleAccountButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Account', chatId);

  // Check verification requirement
  if (config.updatesChannel) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsername = config.updatesChannel.replace('@', '');
    await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
      show_alert: true,
    });
      await showVerificationRequired(bot, chatId, channelUsername);
    return;
  }
  }

  const accounts = await accountLinker.getAccounts(userId);
  const activeAccountId = accountLinker.getActiveAccountId(userId);

  // Create account management menu
  const buttons = [];
  
  // Add "Link Account" button (always available) - full width, prominent
  buttons.push([{ text: '➕ Link New Account', callback_data: 'btn_link' }]);
  
  // Add Premium button - full width
  buttons.push([{ text: '⭐ Premium', callback_data: 'btn_premium' }]);
  
  if (accounts.length > 0) {
    // Add separator (using a non-clickable visual separator)
    // Note: Telegram doesn't support non-clickable buttons, so we'll skip this
    // Instead, we'll use spacing in the message
    
    // Add account list with switch and delete options
    accounts.forEach((account, index) => {
      const prefix = account.isActive ? '✅' : '⚪';
      const displayName = account.firstName || account.phone;
      const accountText = account.isActive 
        ? `${prefix} ${displayName} (Active)`
        : `${prefix} ${displayName}`;
      
      buttons.push([
        {
          text: accountText,
          callback_data: `switch_account_${account.accountId}`
        },
        {
          text: '🗑️',
          callback_data: `delete_account_${account.accountId}`
        }
      ]);
    });
  }
  
  buttons.push([{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]);

  const accountMessage = accounts.length === 0
    ? '👤 <b>Account Management</b>\n\n📱 <i>No accounts linked yet</i>\n\nClick "➕ Link New Account" to add your first account and start broadcasting.'
    : `👤 <b>Account Management</b>\n\n📊 <b>Total:</b> ${accounts.length} account${accounts.length > 1 ? 's' : ''}\n\n✅ <b>Active:</b> ${escapeHtml(accounts.find(a => a.isActive)?.firstName || accounts.find(a => a.isActive)?.phone || 'None')}\n\n<i>Select an account to switch or delete.</i>`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    accountMessage,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: buttons
      }
    }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

// Keep old handler for backward compatibility (redirects to new handler)
export async function handleSwitchAccountButton(bot, callbackQuery) {
  await handleAccountButton(bot, callbackQuery);
}

// ==================== A/B MESSAGE HANDLERS ====================

export async function handleABMessagesButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'A/B Messages', chatId);

  // Check verification requirement
  if (config.updatesChannel) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsername = config.updatesChannel.replace('@', '');
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsername);
      return;
    }
  }

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Please link an account first!',
      show_alert: true,
    });
    return;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const { messageA, messageB } = await messageService.getABMessages(accountId);
  const settings = await configService.getAccountSettings(accountId);
  const abMode = settings?.abMode || false;
  const abModeType = settings?.abModeType || 'single';

  const abMessage = `🔄 <b>A/B Testing Messages</b>\n\n` +
    `📝 <b>Message A:</b> ${messageA ? `"${escapeHtml(messageA.substring(0, 50))}${messageA.length > 50 ? '...' : ''}"` : '❌ Not set'}\n` +
    `📝 <b>Message B:</b> ${messageB ? `"${escapeHtml(messageB.substring(0, 50))}${messageB.length > 50 ? '...' : ''}"` : '❌ Not set'}\n\n` +
    `⚙️ <b>A/B Mode:</b> ${abMode ? `✅ ${abModeType.charAt(0).toUpperCase() + abModeType.slice(1)}` : '❌ Disabled'}\n\n` +
    `${!messageA || !messageB ? '⚠️ Set both messages to enable A/B testing.\n\n' : ''}` +
    `Use buttons below to set or view messages.`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    abMessage,
    { parse_mode: 'HTML', ...createABMessagesKeyboard(!!messageA, !!messageB) }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleABSetMessage(bot, callbackQuery, variant) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, `Set Message ${variant}`, chatId);

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Please link an account first!',
      show_alert: true,
    });
    return;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const currentMessage = await messageService.getActiveMessage(accountId, variant);
  const prompt = currentMessage
    ? `📝 <b>Set Message ${variant}</b>\n\n<b>Current Message ${variant}:</b>\n<i>"${escapeHtml(currentMessage.length > 100 ? currentMessage.substring(0, 100) + '...' : currentMessage)}"</i>\n\nSend your new message to replace it:`
    : `📝 <b>Set Message ${variant}</b>\n\nPlease send your Message ${variant}:`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    prompt,
    { parse_mode: 'HTML', ...createBackButton() }
  );
  
  // Store pending state - need to export or use global
  if (typeof global !== 'undefined' && !global.pendingABMessages) {
    global.pendingABMessages = new Map();
  }
  if (typeof global !== 'undefined') {
    global.pendingABMessages.set(userId, { accountId, variant });
  }
  
  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId, variant };
}

export async function handleABMessageInput(bot, msg, accountId, variant) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  let text = msg.text?.trim();
  
  if (!text) {
    await bot.sendMessage(
      chatId,
      `📝 <b>Set Message ${variant}</b>\n\nPlease send your Message ${variant}:`,
      { parse_mode: 'HTML', ...createBackButton() }
    );
    return;
  }

  // Extract entities (for premium emoji support)
  let messageEntities = null;
  if (msg.entities && msg.entities.length > 0) {
    messageEntities = msg.entities.map(e => ({
      type: e.type,
      offset: e.offset,
      length: e.length,
      language: e.language,
      url: e.url,
      user: e.user,
      custom_emoji_id: e.custom_emoji_id, // For premium emojis
    }));
    console.log(`[handleABMessageInput] Extracted ${messageEntities.length} entities from message ${variant} (including premium emojis)`);
  }

  // Check if message contains HTML tags (from forwarded messages with formatting)
  // Strip HTML tags to prevent them from showing in broadcasts
  if (text.includes('<') && text.includes('>')) {
    console.log(`[handleABMessageInput] Detected HTML tags in message ${variant} from user ${userId}, stripping them...`);
    text = stripHtmlTags(text);
    console.log(`[handleABMessageInput] HTML tags stripped, new length: ${text.length}`);
  }

  // Validate message length (Telegram limit is 4096 characters)
  if (text.length > 4096) {
    await bot.sendMessage(
      chatId,
      `❌ Message ${variant} is too long. Telegram messages have a maximum length of 4096 characters.\n\nPlease shorten your message and try again.`,
      createBackButton()
    );
    console.log(`[handleABMessageInput] User ${userId} sent message ${variant} that's too long: ${text.length} characters`);
    return;
  }

  logger.logChange('MESSAGE', userId, `Message ${variant} set: ${text.substring(0, 50)}...`);
  const result = await messageService.saveMessage(accountId, text, variant, messageEntities);
  
  if (result.success) {
      await bot.sendMessage(
        chatId,
        `✅ <b>Message ${variant} Set Successfully!</b>`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
  } else {
    let errorMessage = `❌ <b>Failed to Save Message</b>\n\n<b>Error:</b> ${result.error}\n\n`;
    
    await bot.sendMessage(
      chatId,
      errorMessage,
      { parse_mode: 'HTML', ...createBackButton() }
    );
  }
}

export async function handleABViewMessages(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'View A/B Messages', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const { messageA, messageB } = await messageService.getABMessages(accountId);

  const viewMessage = `📋 <b>A/B Messages</b>\n\n` +
    `📝 <b>Message A:</b>\n${messageA ? `<i>"${escapeHtml(messageA)}"</i>` : '<i>❌ Not set</i>'}\n\n` +
    `📝 <b>Message B:</b>\n${messageB ? `<i>"${escapeHtml(messageB)}"</i>` : '<i>❌ Not set</i>'}\n\n` +
    `Use buttons below to set or update messages.`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    viewMessage,
    { parse_mode: 'HTML', ...createABMessagesKeyboard(!!messageA, !!messageB) }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

// ==================== SAVED TEMPLATES HANDLERS ====================

export async function handleSavedTemplatesButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Saved Templates', chatId);

  // Check verification requirement
  if (config.updatesChannel) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsername = config.updatesChannel.replace('@', '');
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsername);
      return;
    }
  }

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Please link an account first!',
      show_alert: true,
    });
    return;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const templates = await savedTemplatesService.getSavedTemplates(accountId);
  const settings = await configService.getAccountSettings(accountId);
  const activeSlot = settings?.savedTemplateSlot !== null && settings?.savedTemplateSlot !== undefined ? settings.savedTemplateSlot : null;

  const template1 = templates.find(t => t.slot === 1);
  const template2 = templates.find(t => t.slot === 2);
  const template3 = templates.find(t => t.slot === 3);

  const templatesMessage = `💎 <b>Saved Messages Templates</b>\n\n` +
    `Source: Latest 3 messages from your Saved Messages\n\n` +
    `Active slot: <b>${activeSlot || 'None (using normal message)'}</b>\n\n` +
    `${template1 ? `✅ Slot 1: "${escapeHtml(template1.messageText.substring(0, 50))}${template1.messageText.length > 50 ? '...' : ''}"` : '⬜ Slot 1: Empty'}\n` +
    `${template2 ? `✅ Slot 2: "${escapeHtml(template2.messageText.substring(0, 50))}${template2.messageText.length > 50 ? '...' : ''}"` : '⬜ Slot 2: Empty'}\n` +
    `${template3 ? `✅ Slot 3: "${escapeHtml(template3.messageText.substring(0, 50))}${template3.messageText.length > 50 ? '...' : ''}"` : '⬜ Slot 3: Empty'}\n\n` +
    `🔄 Sync to pull the latest 3 from Saved Messages, then choose a slot.`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    templatesMessage,
    { parse_mode: 'HTML', ...createSavedTemplatesKeyboard(activeSlot, !!template1, !!template2, !!template3) }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleTemplateSync(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  // Answer callback immediately
  await safeAnswerCallback(bot, callbackQuery.id);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  // Optimistically update UI immediately
  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    '⏳ Syncing Saved Messages...',
    { parse_mode: 'HTML' }
  );

  // Process sync in background
  (async () => {
    try {
      // Validate accountId exists before proceeding
      if (!accountId) {
        throw new Error('No active account found');
      }

      logger.logButtonClick(userId, username, 'Sync Saved Templates', chatId);
      const result = await savedTemplatesService.syncSavedMessages(accountId);
      
      if (result.success) {
        await handleSavedTemplatesButton(bot, callbackQuery);
      } else {
        let errorMessage = `❌ <b>Failed to Sync Templates</b>\n\n<b>Error:</b> ${result.error}\n\n`;
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          errorMessage,
          { parse_mode: 'HTML', ...await createMainMenu(userId) }
        );
      }
    } catch (error) {
      logger.logError('TEMPLATE_SYNC', userId, error, 'Error syncing templates');
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `❌ <b>Error Syncing Templates</b>\n\n<b>Error:</b> ${error.message}`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
    }
  })().catch(err => {
    logger.logError('BACKGROUND_TASK', userId, err, 'Unhandled error in template sync background task');
    console.error(`[CRITICAL] Unhandled error in template sync background task: ${err.message}`, err);
  });
}

export async function handleTemplateSelect(bot, callbackQuery, slot) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, `Select Template Slot ${slot}`, chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  if (slot === 'none') {
    const result = await configService.setSavedTemplateSlot(accountId, null);
    if (result.success) {
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: '✅ Using normal message (no template slot)',
        show_alert: true,
      });
      await handleSavedTemplatesButton(bot, callbackQuery);
    } else {
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: `❌ Failed: ${result.error}`,
        show_alert: true,
      });
    }
    return;
  }

  const slotNum = parseInt(slot);
  if (isNaN(slotNum) || ![1, 2, 3].includes(slotNum)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Invalid slot number',
      show_alert: true,
    });
    return;
  }

  // Check if slot has a template
  const template = await savedTemplatesService.getSavedTemplate(accountId, slotNum);
  if (!template) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `Slot ${slotNum} is empty. Please sync Saved Messages first.`,
      show_alert: true,
    });
    return;
  }

  const result = await configService.setSavedTemplateSlot(accountId, slotNum);
  if (result.success) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `✅ Using Saved Template Slot ${slotNum}`,
      show_alert: true,
    });
    await handleSavedTemplatesButton(bot, callbackQuery);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `Error: ${result.error}`,
      show_alert: true,
    });
  }
}

export async function handleTemplateClear(bot, callbackQuery, slot) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, `Clear Template Slot ${slot}`, chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const slotNum = parseInt(slot);
  if (isNaN(slotNum) || ![1, 2, 3].includes(slotNum)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Invalid slot number',
      show_alert: true,
    });
    return;
  }
  
  const result = await savedTemplatesService.clearSlot(accountId, slotNum);
  
  if (result.success) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `✅ Slot ${slotNum} cleared`,
      show_alert: true,
    });
    await handleSavedTemplatesButton(bot, callbackQuery);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `Error: ${result.error}`,
      show_alert: true,
    });
  }
}
  
export async function handleVerifyChannel(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Verify Channel', chatId);

  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length === 0) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Updates channel not configured',
      show_alert: true,
    });
    return;
  }

  try {
    // Check if user is member of ALL required channels (not just one)
    let isMemberOfAll = true;
    const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
    const missingChannels = [];
    
    for (const channelUsername of channelUsernames) {
      if (!channelUsername || typeof channelUsername !== 'string') {
        continue; // Skip invalid channel names
      }

      try {
        // CRITICAL: Use safeBotApiCall to prevent rate limiting and bot deletion
        // getChat and getChatMember can trigger rate limits if called too frequently
        const chat = await safeBotApiCall(
          () => bot.getChat(`@${channelUsername}`),
          { maxRetries: 3, bufferSeconds: 1, throwOnFailure: false }
        );
        
        // Validate chat response
        if (!chat || !chat.id) {
          console.warn(`[VERIFICATION] Invalid chat response for @${channelUsername}`);
          isMemberOfAll = false;
          missingChannels.push(`@${channelUsername}`);
          continue;
        }

        const channelId = chat.id;
        
        // CRITICAL: Use safeBotApiCall for getChatMember to prevent rate limiting
        const member = await safeBotApiCall(
          () => bot.getChatMember(channelId, userId),
          { maxRetries: 3, bufferSeconds: 1, throwOnFailure: false }
        );
        
        // If API call failed, mark as missing
        if (!member) {
          console.warn(`[VERIFICATION] Failed to get chat member for user ${userId} in @${channelUsername}`);
          isMemberOfAll = false;
          missingChannels.push(`@${channelUsername}`);
          continue;
        }
        
        // Validate member response
        if (!member || !member.status) {
          console.warn(`[VERIFICATION] Invalid member response for user ${userId} in @${channelUsername}`);
          isMemberOfAll = false;
          missingChannels.push(`@${channelUsername}`);
          continue;
        }

        // User is a member if status is 'member', 'administrator', or 'creator'
        // Status 'left' means they left, 'kicked' means banned, 'restricted' means restricted
        const isMemberOfThisChannel = member.status === 'member' || 
                   member.status === 'administrator' || 
                   member.status === 'creator';
        
        console.log(`[VERIFICATION] User ${userId} membership status in @${channelUsername}: ${member.status}, isMember: ${isMemberOfThisChannel}`);
        
        if (!isMemberOfThisChannel) {
          // User is not in this channel - they must be in ALL channels
          isMemberOfAll = false;
          missingChannels.push(`@${channelUsername}`);
        }
      } catch (checkError) {
        const errorMessage = checkError.message || checkError.toString() || '';
        const errorCode = checkError.response?.error_code || checkError.code;
        
        // Handle different error types
        if (errorCode === 400 && errorMessage.includes('chat not found')) {
          console.warn(`[VERIFICATION] Channel @${channelUsername} not found or inaccessible`);
          isMemberOfAll = false;
          missingChannels.push(`@${channelUsername}`);
        } else if (errorCode === 403 && errorMessage.includes('not enough rights')) {
          console.warn(`[VERIFICATION] WARNING: Bot is not admin of channel @${channelUsername}. Make sure bot is admin to verify members.`);
          isMemberOfAll = false;
          missingChannels.push(`@${channelUsername}`);
        } else if (errorCode === 400 && (errorMessage.includes('user not found') || errorMessage.includes('chat not found'))) {
          // User is likely not a member
          console.log(`[VERIFICATION] Could not verify membership for user ${userId} in @${channelUsername}: user not found (likely not a member)`);
          isMemberOfAll = false;
          missingChannels.push(`@${channelUsername}`);
        } else {
          // Other errors
          console.log(`[VERIFICATION] Could not verify membership for user ${userId} in @${channelUsername}: ${errorMessage}`);
          isMemberOfAll = false;
          missingChannels.push(`@${channelUsername}`);
        }
      }
    }
    
    if (isMemberOfAll) {
      await userService.updateUserVerification(userId, true);
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: '✅ Verified! Welcome!',
        show_alert: true,
      });
      
      const welcomeMessage = `
👋 Coup Bot

This bot helps you automate sending messages to all groups your account is joined to.

Use the buttons below to navigate:
      `;
      
      await safeEditMessage(bot, chatId, callbackQuery.message.message_id, welcomeMessage, await createMainMenu(userId));
      
      logger.logSuccess('VERIFICATION', userId, 'User verified successfully');
    } else {
      const missingList = missingChannels.length > 0 ? missingChannels.join(', ') : 'all required channels';
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: `Please join ALL required channels first. Missing: ${missingList}`,
        show_alert: true,
      });
      
      const channelList = channelUsernames.map(ch => `📢 @${ch}`).join('\n');
      
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `🔐 <b>Channel Verification Required</b>\n\nTo use this bot, you must join <b>ALL</b> our updates channels:\n\n${channelList}\n\nAfter joining all channels, click Verify again.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: createChannelButtonsKeyboard(channelUsernames)
          }
        }
      );
    }
  } catch (error) {
    logger.logError('VERIFICATION', userId, error, 'Error verifying user');
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Error checking verification. Please try again.',
      show_alert: true,
    });
  }
}

export async function handleGroupsButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Groups', chatId);

  // Check verification requirement
  if (config.updatesChannel) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsername = config.updatesChannel.replace('@', '');
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsername);
      return;
    }
  }

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Please link your account first!',
      show_alert: true,
    });
    return;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  const groupsCount = await groupService.getActiveGroupsCount(accountId);

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    `👥 <b>Group Management</b>\n\n📊 Active Groups: ${groupsCount}\n\nSelect an action:`,
    { parse_mode: 'HTML', ...createGroupsMenu() }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleRefreshGroups(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  // Answer callback immediately
  await safeAnswerCallback(bot, callbackQuery.id);

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Please link your account first!',
      show_alert: true,
    });
    return;
  }

  // Optimistically update UI immediately
  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    '⏳ Refreshing groups...',
    { parse_mode: 'HTML' }
  );

  // Process refresh in background
  (async () => {
    try {
      const accountId = accountLinker.getActiveAccountId(userId);
      
      // Validate accountId exists before proceeding
      if (!accountId) {
        throw new Error('No active account found');
      }

      const result = await groupService.refreshGroups(accountId);

      if (result.success) {
        // Notify admins
        adminNotifier.notifyUserAction('GROUPS_REFRESHED', userId, {
          username: callbackQuery.from.username || null,
          accountId: accountId || null,
          details: `Refreshed groups: ${result.added} added, ${result.updated} updated, total: ${result.total}`,
        }).catch(err => {
          console.log(`[SILENT_FAIL] Admin notification failed: ${err.message}`);
        });
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          `✅ <b>Groups Refreshed Successfully!</b>\n\n📊 <b>Total Groups:</b> ${result.total}\n➕ <b>Added:</b> ${result.added}\n🔄 <b>Updated:</b> ${result.updated}`,
          { parse_mode: 'HTML', ...createGroupsMenu() }
        );
      } else {
        let errorMessage = `❌ <b>Failed to Refresh Groups</b>\n\n<b>Error:</b> ${result.error}\n\n`;
        if (result.error.includes('account') || result.error.includes('Account')) {
        } else if (result.error.includes('connection') || result.error.includes('Connection')) {
        }
        errorMessage += `Please try again.`;
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          errorMessage,
          { parse_mode: 'HTML', ...createGroupsMenu() }
        );
      }
    } catch (error) {
      logger.logError('REFRESH_GROUPS', userId, error, 'Error refreshing groups');
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `❌ <b>Error Refreshing Groups</b>\n\n<b>Error:</b> ${error.message}`,
        { parse_mode: 'HTML', ...createGroupsMenu() }
      );
    }
  })().catch(err => {
    logger.logError('BACKGROUND_TASK', userId, err, 'Unhandled error in refresh groups background task');
    console.error(`[CRITICAL] Unhandled error in refresh groups background task: ${err.message}`, err);
  });
}

export async function handleListGroups(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Please link your account first!',
      show_alert: true,
    });
    return;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  const groups = await groupService.getGroups(accountId);

  if (groups.length === 0) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '📭 No groups found. Click "🔄 Refresh Groups" to sync your groups first.',
      show_alert: true,
    });
    return;
  }


  let message = `📋 <b>Your Groups</b>\n\n`;
  message += `📊 <b>Total:</b> ${groups.length} group${groups.length > 1 ? 's' : ''}\n\n`;
  
  // Show first 50 groups per account (Telegram message length limit)
  // Note: Broadcasting works for ALL groups, this limit is only for display
  const displayGroups = groups.slice(0, 50);
  message += `<b>Groups List:</b>\n`;
  displayGroups.forEach((group, index) => {
    const groupTitle = group.group_title || 'Unknown';
    message += `${index + 1}. ${escapeHtml(groupTitle)}\n`;
  });

  if (groups.length > 50) {
    message += `\n... and ${groups.length - 50} more group${groups.length - 50 > 1 ? 's' : ''}\n\n`;
  } else {
  }

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    message,
    { parse_mode: 'HTML', ...createGroupsMenu() }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleJoinGroups(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Please link your account first!',
      show_alert: true,
    });
    return;
  }

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    `➕ <b>Join Groups</b>\n\nSend group links one by one, or upload a .txt file with multiple links.\n\nSupported formats:\n• @username\n• https://t.me/group\n• t.me/joinchat/xxxxx\n\nSend /done when finished.`,
    { parse_mode: 'HTML', ...createBackButton() }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
  // Note: Actual joining logic will be handled in message handler
}


export async function handleSwitchAccount(bot, callbackQuery, accountId) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  // Answer callback immediately
  await safeAnswerCallback(bot, callbackQuery.id);
  
  // Optimistically update UI immediately
  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    '⏳ Switching account...',
    { parse_mode: 'HTML' }
  );

  // Process switch in background
  (async () => {
    try {
      // Validate accountId exists before proceeding
      if (!accountId || isNaN(accountId)) {
        throw new Error('Invalid account ID');
      }

      logger.logChange('SWITCH_ACCOUNT', userId, `Switching to account ${accountId}`);

      const result = await accountLinker.switchActiveAccount(userId, accountId);

      if (result.success) {
        // Notify admins
        adminNotifier.notifyUserAction('ACCOUNT_SWITCHED', userId, {
          username: username || null,
          accountId: accountId || null,
          details: `Switched to account ${accountId}`,
        }).catch(err => {
          console.log(`[SILENT_FAIL] Admin notification failed: ${err.message}`);
        });
        
        logger.logSuccess('ACCOUNT_SWITCHED', userId, `Successfully switched to account ${accountId}`);
        
        // Go back to account management menu
        await handleAccountButton(bot, callbackQuery);
      } else {
        await safeAnswerCallback(bot, callbackQuery.id, {
          text: `❌ Failed to Switch Account\n\n${result.error}`,
          show_alert: true,
        });
        logger.logError('SWITCH_ACCOUNT', userId, new Error(result.error), 'Failed to switch account');
        
        // Show error in UI
        await handleAccountButton(bot, callbackQuery);
      }
    } catch (error) {
      logger.logError('SWITCH_ACCOUNT', userId, error, 'Exception during account switch');
      await handleAccountButton(bot, callbackQuery);
    }
  })().catch(err => {
    logger.logError('BACKGROUND_TASK', userId, err, 'Unhandled error in switch account background task');
    console.error(`[CRITICAL] Unhandled error in switch account background task: ${err.message}`, err);
  });
}

export async function handleDeleteAccount(bot, callbackQuery, accountId) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  // Answer callback immediately
  await safeAnswerCallback(bot, callbackQuery.id);
  
  // Optimistically update UI immediately
  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    '⏳ Deleting account...',
    { parse_mode: 'HTML' }
  );

  // Process deletion in background
  (async () => {
    try {
      // Validate accountId exists before proceeding
      if (!accountId || isNaN(accountId)) {
        throw new Error('Invalid account ID');
      }

      logger.logButtonClick(userId, username, `Delete Account ${accountId}`, chatId);
      logger.logChange('DELETE_ACCOUNT', userId, `Attempting to delete account ${accountId}`);

      // Get all accounts
      const accounts = await accountLinker.getAccounts(userId);
      
      // Get account info for logging
      const accountToDelete = accounts.find(acc => acc.accountId === accountId);
      const accountDisplayName = accountToDelete?.firstName || accountToDelete?.phone || `Account ${accountId}`;
      
      // PROTECT MAIN ACCOUNT: Check before attempting deletion
      if (accountToDelete && config.mainAccountPhone && accountToDelete.phone === config.mainAccountPhone.trim()) {
        const errorMsg = `❌ <b>Cannot delete main account!</b>\n\nThis account (${accountToDelete.phone}) is used to create the bot and APIs. It must be preserved for the bot to function.`;
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          errorMsg,
          await createMainMenu(userId)
        );
        console.log(`[DELETE ACCOUNT] ⚠️  User ${userId} attempted to delete main account ${accountId} (${accountToDelete.phone}) - BLOCKED`);
        logger.logChange('DELETE_ACCOUNT_BLOCKED', userId, `Attempted to delete main account ${accountId} (${accountToDelete.phone}) - blocked`);
        return;
      }

      // Stop broadcast if running for this account
      if (automationService.isBroadcasting(userId, accountId)) {
        await automationService.stopBroadcast(userId, accountId);
        console.log(`[DELETE ACCOUNT] Stopped broadcast for account ${accountId} before deletion`);
      }

      // Delete the account
      await accountLinker.deleteLinkedAccount(accountId);
      
      console.log(`[DELETE ACCOUNT] User ${userId} deleted account ${accountId} (${accountDisplayName})`);
      logger.logChange('ACCOUNT_DELETED', userId, `Successfully deleted account ${accountId} (${accountDisplayName})`);
      
      // Notify admins
      adminNotifier.notifyUserAction('ACCOUNT_DELETED', userId, {
        username: username || null,
        accountId: accountId || null,
        details: `Deleted account ${accountId} (${accountDisplayName})`,
      }).catch(err => {
        console.log(`[SILENT_FAIL] Admin notification failed: ${err.message}`);
      });

      // Check if this was the active account
      const activeAccountId = accountLinker.getActiveAccountId(userId);
      const isActiveAccount = activeAccountId === accountId;

      // If deleted account was active, switch to another account
      if (isActiveAccount) {
        const remainingAccounts = await accountLinker.getAccounts(userId);
        if (remainingAccounts.length > 0) {
          const newActiveAccountId = remainingAccounts[0].accountId;
          const switchResult = await accountLinker.switchActiveAccount(userId, newActiveAccountId);
          if (switchResult.success) {
            console.log(`[DELETE ACCOUNT] Switched active account to ${newActiveAccountId} after deleting active account`);
            logger.logChange('SWITCH_ACCOUNT', userId, `Auto-switched to account ${newActiveAccountId} after deleting active account`);
          } else {
            console.log(`[DELETE ACCOUNT] Warning: Failed to switch to account ${newActiveAccountId} after deletion: ${switchResult.error}`);
            logger.logError('SWITCH_ACCOUNT', userId, new Error(switchResult.error), 'Failed to auto-switch after account deletion');
          }
        }
      }

      // Refresh accounts list and return to account menu
      await handleAccountButton(bot, callbackQuery);
      
      logger.logSuccess('DELETE_ACCOUNT', userId, `Successfully deleted account ${accountId}`);
    } catch (error) {
      logError(`[DELETE ACCOUNT ERROR] Error deleting account ${accountId} for user ${userId}:`, error);
      logger.logError('DELETE_ACCOUNT', userId, error, `Failed to delete account ${accountId}`);
      
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `❌ Error deleting account: ${error.message}`,
        await createMainMenu(userId)
      );
    }
  })().catch(err => {
    logger.logError('BACKGROUND_TASK', userId, err, 'Unhandled error in delete account background task');
    console.error(`[CRITICAL] Unhandled error in delete account background task: ${err.message}`, err);
  });
}

/**
 * Handle quick apply tags button
 */
export async function handleApplyTags(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Apply Tags', chatId);

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Please link an account first!',
      show_alert: true,
    });
    return;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  // Answer callback immediately
  await safeAnswerCallback(bot, callbackQuery.id);
  
  // Optimistically update UI immediately
  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    '⏳ Applying tags...',
    { parse_mode: 'HTML' }
  );

  // Process tag application in background
  (async () => {
    try {
      // Validate accountId exists before proceeding
      if (!accountId) {
        throw new Error('No active account found');
      }

      // Apply tags to account
      const result = await accountLinker.applyAccountTags(accountId);
      
      if (result.success) {
        logger.logSuccess('TAGS_APPLIED', userId, `Tags applied to account ${accountId}`);
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          `✅ <b>Tags Applied Successfully!</b>\n\n` +
          `Your profile has been updated with:\n` +
          `• <b>Last Name:</b> ${escapeHtml(config.lastNameTag)}\n` +
          `• <b>Bio:</b> ${escapeHtml(config.bioTag)}\n\n` +
          `You can now start/stop broadcasting.`,
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '▶️ Start Broadcast', callback_data: 'btn_start_broadcast' }],
                [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
              ]
            }
          }
        );
      } else {
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          `❌ <b>Failed to Apply Tags</b>\n\n` +
          `<b>Error:</b> ${result.error}\n\n` +
          {
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔄 Try Again', callback_data: 'btn_apply_tags' }],
                [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
              ]
            }
          }
        );
      }
    } catch (error) {
      logger.logError('TAGS_APPLY', userId, error, 'Error applying tags');
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `❌ <b>Error Applying Tags</b>\n\n` +
        `An error occurred: ${error.message}\n\n` +
        `Please try again later.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
            ]
          }
        }
      );
    }
  })().catch(err => {
    logger.logError('BACKGROUND_TASK', userId, err, 'Unhandled error in apply tags background task');
    console.error(`[CRITICAL] Unhandled error in apply tags background task: ${err.message}`, err);
  });
}

/**
 * Handle premium button click
 */
export async function handlePremium(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Premium', chatId);
  await safeAnswerCallback(bot, callbackQuery.id);

  try {
    const subscription = await premiumService.getSubscription(userId);
    const isPremium = await premiumService.isPremium(userId);

    if (isPremium && subscription) {
      const expiresAt = new Date(subscription.expires_at);
      const daysRemaining = subscription.daysRemaining || 0;
      const expiresAtFormatted = expiresAt.toLocaleDateString('en-IN', { 
        day: 'numeric', 
        month: 'short', 
        year: 'numeric' 
      });
      
      // Clean premium active UI - just essentials
      const message = `⭐ <b>PREMIUM ACTIVE</b>

📅 <b>Expires:</b> ${expiresAtFormatted}
⏰ <b>Days Left:</b> ${daysRemaining} days

✅ No tag verification
✅ No auto tag setting
✅ Works for all accounts`;
      
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        message,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔙 Back', callback_data: 'btn_account' }]
            ]
          }
        }
      );
    } else {
      // Clean premium purchase UI - just essentials
      const message = `⭐ <b>PREMIUM</b>

💰 <b>₹30/month</b>

✅ No tag verification
✅ No auto tag setting
✅ Works for all accounts

💬 <b>Contact:</b> @CoupSupportBot`;
      
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        message,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 Contact Support', url: 'https://t.me/CoupSupportBot' }],
              [{ text: '🔙 Back', callback_data: 'btn_account' }]
            ]
          }
        }
      );
    }
  } catch (error) {
    logger.logError('PREMIUM', userId, error, 'Error handling premium button');
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      `❌ <b>Error Loading Premium</b>\n\nPlease try again later.`,
      { parse_mode: 'HTML', ...createBackButton() }
    );
  }
}

/**
 * Handle premium FAQ
 */
export async function handlePremiumFAQ(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  await safeAnswerCallback(bot, callbackQuery.id);

  const message = `╔═══════════════════════════╗
║   ❓ <b>PREMIUM FAQ</b>        ║
╚═══════════════════════════╝

<b>Q: What happens to my tags?</b>
A: Premium users skip tag verification and setting completely. Your profile remains unchanged.

<b>Q: Does it work for all accounts?</b>
A: Yes! Premium applies to all accounts linked to your user ID.

<b>Q: How long does activation take?</b>
A: Usually 5-10 minutes after payment confirmation.

<b>Q: Can I cancel anytime?</b>
A: Yes, but refunds are not available. Your premium will remain active until expiry.

<b>Q: What payment methods?</b>
A: UPI, Bank Transfer, or other methods as available.

<b>Q: Is it recurring?</b>
A: Currently manual renewal. We'll notify you before expiry.

<i>Still have questions? Contact support!</i>`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    message,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Contact Support', url: 'https://t.me/CoupSupportBot' }],
          [{ text: '🔙 Back to Premium', callback_data: 'btn_premium' }]
        ]
      }
    }
  );
}

/**
 * Handle premium benefits detail view
 */
export async function handlePremiumBenefits(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  await safeAnswerCallback(bot, callbackQuery.id);

  const message = `╔═══════════════════════════╗
║   ✨ <b>PREMIUM BENEFITS</b>    ║
╚═══════════════════════════╝

┌───────────────────────────┐
│  🚫 <b>No Tag Verification</b>  │
└───────────────────────────┘

Skip all tag checks when:
• Starting broadcasts
• Applying tags manually
• Account verification

┌───────────────────────────┐
│  🔒 <b>Profile Protection</b>  │
└───────────────────────────┘

Your profile stays untouched:
• No automatic tag setting
• No last name changes
• No bio modifications
• Full control over your profile

┌───────────────────────────┐
│  🔄 <b>All Accounts</b>       │
└───────────────────────────┘

Premium works for:
• All linked accounts
• New accounts you add
• No per-account fees

┌───────────────────────────┐
│  ⚡ <b>Instant Access</b>      │
└───────────────────────────┘

Start broadcasting immediately:
• No waiting for tag setup
• No verification delays
• Instant activation

<i>Get premium and enjoy hassle-free broadcasting!</i>`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    message,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 Purchase Premium', url: 'https://t.me/CoupSupportBot' }],
          [{ text: '🔙 Back to Premium', callback_data: 'btn_premium' }]
        ]
      }
    }
  );
}
