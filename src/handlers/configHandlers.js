/**
 * Config Handlers
 * Handles configuration menu interactions
 */

import accountLinker from '../services/accountLinker.js';
import configService from '../services/configService.js';
import userService from '../services/userService.js';
import groupBlacklistService from '../services/groupBlacklistService.js';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { safeEditMessage, safeAnswerCallback } from '../utils/safeEdit.js';
import { sanitizeButtonText } from '../utils/textHelpers.js';
import { createConfigMenu, createQuietHoursKeyboard, createScheduleKeyboard, createMainMenu, createBackButton, createBackToGroupsButton, createGroupsMenu, createAutoReplyMenu, createIntervalMenu, createMessagesMenu } from './keyboardHandler.js';

/**
 * Create A/B mode keyboard for A/B testing configuration
 */
function createABModeKeyboard(abMode, abModeType) {
  const modeIcons = {
    single: abModeType === 'single' ? '●' : '○',
    rotate: abModeType === 'rotate' ? '●' : '○',
    split: abModeType === 'split' ? '●' : '○'
  };
  
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: `${modeIcons.single} Single`, callback_data: 'config_ab_single' },
          { text: `${modeIcons.rotate} Rotate`, callback_data: 'config_ab_rotate' }
        ],
        [
          { text: `${modeIcons.split} Split`, callback_data: 'config_ab_split' },
          { text: abMode ? '❌ Disable' : '✓ Disabled', callback_data: 'config_ab_disable' }
        ],
        [{ text: '🔙 Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}

// Helper function to show verification required (imported from commandHandler)
// Helper function to create channel buttons keyboard
function createChannelButtonsKeyboard(channelUsernames) {
  // Handle both single string (backward compatibility) and array
  const channels = Array.isArray(channelUsernames) ? channelUsernames : [channelUsernames];
  
  // Create buttons: Verify button on first row, then one button per channel
  const keyboard = [
    [{ text: '✅ Verify', callback_data: 'btn_verify_channel' }]
  ];
  
  // Add one button per channel
  for (const channelUsername of channels) {
    keyboard.push([{ text: `📢 Join @${channelUsername}`, url: `https://t.me/${channelUsername}` }]);
  }
  
  return keyboard;
}

async function showVerificationRequired(bot, chatId, channelUsernames) {
  // Handle both single string (backward compatibility) and array
  const channels = Array.isArray(channelUsernames) ? channelUsernames : [channelUsernames];
  
  // Build channel list text
  const channelList = channels.map(ch => `📢 @${ch}`).join('\n');
  
  const verificationMessage = `
🔐 <b>Channel Verification Required</b>

To use this bot, you must join our updates channel(s) first.

${channelList}

After joining, click the "✅ Verify" button below.
  `;
  
  return await bot.sendMessage(chatId, verificationMessage, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: createChannelButtonsKeyboard(channels)
    }
  });
}

export async function handleConfigButton(bot, callbackQuery) {
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

  // Get settings and accounts in PARALLEL
  const [settings, accounts] = await Promise.all([
    configService.getAccountSettings(accountId).catch(() => null),
    accountLinker.getAccounts(userId)
  ]);

  const currentInterval = settings?.manualInterval || 11;
  const quietHours = settings?.quietStart && settings?.quietEnd 
    ? { start: settings.quietStart, end: settings.quietEnd }
    : null;

  const account = accounts.find(a => a.accountId === accountId);
  const accountName = account?.firstName || account?.phone || 'Unknown';

  // Build clean settings list
  let settingsList = [];
  settingsList.push(`⏱️ Interval: <b>${currentInterval} min</b>`);
  settingsList.push(`🌙 Quiet Hours: ${quietHours ? `<b>${quietHours.start} - ${quietHours.end}</b>` : '<i>Not set</i>'}`);
  settingsList.push(`📚 Pool: ${settings?.useMessagePool ? '<b>ON</b>' : '<i>OFF</i>'}`);
  const dmReplyLabel = settings?.autoReplyDmEnabled
    ? (settings?.autoReplyNativeMode ? '<b>ON</b> (Native)' : '<b>ON</b> (Fallback)')
    : '<i>OFF</i>';
  settingsList.push(`💬 DM Reply: ${dmReplyLabel}`);
  settingsList.push(`👥 Group Reply: ${settings?.autoReplyGroupsEnabled ? '<b>ON</b>' : '<i>OFF</i>'}`);

  const configMessage = `<b>⚙️ SETTINGS</b>
━━━━━━━━━━━━━━━━━━━━━

👤 ${accountName}

${settingsList.join('\n')}`;

  await safeEditMessage(bot, chatId, callbackQuery.message.message_id, configMessage, { parse_mode: 'HTML', ...createConfigMenu(currentInterval, quietHours) });
  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId };
}

/**
 * Handle interval menu (combined Broadcast and Auto Reply intervals)
 */
export async function handleIntervalMenu(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Interval Menu', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const broadcastInterval = settings?.manualInterval || 11;
  const autoReplyInterval = settings?.autoReplyCheckInterval || 0;

  let menuMessage = `⏱️ <b>Interval Settings</b>\n\n`;
  menuMessage += `Configure timing intervals for broadcasts and auto replies.\n\n`;
  menuMessage += `📡 <b>Broadcast Interval:</b> ${broadcastInterval} minutes\n`;
  menuMessage += `💬 <b>Auto Reply Interval:</b> ${autoReplyInterval > 0 ? `${autoReplyInterval} seconds` : 'Real-time (instant)'}\n\n`;
  menuMessage += `Select an option below to configure:`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    menuMessage,
    { parse_mode: 'HTML', ...createIntervalMenu() }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

/**
 * Handle custom interval configuration
 */
export async function handleConfigCustomInterval(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config Custom Interval', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const currentInterval = settings?.manualInterval || 11; // Default 11 minutes

  const intervalMessage = `⏱️ <b>Broadcast Interval</b>\n\n` +
    `Set the time between each broadcast cycle (minimum: 11 minutes).\n\n` +
    `<b>Current interval:</b> ${currentInterval} minutes\n\n` +
    `Please enter the interval in minutes (e.g., 15, 30, 60):`;

  const backKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Interval', callback_data: 'btn_config_interval_menu' }],
      ],
    },
  };

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    intervalMessage,
    { parse_mode: 'HTML', ...backKeyboard }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId, messageId: callbackQuery.message.message_id }; // Return accountId and messageId for pending state
}

/**
 * Helper to create back to interval button
 */
function createBackToIntervalButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Interval', callback_data: 'btn_config_interval_menu' }],
      ],
    },
  };
}

/**
 * Handle custom interval input
 */
export async function handleCustomIntervalInput(bot, msg, accountId, messageId = null) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Delete user's input message
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (e) { /* Ignore deletion errors */ }

  const text = msg.text?.trim();
  
  // Helper to edit or send message
  const editOrSend = async (content, options) => {
    if (messageId) {
      try {
        await safeEditMessage(bot, chatId, messageId, content, options);
        return;
      } catch (e) { /* Fall back to send */ }
    }
    const sent = await bot.sendMessage(chatId, content, options);
    return sent.message_id;
  };
  
  if (!text) {
    await editOrSend(
      `⏱️ <b>Broadcast Interval</b>\n\nPlease enter the interval in minutes (minimum: 11 minutes).\n\nExample: 15, 30, 60\n\nSend your interval now:`,
      { parse_mode: 'HTML', ...createBackToIntervalButton() }
    );
    return false; // Keep pending state
  }

  // Parse interval (must be a valid number)
  const intervalMinutes = parseInt(text, 10);
  
  if (isNaN(intervalMinutes) || intervalMinutes < 11) {
    await editOrSend(
      `❌ Invalid interval. Please enter a number that is at least 11 minutes.\n\nExample: 15, 30, 60\n\nTry again:`,
      { parse_mode: 'HTML', ...createBackToIntervalButton() }
    );
    console.log(`[CUSTOM_INTERVAL] User ${userId} entered invalid interval: ${text}`);
    return false; // Keep pending state so user can retry
  }

  // Validate maximum (reasonable limit, e.g., 1440 minutes = 24 hours)
  const maxIntervalMinutes = 1440;
  if (intervalMinutes > maxIntervalMinutes) {
    await editOrSend(
      `❌ Interval too large. Maximum is ${maxIntervalMinutes} minutes (24 hours).\n\nPlease enter a smaller value:`,
      { parse_mode: 'HTML', ...createBackToIntervalButton() }
    );
    console.log(`[CUSTOM_INTERVAL] User ${userId} entered interval too large: ${intervalMinutes} minutes`);
    return false; // Keep pending state so user can retry
  }

  logger.logChange('CONFIG', userId, `Custom interval set to ${intervalMinutes} minutes`);
  const result = await configService.setCustomInterval(accountId, intervalMinutes);
  
  if (result.success) {
    await editOrSend(
      `✅ <b>Broadcast Interval Set!</b>\n\n⏱️ <b>Interval:</b> ${intervalMinutes} minutes\n\nYour broadcasts will run every ${intervalMinutes} minutes.\n\nNote: If a broadcast is currently running, the new interval will take effect on the next cycle.`,
      { parse_mode: 'HTML', ...createIntervalMenu() }
    );
    console.log(`[CUSTOM_INTERVAL] User ${userId} successfully set interval to ${intervalMinutes} minutes`);
    return true; // Success - clear pending state
  } else {
    const errorMessage = `❌ <b>Failed to Set Broadcast Interval</b>\n\n<b>Error:</b> ${result.error}\n\n`;
    
    await editOrSend(
      errorMessage,
      { parse_mode: 'HTML', ...createBackToIntervalButton() }
    );
    console.log(`[CUSTOM_INTERVAL] User ${userId} failed to set interval: ${result.error}`);
    return false; // Keep pending state so user can retry
  }
}

/**
 * Handle group delay configuration button
 */
export async function handleConfigGroupDelay(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config Group Delay', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const currentMin = settings?.groupDelayMin;
  const currentMax = settings?.groupDelayMax;
  const currentText = currentMin !== null && currentMax !== null
    ? `${currentMin}-${currentMax} seconds`
    : 'Default (5-10 seconds)';

  const delayMessage = `⏳ <b>Group Delay Configuration</b>\n\n` +
    `Set the delay between sending messages to different groups (in seconds).\n\n` +
    `<b>Current delay:</b> ${currentText}\n\n` +
    `Please enter the delay range in format: <code>min-max</code>\n\n` +
    `Examples:\n` +
    `• <code>5-10</code> for 5 to 10 seconds\n` +
    `• <code>3-7</code> for 3 to 7 seconds\n` +
    `• <code>default</code> to use default (5-10 seconds)\n\n` +
    `Minimum: 1 second, Maximum: 300 seconds`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    delayMessage,
    { parse_mode: 'HTML', ...createBackToIntervalButton() }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId, messageId: callbackQuery.message.message_id }; // Return accountId and messageId for pending state
}

/**
 * Handle group delay input
 */
export async function handleGroupDelayInput(bot, msg, accountId, messageId = null) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Delete user's input message
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (e) { /* Ignore deletion errors */ }

  const text = msg.text?.trim().toLowerCase();
  
  // Helper to edit or send message
  const editOrSend = async (content, options) => {
    if (messageId) {
      try {
        await safeEditMessage(bot, chatId, messageId, content, options);
        return;
      } catch (e) { /* Fall back to send */ }
    }
    const sent = await bot.sendMessage(chatId, content, options);
    return sent.message_id;
  };
  
  if (!text) {
    await editOrSend(
      `⏳ <b>Group Delay Configuration</b>\n\nPlease enter the delay range in format: <code>min-max</code>\n\nExamples:\n• <code>5-10</code> for 5 to 10 seconds\n• <code>default</code> to use default\n\nSend your delay range now:`,
      { parse_mode: 'HTML', ...createBackToIntervalButton() }
    );
    return false; // Keep pending state
  }

  // Handle "default" to reset
  if (text === 'default') {
    const result = await configService.setGroupDelay(accountId, null, null);
    
    if (result.success) {
      await editOrSend(
        `✅ <b>Group Delay Reset to Default</b>\n\n⏳ Using default delay: 5-10 seconds`,
        { parse_mode: 'HTML', ...createIntervalMenu() }
      );
      logger.logChange('CONFIG', userId, 'Group delay reset to default');
      return true; // Success - clear pending state
    } else {
      await editOrSend(
        `❌ <b>Failed to Reset Delay</b>\n\n<b>Error:</b> ${result.error}\n\nTry again:`,
        { parse_mode: 'HTML', ...createBackToIntervalButton() }
      );
      return false; // Keep pending state
    }
  }

  // Parse delay range (format: min-max)
  const rangeMatch = text.match(/^(\d+)-(\d+)$/);
  if (!rangeMatch) {
    await editOrSend(
      `❌ Invalid format. Please use format: <code>min-max</code>\n\nExamples:\n• <code>5-10</code> for 5 to 10 seconds\n• <code>3-7</code> for 3 to 7 seconds\n\nTry again:`,
      { parse_mode: 'HTML', ...createBackToIntervalButton() }
    );
    return false; // Keep pending state
  }

  const minSeconds = parseInt(rangeMatch[1], 10);
  const maxSeconds = parseInt(rangeMatch[2], 10);

  if (isNaN(minSeconds) || isNaN(maxSeconds) || minSeconds < 1 || maxSeconds < 1) {
    await editOrSend(
      `❌ Invalid values. Minimum and maximum must be at least 1 second.\n\nTry again:`,
      { parse_mode: 'HTML', ...createBackToIntervalButton() }
    );
    return false; // Keep pending state
  }

  if (minSeconds > maxSeconds) {
    await editOrSend(
      `❌ Invalid range. Minimum (${minSeconds}) cannot be greater than maximum (${maxSeconds}).\n\nTry again:`,
      { parse_mode: 'HTML', ...createBackToIntervalButton() }
    );
    return false; // Keep pending state
  }

  if (minSeconds > 300 || maxSeconds > 300) {
    await editOrSend(
      `❌ Values too large. Maximum delay is 300 seconds (5 minutes).\n\nTry again:`,
      { parse_mode: 'HTML', ...createBackToIntervalButton() }
    );
    return false; // Keep pending state
  }

  logger.logChange('CONFIG', userId, `Group delay set to ${minSeconds}-${maxSeconds} seconds`);
  const result = await configService.setGroupDelay(accountId, minSeconds, maxSeconds);
  
  if (result.success) {
    await editOrSend(
      `✅ <b>Group Delay Set Successfully!</b>\n\n⏳ <b>Delay Range:</b> ${minSeconds}-${maxSeconds} seconds\n\nMessages will wait a random delay between ${minSeconds} and ${maxSeconds} seconds before sending to the next group.`,
      { parse_mode: 'HTML', ...createIntervalMenu() }
    );
    console.log(`[GROUP_DELAY] User ${userId} successfully set delay to ${minSeconds}-${maxSeconds} seconds`);
    return true; // Success - clear pending state
  } else {
    await editOrSend(
      `❌ <b>Failed to Set Delay</b>\n\n<b>Error:</b> ${result.error}\n\nTry again:`,
      { parse_mode: 'HTML', ...createBackToIntervalButton() }
    );
    console.log(`[GROUP_DELAY] User ${userId} failed to set delay: ${result.error}`);
    return false; // Keep pending state
  }
}

/**
 * Handle forward mode toggle
 */
export async function handleConfigForwardMode(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config Forward Mode', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const currentForwardMode = settings?.forwardMode || false;
  const newForwardMode = !currentForwardMode;

  const result = await configService.setForwardMode(accountId, newForwardMode);

  if (result.success) {
    // Refresh messages menu (forward mode is now in messages menu)
    const { handleMessagesMenu } = await import('./commandHandler.js');
    await handleMessagesMenu(bot, callbackQuery);
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `Forward mode ${newForwardMode ? 'enabled' : 'disabled'}`,
      show_alert: false,
    });
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `Failed to update forward mode: ${result.error}`,
      show_alert: true,
    });
  }
}

export async function handleConfigDailyCap(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config Daily Cap', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return null;
  }

  const settings = await configService.getAccountSettings(accountId);
  const currentCap = settings?.dailyCap || 999999;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    `📊 <b>Daily Message Counter</b>\n\n` +
    `Current display cap: <b>${currentCap}</b> messages/day\n\n` +
    `⚠️ <i>Note: Daily cap enforcement has been removed. This setting is for display purposes only.</i>\n\n` +
    `Please send a number (minimum 1) to set the daily counter display cap.\n` +
    `The counter resets at midnight IST.\n\n` +
    `Example: Send <code>100</code> to set display cap to 100 messages/day.`,
    { parse_mode: 'HTML', ...createBackButton() }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
  return accountId; // Return accountId for state management
}

export async function handleDailyCapInput(bot, msg, accountId, cap) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const result = await configService.setDailyCap(accountId, cap);
  
  if (result.success) {
    logger.logSuccess('CONFIG', userId, `Daily cap set to ${cap} (display only)`);
    await bot.sendMessage(
      chatId,
      `✅ Daily counter display cap set to <b>${cap}</b> messages/day\n\n⚠️ <i>Note: Daily cap enforcement has been removed. This is for display purposes only.</i>\n\nThe counter resets at midnight IST.`,
      { parse_mode: 'HTML', ...createMainMenu() }
    );
  } else {
    await bot.sendMessage(
      chatId,
      `❌ Error: ${result.error}\n\nPlease try again.`,
      createBackButton()
    );
  }
}

export async function handleConfigQuietHours(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config Quiet Hours', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const quietHours = settings?.quietStart && settings?.quietEnd 
    ? `${settings.quietStart} - ${settings.quietEnd}`
    : 'Not set';

  const quietHoursText = quietHours !== 'Not set'
    ? `⏰ <b>Quiet Hours</b>\n\n` +
      `Current: <b>${quietHours}</b> IST\n\n` +
      `During quiet hours, broadcasting will be paused.\n\n` +
      `Use the buttons below to modify or clear quiet hours.`
    : `⏰ <b>Quiet Hours</b>\n\n` +
      `Current: <b>Not set</b>\n\n` +
      `Broadcasting is active 24/7.\n\n` +
      `Set quiet hours to pause broadcasting during specific time windows (e.g., 10 PM - 6 AM).`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    quietHoursText,
    { parse_mode: 'HTML', ...createQuietHoursKeyboard() }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

/**
 * Helper to create back to config button
 */
function createBackToConfigButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}

/**
 * Helper to create back to quiet hours button
 */
function createBackToQuietHoursButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Quiet Hours', callback_data: 'btn_config_quiet_hours' }],
      ],
    },
  };
}

export async function handleQuietHoursSet(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Set Quiet Hours', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return null;
  }

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    `🌙 <b>Set Quiet Hours</b>\n\n` +
    `Please send the quiet hours in the following format:\n\n` +
    `<code>HH:MM - HH:MM</code>\n\n` +
    `Example: <code>22:00 - 06:00</code> (10 PM to 6 AM)\n` +
    `Example: <code>09:00 - 17:00</code> (9 AM to 5 PM)\n\n` +
    `Times are in IST (Indian Standard Time).\n` +
    `Use 24-hour format.\n\n` +
    `During quiet hours, broadcasting will be paused.`,
    { parse_mode: 'HTML', ...createBackToQuietHoursButton() }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId, messageId: callbackQuery.message.message_id };
}

export async function handleQuietHoursView(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'View Quiet Hours', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const quietHours = settings?.quietStart && settings?.quietEnd 
    ? `${settings.quietStart} - ${settings.quietEnd}`
    : null;
  
  if (!quietHours) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No quiet hours are currently set',
      show_alert: true,
    });
    await handleConfigQuietHours(bot, callbackQuery);
    return;
  }

  const isWithinQuietHours = await configService.isWithinQuietHours(accountId);
  const statusEmoji = isWithinQuietHours ? '⏸️' : '✅';
  const statusText = isWithinQuietHours ? 'Active (broadcasting paused)' : 'Inactive (broadcasting allowed)';

  const viewMessage = `📋 <b>Quiet Hours Details</b>\n\n` +
    `⏰ Time Window: <b>${quietHours}</b> IST\n` +
    `📊 Status: ${statusEmoji} <b>${statusText}</b>\n\n` +
    `Broadcasting will be paused during quiet hours.`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    viewMessage,
    { parse_mode: 'HTML', ...createQuietHoursKeyboard() }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleQuietHoursClear(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) return;
  
  const result = await configService.setQuietHours(accountId, null, null);
  if (result.success) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '✅ Quiet hours cleared',
      show_alert: true,
    });
    await handleConfigQuietHours(bot, callbackQuery);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `Error: ${result.error}`,
      show_alert: true,
    });
  }
}

export async function handleQuietHoursInput(bot, msg, accountId, messageId = null) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Delete user's input message
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (e) { /* Ignore deletion errors */ }

  const text = msg.text?.trim();
  
  // Helper to edit or send message
  const editOrSend = async (content, options) => {
    if (messageId) {
      try {
        await safeEditMessage(bot, chatId, messageId, content, options);
        return;
      } catch (e) { /* Fall back to send */ }
    }
    const sent = await bot.sendMessage(chatId, content, options);
    return sent.message_id;
  };
  
  if (!text) {
    await editOrSend(
      'Please send the quiet hours in format: <code>HH:MM - HH:MM</code>\n\nExample: <code>22:00 - 06:00</code>',
      { parse_mode: 'HTML', ...createBackToQuietHoursButton() }
    );
    return;
  }

  // Parse quiet hours format: "HH:MM - HH:MM"
  const quietHoursRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]\s*-\s*([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  const match = text.match(quietHoursRegex);
  
  if (!match) {
    await editOrSend(
      '❌ Invalid format. Please use: <code>HH:MM - HH:MM</code>\n\n' +
      'Example: <code>22:00 - 06:00</code> (10 PM to 6 AM)\n' +
      'Example: <code>09:00 - 17:00</code> (9 AM to 5 PM)',
      { parse_mode: 'HTML', ...createBackToQuietHoursButton() }
    );
    return;
  }

  // Extract full time strings from the input (match[1] and match[2] are just hours, need full time)
  const times = text.split(/\s*-\s*/);
  if (times.length !== 2) {
    await editOrSend(
      '❌ Invalid format. Please use: <code>HH:MM - HH:MM</code>\n\nExample: <code>22:00 - 06:00</code>',
      { parse_mode: 'HTML', ...createBackToQuietHoursButton() }
    );
    return;
  }

  const startTime = times[0].trim();
  const endTime = times[1].trim();

  try {
    const result = await configService.setQuietHours(accountId, startTime, endTime);
    
    if (result.success) {
      logger.logSuccess('CONFIG', userId, `Quiet hours set: ${startTime} - ${endTime} IST`);
      await editOrSend(
        `✅ <b>Quiet Hours Set Successfully!</b>\n\n` +
        `🌙 <b>Time Window:</b> ${startTime} - ${endTime} IST\n` +
        `📊 <b>Status:</b> Active\n\n` +
        `💡 Broadcasting will be automatically paused during these hours.`,
        { parse_mode: 'HTML', ...createQuietHoursKeyboard() }
      );
    } else {
      await editOrSend(
        `❌ Error: ${result.error || 'Failed to set quiet hours'}\n\nPlease try again.`,
        { parse_mode: 'HTML', ...createBackToQuietHoursButton() }
      );
    }
  } catch (error) {
    logger.logError('CONFIG', userId, error, 'Failed to handle quiet hours input');
    await editOrSend(
      `❌ An unexpected error occurred: ${error.message}\n\nPlease try again.`,
      { parse_mode: 'HTML', ...createBackToQuietHoursButton() }
    );
  }
}

export async function handleConfigAB(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config A/B Testing', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const abMode = settings?.abMode || false;
  const abModeType = settings?.abModeType || 'single';

  const abMessage = `🔄 <b>A/B Testing</b>\n\n` +
    `Current: <b>${abMode ? abModeType.charAt(0).toUpperCase() + abModeType.slice(1) : 'Disabled'}</b>\n\n` +
    `• <b>Single</b> - Use variant A only\n` +
    `• <b>Rotate</b> - Alternate between A and B\n` +
    `• <b>Split</b> - Random 50/50 split\n` +
    `• <b>Disable</b> - Turn off A/B testing\n\n` +
    `Note: You need to set A and B messages first using "Set Message" menu.`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    abMessage,
    { parse_mode: 'HTML', ...createABModeKeyboard(abMode, abModeType) }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleConfigABMode(bot, callbackQuery, mode) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, `Config A/B Mode: ${mode}`, chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  if (mode === 'disable') {
    const result = await configService.setABMode(accountId, false);
    if (result.success) {
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: '✅ A/B testing disabled',
        show_alert: true,
      });
      await handleConfigAB(bot, callbackQuery);
    } else {
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: `Error: ${result.error}`,
        show_alert: true,
      });
    }
  } else {
    const result = await configService.setABMode(accountId, true, mode);
    if (result.success) {
      const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: `✅ A/B testing enabled (${modeLabel})`,
        show_alert: true,
      });
      await handleConfigAB(bot, callbackQuery);
    } else {
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: `Error: ${result.error}`,
        show_alert: true,
      });
    }
  }
}

export async function handleConfigMention(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Mentions', chatId);

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
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const autoMention = settings?.autoMention || false;
  // Ensure mentionCount is valid (1, 3, or 5), default to 5
  let mentionCount = settings?.mentionCount || 5;
  if (![1, 3, 5].includes(mentionCount)) {
    mentionCount = 5; // Default to 5 if invalid
  }

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    `👥 <b>Auto-Mention Settings</b>\n\n` +
    `Current: <b>${autoMention ? 'Enabled' : 'Disabled'}</b>\n` +
    `Mention Count: <b>${mentionCount}</b> users\n\n` +
    `When enabled, each message will automatically mention the most active users in the group.\n\n` +
    `Select an option:`,
    {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: autoMention ? '✅ Enabled' : 'Enable', callback_data: 'config_mention_enable' },
            { text: !autoMention ? '✅ Disabled' : 'Disable', callback_data: 'config_mention_disable' }
          ],
          [
            { text: '1 user', callback_data: 'config_mention_count_1' },
            { text: '3 users', callback_data: 'config_mention_count_3' },
            { text: '5 users', callback_data: 'config_mention_count_5' }
          ],
          [{ text: '◀️ Back to Menu', callback_data: 'btn_main_menu' }],
        ],
      },
    }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleConfigMentionToggle(bot, callbackQuery, enabled) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) return;

  const settings = await configService.getAccountSettings(accountId);
  // Ensure mentionCount is valid (1, 3, or 5), default to 5
  let mentionCount = settings?.mentionCount || 5;
  if (![1, 3, 5].includes(mentionCount)) {
    mentionCount = 5; // Default to 5 if invalid
  }

  const result = await configService.setAutoMention(accountId, enabled, mentionCount);
  
  if (result.success) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `✅ Auto-mention ${enabled ? 'enabled' : 'disabled'}`,
      show_alert: true,
    });
    await handleConfigMention(bot, callbackQuery);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `Error: ${result.error}`,
      show_alert: true,
    });
  }
}

export async function handleConfigMentionCount(bot, callbackQuery, count) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  // Validate count - only allow 1, 3, or 5
  const validCounts = [1, 3, 5];
  if (!validCounts.includes(count)) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'Invalid mention count. Only 1, 3, or 5 users are allowed.',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const enabled = settings?.autoMention || false;

  console.log(`[MENTION] Setting mention count to ${count} for account ${accountId}`);
  const result = await configService.setAutoMention(accountId, enabled, count);
  
  if (result.success) {
    console.log(`[MENTION] ✅ Successfully set mention count to ${count} for account ${accountId}`);
    logger.logChange('MENTION_COUNT', userId, `Mention count set to ${count} for account ${accountId}`);
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `✅ Mention count set to ${count} user${count > 1 ? 's' : ''}`,
      show_alert: true,
    });
    // Refresh the mention menu to show updated count
    await handleConfigMention(bot, callbackQuery);
  } else {
    console.log(`[MENTION] ❌ Failed to set mention count: ${result.error}`);
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `❌ Error: ${result.error}`,
      show_alert: true,
    });
  }
}

export async function handleConfigSchedule(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config Schedule', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const schedule = await configService.getSchedule(accountId);
  const scheduleText = schedule
    ? `⏰ <b>Schedule Settings</b>\n\n` +
      `Current Schedule: <b>${schedule.startTime} - ${schedule.endTime}</b> IST\n` +
      `Interval: <b>${schedule.minInterval}-${schedule.maxInterval} minutes</b>\n\n` +
      `Broadcasting will only be active during this time window.\n\n` +
      `Use the buttons below to modify or clear the schedule.`
    : `⏰ <b>Schedule Settings</b>\n\n` +
      `Current Schedule: <b>Not set</b>\n\n` +
      `Broadcasting is active 24/7.\n\n` +
      `Set a schedule to limit broadcasting to specific time windows (e.g., 9 AM - 5 PM).`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    scheduleText,
    { parse_mode: 'HTML', ...createScheduleKeyboard() }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

/**
 * Helper to create back to schedule button
 */
function createBackToScheduleButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Schedule', callback_data: 'btn_config_schedule' }],
      ],
    },
  };
}

export async function handleScheduleSet(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Set Schedule', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return null;
  }

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    `⏰ <b>Set Schedule</b>\n\n` +
    `Please send the schedule in the following format:\n\n` +
    `<code>HH:MM - HH:MM</code>\n\n` +
    `Example: <code>09:00 - 17:00</code> (9 AM to 5 PM)\n` +
    `Example: <code>22:00 - 06:00</code> (10 PM to 6 AM, spans midnight)\n\n` +
    `Times are in IST (Indian Standard Time).\n` +
    `Use 24-hour format.`,
    { parse_mode: 'HTML', ...createBackToScheduleButton() }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId, messageId: callbackQuery.message.message_id };
}

export async function handleScheduleView(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'View Schedule', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const schedule = await configService.getSchedule(accountId);
  
  if (!schedule) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No schedule is currently set',
      show_alert: true,
    });
    await handleConfigSchedule(bot, callbackQuery);
    return;
  }

  const isWithinSchedule = await configService.isWithinSchedule(accountId);
  const statusEmoji = isWithinSchedule ? '✅' : '⏸️';
  const statusText = isWithinSchedule ? 'Active' : 'Inactive (outside schedule window)';

  const viewMessage = `📋 <b>Schedule Details</b>\n\n` +
    `⏰ Time Window: <b>${schedule.startTime} - ${schedule.endTime}</b> IST\n` +
    `⏱️ Interval: <b>${schedule.minInterval}-${schedule.maxInterval} minutes</b>\n` +
    `📊 Status: ${statusEmoji} <b>${statusText}</b>\n\n` +
    `Broadcasting will only occur during the scheduled time window.`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    viewMessage,
    { parse_mode: 'HTML', ...createScheduleKeyboard() }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleScheduleClear(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Clear Schedule', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const result = await configService.clearSchedule(accountId);
  
  if (result.success) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '✅ Schedule cleared. Broadcasting is now active 24/7.',
      show_alert: true,
    });
    await handleConfigSchedule(bot, callbackQuery);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `Error: ${result.error}`,
      show_alert: true,
    });
  }
}

export async function handleScheduleInput(bot, msg, accountId, messageId = null) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Delete user's input message
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (e) { /* Ignore deletion errors */ }

  const text = msg.text?.trim();
  
  // Helper to edit or send message
  const editOrSend = async (content, options) => {
    if (messageId) {
      try {
        await safeEditMessage(bot, chatId, messageId, content, options);
        return;
      } catch (e) { /* Fall back to send */ }
    }
    const sent = await bot.sendMessage(chatId, content, options);
    return sent.message_id;
  };
  
  if (!text) {
    await editOrSend(
      'Please send the schedule in format: <code>HH:MM - HH:MM</code>\n\nExample: <code>09:00 - 17:00</code>',
      { parse_mode: 'HTML', ...createBackToScheduleButton() }
    );
    return;
  }

  // Parse schedule format: "HH:MM - HH:MM"
  const scheduleRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]\s*-\s*([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  const match = text.match(scheduleRegex);
  
  if (!match) {
    await editOrSend(
      '❌ Invalid format. Please use: <code>HH:MM - HH:MM</code>\n\n' +
      'Example: <code>09:00 - 17:00</code> (9 AM to 5 PM)\n' +
      'Example: <code>22:00 - 06:00</code> (10 PM to 6 AM)',
      { parse_mode: 'HTML', ...createBackToScheduleButton() }
    );
    return;
  }

  // Extract full time strings from the input (match[1] and match[2] are just hours, need full time)
  const times = text.split(/\s*-\s*/);
  if (times.length !== 2) {
    await editOrSend(
      '❌ Invalid format. Please use: <code>HH:MM - HH:MM</code>\n\nExample: <code>09:00 - 17:00</code>',
      { parse_mode: 'HTML', ...createBackToScheduleButton() }
    );
    return;
  }

  const startTime = times[0].trim();
  const endTime = times[1].trim();

  try {
    const result = await configService.setSchedule(accountId, startTime, endTime);
    
    if (result.success) {
      logger.logSuccess('CONFIG', userId, `Schedule set: ${startTime} - ${endTime} IST`);
      await editOrSend(
        `✅ <b>Schedule Set Successfully!</b>\n\n` +
        `⏰ <b>Time Window:</b> ${startTime} - ${endTime} IST\n` +
        `📊 <b>Status:</b> Active\n\n` +
        `💡 Broadcasting will only occur during this time window. You can start broadcasts anytime, but messages will only be sent during the schedule.`,
        { parse_mode: 'HTML', ...createScheduleKeyboard() }
      );
    } else {
      await editOrSend(
        `❌ Error: ${result.error || 'Failed to set schedule'}\n\nPlease try again.`,
        { parse_mode: 'HTML', ...createBackToScheduleButton() }
      );
    }
  } catch (error) {
    logger.logError('CONFIG', userId, error, 'Failed to handle schedule input');
    await editOrSend(
      `❌ An unexpected error occurred: ${error.message}\n\nPlease try again.`,
      { parse_mode: 'HTML', ...createBackToScheduleButton() }
    );
  }
}

/**
 * Handle group blacklist button
 */
export async function handleConfigGroupBlacklist(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config Group Blacklist', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const blacklisted = await groupBlacklistService.getBlacklistedGroups(accountId);
  const blacklistCount = blacklisted.groups?.length || 0;

  let message = `🚫 <b>Group Blacklist</b>\n\n`;
  message += `Blacklisted groups: <b>${blacklistCount}</b>\n\n`;
  message += `Search for groups by keyword to add them to the blacklist.\n`;
  message += `Blacklisted groups will be excluded from broadcasts.`;

  const keyboard = {
    inline_keyboard: [
      [{ text: '🔍 Search Groups', callback_data: 'btn_blacklist_search' }],
      blacklistCount > 0 ? [{ text: '📋 View Blacklist', callback_data: 'btn_blacklist_view' }] : [],
      [{ text: '🔙 Back to Groups', callback_data: 'btn_groups' }],
    ],
  };

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    message,
    { parse_mode: 'HTML', reply_markup: keyboard }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId };
}

/**
 * Handle blacklist search button
 */
export async function handleBlacklistSearch(bot, callbackQuery) {
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

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    '🔍 <b>Search Groups</b>\n\nEnter a keyword to search for groups:',
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Blacklist', callback_data: 'btn_config_blacklist' }]] } }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId, messageId: callbackQuery.message.message_id };
}

/**
 * Handle blacklist search input
 */
export async function handleBlacklistSearchInput(bot, msg, accountId, messageId = null) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Delete user's input message
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (e) { /* Ignore deletion errors */ }

  const keyword = msg.text?.trim();
  
  // Helper to edit or send message
  const editOrSend = async (content, options) => {
    if (messageId) {
      try {
        await safeEditMessage(bot, chatId, messageId, content, options);
        return;
      } catch (e) { /* Fall back to send */ }
    }
    const sent = await bot.sendMessage(chatId, content, options);
    return sent.message_id;
  };
  
  const backButton = { reply_markup: { inline_keyboard: [[{ text: '🔙 Back to Blacklist', callback_data: 'btn_config_blacklist' }]] } };
  
  if (!keyword || keyword.length < 2) {
    await editOrSend(
      '❌ Please enter at least 2 characters to search.',
      { parse_mode: 'HTML', ...backButton }
    );
    return false;
  }

  const result = await groupBlacklistService.searchGroups(accountId, keyword);
  
  if (!result.success || result.groups.length === 0) {
    await editOrSend(
      `❌ No groups found matching "${keyword}"\n\nTry a different keyword.`,
      { parse_mode: 'HTML', ...backButton }
    );
    return false;
  }

  // Create buttons for each group (max 10)
  const groups = result.groups.slice(0, 10);
  const keyboard = {
    inline_keyboard: groups.map(group => [
      { 
        text: sanitizeButtonText(group.group_title || `Group ${group.group_id}`), 
        callback_data: `blacklist_add_${group.group_id}` 
      }
    ]).concat([
      [{ text: '🔙 Back', callback_data: 'btn_config_blacklist' }]
    ]),
  };

  await editOrSend(
    `🔍 <b>Search Results</b>\n\nFound <b>${groups.length}</b> group(s) matching "${keyword}":\n\nSelect a group to add to blacklist:`,
    { parse_mode: 'HTML', reply_markup: keyboard }
  );
  return true;
}

/**
 * Handle add to blacklist
 */
export async function handleBlacklistAdd(bot, callbackQuery, groupId) {
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

  const result = await groupBlacklistService.addToBlacklist(accountId, groupId);
  
  if (result.success) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `✅ Added "${result.groupTitle}" to blacklist`,
      show_alert: true,
    });
    
    // Refresh blacklist view
    await handleConfigGroupBlacklist(bot, callbackQuery);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: result.error || 'Failed to add to blacklist',
      show_alert: true,
    });
  }
}

/**
 * Handle view blacklist
 */
export async function handleBlacklistView(bot, callbackQuery) {
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

  const result = await groupBlacklistService.getBlacklistedGroups(accountId);
  
  if (!result.success || result.groups.length === 0) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No groups in blacklist',
      show_alert: true,
    });
    return;
  }

  const groups = result.groups;
  const keyboard = {
    inline_keyboard: groups.map(group => [
      { 
        text: `❌ ${sanitizeButtonText(group.group_title || `Group ${group.group_id}`)}`, 
        callback_data: `blacklist_remove_${group.group_id}` 
      }
    ]).concat([
      [{ text: '🔙 Back', callback_data: 'btn_config_blacklist' }]
    ]),
  };

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    `📋 <b>Blacklisted Groups</b>\n\nTotal: <b>${groups.length}</b>\n\nClick to remove from blacklist:`,
    { parse_mode: 'HTML', reply_markup: keyboard }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

/**
 * Handle remove from blacklist
 */
export async function handleBlacklistRemove(bot, callbackQuery, groupId) {
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

  const result = await groupBlacklistService.removeFromBlacklist(accountId, groupId);
  
  if (result.success) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: '✅ Removed from blacklist',
      show_alert: true,
    });
    
    // Refresh blacklist view
    await handleBlacklistView(bot, callbackQuery);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: result.error || 'Failed to remove from blacklist',
      show_alert: true,
    });
  }
}

/**
 * Handle auto reply DM configuration
 */
export async function handleConfigAutoReplyDm(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config Auto Reply DM', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const enabled = settings?.autoReplyDmEnabled || false;
  const message = settings?.autoReplyDmMessage || 'Not set';

  const nativeMode = settings?.autoReplyNativeMode ? true : false;
  const modeText = enabled ? (nativeMode ? '🟢 Native Away (Telegram servers)' : '🟡 Fallback (event-driven)') : '⚪ Disabled';

  let configMessage = `💬 <b>Auto Reply to DM</b>\n\n`;
  configMessage += `Status: ${modeText}\n`;
  configMessage += `Message: ${message !== 'Not set' ? message.substring(0, 50) + (message.length > 50 ? '...' : '') : 'Not set'}\n\n`;
  if (enabled && nativeMode) {
    configMessage += `Telegram handles replies automatically — account stays offline.\n`;
    configMessage += `Requires: Telegram Premium/Business`;
  } else if (enabled) {
    configMessage += `Replies via event-driven handler (2-10s delay).\n`;
    configMessage += `Cooldown: 30 minutes per chat`;
  } else {
    configMessage += `When enabled, auto-replies to direct messages.\n`;
    configMessage += `Tries native Away Message first (Premium), falls back to event-driven.`;
  }

  const statusIcon = enabled ? '✓' : '✗';
  const keyboard = {
    inline_keyboard: [
      [
        { text: `💬 Status [${statusIcon}]`, callback_data: `auto_reply_dm_toggle_${!enabled}` }
      ],
      message !== 'Not set' ? [
        { text: '✏️ Edit Message', callback_data: 'auto_reply_dm_set_message' }
      ] : [
        { text: '✏️ Set Message', callback_data: 'auto_reply_dm_set_message' }
      ],
      [{ text: '🔙 Back to Auto Reply', callback_data: 'btn_auto_reply' }],
    ],
  };

  try {
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      configMessage,
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  } catch (error) {
    console.error(`[AUTO_REPLY] Error editing message for DM config:`, error.message);
    try {
      await bot.sendMessage(chatId, configMessage, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } catch (sendError) {
      console.error(`[AUTO_REPLY] Error sending message for DM config:`, sendError.message);
    }
  }
  
  try {
    await safeAnswerCallback(bot, callbackQuery.id);
  } catch (error) {
    console.log(`[AUTO_REPLY] Callback already answered for DM config`);
  }
  
  return { accountId };
}

/**
 * Handle auto reply DM toggle
 */
export async function handleAutoReplyDmToggle(bot, callbackQuery, enabled) {
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

  const settings = await configService.getAccountSettings(accountId);
  const currentMessage = settings?.autoReplyDmMessage;

  const result = await configService.setAutoReplyDm(accountId, enabled, currentMessage);
  
  if (result.success) {
    // Re-evaluate auto-reply setup (native away vs fallback)
    const autoReplyRealtimeService = (await import('../services/autoReplyRealtimeService.js')).default;
    try {
      await autoReplyRealtimeService.setupAccount(accountId);
      console.log(`[AUTO_REPLY] ✅ Setup complete after DM ${enabled ? 'enable' : 'disable'} for account ${accountId}`);
    } catch (setupError) {
      console.error(`[AUTO_REPLY] ❌ Error setting up account after DM toggle:`, setupError.message);
    }

    // Check resulting mode for user feedback
    const updatedSettings = await configService.getAccountSettings(accountId);
    const isNative = updatedSettings?.autoReplyNativeMode ? true : false;
    const feedbackText = enabled
      ? (isNative ? '✅ DM auto-reply enabled (Native Away)' : '✅ DM auto-reply enabled (event-driven)')
      : '✅ DM auto-reply disabled';

    try {
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: feedbackText,
        show_alert: true,
      });
      await handleConfigAutoReplyDm(bot, callbackQuery);
    } catch (error) {
      console.error(`[AUTO_REPLY] Error updating UI after DM toggle:`, error.message);
      try {
        await safeAnswerCallback(bot, callbackQuery.id, { text: feedbackText, show_alert: true });
      } catch (e) {}
    }
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: result.error || 'Failed to update settings',
      show_alert: true,
    });
  }
}

/**
 * Helper to create back to auto reply DM button
 */
function createBackToAutoReplyDmButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Auto Reply DM', callback_data: 'btn_config_auto_reply_dm' }],
      ],
    },
  };
}

/**
 * Handle auto reply DM set message
 */
export async function handleAutoReplyDmSetMessage(bot, callbackQuery) {
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

  try {
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      '💬 <b>Set Auto Reply DM Message</b>\n\nSend the message to use for auto replies to direct messages:',
      { parse_mode: 'HTML', ...createBackToAutoReplyDmButton() }
    );
  } catch (error) {
    console.error(`[AUTO_REPLY] Error editing message for DM set message:`, error.message);
    try {
      await bot.sendMessage(chatId, '💬 <b>Set Auto Reply DM Message</b>\n\nSend the message to use for auto replies to direct messages:', {
        parse_mode: 'HTML',
        ...createBackToAutoReplyDmButton()
      });
    } catch (sendError) {
      console.error(`[AUTO_REPLY] Error sending message for DM set message:`, sendError.message);
    }
  }
  
  try {
    await safeAnswerCallback(bot, callbackQuery.id);
  } catch (error) {
    console.log(`[AUTO_REPLY] Callback already answered for DM set message`);
  }
  
  return { accountId, messageId: callbackQuery.message.message_id };
}

/**
 * Handle auto reply DM message input
 */
export async function handleAutoReplyDmMessageInput(bot, msg, accountId, messageId = null) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Delete user's input message
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (e) { /* Ignore deletion errors */ }

  const message = msg.text?.trim();
  
  // Helper to edit or send message
  const editOrSend = async (content, options) => {
    if (messageId) {
      try {
        await safeEditMessage(bot, chatId, messageId, content, options);
        return;
      } catch (e) { /* Fall back to send */ }
    }
    const sent = await bot.sendMessage(chatId, content, options);
    return sent.message_id;
  };
  
  if (!message) {
    await editOrSend(
      '❌ Please send a valid message.',
      { parse_mode: 'HTML', ...createBackToAutoReplyDmButton() }
    );
    return false;
  }

  const settings = await configService.getAccountSettings(accountId);
  const enabled = settings?.autoReplyDmEnabled || false;

  const result = await configService.setAutoReplyDm(accountId, enabled, message);
  
  if (result.success) {
    // Re-evaluate auto-reply setup (updates native away message text or reconnects fallback)
    const autoReplyRealtimeService = (await import('../services/autoReplyRealtimeService.js')).default;
    try {
      await autoReplyRealtimeService.setupAccount(accountId);
      console.log(`[AUTO_REPLY] ✅ Setup complete after DM message update for account ${accountId}`);
    } catch (setupError) {
      console.error(`[AUTO_REPLY] ❌ Error setting up account after DM message update:`, setupError.message);
    }

    const updatedSettings = await configService.getAccountSettings(accountId);
    const dmEnabled = updatedSettings?.autoReplyDmEnabled || false;
    const groupsEnabled = updatedSettings?.autoReplyGroupsEnabled || false;
    const isNative = updatedSettings?.autoReplyNativeMode ? true : false;

    const savedText = isNative ? '✅ DM auto-reply message saved! (Native Away updated)' : '✅ DM auto-reply message saved!';
    await editOrSend(
      savedText,
      { parse_mode: 'HTML', ...createAutoReplyMenu(dmEnabled, groupsEnabled) }
    );
    return true;
  } else {
    await editOrSend(
      `❌ Failed to set message: ${result.error}`,
      { parse_mode: 'HTML', ...createBackToAutoReplyDmButton() }
    );
    return false;
  }
}

/**
 * Handle auto reply groups configuration
 */
export async function handleConfigAutoReplyGroups(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config Auto Reply Groups', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const enabled = settings?.autoReplyGroupsEnabled || false;
  const message = settings?.autoReplyGroupsMessage || 'Not set';

  let configMessage = `💬 <b>Auto Reply in Groups</b>\n\n`;
  configMessage += `Status: ${enabled ? '🟢 Enabled' : '⚪ Disabled'}\n`;
  configMessage += `Message: ${message !== 'Not set' ? message.substring(0, 50) + (message.length > 50 ? '...' : '') : 'Not set'}\n\n`;
  configMessage += `When enabled, the bot will automatically reply to messages in groups.\n`;
  configMessage += `Cooldown: 30 minutes per chat`;

  const statusIcon = enabled ? '✓' : '✗';
  const keyboard = {
    inline_keyboard: [
      [
        { text: `👥 Status [${statusIcon}]`, callback_data: `auto_reply_groups_toggle_${!enabled}` }
      ],
      message !== 'Not set' ? [
        { text: '✏️ Edit Message', callback_data: 'auto_reply_groups_set_message' }
      ] : [
        { text: '✏️ Set Message', callback_data: 'auto_reply_groups_set_message' }
      ],
      [{ text: '🔙 Back to Auto Reply', callback_data: 'btn_auto_reply' }],
    ],
  };

  try {
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      configMessage,
      { parse_mode: 'HTML', reply_markup: keyboard }
    );
  } catch (error) {
    console.error(`[AUTO_REPLY] Error editing message for groups config:`, error.message);
    try {
      await bot.sendMessage(chatId, configMessage, {
        parse_mode: 'HTML',
        reply_markup: keyboard
      });
    } catch (sendError) {
      console.error(`[AUTO_REPLY] Error sending message for groups config:`, sendError.message);
    }
  }
  
  try {
    await safeAnswerCallback(bot, callbackQuery.id);
  } catch (error) {
    console.log(`[AUTO_REPLY] Callback already answered for groups config`);
  }
  
  return { accountId };
}

/**
 * Handle auto reply menu (combined DM and Groups)
 */
export async function handleAutoReplyMenu(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Auto Reply Menu', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const dmEnabled = settings?.autoReplyDmEnabled || false;
  const groupsEnabled = settings?.autoReplyGroupsEnabled || false;

  // Check if DM is using native away message mode
  const nativeMode = settings?.autoReplyNativeMode ? true : false;
  const dmModeLabel = dmEnabled
    ? (nativeMode ? '<b>ON</b> (Native Away)' : '<b>ON</b> (Fallback)')
    : '<i>OFF</i>';

  // Build description lines
  const descLines = [];
  if (dmEnabled && nativeMode) {
    descLines.push('<i>DM: Telegram servers handle replies (offline)</i>');
  } else if (dmEnabled) {
    descLines.push('<i>DM: Event-driven (2-10s delay)</i>');
  }
  if (groupsEnabled) {
    descLines.push('<i>Groups: Event-driven (2-10s delay)</i>');
  }
  if (!dmEnabled && !groupsEnabled) {
    descLines.push('<i>Enable DM or Group auto-reply below</i>');
  }

  let menuMessage = `<b>💬 AUTO REPLY</b>
━━━━━━━━━━━━━━━━━━━━━

📱 DM Replies: ${dmModeLabel}
👥 Group Replies: ${groupsEnabled ? '<b>ON</b>' : '<i>OFF</i>'}

${descLines.join('\n')}`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    menuMessage,
    { parse_mode: 'HTML', ...createAutoReplyMenu(dmEnabled, groupsEnabled) }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

/**
 * Handle auto reply groups toggle
 */
export async function handleAutoReplyGroupsToggle(bot, callbackQuery, enabled) {
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

  const settings = await configService.getAccountSettings(accountId);
  const currentMessage = settings?.autoReplyGroupsMessage;

  const result = await configService.setAutoReplyGroups(accountId, enabled, currentMessage);

  if (result.success) {
    // Re-evaluate auto-reply setup
    const autoReplyRealtimeService = (await import('../services/autoReplyRealtimeService.js')).default;
    try {
      await autoReplyRealtimeService.setupAccount(accountId);
      console.log(`[AUTO_REPLY] ✅ Setup complete after groups ${enabled ? 'enable' : 'disable'} for account ${accountId}`);
    } catch (setupError) {
      console.error(`[AUTO_REPLY] ❌ Error setting up account after groups toggle:`, setupError.message);
    }

    try {
      await safeAnswerCallback(bot, callbackQuery.id, {
        text: enabled ? '✅ Group auto-reply enabled (event-driven)' : '✅ Group auto-reply disabled',
        show_alert: true,
      });
      await handleConfigAutoReplyGroups(bot, callbackQuery);
    } catch (error) {
      console.error(`[AUTO_REPLY] Error updating UI after groups toggle:`, error.message);
      try {
        await safeAnswerCallback(bot, callbackQuery.id, {
          text: enabled ? '✅ Group auto-reply enabled' : '✅ Group auto-reply disabled',
          show_alert: true,
        });
      } catch (e) {}
    }
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: result.error || 'Failed to update settings',
      show_alert: true,
    });
  }
}

/**
 * Helper to create back to auto reply groups button
 */
function createBackToAutoReplyGroupsButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Auto Reply Groups', callback_data: 'btn_config_auto_reply_groups' }],
      ],
    },
  };
}

/**
 * Handle auto reply groups set message
 */
export async function handleAutoReplyGroupsSetMessage(bot, callbackQuery) {
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

  try {
    await safeEditMessage(
      bot,
      chatId,
      callbackQuery.message.message_id,
      '💬 <b>Set Auto Reply Groups Message</b>\n\nSend the message to use for auto replies in groups:',
      { parse_mode: 'HTML', ...createBackToAutoReplyGroupsButton() }
    );
  } catch (error) {
    console.error(`[AUTO_REPLY] Error editing message for groups set message:`, error.message);
    try {
      await bot.sendMessage(chatId, '💬 <b>Set Auto Reply Groups Message</b>\n\nSend the message to use for auto replies in groups:', {
        parse_mode: 'HTML',
        ...createBackToAutoReplyGroupsButton()
      });
    } catch (sendError) {
      console.error(`[AUTO_REPLY] Error sending message for groups set message:`, sendError.message);
    }
  }
  
  try {
    await safeAnswerCallback(bot, callbackQuery.id);
  } catch (error) {
    console.log(`[AUTO_REPLY] Callback already answered for groups set message`);
  }
  
  return { accountId, messageId: callbackQuery.message.message_id };
}

/**
 * Handle auto reply groups message input
 */
export async function handleAutoReplyGroupsMessageInput(bot, msg, accountId, messageId = null) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  // Delete user's input message
  try {
    await bot.deleteMessage(chatId, msg.message_id);
  } catch (e) { /* Ignore deletion errors */ }

  const message = msg.text?.trim();
  
  // Helper to edit or send message
  const editOrSend = async (content, options) => {
    if (messageId) {
      try {
        await safeEditMessage(bot, chatId, messageId, content, options);
        return;
      } catch (e) { /* Fall back to send */ }
    }
    const sent = await bot.sendMessage(chatId, content, options);
    return sent.message_id;
  };
  
  if (!message) {
    await editOrSend(
      '❌ Please send a valid message.',
      { parse_mode: 'HTML', ...createBackToAutoReplyGroupsButton() }
    );
    return false;
  }

  const settings = await configService.getAccountSettings(accountId);
  const enabled = settings?.autoReplyGroupsEnabled || false;

  const result = await configService.setAutoReplyGroups(accountId, enabled, message);
  
  if (result.success) {
    // Re-evaluate auto-reply setup
    const autoReplyRealtimeService = (await import('../services/autoReplyRealtimeService.js')).default;
    try {
      await autoReplyRealtimeService.setupAccount(accountId);
      console.log(`[AUTO_REPLY] ✅ Setup complete after groups message update for account ${accountId}`);
    } catch (setupError) {
      console.error(`[AUTO_REPLY] ❌ Error setting up account after groups message update:`, setupError.message);
    }

    const updatedSettings = await configService.getAccountSettings(accountId);
    const dmEnabled = updatedSettings?.autoReplyDmEnabled || false;
    const groupsEnabled = updatedSettings?.autoReplyGroupsEnabled || false;

    await editOrSend(
      '✅ Groups auto-reply message saved!',
      { parse_mode: 'HTML', ...createAutoReplyMenu(dmEnabled, groupsEnabled) }
    );
    return true;
  } else {
    await editOrSend(
      `❌ Failed to set message: ${result.error}`,
      { parse_mode: 'HTML', ...createBackToAutoReplyGroupsButton() }
    );
    return false;
  }
}

