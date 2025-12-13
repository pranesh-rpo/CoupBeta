/**
 * Config Handlers
 * Handles configuration menu interactions
 */

import accountLinker from '../services/accountLinker.js';
import configService from '../services/configService.js';
import userService from '../services/userService.js';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { safeEditMessage, safeAnswerCallback } from '../utils/safeEdit.js';
import { createConfigMenu, createRateLimitKeyboard, createQuietHoursKeyboard, createABModeKeyboard, createScheduleKeyboard, createMainMenu, createBackButton } from './keyboardHandler.js';

// Helper function to show verification required (imported from commandHandler)
async function showVerificationRequired(bot, chatId, channelUsername) {
  const verificationMessage = `
🔐 <b>Channel Verification Required</b>

To use this bot, you must join our updates channel first.

📢 Join: @${channelUsername}

After joining, click the "✅ Verify" button below.
  `;
  
  return await bot.sendMessage(chatId, verificationMessage, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Verify', callback_data: 'btn_verify_channel' }],
        [{ text: '📢 Join Channel', url: `https://t.me/${channelUsername}` }]
      ]
    }
  });
}

export async function handleConfigButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config', chatId);

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

  const settings = await configService.getAccountSettings(accountId);
  const preset = configService.intervalToPreset(settings?.manualInterval);
  const quietHours = settings?.quietStart && settings?.quietEnd 
    ? { start: settings.quietStart, end: settings.quietEnd }
    : null;

  const autoMentionText = settings?.autoMention ? `Enabled (${settings.mentionCount || 5} users)` : 'Disabled';
  
  const configMessage = `⚙️ <b>Account Configuration</b>\n\n` +
    `📱 Account: ${(await accountLinker.getAccounts(userId)).find(a => a.accountId === accountId)?.phone || 'Unknown'}\n\n` +
    `⚡ Rate Limit: ${preset === '1' ? '1 msg/hr' : preset === '3' ? '3 msg/hr' : preset === '5' ? '5 msg/hr' : 'Default'}\n` +
    `🌙 Quiet Hours: ${quietHours ? `${quietHours.start} - ${quietHours.end}` : 'Not set'}\n` +
    `🔄 A/B Testing: ${settings?.abMode ? settings.abModeType.charAt(0).toUpperCase() + settings.abModeType.slice(1) : 'Disabled'}\n\n` +
    `Select an option to configure:`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    configMessage,
    { parse_mode: 'HTML', ...createConfigMenu(preset, quietHours, settings?.abMode || false, settings?.abModeType || 'single') }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId }; // Return accountId for state management
}

export async function handleConfigRateLimit(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Config Rate Limit', chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const settings = await configService.getAccountSettings(accountId);
  const preset = configService.intervalToPreset(settings?.manualInterval);

  const rateLimitMessage = `⚡ <b>Rate Limit Presets</b>\n\n` +
    `Select a rate limit preset:\n\n` +
    `• <b>1 msg/hr</b> - 60 min interval (slowest, safest)\n` +
    `• <b>3 msg/hr</b> - 20 min interval (balanced)\n` +
    `• <b>5 msg/hr</b> - 12 min interval (default, recommended)\n` +
    `• <b>Default</b> - Uses system default (12 min)\n\n` +
    `Current: <b>${preset === '1' ? '1 msg/hr' : preset === '3' ? '3 msg/hr' : preset === '5' ? '5 msg/hr' : 'Default'}</b>`;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    rateLimitMessage,
    { parse_mode: 'HTML', ...createRateLimitKeyboard(preset) }
  );
  
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleConfigRateLimitPreset(bot, callbackQuery, preset) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, `Config Rate Limit: ${preset}`, chatId);

  const accountId = accountLinker.getActiveAccountId(userId);
  if (!accountId) {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: 'No active account found!',
      show_alert: true,
    });
    return;
  }

  const result = await configService.setRateLimitPreset(accountId, preset);
  
  if (result.success) {
    const presetLabel = preset === '1' ? '1 msg/hr' : preset === '3' ? '3 msg/hr' : preset === '5' ? '5 msg/hr' : 'Default';
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `✅ Rate limit set to ${presetLabel}`,
      show_alert: true,
    });
    
    // Refresh config menu
    await handleConfigButton(bot, callbackQuery);
  } else {
    await safeAnswerCallback(bot, callbackQuery.id, {
      text: `Error: ${result.error}`,
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
  const currentCap = settings?.dailyCap || 50;

  await safeEditMessage(
    bot,
    chatId,
    callbackQuery.message.message_id,
    `📊 <b>Daily Message Cap</b>\n\n` +
    `Current cap: <b>${currentCap}</b> messages/day\n\n` +
    `Please send a number between 1 and 1000 to set the daily message cap.\n` +
    `The counter resets at midnight IST.\n\n` +
    `Example: Send <code>100</code> to set cap to 100 messages/day.`,
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
    logger.logSuccess('CONFIG', userId, `Daily cap set to ${cap}`);
    await bot.sendMessage(
      chatId,
      `✅ Daily cap set to <b>${cap}</b> messages/day\n\nThe counter resets at midnight IST.`,
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
    { parse_mode: 'HTML', ...createBackButton() }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId, type: 'quiet_hours' };
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

export async function handleQuietHoursInput(bot, msg, accountId) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const text = msg.text?.trim();
  
  if (!text) {
    await bot.sendMessage(
      chatId,
      'Please send the quiet hours in format: <code>HH:MM - HH:MM</code>\n\nExample: <code>22:00 - 06:00</code>',
      { parse_mode: 'HTML', ...createBackButton() }
    );
    return;
  }

  // Parse quiet hours format: "HH:MM - HH:MM"
  const quietHoursRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]\s*-\s*([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  const match = text.match(quietHoursRegex);
  
  if (!match) {
    await bot.sendMessage(
      chatId,
      '❌ Invalid format. Please use: <code>HH:MM - HH:MM</code>\n\n' +
      'Example: <code>22:00 - 06:00</code> (10 PM to 6 AM)\n' +
      'Example: <code>09:00 - 17:00</code> (9 AM to 5 PM)',
      { parse_mode: 'HTML', ...createBackButton() }
    );
    return;
  }

  const startTime = match[1];
  const endTime = match[2];

  // Validate times
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
    await bot.sendMessage(
      chatId,
      '❌ Invalid time format. Please use 24-hour format (HH:MM).\n\nExample: <code>22:00 - 06:00</code>',
      { parse_mode: 'HTML', ...createBackButton() }
    );
    return;
  }

  const result = await configService.setQuietHours(accountId, startTime, endTime);
  
  if (result.success) {
    logger.logSuccess('CONFIG', userId, `Quiet hours set: ${startTime} - ${endTime} IST`);
    await bot.sendMessage(
      chatId,
      `✅ <b>Quiet Hours Set Successfully!</b>\n\n` +
      `🌙 <b>Time Window:</b> ${startTime} - ${endTime} IST\n` +
      `📊 <b>Status:</b> Active\n\n` +
      `💡 Broadcasting will be automatically paused during these hours.`,
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
    { parse_mode: 'HTML', ...createBackButton() }
  );

  await safeAnswerCallback(bot, callbackQuery.id);
  return { accountId, type: 'schedule' };
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

export async function handleScheduleInput(bot, msg, accountId) {
  const userId = msg.from.id;
  const chatId = msg.chat.id;

  const text = msg.text?.trim();
  
  if (!text) {
    await bot.sendMessage(
      chatId,
      'Please send the schedule in format: <code>HH:MM - HH:MM</code>\n\nExample: <code>09:00 - 17:00</code>',
      { parse_mode: 'HTML', ...createBackButton() }
    );
    return;
  }

  // Parse schedule format: "HH:MM - HH:MM"
  const scheduleRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]\s*-\s*([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  const match = text.match(scheduleRegex);
  
  if (!match) {
    await bot.sendMessage(
      chatId,
      '❌ Invalid format. Please use: <code>HH:MM - HH:MM</code>\n\n' +
      'Example: <code>09:00 - 17:00</code> (9 AM to 5 PM)\n' +
      'Example: <code>22:00 - 06:00</code> (10 PM to 6 AM)',
      { parse_mode: 'HTML', ...createBackButton() }
    );
    return;
  }

  const startTime = match[1];
  const endTime = match[2];

  // Validate times
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
    await bot.sendMessage(
      chatId,
      '❌ Invalid time format. Please use 24-hour format (HH:MM).\n\nExample: <code>09:00 - 17:00</code>',
      { parse_mode: 'HTML', ...createBackButton() }
    );
    return;
  }

  const result = await configService.setSchedule(accountId, startTime, endTime);
  
  if (result.success) {
    logger.logSuccess('CONFIG', userId, `Schedule set: ${startTime} - ${endTime} IST`);
    await bot.sendMessage(
      chatId,
      `✅ <b>Schedule Set Successfully!</b>\n\n` +
      `⏰ <b>Time Window:</b> ${startTime} - ${endTime} IST\n` +
      `📊 <b>Status:</b> Active\n\n` +
      `💡 Broadcasting will only occur during this time window. You can start broadcasts anytime, but messages will only be sent during the schedule.`,
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
