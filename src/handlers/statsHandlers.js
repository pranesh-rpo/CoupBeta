/**
 * Statistics Handlers
 * Handles broadcast statistics and analytics
 */

import accountLinker from '../services/accountLinker.js';
import broadcastStatsService from '../services/broadcastStatsService.js';
import analyticsService from '../services/analyticsService.js';
import userService from '../services/userService.js';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { safeEditMessage, safeAnswerCallback } from '../utils/safeEdit.js';
import { createBackButton, createMainMenu } from './keyboardHandler.js';

// Helper function to show verification required
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

export async function handleStatsButton(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Statistics', chatId);

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

  const todayStats = await broadcastStatsService.getTodayStats(accountId);
  const summary = await broadcastStatsService.getSummary(accountId, 30);

  let statsMessage = `📊 <b>Broadcast Statistics</b>\n\n`;
  
  if (todayStats.stats) {
    statsMessage += `📅 <b>Today:</b>\n`;
    statsMessage += `• Messages Sent: ${todayStats.stats.messages_sent || 0}\n`;
    statsMessage += `• Messages Failed: ${todayStats.stats.messages_failed || 0}\n`;
    statsMessage += `• Success Rate: ${todayStats.stats.success_rate || 0}%\n`;
    statsMessage += `• Total Groups: ${todayStats.stats.total_groups || 0}\n\n`;
  }
  
  if (summary.summary) {
    statsMessage += `📈 <b>Last 30 Days:</b>\n`;
    statsMessage += `• Total Broadcasts: ${summary.summary.total_broadcasts || 0}\n`;
    statsMessage += `• Total Sent: ${summary.summary.total_sent || 0}\n`;
    statsMessage += `• Total Failed: ${summary.summary.total_failed || 0}\n`;
    statsMessage += `• Avg Success Rate: ${summary.summary.avg_success_rate ? parseFloat(summary.summary.avg_success_rate).toFixed(2) : 0}%\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📈 Detailed', callback_data: 'stats_detailed' },
          { text: '🏆 Top Groups', callback_data: 'stats_top_groups' }
        ],
        [
          { text: '⚠️ Problems', callback_data: 'stats_problematic' },
          { text: '🔄 A/B Results', callback_data: 'stats_ab' }
        ],
        [{ text: '◀️ Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };

  await safeEditMessage(bot, chatId, callbackQuery.message.message_id, statsMessage, { parse_mode: 'HTML', ...keyboard });
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleTopGroups(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  
  const topGroups = await analyticsService.getTopGroups(accountId, 10);
  
  let message = `🏆 <b>Top Performing Groups</b>\n\n`;
  
  if (topGroups.groups && topGroups.groups.length > 0) {
    topGroups.groups.forEach((group, i) => {
      const successRate = group.messages_sent + group.messages_failed > 0
        ? ((group.messages_sent / (group.messages_sent + group.messages_failed)) * 100).toFixed(1)
        : 0;
      message += `${i + 1}. ${group.group_title || 'Unknown'}\n`;
      message += `   ✅ Sent: ${group.messages_sent || 0} | ❌ Failed: ${group.messages_failed || 0} | Rate: ${successRate}%\n\n`;
    });
  } else {
    message += `No statistics available yet.`;
  }

  await safeEditMessage(
    bot,
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    message,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Stats', callback_data: 'btn_stats' }]] } }
  );
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleProblematicGroups(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  
  const problematic = await analyticsService.getProblematicGroups(accountId, 10);
  
  let message = `⚠️ <b>Problematic Groups</b>\n\n`;
  
  if (problematic.groups && problematic.groups.length > 0) {
    problematic.groups.forEach((group, i) => {
      const failureRate = parseFloat(group.failure_rate || 0).toFixed(1);
      message += `${i + 1}. ${group.group_title || 'Unknown'}\n`;
      message += `   ❌ Failed: ${group.messages_failed || 0} | Rate: ${failureRate}%\n`;
      if (group.last_error) {
        message += `   Error: ${group.last_error.substring(0, 50)}...\n`;
      }
      message += `\n`;
    });
  } else {
    message += `No problematic groups found. All groups are performing well! 🎉`;
  }

  await safeEditMessage(
    bot,
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    message,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Stats', callback_data: 'btn_stats' }]] } }
  );
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleABResults(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  
  const abResults = await analyticsService.getABResults(accountId);
  
  let message = `🔄 <b>A/B Test Results</b>\n\n`;
  
  if (abResults.results && abResults.results.length > 0) {
    abResults.results.forEach(result => {
      const variant = result.variant;
      const totalSent = result.total_sent || 0;
      const avgEngagement = parseFloat(result.avg_engagement || 0).toFixed(2);
      const engagedCount = result.engaged_count || 0;
      const engagementRate = totalSent > 0 ? ((engagedCount / totalSent) * 100).toFixed(1) : 0;
      
      message += `<b>Variant ${variant}:</b>\n`;
      message += `• Total Sent: ${totalSent}\n`;
      message += `• Engaged: ${engagedCount} (${engagementRate}%)\n`;
      message += `• Avg Engagement: ${avgEngagement}\n\n`;
    });
  } else {
    message += `No A/B test data available yet.`;
  }

  await safeEditMessage(
    bot,
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    message,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Stats', callback_data: 'btn_stats' }]] } }
  );
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleDetailedStats(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  
  const stats = await broadcastStatsService.getStats(accountId, 
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    new Date().toISOString().split('T')[0]
  );
  
  let message = `📈 <b>Detailed Statistics (Last 7 Days)</b>\n\n`;
  
  if (stats.stats && stats.stats.length > 0) {
    stats.stats.forEach((stat, i) => {
      message += `<b>${stat.broadcast_date}:</b>\n`;
      message += `• Sent: ${stat.messages_sent || 0} | Failed: ${stat.messages_failed || 0}\n`;
      message += `• Success Rate: ${stat.success_rate || 0}%\n\n`;
    });
  } else {
    message += `No statistics available for the last 7 days.`;
  }

  await safeEditMessage(
    bot,
    callbackQuery.message.chat.id,
    callbackQuery.message.message_id,
    message,
    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Back to Stats', callback_data: 'btn_stats' }]] } }
  );
  await safeAnswerCallback(bot, callbackQuery.id);
}
