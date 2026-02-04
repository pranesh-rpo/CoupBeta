import accountLinker from '../services/accountLinker.js';
import automationService from '../services/automationService.js';
import messageManager from '../services/messageManager.js';
import messageService from '../services/messageService.js';
import userService from '../services/userService.js';
import groupService from '../services/groupService.js';
import configService from '../services/configService.js';
import groupBlacklistService from '../services/groupBlacklistService.js';
import adminNotifier from '../services/adminNotifier.js';
import premiumService from '../services/premiumService.js';
import paymentVerificationService from '../services/paymentVerificationService.js';
import loggerBotService from '../services/loggerBotService.js';
import otpHandler, { createOTPKeypad } from './otpHandler.js';
import { createMainMenu, createBackButton, createStopButton, createAccountSwitchKeyboard, createGroupsMenu, createConfigMenu, createQuietHoursKeyboard, createScheduleKeyboard, createMessagePoolKeyboard, createMessagePoolListKeyboard, generateStatusText, createLoginOptionsKeyboard, createMessagesMenu } from './keyboardHandler.js';
import { config } from '../config.js';
import logger, { logError } from '../utils/logger.js';
import { safeEditMessage, safeAnswerCallback } from '../utils/safeEdit.js';
import { safeBotApiCall } from '../utils/floodWaitHandler.js';
import { escapeHtml, stripHtmlTags } from '../utils/textHelpers.js';
import { Api } from 'telegram/tl/index.js';
import db from '../database/db.js';
import { getUserFriendlyErrorMessage } from '../utils/security.js';

// Store reference to pending phone numbers Map/Set for setting pending state
// This will be set by index.js (currently a Map: userId -> { messageId })
let pendingPhoneNumbersSet = null;

/**
 * Set the pending phone numbers Map/Set reference (called from index.js)
 * This allows commandHandler to set pending state when redirecting to link account
 * @param {Map|Set} pendingSet - Map or Set to track pending phone number states
 */
export function setPendingPhoneNumbersReference(pendingSet) {
  pendingPhoneNumbersSet = pendingSet;
}

/**
 * Add user to pending phone numbers (called from commandHandler when redirecting to link)
 */
function addPendingPhoneNumber(userId) {
  if (pendingPhoneNumbersSet) {
    // pendingPhoneNumbersSet is actually a Map, not a Set
    // Use .set() instead of .add() to work with Map
    if (pendingPhoneNumbersSet instanceof Map) {
      pendingPhoneNumbersSet.set(userId, {});
    } else if (pendingPhoneNumbersSet instanceof Set) {
      pendingPhoneNumbersSet.add(userId);
    }
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
 * Extract message entities with comprehensive fallback methods
 * This function tries multiple locations to find entities, especially for premium emojis
 * @param {Object} msg - Telegram Bot API message object
 * @returns {Array|null} Extracted entities array or null
 */
function extractMessageEntities(msg) {
  if (!msg) {
    console.log(`[EXTRACT_ENTITIES] No message object provided`);
    return null;
  }

  // Log all available properties in the message object for debugging
  const msgKeys = Object.keys(msg);
  console.log(`[EXTRACT_ENTITIES] Message object keys:`, msgKeys);
  console.log(`[EXTRACT_ENTITIES] Has entities: ${!!msg.entities}, Has caption_entities: ${!!msg.caption_entities}`);
  
  let entities = null;
  let source = 'none';

  // Method 1: Try msg.entities (standard location for text messages)
  if (msg.entities && Array.isArray(msg.entities) && msg.entities.length > 0) {
    entities = msg.entities;
    source = 'msg.entities';
    console.log(`[EXTRACT_ENTITIES] ✅ Found ${entities.length} entities in msg.entities`);
  }
  // Method 2: Try msg.caption_entities (for media messages with captions)
  else if (msg.caption_entities && Array.isArray(msg.caption_entities) && msg.caption_entities.length > 0) {
    entities = msg.caption_entities;
    source = 'msg.caption_entities';
    console.log(`[EXTRACT_ENTITIES] ✅ Found ${entities.length} entities in msg.caption_entities`);
  }
  // Method 3: Check if entities are nested in other properties
  else if (msg.message && msg.message.entities && Array.isArray(msg.message.entities) && msg.message.entities.length > 0) {
    entities = msg.message.entities;
    source = 'msg.message.entities';
    console.log(`[EXTRACT_ENTITIES] ✅ Found ${entities.length} entities in msg.message.entities`);
  }
  // Method 4: Check reply_to_message for forwarded entities
  else if (msg.reply_to_message) {
    if (msg.reply_to_message.entities && Array.isArray(msg.reply_to_message.entities) && msg.reply_to_message.entities.length > 0) {
      entities = msg.reply_to_message.entities;
      source = 'msg.reply_to_message.entities';
      console.log(`[EXTRACT_ENTITIES] ✅ Found ${entities.length} entities in reply_to_message.entities`);
    } else if (msg.reply_to_message.caption_entities && Array.isArray(msg.reply_to_message.caption_entities) && msg.reply_to_message.caption_entities.length > 0) {
      entities = msg.reply_to_message.caption_entities;
      source = 'msg.reply_to_message.caption_entities';
      console.log(`[EXTRACT_ENTITIES] ✅ Found ${entities.length} entities in reply_to_message.caption_entities`);
    }
  }

  if (!entities || entities.length === 0) {
    console.log(`[EXTRACT_ENTITIES] ⚠️ No entities found in any location. Full message structure:`, JSON.stringify(msg, null, 2).substring(0, 500));
    return null;
  }

  // Log raw entities for debugging
  console.log(`[EXTRACT_ENTITIES] Raw entities from ${source}:`, JSON.stringify(entities, null, 2));

  // Map entities to our format, preserving all important properties
  const mappedEntities = entities.map((e, index) => {
    const entity = {
      type: e.type,
      offset: e.offset,
      length: e.length,
    };

    // Preserve optional properties
    if (e.language !== undefined) entity.language = e.language;
    if (e.url !== undefined) entity.url = e.url;
    if (e.user !== undefined) entity.user = e.user;

    // CRITICAL: Preserve custom_emoji_id as string to avoid precision loss
    // Telegram Bot API returns custom_emoji_id as string for large numbers
    // This is essential for premium emojis to work correctly
    if (e.custom_emoji_id !== undefined && e.custom_emoji_id !== null) {
      entity.custom_emoji_id = String(e.custom_emoji_id); // Always store as string
      console.log(`[EXTRACT_ENTITIES] ✅ Entity ${index}: Found custom_emoji_id="${entity.custom_emoji_id}" (original type: ${typeof e.custom_emoji_id}, type: ${e.type}, offset: ${e.offset}, length: ${e.length})`);
    }

    return entity;
  });

  // Count premium emojis
  const premiumEmojiCount = mappedEntities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id).length;
  const totalEntities = mappedEntities.length;

  console.log(`[EXTRACT_ENTITIES] ✅ Extracted ${totalEntities} entities from ${source} (${premiumEmojiCount} premium emojis)`);
  
  if (premiumEmojiCount > 0) {
    const emojiIds = mappedEntities.filter(e => e.custom_emoji_id).map(e => e.custom_emoji_id);
    console.log(`[EXTRACT_ENTITIES] 🎨 Premium emoji IDs preserved: ${emojiIds.join(', ')}`);
    console.log(`[EXTRACT_ENTITIES] Full mapped entity data:`, JSON.stringify(mappedEntities, null, 2));
  }

  return mappedEntities;
}

// Helper function to check if user is verified
async function checkUserVerification(bot, userId) {
  // If no updates channel configured, allow access
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length === 0) {
    return { verified: true };
  }

  // FAST: Only check DB verification status for button clicks
  // Real-time verification is handled by background channelVerificationService periodically
  // This makes button clicks INSTANT instead of waiting for API calls
  const isVerifiedInDb = await userService.isUserVerified(userId);
  
  if (isVerifiedInDb) {
    return { verified: true };
  }
  
  // User not verified in DB - return unverified
  const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
  return { verified: false, channelUsernames };
}

// Legacy function for real-time verification (used by verification service, not button clicks)
async function checkUserVerificationRealtime(bot, userId) {
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length === 0) {
    return { verified: true };
  }

  const isVerifiedInDb = await userService.isUserVerified(userId);
  
  if (isVerifiedInDb) {
    const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
    
    // Real-time check: verify user is still in ALL channels
    let isStillMemberOfAll = true;
    for (const channelUsername of channelUsernames) {
      if (!channelUsername || typeof channelUsername !== 'string') {
        continue;
      }

      try {
        const chat = await safeBotApiCall(
          () => bot.getChat(`@${channelUsername}`),
          { maxRetries: 3, bufferSeconds: 1, throwOnFailure: false }
        );
        
        if (!chat || !chat.id) {
          console.warn(`[VERIFICATION] Invalid chat response for @${channelUsername}`);
          isStillMemberOfAll = false;
          break;
        }

        const channelId = chat.id;
        
        const member = await safeBotApiCall(
          () => bot.getChatMember(channelId, userId),
          { maxRetries: 3, bufferSeconds: 1, throwOnFailure: false }
        );
        
        if (!member || !member.status) {
          console.warn(`[VERIFICATION] Invalid member response for user ${userId} in @${channelUsername}`);
          isStillMemberOfAll = false;
          break;
        }

        const isMember = member.status === 'member' || 
                        member.status === 'administrator' || 
                        member.status === 'creator';
        
        if (!isMember) {
          console.log(`[VERIFICATION] User ${userId} is not in @${channelUsername} (required channel)`);
          isStillMemberOfAll = false;
          break;
        }
      } catch (checkError) {
        const errorMessage = checkError.message || checkError.toString() || '';
        const errorCode = checkError.response?.error_code || checkError.code;
        
        if (errorCode === 400 && errorMessage.includes('chat not found')) {
          console.warn(`[VERIFICATION] Channel @${channelUsername} not found or inaccessible`);
          isStillMemberOfAll = false;
          break;
        } else if (errorCode === 403 && errorMessage.includes('not enough rights')) {
          console.warn(`[VERIFICATION] Bot is not admin of @${channelUsername} - cannot verify membership`);
          isStillMemberOfAll = false;
          break;
        } else if (errorCode === 400 && (errorMessage.includes('user not found') || errorMessage.includes('chat not found'))) {
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

  logger.logInfo('START', `User ${userId} (@${username}) started the bot`, userId);

  // NOTE: User is already added to DB by ensureUserStored() in index.js - no duplicate call needed

  // Check channel verification requirement (mandatory if updates channel is configured)
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    // FAST: Only check DB verification status for /start - skip expensive real-time API calls
    // Real-time verification is done by background channelVerificationService periodically
    const isVerifiedInDb = await userService.isUserVerified(userId);
    
    if (!isVerifiedInDb) {
      // User not verified - show verification requirement
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await showVerificationRequired(bot, chatId, channelUsernames);
      return;
    }
  }

  // Run status and menu generation in PARALLEL for faster response
  const [statusText, mainMenu] = await Promise.all([
    generateStatusText(userId),
    createMainMenu(userId)
  ]);

  const welcomeMessage = `<b>📊 COUP DASHBOARD</b>${statusText}`;

  try {
    await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'HTML', ...mainMenu });
    logger.logInfo('START', `Dashboard sent to user ${userId}`, userId);
  } catch (error) {
    logger.logError('START', userId, error, 'Failed to send welcome message');
  }
}

export async function handleMainMenu(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;

  // Check verification (fast - uses cache)
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const verification = await checkUserVerification(bot, userId);
    if (!verification.verified) {
      await showVerificationRequired(bot, chatId, verification.channelUsernames || updatesChannels.map(ch => ch.replace('@', '')));
      return;
    }
  }

  // Run status and menu generation in PARALLEL
  const [statusText, mainMenu] = await Promise.all([
    generateStatusText(userId),
    createMainMenu(userId)
  ]);

  const welcomeMessage = `<b>📊 COUP DASHBOARD</b>${statusText}`;

  await safeEditMessage(bot, chatId, messageId, welcomeMessage, { parse_mode: 'HTML', ...mainMenu });
  
  await safeAnswerCallback(bot, callbackQuery.id);
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

  // Edit existing message to show phone input instructions (inline keyboard)
  logger.logChange('LINK', userId, 'Showing unified phone input');
  
  const originalMsgId = callbackQuery.message.message_id;
  
  // Edit the original message to show instructions
  await safeEditMessage(
    bot,
    chatId,
    originalMsgId,
    `📱 <b>Link Account</b>\n\n` +
    `Please provide your phone number:\n\n` +
    `• <b>Tap the button below</b> to share your contact\n` +
    `• <b>Or type</b> your number: <code>+1234567890</code>\n\n` +
    `<i>Format: International format with country code</i>`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '❌ Cancel', callback_data: 'btn_main_menu' }]
        ]
      }
    }
  );
  
  // Send separate message with reply keyboard (required for contact sharing)
  const keyboardMsg = await bot.sendMessage(
    chatId,
    '👇 <b>Tap below to share, or type your number:</b>',
    {
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: [
          [{ text: '📱 Share My Phone Number', request_contact: true }]
        ],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
  // Return object with message IDs for editing later
  return { statusMsgId: originalMsgId, keyboardMsgId: keyboardMsg.message_id };
}


export async function handleLoginTypePhone(bot, callbackQuery) {
  return await handleLinkButton(bot, callbackQuery);
}

export async function handleLoginCancel(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  await safeAnswerCallback(bot, callbackQuery.id);

  // Cancel web login if in progress
  await accountLinker.cancelWebLogin(userId);

  // Remove keyboard and show main menu
  await bot.sendMessage(
    chatId,
    'ℹ️ Account linking cancelled. You can try again anytime.',
    { reply_markup: { remove_keyboard: true } }
  );
  
  // Delete previous message
  try {
    await bot.deleteMessage(chatId, callbackQuery.message.message_id);
  } catch (e) {
    // Ignore
  }
  
  // Show main menu
  await bot.sendMessage(
    chatId,
    await generateStatusText(userId),
    { parse_mode: 'HTML', ...createMainMenu() }
  );
}

export async function handlePhoneNumber(bot, msg, phoneNumber, processingMsgId = null) {
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
    // Use existing processing message or create new one
    let statusMsgId = processingMsgId;
    if (!statusMsgId) {
      const connectingMsg = await bot.sendMessage(
        chatId,
        '🔌 Connecting to Telegram...',
        { parse_mode: 'HTML' }
      );
      statusMsgId = connectingMsg.message_id;
    } else {
      // Update existing processing message
      await bot.editMessageText(
        '🔌 Connecting to Telegram...',
        { chat_id: chatId, message_id: statusMsgId, parse_mode: 'HTML' }
      ).catch(() => {});
    }
    console.log(`[LINK] Showing connecting status for user ${userId}`);
    logger.logInfo('LINK', `Initiating account link for user ${userId}`, userId);
    
    // Update to sending status
    await bot.editMessageText(
      '📤 Sending verification code...',
      {
        chat_id: chatId,
        message_id: statusMsgId,
        parse_mode: 'HTML'
      }
    ).catch(() => {});
    console.log(`[LINK] Showing sending code status for user ${userId}`);
    
    const result = await accountLinker.initiateLink(userId, phoneNumber);
    
    if (result.success) {
      logger.logSuccess('LINK', userId, 'Verification code sent successfully');
      otpHandler.clearOTP(userId);
      
      // Update message to show success and OTP keypad
      await bot.editMessageText(
        '✅ <b>Verification code sent!</b>\n\n📱 Enter the 5-digit code from Telegram:',
        {
          chat_id: chatId,
          message_id: statusMsgId,
          parse_mode: 'HTML',
          reply_markup: createOTPKeypad('').reply_markup
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
        // Get user-friendly error message based on the actual error
        const friendlyErrorMsg = getUserFriendlyErrorMessage(result.error);
        const errorMessage = `${friendlyErrorMsg}\n\nClick "🔗 Link Account" to try again.`;
        
        await bot.editMessageText(
          errorMessage,
          {
            chat_id: chatId,
            message_id: statusMsgId,
            parse_mode: 'HTML',
            ...await createMainMenu(userId)
          }
        );
      } catch (editError) {
        const friendlyErrorMsg = getUserFriendlyErrorMessage(result.error);
        await bot.sendMessage(
          chatId,
          `${friendlyErrorMsg}\n\nPlease try again using the "Link Account" button.`,
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
    
    // Get user-friendly error message based on the actual error
    const friendlyErrorMsg = getUserFriendlyErrorMessage(error);
    
    // Send error message with better formatting
    try {
      await bot.sendMessage(
        chatId,
        `${friendlyErrorMsg}\n\nClick "🔗 Link Account" to retry.`,
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
        text: '🔐 Please enter a valid 5-digit verification code',
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
      
      // Clear the OTP code so user can enter a new one
      otpHandler.clearOTP(userId);
      
      // Provide helpful error message (don't expose technical details)
      let errorText = `🔐 <b>Invalid Verification Code</b>\n\nThe code you entered doesn't match. Please double-check and try again.`;
      if (verifyResult.error && (verifyResult.error.includes('expired') || verifyResult.error.includes('timeout'))) {
        errorText = `⏰ <b>Code Expired</b>\n\nThe verification code has expired. Please click "🔗 Link Account" to request a new code.`;
      } else if (verifyResult.error && verifyResult.error.includes('Rate limited')) {
        errorText = `⏳ <b>Too Many Attempts</b>\n\nPlease wait a moment before trying again.`;
      }
      
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: errorText,
        show_alert: true,
      });
      
      // Show error message and OTP keypad again so user can enter a new code
      const errorMsg = verifyResult.error || '';
      let errorMessage = `🔐 <b>Verification Code Incorrect</b>\n\n`;
      
      if (errorMsg && (errorMsg.includes('code') || errorMsg.includes('invalid'))) {
        errorMessage += `The code you entered doesn't match. Please check the code sent to your Telegram app and try again.\n\n`;
        errorMessage += `💡 <b>Tip:</b> Make sure you're entering all 5 digits correctly.\n\n`;
        errorMessage += `Enter the code using the keypad below:`;
        
        // Clear OTP and show fresh keypad for retry
        otpHandler.clearOTP(userId);
        
        // Show OTP keypad again so user can enter a new code
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          errorMessage,
          { 
            parse_mode: 'HTML',
            reply_markup: createOTPKeypad('').reply_markup
          }
        );
        return false;
      } else if (errorMsg && (errorMsg.includes('expired') || errorMsg.includes('timeout'))) {
        errorMessage += `⏰ <b>Code Expired</b>\n\nThe verification code has expired for security reasons.\n\n`;
        errorMessage += `📝 <b>What to do:</b>\n`;
        errorMessage += `• Click "🔗 Link Account" below to start over\n`;
        errorMessage += `• You'll receive a new verification code\n`;
        errorMessage += `• Enter the new code when prompted`;
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          errorMessage,
          { 
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [
                [{ text: '🔗 Link Account', callback_data: 'btn_link' }],
                [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
              ]
            }
          }
        );
        return false;
      } else {
        // Use generic error message for other errors
        errorMessage += `⚠️ <b>Something Went Wrong</b>\n\n`;
        errorMessage += `We couldn't verify your code. This might be a temporary issue.\n\n`;
        errorMessage += `📝 <b>What to do:</b>\n`;
        errorMessage += `• Try entering the code again using the keypad below\n`;
        errorMessage += `• Make sure you're entering all 5 digits\n`;
        errorMessage += `• If the problem persists, click "🔗 Link Account" to start over`;
        
        // Clear OTP and show fresh keypad for retry
        otpHandler.clearOTP(userId);
        
        // Show OTP keypad again so user can enter a new code
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          errorMessage,
          { 
            parse_mode: 'HTML',
            reply_markup: createOTPKeypad('').reply_markup
          }
        );
        return false;
      }
    }
  } else if (result.action === 'ignore') {
    // User clicked on display area - just acknowledge
    await safeAnswerCallback(bot, callbackQuery.id);
    return false;
  } else if (result.action === 'full') {
    // Already at max digits
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '5 digits entered. Press Submit to verify!',
      show_alert: false,
    });
    return false;
  } else if (result.action === 'error') {
    // Validation error from OTP handler
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: result.error || 'Invalid input',
      show_alert: true,
    });
    return false;
  } else if (result.action === 'cancel') {
    // User cancelled linking process
    logger.logChange('OTP_CANCEL', userId, 'User cancelled account linking');
    
    // Cancel any pending auth process in accountLinker
    try {
      await accountLinker.cancelAuth(userId);
    } catch (e) {
      // Ignore errors - just cleanup what we can
    }
    
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Account linking cancelled',
      show_alert: false,
    });
    
    // Show account menu with link option
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      `ℹ️ <b>Linking Cancelled</b>\n\nYou cancelled the account linking process.\n\n💡 <b>No worries!</b> You can start linking your account again anytime from the main menu.`,
      { 
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔗 Link Account', callback_data: 'btn_link' }],
            [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
          ]
        }
      }
    );
    return false;
  } else {
    // 'update' or 'complete' action - update the display
    const currentCode = otpHandler.getCurrentCode(userId);
    const remainingDigits = otpHandler.getRemainingDigits(userId);
    
    let statusText = '📱 <b>Enter Verification Code</b>\n\n';
    if (currentCode.length === 0) {
      statusText += '⏳ Waiting for input...';
    } else if (remainingDigits > 0) {
      statusText += `✏️ ${currentCode.length}/5 digits entered`;
    } else {
      statusText += '✅ Code complete! Press <b>Submit Code</b> to verify.';
    }
    
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      statusText,
      {
        reply_markup: createOTPKeypad(currentCode).reply_markup,
        parse_mode: 'HTML',
      }
    );
    
    // Show feedback for complete code
    if (result.action === 'complete') {
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: '✅ 5 digits entered! Press Submit to verify.',
        show_alert: false,
      });
    } else {
      await safeAnswerCallback(bot, callbackQuery.id);
    }
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
      '🔗 <b>Account Not Linked</b>\n\nPlease link your Telegram account first to set a broadcast message.\n\n📝 <b>What to do:</b>\n• Click "🔗 Link Account" from the main menu\n• Follow the verification steps\n• Then come back to set your message',
      await createMainMenu(userId)
    );
    console.log(`[handleSetStartMessage] User ${userId} not linked, returning false`);
    return false;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await bot.sendMessage(
      chatId,
      '🔗 <b>No Active Account</b>\n\nPlease link or switch to an account first.',
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

  // Extract entities (for premium emoji support) using comprehensive helper function
  // This function tries multiple fallback methods to find entities
  console.log(`[handleSetStartMessage] Extracting entities from message for user ${userId}...`);
  const messageEntities = extractMessageEntities(msg);
  
  if (messageEntities && messageEntities.length > 0) {
    const premiumEmojiCount = messageEntities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id).length;
    console.log(`[handleSetStartMessage] ✅ Successfully extracted ${messageEntities.length} entities (${premiumEmojiCount} premium emojis)`);
  } else {
    console.log(`[handleSetStartMessage] ⚠️ No entities found in message - premium emojis may not be preserved`);
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
      '📝 <b>Message Too Long</b>\n\nYour message exceeds Telegram\'s limit of 4,096 characters.\n\n📝 <b>What to do:</b>\n• Shorten your message\n• Split it into multiple parts if needed\n• Try again with a shorter message',
      createBackButton()
    );
    console.log(`[handleSetStartMessage] User ${userId} sent message that's too long: ${text.length} characters`);
    return false; // Keep pending state so user can retry
  }

  logger.logChange('MESSAGE_SET', userId, `Broadcast message set: ${text.substring(0, 50)}...`);
  
  // Save message with metadata (entities including premium emojis)
  // The entities are extracted from the original message and saved to database
  // When broadcasting, these entities will be used to preserve premium emojis
  const result = await messageService.saveMessage(accountId, text, 'A', messageEntities);
  
  if (result.success) {
    // Log entity information for debugging
    if (messageEntities && messageEntities.length > 0) {
      const premiumEmojis = messageEntities.filter(e => e.type === 'custom_emoji' && e.custom_emoji_id);
      if (premiumEmojis.length > 0) {
        console.log(`[MESSAGE_SET] ✅ Message saved with ${premiumEmojis.length} premium emoji entities preserved`);
        console.log(`[MESSAGE_SET] Premium emoji IDs: ${premiumEmojis.map(e => e.custom_emoji_id).join(', ')}`);
        
        // Note: For premium emojis to work, user should forward the message to account's Saved Messages
        // This is handled separately via the "Forward to Saved Messages" option
      } else {
        console.log(`[MESSAGE_SET] ✅ Message saved with ${messageEntities.length} entities`);
      }
    } else {
      console.log(`[MESSAGE_SET] ✅ Message saved (no entities)`);
    }
    
    // Notify admins
    adminNotifier.notifyUserAction('MESSAGE_SET', userId, {
      username: msg.from.username || null,
      accountId: accountId || null,
      message: text,
      details: `Broadcast message set successfully`,
    }).catch(() => {}); // Silently fail to avoid blocking
    
    const settings = await configService.getAccountSettings(accountId);
    await bot.sendMessage(
      chatId,
      `✅ <b>Broadcast Message Set Successfully!</b>${settings?.forwardMode ? '\n\n📤 Forward Mode enabled - will forward LAST message from Saved Messages\n\n💡 Tip: Forward a message (with premium emojis) to your Saved Messages first!' : ''}`,
      { parse_mode: 'HTML', ...await createMainMenu(userId) }
    );
    console.log(`[handleSetStartMessage] User ${userId} successfully set message, returning true`);
    return true; // Success - clear pending state
  } else {
    const errorMessage = `⚠️ <b>Couldn't Save Message</b>\n\n${getUserFriendlyErrorMessage()}\n\n💡 <b>Don't worry!</b> Your message is safe. Please try saving again.`;
    
    await bot.sendMessage(
      chatId,
      errorMessage,
      { parse_mode: 'HTML', ...createBackButton() }
    );
    console.log(`[handleSetStartMessage] User ${userId} failed to save message: ${result.error}, returning false`);
    return false; // Keep pending state so user can retry
  }
}


export async function handlePasswordInput(bot, msg, password, statusMsgId = null) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;
  const username = msg.from.username || 'Unknown';

  // Check if there's a pending password authentication
  if (!accountLinker.isPasswordRequired(userId) && !accountLinker.isWebLoginPasswordRequired(userId)) {
    // This is a stale state - pendingPasswords Map has the user but accountLinker doesn't
    // Log as info instead of error since this is expected when state expires
    logger.logInfo('2FA', `Password input attempted but authentication state expired for user ${userId}`, userId);
    console.log(`[2FA] User ${userId} attempted password input but no pending authentication found (stale state)`);
    if (statusMsgId) {
      await bot.editMessageText(
        '❌ <b>Authentication Expired</b>\n\nYour password authentication session has expired. Please start the account linking process again.',
        { chat_id: chatId, message_id: statusMsgId, parse_mode: 'HTML', ...await createMainMenu(userId) }
      ).catch(() => {});
    } else {
      await bot.sendMessage(
        chatId,
        '❌ <b>Authentication Expired</b>\n\nYour password authentication session has expired. Please start the account linking process again.',
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      ).catch(() => {});
    }
    // Return staleState flag so caller can clean up pendingPasswords Map
    return { success: false, error: 'No pending password authentication found', staleState: true };
  }

  logger.logChange('2FA', userId, '2FA password provided');
  console.log(`[2FA] User ${userId} provided password for 2FA authentication`);

  // Use existing message or create new one
  let msgId = statusMsgId;
  try {
    // Show verifying password status
    if (msgId) {
      await bot.editMessageText(
        '🔍 Verifying password...',
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
      ).catch(() => {});
    } else {
      const verifyingMsg = await bot.sendMessage(chatId, '🔍 Verifying password...', { parse_mode: 'HTML' });
      msgId = verifyingMsg.message_id;
    }
    console.log(`[2FA] Showing verifying password status for user ${userId}`);
    
    const result = await accountLinker.verifyPassword(userId, password);
    
    if (result.success) {
      // Show connecting account status
      await bot.editMessageText(
        '🔌 Connecting account...',
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML' }
      ).catch(() => {});
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
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', ...await createMainMenu(userId) }
      ).catch(() => {});
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
        let errorMessage = `🔒 <b>Too Many Password Attempts</b>\n\n`;
        errorMessage += `You've tried entering your password 3 times, but it wasn't correct.\n\n`;
        
        // Show cooldown information if available
        if (result.cooldownRemaining && result.cooldownRemaining > 0) {
          const minutes = result.cooldownMinutes || Math.ceil(result.cooldownRemaining / 60000);
          const seconds = result.cooldownSeconds || Math.ceil(result.cooldownRemaining / 1000);
          errorMessage += `⏳ <b>Please wait:</b> ${minutes} minute(s) (${seconds} seconds)\n\n`;
          errorMessage += `This cooldown period helps protect your account.\n\n`;
        } else {
          errorMessage += `⏳ <b>Please wait:</b> A few minutes\n\n`;
          errorMessage += `This cooldown period helps protect your account.\n\n`;
        }
        
        errorMessage += `📝 <b>After waiting:</b>\n`;
        errorMessage += `• Click "🔗 Link Account" to start over\n`;
        errorMessage += `• Make sure you have the correct password ready\n`;
        errorMessage += `• You'll have 3 more attempts`;
        
        await bot.editMessageText(
          errorMessage,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', ...await createMainMenu(userId) }
        ).catch(() => {});
      } else {
        // Handle AUTH_USER_CANCEL gracefully (user cancelled, not an error)
        if (result.error && result.error.includes('AUTH_USER_CANCEL')) {
          console.log(`[2FA] User ${userId} cancelled password authentication`);
          await bot.editMessageText(
            'ℹ️ <b>Authentication Cancelled</b>\n\nYou cancelled the password entry. You can try linking your account again anytime.',
            { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', ...await createMainMenu(userId) }
          ).catch(() => {});
          return { success: false, error: 'User cancelled authentication', cancelled: true };
        }

        // Show remaining attempts
        const remainingAttempts = result.remainingAttempts !== undefined ? result.remainingAttempts : 2;
        const attempts = result.attempts !== undefined ? result.attempts : 1;
        
        // Get user-friendly error message based on the actual error
        const friendlyErrorMsg = getUserFriendlyErrorMessage(result.error);
        
        // Try to edit the status message, or send new one if it fails
        let errorMessage = `${friendlyErrorMsg}\n\n`;
        
        // Only show attempts info if it's a password-related error (not account conflict)
        if (!result.error || !result.error.toLowerCase().includes('already linked') && !result.error.toLowerCase().includes('broadcasting')) {
          errorMessage += `🔐 <b>Password Attempts:</b> ${attempts}/3\n`;
          errorMessage += `🔄 <b>Remaining:</b> ${remainingAttempts} ${remainingAttempts === 1 ? 'try' : 'tries'}\n\n`;
          
          if (remainingAttempts > 0) {
            errorMessage += `📝 <b>What to do:</b>\n`;
            errorMessage += `• Double-check your password\n`;
            errorMessage += `• Make sure Caps Lock is off\n`;
            errorMessage += `• Try entering it again`;
          } else {
            errorMessage += `⏳ <b>Cooldown Period</b>\n\n`;
            errorMessage += `Please wait a few minutes before trying again. This helps protect your account.`;
          }
        }
        
        await bot.editMessageText(
          errorMessage,
          { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', ...await createMainMenu(userId) }
        ).catch(() => {});
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
    
    // Get user-friendly error message based on the actual error
    const friendlyErrorMsg = getUserFriendlyErrorMessage(error);
    
    // Edit message with error
    if (msgId) {
      await bot.editMessageText(
        `${friendlyErrorMsg}\n\nClick "🔗 Link Account" to retry.`,
        { chat_id: chatId, message_id: msgId, parse_mode: 'HTML', ...await createMainMenu(userId) }
      ).catch(() => {});
    } else {
      await bot.sendMessage(
        chatId,
        `${friendlyErrorMsg}\n\nClick "🔗 Link Account" to retry.`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      ).catch(() => {});
    }
  }
}

/**
 * Handle Messages menu (combined Set Message and Message Pool)
 */
export async function handleMessagesMenu(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Messages Menu', chatId);

  // Check verification requirement
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel(s) first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsernames);
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
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  try {
    // Run ALL queries in PARALLEL for speed (including Saved Messages URL fetch)
    const [currentMessage, pool, settings, savedMessagesUrl] = await Promise.all([
      messageService.getActiveMessage(accountId).catch(() => null),
      messageService.getMessagePool(accountId, true).catch(() => []),
      configService.getAccountSettings(accountId).catch(() => null),
      // Fetch Saved Messages URL in parallel - no extra delay!
      (async () => {
        try {
          const client = await accountLinker.ensureConnected(accountId);
          if (client) {
            const me = await client.getMe();
            if (me && me.username) {
              return `tg://resolve?domain=${me.username}`;
            }
          }
        } catch (e) {
          // Silently fail - will use callback button as fallback
        }
        return null;
      })()
    ]);

    const usePool = settings?.useMessagePool || false;
    const forwardMode = settings?.forwardMode || false;

    // Handle both object format {text, entities} and string format for backward compatibility
    const messageText = currentMessage ? (typeof currentMessage === 'string' ? currentMessage : currentMessage.text) : null;

    const msgPreview = messageText 
      ? `"${escapeHtml(messageText.substring(0, 35))}${messageText.length > 35 ? '...' : ''}"` 
      : '<i>Not set</i>';
    const poolCount = (pool || []).length;

    let menuMessage = `<b>📝 MESSAGES</b>
━━━━━━━━━━━━━━━━━━━━━

📄 Current Message:
${msgPreview}

📚 Pool: ${usePool ? `<b>ON</b> (${poolCount} messages)` : `<i>OFF</i> (${poolCount} saved)`}
↗️ Forward Mode: ${forwardMode ? '<b>ON</b>' : '<i>OFF</i>'}`;

    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      menuMessage,
      { parse_mode: 'HTML', ...createMessagesMenu(forwardMode, savedMessagesUrl) }
    );
    
    await safeAnswerCallback(bot, callbackQuery.id);
  } catch (error) {
    console.error(`[MESSAGES_MENU] Error:`, error.message);
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '⚠️ Something went wrong. Please try again.',
      show_alert: true,
    });
  }
}

export async function handleSetStartMessageButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  // Check verification (fast)
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await safeAnswerCallback(bot, callbackQuery.id, { text: 'Please verify first!', show_alert: true });
      await showVerificationRequired(bot, chatId, channelUsernames);
      return;
    }
  }

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, { text: 'Please link an account first!', show_alert: true });
    return;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, { text: 'No active account found!', show_alert: true });
    return;
  }

  // Answer callback immediately - the rest is slow (needs Telegram connection)
  await safeAnswerCallback(bot, callbackQuery.id, { text: 'Checking Saved Messages...', show_alert: false });

  try {
    const accountLinker = (await import('../services/accountLinker.js')).default;
    
    // Check if account exists in database
    const accounts = await accountLinker.getAccounts(userId);
    const account = accounts.find(a => a.accountId === accountId);
    
    if (!account) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '🔍 <b>Account Not Found</b>\n\nWe couldn\'t find your account. This might be a temporary issue.\n\n📝 <b>What to do:</b>\n• Try refreshing your account list\n• Make sure your account is properly linked\n• If the problem persists, try linking your account again\n\n' +
        `The account (ID: ${accountId}) is no longer linked or has been deleted.\n\n` +
        `Please link your account again from the Account menu.`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
      return;
    }
    
    // Try to get client and connect
    let client;
    try {
      client = await accountLinker.getClientAndConnect(userId, accountId);
      
      // If client is null, account might not be in memory - try reloading
      if (!client) {
        console.log(`[SET_MESSAGE] Account ${accountId} not in memory, reloading accounts...`);
        try {
          // Reload all accounts to ensure this one is loaded
          await accountLinker.loadLinkedAccounts();
          console.log(`[SET_MESSAGE] Accounts reloaded, retrying connection...`);
          // Retry after reload
          client = await accountLinker.getClientAndConnect(userId, accountId);
        } catch (reloadError) {
          console.log(`[SET_MESSAGE] Error reloading accounts: ${reloadError.message}`);
        }
      }
    } catch (connectError) {
      console.log(`[SET_MESSAGE] Connection error for account ${accountId}: ${connectError.message}`);
      
      // Check if it's a session revocation error
      const errorMessage = connectError.message || connectError.toString() || '';
      const errorCode = connectError.code || connectError.errorCode || connectError.response?.error_code;
      const isSessionRevoked = connectError.errorMessage === 'SESSION_REVOKED' || 
                                connectError.errorMessage === 'AUTH_KEY_UNREGISTERED' ||
                                (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
                                errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
                                errorMessage.includes('SESSION_REVOKED');
      
      if (isSessionRevoked) {
        console.log(`[SET_MESSAGE] Session revoked for account ${accountId} during connection, handling revocation...`);
        await accountLinker.handleSessionRevoked(accountId);
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          '🔐 <b>Session Expired</b>\n\n' +
          `Your account session has expired or been revoked.\n\n` +
          `Please re-link your account:\n\n` +
          `1️⃣ Go to Account menu\n` +
          `2️⃣ Delete the old account\n` +
          `3️⃣ Link your account again\n\n` +
          `After re-linking, you can set your message again.`,
          { parse_mode: 'HTML', ...await createMainMenu(userId) }
        );
        return;
      }
      
      // Check if it's an "Account not found" error - try reloading once
      if (connectError.message && connectError.message.includes('not found')) {
        try {
          console.log(`[SET_MESSAGE] Account not found, attempting to reload accounts...`);
          await accountLinker.loadLinkedAccounts();
          // Retry after reload
          client = await accountLinker.getClientAndConnect(userId, accountId);
        } catch (retryError) {
          // If retry also fails, show error message
          await safeEditMessage(
            bot,
            chatId,
            callbackQuery.message.message_id,
            '❌ <b>Account Connection Error</b>\n\n' +
            `Unable to connect to account ${accountId}.\n\n` +
            `This might happen if:\n` +
            `• The account session expired\n` +
            `• The account was deleted\n` +
            `• There's a connection issue\n\n` +
            `Please try:\n` +
            `1. Switch to another account\n` +
            `2. Re-link this account\n` +
            `3. Try again later`,
            { parse_mode: 'HTML', ...await createMainMenu(userId) }
          );
          return;
        }
      } else {
        throw connectError; // Re-throw other errors
      }
    }
    
    if (!client) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '❌ <b>Account Connection Error</b>\n\n' +
        `Unable to connect to account ${accountId}.\n\n` +
        `Please try:\n` +
        `1. Switch to another account\n` +
        `2. Re-link this account`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
      return;
    }

    // Get Saved Messages entity
    let me;
    let savedMessagesEntity;
    try {
      me = await client.getMe();
    } catch (error) {
      // Check if it's a session revocation error
      const errorMessage = error.message || error.toString() || '';
      const errorCode = error.code || error.errorCode || error.response?.error_code;
      const isSessionRevoked = error.errorMessage === 'SESSION_REVOKED' || 
                                error.errorMessage === 'AUTH_KEY_UNREGISTERED' ||
                                (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
                                errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
                                errorMessage.includes('SESSION_REVOKED');
      
      if (isSessionRevoked) {
        console.log(`[SET_MESSAGE] Session revoked for account ${accountId}, handling revocation...`);
        await accountLinker.handleSessionRevoked(accountId);
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          '🔐 <b>Session Expired</b>\n\n' +
          `Your account session has expired or been revoked.\n\n` +
          `Please re-link your account:\n\n` +
          `1️⃣ Go to Account menu\n` +
          `2️⃣ Delete the old account\n` +
          `3️⃣ Link your account again\n\n` +
          `After re-linking, you can set your message again.`,
          { parse_mode: 'HTML', ...await createMainMenu(userId) }
        );
        return;
      }
      
      throw error;
    }
    
    try {
      savedMessagesEntity = await client.getEntity(me);
    } catch (error) {
      // Check if it's a session revocation error
      const errorMessage = error.message || error.toString() || '';
      const errorCode = error.code || error.errorCode || error.response?.error_code;
      const isSessionRevoked = error.errorMessage === 'SESSION_REVOKED' || 
                                error.errorMessage === 'AUTH_KEY_UNREGISTERED' ||
                                (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
                                errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
                                errorMessage.includes('SESSION_REVOKED');
      
      if (isSessionRevoked) {
        console.log(`[SET_MESSAGE] Session revoked for account ${accountId} while getting entity, handling revocation...`);
        await accountLinker.handleSessionRevoked(accountId);
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          '🔐 <b>Session Expired</b>\n\n' +
          `Your account session has expired or been revoked.\n\n` +
          `Please re-link your account:\n\n` +
          `1️⃣ Go to Account menu\n` +
          `2️⃣ Delete the old account\n` +
          `3️⃣ Link your account again\n\n` +
          `After re-linking, you can set your message again.`,
          { parse_mode: 'HTML', ...await createMainMenu(userId) }
        );
        return;
      }
      
      // Try alternative method
      try {
        const dialogs = await client.getDialogs();
        const savedDialog = dialogs.find(d => d.isUser && d.name === 'Saved Messages');
        if (savedDialog) {
          savedMessagesEntity = savedDialog.entity;
        } else {
          throw new Error('Saved Messages not found');
        }
      } catch (dialogError) {
        const dialogErrorMessage = dialogError.message || dialogError.toString() || '';
        const dialogErrorCode = dialogError.code || dialogError.errorCode || dialogError.response?.error_code;
        const isDialogSessionRevoked = dialogError.errorMessage === 'SESSION_REVOKED' || 
                                       dialogError.errorMessage === 'AUTH_KEY_UNREGISTERED' ||
                                       (dialogErrorCode === 401 && (dialogErrorMessage.includes('SESSION_REVOKED') || dialogErrorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
                                       dialogErrorMessage.includes('AUTH_KEY_UNREGISTERED') ||
                                       dialogErrorMessage.includes('SESSION_REVOKED');
        
        if (isDialogSessionRevoked) {
          console.log(`[SET_MESSAGE] Session revoked for account ${accountId} while getting dialogs, handling revocation...`);
          await accountLinker.handleSessionRevoked(accountId);
          
          await safeEditMessage(
            bot,
            chatId,
            callbackQuery.message.message_id,
            '🔐 <b>Session Expired</b>\n\n' +
            `Your account session has expired or been revoked.\n\n` +
            `Please re-link your account:\n\n` +
            `1️⃣ Go to Account menu\n` +
            `2️⃣ Delete the old account\n` +
            `3️⃣ Link your account again\n\n` +
            `After re-linking, you can set your message again.`,
            { parse_mode: 'HTML', ...await createMainMenu(userId) }
          );
          return;
        }
        
        throw dialogError;
      }
    }

    // Get the last message from Saved Messages
    let messages;
    try {
      messages = await client.getMessages(savedMessagesEntity, { limit: 1 });
    } catch (error) {
      // Check if it's a session revocation error
      const errorMessage = error.message || error.toString() || '';
      const errorCode = error.code || error.errorCode || error.response?.error_code;
      const isSessionRevoked = error.errorMessage === 'SESSION_REVOKED' || 
                                error.errorMessage === 'AUTH_KEY_UNREGISTERED' ||
                                (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
                                errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
                                errorMessage.includes('SESSION_REVOKED');
      
      if (isSessionRevoked) {
        console.log(`[SET_MESSAGE] Session revoked for account ${accountId} while getting messages, handling revocation...`);
        await accountLinker.handleSessionRevoked(accountId);
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          '🔐 <b>Session Expired</b>\n\n' +
          `Your account session has expired or been revoked.\n\n` +
          `Please re-link your account:\n\n` +
          `1️⃣ Go to Account menu\n` +
          `2️⃣ Delete the old account\n` +
          `3️⃣ Link your account again\n\n` +
          `After re-linking, you can set your message again.`,
          { parse_mode: 'HTML', ...await createMainMenu(userId) }
        );
        return;
      }
      
      throw error;
    }
    
    if (!messages || messages.length === 0) {
      const instructions = `📝 <b>Set Broadcast Message</b>\n\n` +
        `No message found in Saved Messages.\n\n` +
        `To set your broadcast message:\n\n` +
        `1️⃣ Open your account's Telegram app\n` +
        `2️⃣ Go to <b>Saved Messages</b>\n` +
        `3️⃣ Send your message there (with premium emojis if you want)\n` +
        `4️⃣ Come back and click "Set Message" again\n\n` +
        `The bot will automatically use the <b>last message</b> from your Saved Messages.`;

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📖 How to Open Saved Messages', callback_data: 'btn_show_saved_instructions' }],
            [{ text: '🔄 Try Again', callback_data: 'btn_set_start_msg' }],
            [{ text: '🔙 Back', callback_data: 'btn_messages_menu' }]
          ]
        }
      };

      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        instructions,
        { parse_mode: 'HTML', ...keyboard }
      );
      return;
    }

    const savedMessage = messages[0];
    const savedMessageId = savedMessage.id;
    const messageText = savedMessage.text || '';
    
    // Extract entities from the saved message
    let messageEntities = null;
    if (savedMessage.entities && savedMessage.entities.length > 0) {
      messageEntities = savedMessage.entities.map(e => {
        let entityType = 'unknown';
        
        if (e.className === 'MessageEntityCustomEmoji' || e.constructor?.name === 'MessageEntityCustomEmoji') {
          entityType = 'custom_emoji';
        } else if (e.className === 'MessageEntityBold' || e.constructor?.name === 'MessageEntityBold') {
          entityType = 'bold';
        } else if (e.className === 'MessageEntityItalic' || e.constructor?.name === 'MessageEntityItalic') {
          entityType = 'italic';
        } else if (e.className === 'MessageEntityCode' || e.constructor?.name === 'MessageEntityCode') {
          entityType = 'code';
        } else if (e.className === 'MessageEntityPre' || e.constructor?.name === 'MessageEntityPre') {
          entityType = 'pre';
        }

        const entity = {
          type: entityType,
          offset: e.offset,
          length: e.length,
        };

        if (entityType === 'custom_emoji' && e.documentId !== undefined && e.documentId !== null) {
          entity.custom_emoji_id = String(e.documentId);
        }

        if (entityType === 'pre' && e.language !== undefined) {
          entity.language = e.language;
        }

        return entity;
      });
    }

    // Deactivate existing messages
    await db.query(
      `UPDATE messages SET is_active = FALSE WHERE account_id = $1`,
      [accountId]
    );

    // Save new active message
    const result = await messageService.saveMessage(accountId, messageText, 'A', messageEntities);
    
    if (result.success) {
      // Update with saved_message_id
      await db.query(
        `UPDATE messages 
         SET saved_message_id = $1
         WHERE account_id = $2 AND is_active = TRUE AND variant = 'A'
         ORDER BY updated_at DESC LIMIT 1`,
        [savedMessageId, accountId]
      );

      const premiumEmojiCount = messageEntities ? messageEntities.filter(e => e.type === 'custom_emoji').length : 0;
      const previewText = messageText.length > 50 ? messageText.substring(0, 50) + '...' : messageText;

      let successMessage = `✅ <b>Broadcast Message Set!</b>\n\n`;
      successMessage += `Your message from Saved Messages has been set as the broadcast message.\n\n`;
      successMessage += `📝 <b>Preview:</b> ${escapeHtml(previewText)}\n`;
      if (premiumEmojiCount > 0) {
        successMessage += `🎨 <b>Premium Emojis:</b> ${premiumEmojiCount} found\n\n`;
      }
      successMessage += `✅ The bot will use the <b>last message</b> from Saved Messages when broadcasting.`;

      console.log(`[SET_MESSAGE] ✅ Message set from Saved Messages (ID: ${savedMessageId}, ${premiumEmojiCount} premium emojis)`);

      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        successMessage,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );

      logger.logChange('MESSAGE_SET', userId, `Message set from Saved Messages (ID: ${savedMessageId})`);
    } else {
      throw new Error(result.error || 'Failed to save message');
    }
  } catch (error) {
    console.log(`[SET_MESSAGE] Error: ${error.message}`);
    
    // Check if it's a session revocation error
    const errorMessage = error.message || error.toString() || '';
    const errorCode = error.code || error.errorCode || error.response?.error_code;
    const isSessionRevoked = error.errorMessage === 'SESSION_REVOKED' || 
                              error.errorMessage === 'AUTH_KEY_UNREGISTERED' ||
                              (errorCode === 401 && (errorMessage.includes('SESSION_REVOKED') || errorMessage.includes('AUTH_KEY_UNREGISTERED'))) ||
                              errorMessage.includes('AUTH_KEY_UNREGISTERED') ||
                              errorMessage.includes('SESSION_REVOKED');
    
    if (isSessionRevoked) {
      console.log(`[SET_MESSAGE] Session revoked for account ${accountId} in catch block, handling revocation...`);
      try {
        await accountLinker.handleSessionRevoked(accountId);
      } catch (revokeError) {
        console.log(`[SET_MESSAGE] Error handling session revocation: ${revokeError.message}`);
      }
      
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '🔐 <b>Session Expired</b>\n\n' +
        `Your account session has expired or been revoked.\n\n` +
        `Please re-link your account:\n\n` +
        `1️⃣ Go to Account menu\n` +
        `2️⃣ Delete the old account\n` +
        `3️⃣ Link your account again\n\n` +
        `After re-linking, you can set your message again.`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
      return;
    }
    
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      `❌ <b>Error</b>\n\n${getUserFriendlyErrorMessage()}\n\nPlease make sure you have sent a message to Saved Messages first.`,
      { parse_mode: 'HTML', ...createBackButton() }
    );
  }
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
      `🔗 <b>No Active Account</b>\n\nYou need to have an active account to use this feature.\n\n📝 <b>What to do:</b>\n• Click "🔗 Link Account" to link a new account\n• Or switch to an existing account from the Account menu`,
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

  // Check if logger bot is started (only on first time - check if user has ever started broadcast before)
  const hasLoggerBotStarted = await loggerBotService.hasLoggerBotStarted(userId);
  if (!hasLoggerBotStarted) {
    // Check if this is the first time starting broadcast (no previous broadcast history)
    const hasPreviousBroadcast = await db.query(
      'SELECT 1 FROM accounts WHERE user_id = ? AND broadcast_start_time IS NOT NULL LIMIT 1',
      [userId]
    );
    
    // Only show warning on first time
    if (!hasPreviousBroadcast.rows || hasPreviousBroadcast.rows.length === 0) {
      const loggerBotUsername = config.userLoggerBotToken ? 'your logger bot' : 'the logger bot';
      await bot.sendMessage(
        chatId,
        `❌ <b>Logger Bot Required</b>\n\n` +
        `Please start the logger bot before starting broadcast.\n\n` +
        `The logger bot sends you important logs about your account activity.\n\n` +
        `Click the button below to start the logger bot:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Start Logger Bot', callback_data: 'btn_logger_bot' }],
              [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
            ]
          }
        }
      );
      return;
    }
  }

  // automationService.startBroadcast will get message from messageService if not provided
  const result = await automationService.startBroadcast(userId, null);

  if (result.success) {
    const accountId = accountLinker.getActiveAccountId(userId);
    logger.logSuccess('BROADCAST_STARTED', userId, `Broadcast started for account ${accountId}`);
    
    // Send log to logger bot
    loggerBotService.logBroadcastStarted(userId, accountId).catch(() => {
      // Silently fail - logger bot may not be started or user may have blocked it
    });
    
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
    const errorMessage = `❌ <b>Failed to Start Broadcast</b>\n\n${getUserFriendlyErrorMessage()}\n\n`;
    
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

  // Check verification (fast)
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await safeAnswerCallback(bot, callbackQuery.id, { text: 'Please verify first!', show_alert: true });
      await showVerificationRequired(bot, chatId, channelUsernames);
      return;
    }
  }

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, { text: 'Please link your account first!', show_alert: true });
    const linkResult = await handleLinkButton(bot, callbackQuery);
    if (linkResult) {
      addPendingPhoneNumber(userId);
    }
    return;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, { text: 'No active account found!', show_alert: true });
    return;
  }

  // Check logger bot only if NOT broadcasting (and check in PARALLEL)
  if (!automationService.isBroadcasting(userId, accountId)) {
    const [hasLoggerBotStarted, hasPreviousBroadcast] = await Promise.all([
      loggerBotService.hasLoggerBotStarted(userId).catch(() => true), // Default to true to skip check on error
      db.query('SELECT 1 FROM accounts WHERE user_id = ? AND broadcast_start_time IS NOT NULL LIMIT 1', [userId]).catch(() => ({ rows: [1] }))
    ]);

    if (!hasLoggerBotStarted && (!hasPreviousBroadcast.rows || hasPreviousBroadcast.rows.length === 0)) {
      await safeAnswerCallback(bot, callbackQuery.id, { text: 'Please start the logger bot first!', show_alert: true });
      await safeEditMessage(bot, chatId, callbackQuery.message.message_id,
        `❌ <b>Logger Bot Required</b>\n\nPlease start the logger bot before starting broadcast.`,
        { parse_mode: 'HTML', reply_markup: { inline_keyboard: [
          [{ text: '📝 Start Logger Bot', callback_data: 'btn_logger_bot' }],
          [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
        ]}}
      );
      return;
    }
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
          
          // Send log to logger bot
          loggerBotService.logBroadcastStopped(userId, accountId).catch(() => {
            // Silently fail - logger bot may not be started or user may have blocked it
          });
          
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
          const errorMessage = `❌ <b>Failed to Stop Broadcast</b>\n\n${getUserFriendlyErrorMessage()}\n\n`;
          
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
          `❌ <b>Error Stopping Broadcast</b>\n\n${getUserFriendlyErrorMessage()}`,
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
        const errorMessage = `❌ <b>Failed to Start Broadcast</b>\n\n${getUserFriendlyErrorMessage()}\n\n`;
        
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
        `❌ <b>Error Starting Broadcast</b>\n\n${getUserFriendlyErrorMessage()}`,
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
      '🔗 <b>No Active Account</b>\n\nPlease link or switch to an account first.',
      await createMainMenu(userId)
    );
    return;
  }

  const result = await automationService.stopBroadcast(userId, accountId);

  if (result.success) {
    logger.logSuccess('BROADCAST_STOPPED', userId, `Broadcast stopped for account ${accountId}`);
    
    // Send log to logger bot
    loggerBotService.logBroadcastStopped(userId, accountId).catch(() => {
      // Silently fail - logger bot may not be started or user may have blocked it
    });
    
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
      text: '🔗 No active account found. Please link or switch to an account first.',
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
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  const result = await automationService.stopBroadcast(userId, accountId);

  if (result.success) {
    logger.logSuccess('BROADCAST_STOPPED', userId, `Broadcast stopped for account ${accountId}`);
    
    // Send log to logger bot
    loggerBotService.logBroadcastStopped(userId, accountId).catch(() => {
      // Silently fail - logger bot may not be started or user may have blocked it
    });
    
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

  // Check verification (fast)
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsernames);
      return;
    }
  }

  // Get data in PARALLEL
  const [accounts, mainMenu] = await Promise.all([
    accountLinker.getAccounts(userId),
    createMainMenu(userId)
  ]);
  
  const isLinked = accountLinker.isLinked(userId);
  const activeAccountId = accountLinker.getActiveAccountId(userId);
  const isBroadcasting = activeAccountId ? automationService.isBroadcasting(userId, activeAccountId) : false;

  let statusMessage = '<b>Account</b>\n\n';
  
  if (isLinked && accounts.length > 0) {
    const activeAccount = accounts.find(acc => acc.accountId === activeAccountId);
    const displayName = activeAccount ? (activeAccount.firstName || activeAccount.phone) : 'None';
    statusMessage += `Active: ${escapeHtml(displayName)}\n`;
    statusMessage += `Broadcast: ${isBroadcasting ? 'Active' : 'Inactive'}\n`;
  } else {
    statusMessage += `Not linked\n`;
  }
  
  await safeEditMessage(bot, chatId, callbackQuery.message.message_id, statusMessage, { parse_mode: 'HTML', ...mainMenu });
  await safeAnswerCallback(bot, callbackQuery.id);
}

// Unified account management handler
export async function handleLoggerBotButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  await safeAnswerCallback(bot, callbackQuery.id);

  if (!config.userLoggerBotToken) {
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      '❌ <b>Logger Bot Not Configured</b>\n\nThe logger bot is not configured. Please contact support.',
      { parse_mode: 'HTML', ...await createMainMenu(userId) }
    );
    return;
  }

  // Get logger bot info
  try {
    if (!loggerBotService.bot || !loggerBotService.initialized) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '❌ <b>Logger Bot Not Available</b>\n\nThe logger bot is not initialized. Please contact support.',
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
      return;
    }

    const botInfo = await safeBotApiCall(
      () => loggerBotService.bot.getMe(),
      { maxRetries: 2, bufferSeconds: 1, throwOnFailure: false }
    );

    if (!botInfo) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '⚠️ <b>Logger Bot Unavailable</b>\n\nThe logger bot is temporarily unavailable.\n\n📝 <b>What to do:</b>\n• Try again in a few moments\n• Make sure the logger bot is running\n• Contact support if the problem persists',
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
      return;
    }

    const loggerBotUsername = botInfo.username || 'logger bot';
    const hasStarted = await loggerBotService.hasLoggerBotStarted(userId);

    if (hasStarted) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `✅ <b>Logger Bot Active</b>\n\n` +
        `You are receiving logs from the logger bot.\n\n` +
        `Bot: @${loggerBotUsername}\n\n` +
        `To stop receiving logs, you can block the logger bot.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
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
        `📝 <b>Start Logger Bot</b>\n\n` +
        `The logger bot sends you comprehensive logs about your account activity, including:\n\n` +
        `📢 Broadcast status, cycle stats, daily cap warnings\n` +
        `👥 Group refresh, add/remove events\n` +
        `⚙️ Settings changes (interval, quiet hours, schedule)\n` +
        `💬 Auto-reply activity (DM & groups)\n` +
        `🔑 Account status, session issues\n` +
        `📝 Message pool changes, message updates\n` +
        `⭐ Premium status changes\n` +
        `⚠️ Rate limits, errors, connection issues\n\n` +
        `To start the logger bot, click the button below and send /start to @${loggerBotUsername}:`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: `📝 Start @${loggerBotUsername}`, url: `https://t.me/${loggerBotUsername}?start=start` }],
              [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]
            ]
          }
        }
      );
    }
  } catch (error) {
    logError('[LOGGER_BOT] Error handling logger bot button:', error);
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      '⚠️ <b>Couldn\'t Get Logger Bot Info</b>\n\nWe couldn\'t retrieve logger bot information right now.\n\n📝 <b>What to do:</b>\n• Try again in a moment\n• Check if the logger bot is running\n• Contact support if needed',
      { parse_mode: 'HTML', ...await createMainMenu(userId) }
    );
  }
}

export async function handleAccountButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  // Check verification (fast - uses cache)
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsernames);
      return;
    }
  }

  // Get accounts (fast - from memory)
  const accounts = await accountLinker.getAccounts(userId);
  const activeAccountId = accountLinker.getActiveAccountId(userId);

  // Create account management menu
  const buttons = [];
  
  // Add "Link Account" button (always available) - full width, prominent
  buttons.push([{ text: '➕ Link New Account', callback_data: 'btn_link' }]);
  
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
  
  buttons.push([{ text: '← Back', callback_data: 'btn_main_menu' }]);

  let accountMessage;
  if (accounts.length === 0) {
    accountMessage = `<b>👤 ACCOUNTS</b>
━━━━━━━━━━━━━━━━━━━━━

<i>No accounts linked yet</i>

Tap below to link your first account.`;
  } else {
    const activeAccount = accounts.find(a => a.isActive);
    const activeName = activeAccount?.firstName || activeAccount?.phone || 'None';
    accountMessage = `<b>👤 ACCOUNTS</b>
━━━━━━━━━━━━━━━━━━━━━

Total: <b>${accounts.length}</b>
Active: <b>${escapeHtml(activeName)}</b>

<i>Tap to switch or delete</i>`;
  }

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


// ==================== MESSAGE POOL HANDLERS ====================

export async function handleMessagePoolButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  // Check verification (fast)
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsernames);
      return;
    }
  }

  if (!accountLinker.isLinked(userId)) {
    await safeAnswerCallback(bot, callbackQuery.id, { text: 'Please link an account first!', show_alert: true });
    return;
  }

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, { text: 'No active account found!', show_alert: true });
    return;
  }

  // Get pool and settings in PARALLEL - NO SYNC on click (too slow)
  const [pool, settings] = await Promise.all([
    messageService.getMessagePool(accountId, true).catch(() => []),
    configService.getAccountSettings(accountId).catch(() => null)
  ]);

  const usePool = settings?.useMessagePool || false;
  const poolMode = settings?.messagePoolMode || 'random';
  const activePool = (pool || []).filter(msg => msg.is_active);

  const poolMessage = `🎲 <b>Message Pool</b>\n\n` +
    `📊 <b>Total:</b> ${(pool || []).length} (${activePool.length} active)\n` +
    `⚙️ <b>Mode:</b> ${usePool ? `✅ ${poolMode === 'random' ? '🎲 Random' : poolMode === 'rotate' ? '🔄 Rotate' : '➡️ Sequential'}` : '❌ Disabled'}\n\n` +
    `${(pool || []).length === 0 ? '⚠️ No messages. Click 🔄 Refresh to sync from Saved Messages.\n\n' : ''}` +
    `Click <b>🔄 Refresh</b> to sync messages from Saved Messages.`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    poolMessage,
    { parse_mode: 'HTML', ...createMessagePoolKeyboard(activePool.length, poolMode, usePool) }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handlePoolAddMessage(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Add to Pool', chatId);

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
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  // Automatically detect and add the last message from Saved Messages to pool
  await safeAnswerCallback(bot, callbackQuery.id, {
    text: 'Checking Saved Messages...',
    show_alert: false,
  });

  try {
    const accountLinker = (await import('../services/accountLinker.js')).default;
    
    // Check if account exists and is linked
    const accounts = await accountLinker.getAccounts(userId);
    const account = accounts.find(a => a.accountId === accountId);
    
    if (!account) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '🔍 <b>Account Not Found</b>\n\nWe couldn\'t find your account. This might be a temporary issue.\n\n📝 <b>What to do:</b>\n• Try refreshing your account list\n• Make sure your account is properly linked\n• If the problem persists, try linking your account again\n\n' +
        `The account (ID: ${accountId}) is no longer linked or has been deleted.\n\n` +
        `Please link your account again from the Account menu.`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
      return;
    }
    
    // Try to get client and connect
    let client;
    try {
      client = await accountLinker.getClientAndConnect(userId, accountId);
      
      // If client is null, account might not be in memory - try reloading
      if (!client) {
        console.log(`[POOL_ADD] Account ${accountId} not in memory, reloading accounts...`);
        try {
          // Reload all accounts to ensure this one is loaded
          await accountLinker.loadLinkedAccounts();
          console.log(`[POOL_ADD] Accounts reloaded, retrying connection...`);
          // Retry after reload
          client = await accountLinker.getClientAndConnect(userId, accountId);
        } catch (reloadError) {
          console.log(`[POOL_ADD] Error reloading accounts: ${reloadError.message}`);
        }
      }
    } catch (connectError) {
      console.log(`[POOL_ADD] Connection error for account ${accountId}: ${connectError.message}`);
      
      // Check if it's an "Account not found" error - try reloading once
      if (connectError.message && connectError.message.includes('not found')) {
        try {
          console.log(`[POOL_ADD] Account not found, attempting to reload accounts...`);
          await accountLinker.loadLinkedAccounts();
          // Retry after reload
          client = await accountLinker.getClientAndConnect(userId, accountId);
        } catch (retryError) {
          // If retry also fails, show error message
          await safeEditMessage(
            bot,
            chatId,
            callbackQuery.message.message_id,
            '❌ <b>Account Connection Error</b>\n\n' +
            `Unable to connect to account ${accountId}.\n\n` +
            `This might happen if:\n` +
            `• The account session expired\n` +
            `• The account was deleted\n` +
            `• There's a connection issue\n\n` +
            `Please try:\n` +
            `1. Switch to another account\n` +
            `2. Re-link this account\n` +
            `3. Try again later`,
            { parse_mode: 'HTML', ...await createMainMenu(userId) }
          );
          return;
        }
      } else {
        throw connectError; // Re-throw other errors
      }
    }
    
    if (!client) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '❌ <b>Account Connection Error</b>\n\n' +
        `Unable to connect to account ${accountId}.\n\n` +
        `Please try:\n` +
        `1. Switch to another account\n` +
        `2. Re-link this account`,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
      return;
    }
    
    if (!client) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '⚠️ <b>Account Connection Issue</b>\n\nYour account connection is temporarily unavailable.\n\n📝 <b>What to do:</b>\n• Wait a moment and try again\n• Make sure your account is properly linked\n• If the problem persists, try re-linking your account',
        { parse_mode: 'HTML', ...createBackButton() }
      );
      return;
    }

    // Get Saved Messages entity
    const me = await client.getMe();
    let savedMessagesEntity;
    try {
      savedMessagesEntity = await client.getEntity(me);
    } catch (error) {
      const dialogs = await client.getDialogs();
      const savedDialog = dialogs.find(d => d.isUser && d.name === 'Saved Messages');
      if (savedDialog) {
        savedMessagesEntity = savedDialog.entity;
      } else {
        throw new Error('Saved Messages not found');
      }
    }

    // Get the last 7 messages from Saved Messages
    const messages = await client.getMessages(savedMessagesEntity, { limit: 7 });
    if (!messages || messages.length === 0) {
      const instructions = `📝 <b>Add Messages to Pool</b>\n\n` +
        `No messages found in Saved Messages.\n\n` +
        `To add messages to the pool:\n\n` +
        `1️⃣ Open your account's Telegram app\n` +
        `2️⃣ Go to <b>Saved Messages</b>\n` +
        `3️⃣ Send your messages there (with premium emojis if you want)\n` +
        `4️⃣ Come back and click "Add to Pool" again\n\n` +
        `The bot will automatically add the <b>last 7 messages</b> from your Saved Messages.`;

      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [{ text: '📱 How to Open Saved Messages', callback_data: 'btn_show_saved_instructions' }],
            [{ text: '🔄 Try Again', callback_data: 'pool_add_message' }],
            [{ text: '🔙 Back', callback_data: 'btn_message_pool' }]
          ]
        }
      };

      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        instructions,
        { parse_mode: 'HTML', ...keyboard }
      );
      return;
    }

    // Process all messages (up to 5)
    let addedCount = 0;
    let duplicateCount = 0;
    let skippedCount = 0;
    const results = [];

    for (const savedMessage of messages) {
      const messageText = savedMessage.text || '';
      
      // Skip empty messages
      if (!messageText || messageText.trim().length === 0) {
        skippedCount++;
        continue;
      }

      // Validate message length
      if (messageText.length > 4096) {
        skippedCount++;
        continue;
      }
      
      // Extract entities from the saved message
      let messageEntities = null;
      if (savedMessage.entities && savedMessage.entities.length > 0) {
        messageEntities = savedMessage.entities.map(e => {
          let entityType = 'unknown';
          
          if (e.className === 'MessageEntityCustomEmoji' || e.constructor?.name === 'MessageEntityCustomEmoji') {
            entityType = 'custom_emoji';
          } else if (e.className === 'MessageEntityBold' || e.constructor?.name === 'MessageEntityBold') {
            entityType = 'bold';
          } else if (e.className === 'MessageEntityItalic' || e.constructor?.name === 'MessageEntityItalic') {
            entityType = 'italic';
          } else if (e.className === 'MessageEntityCode' || e.constructor?.name === 'MessageEntityCode') {
            entityType = 'code';
          } else if (e.className === 'MessageEntityPre' || e.constructor?.name === 'MessageEntityPre') {
            entityType = 'pre';
          }

          const entity = {
            type: entityType,
            offset: e.offset,
            length: e.length,
          };

          if (entityType === 'custom_emoji' && e.documentId !== undefined && e.documentId !== null) {
            entity.custom_emoji_id = String(e.documentId);
          }

          if (entityType === 'pre' && e.language !== undefined) {
            entity.language = e.language;
          }

          return entity;
        });
      }

      // Add to pool
      logger.logChange('MESSAGE_POOL', userId, `Message added to pool from Saved Messages: ${messageText.substring(0, 50)}...`);
      const result = await messageService.addToMessagePool(accountId, messageText, messageEntities);
      
      if (result.success) {
        addedCount++;
        results.push({ success: true, text: messageText, entities: messageEntities });
      } else if (result.isDuplicate) {
        duplicateCount++;
      } else {
        skippedCount++;
      }
    }

    // Show summary
    const pool = await messageService.getMessagePool(accountId);
    let successMessage = `✅ <b>Messages Added to Pool!</b>\n\n`;
    successMessage += `✅ <b>Added:</b> ${addedCount} message(s)\n`;
    if (duplicateCount > 0) {
      successMessage += `⚠️ <b>Duplicates skipped:</b> ${duplicateCount} message(s)\n`;
    }
    if (skippedCount > 0) {
      successMessage += `⏭️ <b>Skipped:</b> ${skippedCount} message(s) (empty or too long)\n`;
    }
    successMessage += `\n📊 <b>Total messages in pool:</b> ${pool.length}\n`;
    
    const totalPremiumEmojis = results.reduce((sum, r) => {
      return sum + (r.entities ? r.entities.filter(e => e.type === 'custom_emoji').length : 0);
    }, 0);
    if (totalPremiumEmojis > 0) {
      successMessage += `🎨 <b>Premium Emojis found:</b> ${totalPremiumEmojis}\n`;
    }
    
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      successMessage,
      { parse_mode: 'HTML', ...createBackButton() }
    );
  } catch (error) {
    console.log(`[POOL_ADD] Error: ${error.message}`);
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      `❌ <b>Error</b>\n\n${getUserFriendlyErrorMessage()}\n\nPlease make sure you have sent a message to Saved Messages first.`,
      { parse_mode: 'HTML', ...createBackButton() }
    );
  }
  
  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId };
}

/**
 * Handle adding last message from Saved Messages to pool
 */
export async function handlePoolAddFromSaved(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Add from Saved to Pool', chatId);

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
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  await safeAnswerCallback(bot, callbackQuery.id, {
    text: 'Checking Saved Messages...',
    show_alert: false,
  });

  try {
    const accountLinker = (await import('../services/accountLinker.js')).default;
    const client = await accountLinker.ensureConnected(accountId);
    
    if (!client) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '⚠️ <b>Account Connection Issue</b>\n\nYour account connection is temporarily unavailable.\n\n📝 <b>What to do:</b>\n• Wait a moment and try again\n• Make sure your account is properly linked\n• If the problem persists, try re-linking your account',
        { parse_mode: 'HTML', ...createBackButton() }
      );
      return;
    }

    // Get Saved Messages entity
    const me = await client.getMe();
    let savedMessagesEntity;
    try {
      savedMessagesEntity = await client.getEntity(me);
    } catch (error) {
      const dialogs = await client.getDialogs();
      const savedDialog = dialogs.find(d => d.isUser && d.name === 'Saved Messages');
      if (savedDialog) {
        savedMessagesEntity = savedDialog.entity;
      } else {
        throw new Error('Saved Messages not found');
      }
    }

    // Get the last message from Saved Messages
    const messages = await client.getMessages(savedMessagesEntity, { limit: 1 });
    if (!messages || messages.length === 0) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '❌ <b>No Message Found</b>\n\nPlease send your message to Saved Messages first, then try again.',
        { parse_mode: 'HTML', ...createBackButton() }
      );
      return;
    }

    const savedMessage = messages[0];
    const messageText = savedMessage.text || '';
    
    // Extract entities from the saved message
    let messageEntities = null;
    if (savedMessage.entities && savedMessage.entities.length > 0) {
      messageEntities = savedMessage.entities.map(e => {
        let entityType = 'unknown';
        
        if (e.className === 'MessageEntityCustomEmoji' || e.constructor?.name === 'MessageEntityCustomEmoji') {
          entityType = 'custom_emoji';
        } else if (e.className === 'MessageEntityBold' || e.constructor?.name === 'MessageEntityBold') {
          entityType = 'bold';
        } else if (e.className === 'MessageEntityItalic' || e.constructor?.name === 'MessageEntityItalic') {
          entityType = 'italic';
        } else if (e.className === 'MessageEntityCode' || e.constructor?.name === 'MessageEntityCode') {
          entityType = 'code';
        } else if (e.className === 'MessageEntityPre' || e.constructor?.name === 'MessageEntityPre') {
          entityType = 'pre';
        }

        const entity = {
          type: entityType,
          offset: e.offset,
          length: e.length,
        };

        if (entityType === 'custom_emoji' && e.documentId !== undefined && e.documentId !== null) {
          entity.custom_emoji_id = String(e.documentId);
        }

        if (entityType === 'pre' && e.language !== undefined) {
          entity.language = e.language;
        }

        return entity;
      });
    }

    // Validate message length
    if (messageText.length > 4096) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '📝 <b>Message Too Long</b>\n\nYour message exceeds Telegram\'s 4,096 character limit.\n\n📝 <b>What to do:</b>\n• Shorten your message\n• Split it into multiple parts if needed\n• Try again with a shorter message',
        { parse_mode: 'HTML', ...createBackButton() }
      );
      return;
    }

    // Add to pool
    logger.logChange('MESSAGE_POOL', userId, `Message added to pool from Saved Messages: ${messageText.substring(0, 50)}...`);
    const result = await messageService.addToMessagePool(accountId, messageText, messageEntities);
    
    if (result.success) {
      const pool = await messageService.getMessagePool(accountId);
      const premiumEmojiCount = messageEntities ? messageEntities.filter(e => e.type === 'custom_emoji').length : 0;
      const previewText = messageText.length > 50 ? messageText.substring(0, 50) + '...' : messageText;
      
      let successMessage = `✅ <b>Message Added to Pool!</b>\n\n`;
      successMessage += `📝 <b>Preview:</b> ${escapeHtml(previewText)}\n`;
      successMessage += `📊 <b>Total messages in pool:</b> ${pool.length}\n`;
      if (premiumEmojiCount > 0) {
        successMessage += `🎨 <b>Premium Emojis:</b> ${premiumEmojiCount} found\n`;
      }
      
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        successMessage,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );
    } else {
      // Check if it's a duplicate
      if (result.isDuplicate) {
        const pool = await messageService.getMessagePool(accountId);
        const previewText = messageText.length > 50 ? messageText.substring(0, 50) + '...' : messageText;
        
        let errorMessage = `⚠️ <b>Message Already in Pool</b>\n\n`;
        errorMessage += `This message is already in your message pool.\n\n`;
        errorMessage += `📝 <b>Preview:</b> ${escapeHtml(previewText)}\n`;
        errorMessage += `📊 <b>Total messages in pool:</b> ${pool.length}\n\n`;
        errorMessage += `Please add a different message.`;
        
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          errorMessage,
          { parse_mode: 'HTML', ...createBackButton() }
        );
      } else {
        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          `❌ <b>Failed to Add Message</b>\n\n<b>Error:</b> ${result.error}`,
          { parse_mode: 'HTML', ...createBackButton() }
        );
      }
    }
  } catch (error) {
    console.log(`[POOL_ADD_FROM_SAVED] Error: ${error.message}`);
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      `❌ <b>Error</b>\n\n${getUserFriendlyErrorMessage()}`,
      { parse_mode: 'HTML', ...createBackButton() }
    );
  }
}


export async function handlePoolViewMessages(bot, callbackQuery, page = 0) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'View Pool Messages', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  // Get all messages including inactive ones for display
  const pool = await messageService.getMessagePool(accountId, true);
  const activePool = pool.filter(msg => msg.is_active);
  const inactivePool = pool.filter(msg => !msg.is_active);

  if (pool.length === 0) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Pool is empty! Send messages to Saved Messages and they will be auto-synced.',
      show_alert: true,
    });
    return;
  }

  // Validate page number
  const pageSize = 3;
  const maxPage = Math.max(0, Math.ceil(pool.length / pageSize) - 1);
  const currentPage = Math.max(0, Math.min(page, maxPage));

  const start = currentPage * pageSize;
  const end = Math.min(start + pageSize, pool.length);
  const pageMessages = pool.slice(start, end);

  let viewMessage = `📋 <b>Message Pool</b>\n\n`;
  viewMessage += `✅ <b>Active:</b> ${activePool.length} | ❌ <b>Disabled:</b> ${inactivePool.length}\n`;
  viewMessage += `📄 <b>Page:</b> ${currentPage + 1}/${maxPage + 1} (${pool.length} total)\n\n`;
  
  // Show messages for current page
  pageMessages.forEach((msg, idx) => {
    const statusIcon = msg.is_active ? '✅' : '❌';
    const globalIndex = start + idx + 1;
    const preview = msg.text.length > 80 ? msg.text.substring(0, 80) + '...' : msg.text;
    viewMessage += `${statusIcon} ${globalIndex}. <i>"${escapeHtml(preview)}"</i>\n\n`;
  });

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    viewMessage,
    { parse_mode: 'HTML', ...createMessagePoolListKeyboard(pool, currentPage, pageSize) }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handlePoolDeleteMessage(bot, callbackQuery, messageId) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Delete from Pool', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  const result = await messageService.deleteFromMessagePool(accountId, messageId);
  
  if (result.success) {
    const pool = await messageService.getMessagePool(accountId, true);
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Message deleted from pool!',
      show_alert: true,
    });
    
    // Refresh the view - calculate page based on message position
    if (pool.length === 0) {
      await handleMessagePoolButton(bot, callbackQuery);
    } else {
      // Find which page the deleted message was on (if still exists, find similar position)
      const pageSize = 3;
      const messageIndex = pool.findIndex(msg => msg.id === messageId);
      const page = messageIndex >= 0 ? Math.floor(messageIndex / pageSize) : 0;
      await handlePoolViewMessages(bot, callbackQuery, page);
    }
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: getUserFriendlyErrorMessage(),
      show_alert: true,
    });
  }
}

export async function handlePoolToggleMessage(bot, callbackQuery, messageId) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Toggle Pool Message', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  const result = await messageService.toggleMessagePoolActive(accountId, messageId);
  
  if (result.success) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: result.isActive ? 'Message enabled!' : 'Message disabled!',
      show_alert: true,
    });
    
    // Refresh the view - find which page the message is on
    const pool = await messageService.getMessagePool(accountId, true);
    const pageSize = 3;
    const messageIndex = pool.findIndex(msg => msg.id === messageId);
    const page = messageIndex >= 0 ? Math.floor(messageIndex / pageSize) : 0;
    await handlePoolViewMessages(bot, callbackQuery, page);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: getUserFriendlyErrorMessage(),
      show_alert: true,
    });
  }
}

export async function handlePoolModeChange(bot, callbackQuery, mode) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, `Pool Mode: ${mode}`, chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  await configService.updateMessagePoolMode(accountId, mode);
  await configService.setMessagePoolEnabled(accountId, true);
  
  const modeNames = {
    'random': 'Random',
    'rotate': 'Rotate',
    'sequential': 'Sequential'
  };
  
  await safeAnswerCallback(bot, callbackQuery.id, {
    text: `Mode changed to ${modeNames[mode] || mode}! Pool enabled.`,
    show_alert: true,
  });

  // Refresh the pool menu
  await handleMessagePoolButton(bot, callbackQuery);
}

export async function handlePoolToggle(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Toggle Pool', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const currentState = settings?.useMessagePool || false;
  const pool = await messageService.getMessagePool(accountId);

  if (!currentState && pool.length === 0) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Add at least one message to the pool before enabling!',
      show_alert: true,
    });
    return;
  }

  await configService.setMessagePoolEnabled(accountId, !currentState);
  await safeAnswerCallback(bot, callbackQuery.id, {
    text: `Message pool ${!currentState ? 'enabled' : 'disabled'}!`,
    show_alert: true,
  });

  // Refresh the pool menu
  await handleMessagePoolButton(bot, callbackQuery);
}

export async function handlePoolClear(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Clear Pool', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  const pool = await messageService.getMessagePool(accountId);
  
  // Delete all messages
  for (const msg of pool) {
    await messageService.deleteFromMessagePool(accountId, msg.id);
  }

  await safeAnswerCallback(bot, callbackQuery.id, {
    text: `Pool cleared! Removed ${pool.length} messages.`,
    show_alert: true,
  });

  // Refresh the pool menu
  await handleMessagePoolButton(bot, callbackQuery);
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
      text: '🔗 No active account found. Please link or switch to an account first.',
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
      text: '🔗 No active account found. Please link or switch to an account first.',
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
        const errorMessage = `❌ <b>Failed to Sync Templates</b>\n\n${getUserFriendlyErrorMessage()}\n\n`;
        
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
      text: '🔗 No active account found. Please link or switch to an account first.',
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
      text: '🔗 No active account found. Please link or switch to an account first.',
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
      text: '⚠️ Couldn\'t check verification status. Please try again.',
      show_alert: true,
    });
  }
}

export async function handleGroupsButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  // Check verification (fast)
  const updatesChannels = config.getUpdatesChannels();
  if (updatesChannels.length > 0) {
    const isVerified = await userService.isUserVerified(userId);
    if (!isVerified) {
      const channelUsernames = updatesChannels.map(ch => ch.replace('@', ''));
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: 'Please verify by joining our updates channel first!',
        show_alert: true,
      });
      await showVerificationRequired(bot, chatId, channelUsernames);
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

  // Run ALL queries in PARALLEL
  const [groupsCount, settings, blacklistResult] = await Promise.all([
    groupService.getActiveGroupsCount(accountId),
    configService.getAccountSettings(accountId).catch(() => null),
    groupBlacklistService.getBlacklistedGroups(accountId).catch(() => ({ groups: [] }))
  ]);
  
  const groupDelayMin = settings?.groupDelayMin;
  const groupDelayMax = settings?.groupDelayMax;
  const groupDelayText = groupDelayMin !== null && groupDelayMax !== null
    ? `${groupDelayMin}-${groupDelayMax}s`
    : 'Default (5-10s)';
  
  const blacklistCount = blacklistResult.groups?.length || 0;

  const groupsMessage = `<b>👥 GROUPS</b>
━━━━━━━━━━━━━━━━━━━━━

📊 Active Groups: <b>${groupsCount}</b>
⏳ Delay: <b>${groupDelayText}</b>
🚫 Blacklisted: <b>${blacklistCount}</b>`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    groupsMessage,
    { parse_mode: 'HTML', ...createGroupsMenu(groupDelayMin, groupDelayMax, blacklistCount) }
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
        errorMessage += `📝 <b>What to do:</b>\n• Double-check your input\n• Make sure everything is correct\n• Try again`;
        
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

export async function handleAutoJoinGroups(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Auto Join Groups', chatId);

  const message = `<b>➕ Auto Join Groups</b>

Use <b>@CoupJoinerBot</b> to automatically join groups!

Simply forward group invites to the bot and it will automatically join them using your linked account.

Click the button below to open @CoupJoinerBot:`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🤖 Open @CoupJoinerBot', url: 'https://t.me/CoupJoinerBot' }],
        [{ text: '🔙 Back to Groups', callback_data: 'btn_groups' }],
      ],
    },
  };

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    message,
    { parse_mode: 'HTML', ...keyboard }
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

      // Get account phone before deletion
      const accountPhone = accountToDelete?.phone || 'N/A';
      
      // Delete the account
      await accountLinker.deleteLinkedAccount(accountId);
      
      console.log(`[DELETE ACCOUNT] User ${userId} deleted account ${accountId} (${accountDisplayName})`);
      logger.logChange('ACCOUNT_DELETED', userId, `Successfully deleted account ${accountId} (${accountDisplayName})`);
      
      // Log to logger bot
      loggerBotService.logAccountDeleted(userId, accountId, accountPhone).catch(() => {
        // Silently fail - logger bot may not be started or user may have blocked it
      });
      
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
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  // Check if user has premium subscription (skip tags for premium users)
  const isPremium = await premiumService.isPremium(userId);
  if (isPremium) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '⭐ Premium users do not need to set tags!',
      show_alert: true,
    });
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      `⭐ <b>Premium User</b>\n\n` +
      `As a premium member, you don't need to set profile tags.\n\n` +
      `You can start broadcasting directly!`,
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
        month: 'long', 
        year: 'numeric' 
      });
      
      const message = `<b>⭐ PREMIUM ACTIVE</b>
━━━━━━━━━━━━━━━━━━━━━

✅ Your subscription is active!

📅 Expires: <b>${expiresAtFormatted}</b>
⏰ Remaining: <b>${daysRemaining} days</b>

<b>Your Benefits:</b>
• No tag verification
• Profile stays untouched
• All accounts covered
• Priority support`;
      
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        message,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '← Back', callback_data: 'btn_main_menu' }]
            ]
          }
        }
      );
    } else {
      const message = `<b>⭐ PREMIUM</b>
━━━━━━━━━━━━━━━━━━━━━

<b>₹30/month</b>

<b>Benefits:</b>
• No tag verification
• Profile stays untouched
• All accounts covered
• Instant activation
• Priority support

<i>Contact support to purchase</i>`;
      
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        message,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💬 Contact Support', url: 'https://t.me/CoupSupBot' }],
              [{ text: '← Back', callback_data: 'btn_main_menu' }]
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
          [{ text: '💬 Contact Support', url: 'https://t.me/CoupSupBot' }],
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
          [{ text: '💬 Contact Support', url: 'https://t.me/CoupSupBot' }],
          [{ text: '🔙 Back to Premium', callback_data: 'btn_premium' }]
        ]
      }
    }
  );
}


/**
 * Handle payment status check
 */
export async function handleCheckPaymentStatus(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;

  await safeAnswerCallback(bot, callbackQuery.id);

  try {
    const isPremium = await premiumService.isPremium(userId);
    if (isPremium) {
      const subscription = await premiumService.getSubscription(userId);
      const expiresAt = new Date(subscription.expires_at);
      const expiresAtFormatted = expiresAt.toLocaleDateString('en-IN', { 
        day: 'numeric', 
        month: 'long', 
        year: 'numeric' 
      });

      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `✅ <b>Premium Active!</b>\n\nYour premium subscription is active.\n\n<b>Expires:</b> ${expiresAtFormatted}\n<b>Days Remaining:</b> ${subscription.daysRemaining}`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⭐ View Premium', callback_data: 'btn_premium' }],
              [{ text: '🏠 Back to Menu', callback_data: 'btn_main_menu' }]
            ]
          }
        }
      );
      return;
    }

    const submission = await paymentVerificationService.getSubmissionStatus(userId);
    if (!submission) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        `📭 <b>No Payment Submission</b>\n\nYou haven't submitted any payment yet.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '💳 Purchase Premium', callback_data: 'btn_premium' }],
              [{ text: '🏠 Back to Menu', callback_data: 'btn_main_menu' }]
            ]
          }
        }
      );
      return;
    }

    let statusMessage = '';
    let statusEmoji = '⏳';
    
    if (submission.status === 'verified') {
      statusEmoji = '✅';
      statusMessage = 'Your payment has been verified and premium is active!';
    } else if (submission.status === 'pending') {
      statusEmoji = '⏳';
      statusMessage = 'Your payment is being verified. Please wait...';
    } else if (submission.status === 'rejected') {
      statusEmoji = '❌';
      statusMessage = `Your payment was rejected: ${submission.rejection_reason || 'Unknown reason'}`;
    }

    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      `${statusEmoji} <b>Payment Status</b>\n\n${statusMessage}\n\n<b>Transaction ID:</b> <code>${submission.transaction_id}</code>\n<b>Amount:</b> ₹${submission.amount}\n<b>Status:</b> ${submission.status.toUpperCase()}`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔄 Refresh', callback_data: 'premium_check_status' }],
            [{ text: '🏠 Back to Menu', callback_data: 'btn_main_menu' }]
          ]
        }
      }
    );
  } catch (error) {
    logger.logError('PREMIUM', userId, error, 'Error checking payment status');
  }
}

/**
 * Handle "Go to Saved Messages" button - tries to get URL and redirect, or shows instructions
 */
export async function handleGoToSavedMessages(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Go to Saved Messages', chatId);

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
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  // Try to get the account's username to create a direct link
  let savedMessagesUrl = null;
  let accountUsername = null;
  
  try {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Getting Saved Messages link...',
      show_alert: false,
    });
    
    // Try to connect and get account info
    const client = await accountLinker.getClientAndConnect(userId, accountId);
    if (client) {
      const me = await client.getMe();
      if (me) {
        if (me.username) {
          accountUsername = me.username;
          savedMessagesUrl = `https://t.me/${me.username}`;
        } else if (me.id) {
          savedMessagesUrl = `tg://user?id=${me.id}`;
        }
      }
    }
  } catch (error) {
    console.log(`[GO_TO_SAVED] Error getting account info: ${error.message}`);
  }

  if (savedMessagesUrl) {
    // Show message with direct link button
    const message = accountUsername 
      ? `📱 <b>Go to Saved Messages</b>\n\n` +
        `Click the button below to open Saved Messages for <b>@${accountUsername}</b>:\n\n` +
        `💡 After sending your message there, come back and click "✅ Check Saved Messages" to sync it.`
      : `📱 <b>Go to Saved Messages</b>\n\n` +
        `Click the button below to open Saved Messages:\n\n` +
        `💡 After sending your message there, come back and click "✅ Check Saved Messages" to sync it.`;

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '📱 Open Saved Messages', url: savedMessagesUrl }],
          [{ text: '✅ Check Saved Messages', callback_data: 'btn_check_saved_messages' }],
          [{ text: '🔙 Back to Messages', callback_data: 'btn_messages_menu' }]
        ]
      }
    };

    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      message,
      { parse_mode: 'HTML', ...keyboard }
    );
  } else {
    // Fallback: show instructions if we couldn't get the URL
    const instructions = `📱 <b>Open Saved Messages</b>\n\n` +
      `Could not create a direct link. Please open Saved Messages manually:\n\n` +
      `📱 <b>Mobile:</b> Menu (☰) → Saved Messages\n` +
      `💻 <b>Desktop:</b> Menu (☰) → Saved Messages\n` +
      `🔍 <b>Or:</b> Search for "Saved Messages"\n\n` +
      `⚠️ Make sure you're using your <b>linked account's</b> Telegram app!\n\n` +
      `After sending your message, click "✅ Check Saved Messages" below.`;

    const keyboard = {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Check Saved Messages', callback_data: 'btn_check_saved_messages' }],
          [{ text: '🔙 Back to Messages', callback_data: 'btn_messages_menu' }]
        ]
      }
    };

    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      instructions,
      { parse_mode: 'HTML', ...keyboard }
    );
  }
}

/**
 * Handle show Saved Messages instructions button
 */
export async function handleShowSavedInstructions(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Show Saved Messages Instructions', chatId);

  const instructions = `📱 <b>How to Open Saved Messages</b>\n\n` +
    `To open Saved Messages in Telegram:\n\n` +
    `📱 <b>Mobile (Android/iOS):</b>\n` +
    `1. Open Telegram app\n` +
    `2. Tap the menu (☰) in the top left\n` +
    `3. Tap "Saved Messages" at the top\n\n` +
    `💻 <b>Desktop/Web:</b>\n` +
    `1. Open Telegram\n` +
    `2. Click the menu (☰) in the top left\n` +
    `3. Click "Saved Messages"\n\n` +
    `💡 <b>Tip:</b> You can also search for "Saved Messages" in the search bar.\n\n` +
    `Once you're in Saved Messages, send your message there, then come back and try again!`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Messages', callback_data: 'btn_messages_menu' }]
      ]
    }
  };

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    instructions,
    { parse_mode: 'HTML', ...keyboard }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
}

/**
 * Handle forward to Saved Messages button click
 */
export async function handleForwardToSavedButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Forward to Saved Messages', chatId);

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
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  const instructions = `📤 <b>Use Saved Messages for Premium Emojis</b>\n\n` +
    `To use premium emojis in your broadcasts:\n\n` +
    `1️⃣ Open your account's Telegram app\n` +
    `2️⃣ Go to <b>Saved Messages</b>\n` +
    `3️⃣ Send your message with premium emojis there\n` +
    `4️⃣ Come back and click "✅ Check Saved Messages" below\n\n` +
    `The bot will automatically use the last message from Saved Messages for broadcasts.`;

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Check Saved Messages', callback_data: 'btn_check_saved_messages' }],
        [{ text: '🔙 Back', callback_data: 'btn_messages_menu' }]
      ]
    }
  };

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    instructions,
    { parse_mode: 'HTML', ...keyboard }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
}

/**
 * Handle check Saved Messages button - gets last message from Saved Messages
 * Can be used for setting message or just checking
 */
export async function handleCheckSavedMessages(bot, callbackQuery, saveAsMessage = false) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, saveAsMessage ? 'Check Saved Messages (Set)' : 'Check Saved Messages', chatId);

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
      text: '🔗 No active account found. Please link or switch to an account first.',
      show_alert: true,
    });
    return;
  }

  await safeAnswerCallback(bot, callbackQuery.id, {
    text: 'Checking Saved Messages...',
    show_alert: false,
  });

  try {
    const accountLinker = (await import('../services/accountLinker.js')).default;
    const client = await accountLinker.ensureConnected(accountId);
    
    if (!client) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '⚠️ <b>Account Connection Issue</b>\n\nYour account connection is temporarily unavailable.\n\n📝 <b>What to do:</b>\n• Wait a moment and try again\n• Make sure your account is properly linked\n• If the problem persists, try re-linking your account',
        { parse_mode: 'HTML', ...createBackButton() }
      );
      return;
    }

    // Get Saved Messages entity
    const me = await client.getMe();
    let savedMessagesEntity;
    try {
      savedMessagesEntity = await client.getEntity(me);
    } catch (error) {
      const dialogs = await client.getDialogs();
      const savedDialog = dialogs.find(d => d.isUser && d.name === 'Saved Messages');
      if (savedDialog) {
        savedMessagesEntity = savedDialog.entity;
      } else {
        throw new Error('Saved Messages not found');
      }
    }

    // Get the last message from Saved Messages
    const messages = await client.getMessages(savedMessagesEntity, { limit: 1 });
    if (!messages || messages.length === 0) {
      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        '❌ <b>No Message Found</b>\n\nPlease send your message to Saved Messages first, then try again.',
        { parse_mode: 'HTML', ...createBackButton() }
      );
      return;
    }

    const savedMessage = messages[0];
    const savedMessageId = savedMessage.id;

    // Extract message text and entities
    const messageText = savedMessage.text || '';
    let messageEntities = null;

    // Extract entities from the saved message
    if (savedMessage.entities && savedMessage.entities.length > 0) {
      messageEntities = savedMessage.entities.map(e => {
        let entityType = 'unknown';
        
        // Determine entity type from GramJS entity class
        if (e.className === 'MessageEntityCustomEmoji' || e.constructor?.name === 'MessageEntityCustomEmoji') {
          entityType = 'custom_emoji';
        } else if (e.className === 'MessageEntityBold' || e.constructor?.name === 'MessageEntityBold') {
          entityType = 'bold';
        } else if (e.className === 'MessageEntityItalic' || e.constructor?.name === 'MessageEntityItalic') {
          entityType = 'italic';
        } else if (e.className === 'MessageEntityCode' || e.constructor?.name === 'MessageEntityCode') {
          entityType = 'code';
        } else if (e.className === 'MessageEntityPre' || e.constructor?.name === 'MessageEntityPre') {
          entityType = 'pre';
        }

        const entity = {
          type: entityType,
          offset: e.offset,
          length: e.length,
        };

        // Preserve custom_emoji_id for premium emojis
        if (entityType === 'custom_emoji' && e.documentId !== undefined && e.documentId !== null) {
          entity.custom_emoji_id = String(e.documentId);
        }

        // Add language for pre entities
        if (entityType === 'pre' && e.language !== undefined) {
          entity.language = e.language;
        }

        return entity;
      });
    }

    // If saveAsMessage is true, save as the active message
    if (saveAsMessage) {
      // Deactivate existing messages
      await db.query(
        `UPDATE messages SET is_active = FALSE WHERE account_id = $1`,
        [accountId]
      );

      // Save new active message
      const result = await messageService.saveMessage(accountId, messageText, 'A', messageEntities);
      
      if (result.success) {
        // Update with saved_message_id
        await db.query(
          `UPDATE messages 
           SET saved_message_id = $1
           WHERE account_id = $2 AND is_active = TRUE AND variant = 'A'
           ORDER BY updated_at DESC LIMIT 1`,
          [savedMessageId, accountId]
        );

        const premiumEmojiCount = messageEntities ? messageEntities.filter(e => e.type === 'custom_emoji').length : 0;
        const previewText = messageText.length > 50 ? messageText.substring(0, 50) + '...' : messageText;

        let successMessage = `✅ <b>Broadcast Message Set!</b>\n\n`;
        successMessage += `Your message from Saved Messages has been set as the broadcast message.\n\n`;
        successMessage += `📝 <b>Preview:</b> ${escapeHtml(previewText)}\n`;
        if (premiumEmojiCount > 0) {
          successMessage += `🎨 <b>Premium Emojis:</b> ${premiumEmojiCount} found\n\n`;
        }
        successMessage += `✅ The bot will use the <b>last message</b> from Saved Messages when broadcasting.`;

        console.log(`[SET_MESSAGE] ✅ Message set from Saved Messages (ID: ${savedMessageId}, ${premiumEmojiCount} premium emojis)`);

        await safeEditMessage(
          bot,
          chatId,
          callbackQuery.message.message_id,
          successMessage,
          { parse_mode: 'HTML', ...await createMainMenu(userId) }
        );

        logger.logChange('MESSAGE_SET', userId, `Message set from Saved Messages (ID: ${savedMessageId})`);
      } else {
        throw new Error(result.error || 'Failed to save message');
      }
    } else {
      // Just update existing message with saved_message_id (for forward mode)
      await db.query(
        `UPDATE messages 
         SET saved_message_id = $1, message_text = $2, message_entities = $3
         WHERE account_id = $4 AND is_active = TRUE 
         ORDER BY updated_at DESC LIMIT 1`,
        [
          savedMessageId,
          messageText,
          messageEntities ? JSON.stringify(messageEntities) : null,
          accountId
        ]
      );

      const premiumEmojiCount = messageEntities ? messageEntities.filter(e => e.type === 'custom_emoji').length : 0;
      const previewText = messageText.length > 50 ? messageText.substring(0, 50) + '...' : messageText;

      let successMessage = `✅ <b>Message Updated!</b>\n\n`;
      successMessage += `Your message from Saved Messages has been linked.\n\n`;
      successMessage += `📝 <b>Preview:</b> ${escapeHtml(previewText)}\n`;
      successMessage += `🆔 <b>Message ID:</b> <code>${savedMessageId}</code>\n`;
      if (premiumEmojiCount > 0) {
        successMessage += `🎨 <b>Premium Emojis:</b> ${premiumEmojiCount} found\n\n`;
      }
      successMessage += `✅ Premium emojis will be preserved during broadcasts!`;

      console.log(`[CHECK_SAVED] ✅ Updated message with Saved Messages ID: ${savedMessageId} (${premiumEmojiCount} premium emojis)`);

      await safeEditMessage(
        bot,
        chatId,
        callbackQuery.message.message_id,
        successMessage,
        { parse_mode: 'HTML', ...await createMainMenu(userId) }
      );

      logger.logChange('CHECK_SAVED', userId, `Message from Saved Messages linked (ID: ${savedMessageId})`);
    }
  } catch (error) {
    console.log(`[CHECK_SAVED] Error: ${error.message}`);
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      `❌ <b>Error</b>\n\nFailed to check Saved Messages: ${error.message}`,
      { parse_mode: 'HTML', ...createBackButton() }
    );
  }
}

