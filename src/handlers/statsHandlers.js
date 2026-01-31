/**
 * Statistics Handlers
 * Handles broadcast statistics and analytics with enhanced visualizations
 */

import accountLinker from '../services/accountLinker.js';
import broadcastStatsService from '../services/broadcastStatsService.js';
import analyticsService from '../services/analyticsService.js';
import userService from '../services/userService.js';
import groupService from '../services/groupService.js';
import { config } from '../config.js';
import logger from '../utils/logger.js';
import { safeEditMessage, safeAnswerCallback } from '../utils/safeEdit.js';
import { createBackButton, createMainMenu } from './keyboardHandler.js';

// Helper function to show verification required
function createChannelButtonsKeyboard(channelUsernames) {
  const channels = Array.isArray(channelUsernames) ? channelUsernames : [channelUsernames];
  const keyboard = [[{ text: '✅ Verify', callback_data: 'btn_verify_channel' }]];
  for (const channelUsername of channels) {
    keyboard.push([{ text: `📢 Join @${channelUsername}`, url: `https://t.me/${channelUsername}` }]);
  }
  return keyboard;
}

async function showVerificationRequired(bot, chatId, channelUsernames) {
  const channels = Array.isArray(channelUsernames) ? channelUsernames : [channelUsernames];
  const channelList = channels.map(ch => `📢 @${ch}`).join('\n');
  const verificationMessage = `
🔐 <b>Channel Verification Required</b>

To use this bot, you must join our updates channel(s) first.

${channelList}

After joining, click the "✅ Verify" button below.
  `;
  return await bot.sendMessage(chatId, verificationMessage, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: createChannelButtonsKeyboard(channels) }
  });
}

/**
 * Create a visual progress bar
 */
function createProgressBar(value, max, length = 10) {
  const percentage = max > 0 ? (value / max) : 0;
  const filled = Math.round(percentage * length);
  const empty = length - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/**
 * Format number with commas
 */
function formatNumber(num) {
  return num ? num.toLocaleString() : '0';
}

/**
 * Get trend indicator emoji
 */
function getTrendEmoji(current, previous) {
  if (!previous || previous === 0) return '📊';
  const change = ((current - previous) / previous) * 100;
  if (change > 10) return '📈';
  if (change < -10) return '📉';
  return '➡️';
}

/**
 * Create statistics keyboard
 */
function createStatsKeyboard(period = 'today') {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: period === 'today' ? '🟢 Today' : '⚪ Today', callback_data: 'stats_period_today' },
          { text: period === 'week' ? '🟢 Week' : '⚪ Week', callback_data: 'stats_period_week' },
          { text: period === 'month' ? '🟢 Month' : '⚪ Month', callback_data: 'stats_period_month' }
        ],
        [
          { text: period === 'all' ? '🟢 All Time' : '⚪ All Time', callback_data: 'stats_period_all' },
          { text: '📈 Trends', callback_data: 'stats_trends' }
        ],
        [
          { text: '🏆 Top Groups', callback_data: 'stats_top_groups' },
          { text: '⚠️ Problems', callback_data: 'stats_problematic' }
        ],
        [
          { text: '📊 Detailed', callback_data: 'stats_detailed' },
          { text: '🔄 A/B Results', callback_data: 'stats_ab' }
        ],
        [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export async function handleStatsButton(bot, callbackQuery, period = 'today') {
  const userId = callbackQuery.from.id;
  const chatId = callbackQuery.message.chat.id;
  const username = callbackQuery.from.username || 'Unknown';

  logger.logButtonClick(userId, username, 'Statistics', chatId);

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

  let statsMessage = `📊 <b>Broadcast Statistics</b>\n`;
  statsMessage += `━━━━━━━━━━━━━━━━━━\n\n`;

  // Get data based on period
  let currentStats, comparison, periodLabel;
  const days = period === 'today' ? 1 : period === 'week' ? 7 : period === 'month' ? 30 : null;

  if (period === 'today') {
    const todayData = await broadcastStatsService.getTodayStats(accountId);
    currentStats = todayData.stats;
    periodLabel = 'Today';
    
    // Compare with yesterday
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayData = await broadcastStatsService.getStats(
      accountId,
      yesterday.toISOString().split('T')[0],
      yesterday.toISOString().split('T')[0]
    );
    const yesterdayStats = yesterdayData.stats?.[0];
    
    if (currentStats) {
      const sent = currentStats.messages_sent || 0;
      const failed = currentStats.messages_failed || 0;
      const total = sent + failed;
      const successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : 0;
      const groups = currentStats.total_groups || 0;
      
      statsMessage += `📅 <b>${periodLabel}</b>\n\n`;
      statsMessage += `✅ <b>Sent:</b> ${formatNumber(sent)}\n`;
      statsMessage += `❌ <b>Failed:</b> ${formatNumber(failed)}\n`;
      statsMessage += `📊 <b>Total:</b> ${formatNumber(total)}\n\n`;
      
      // Visual progress bar for success rate
      const successBar = createProgressBar(parseFloat(successRate), 100, 15);
      statsMessage += `🎯 <b>Success Rate:</b> ${successRate}%\n`;
      statsMessage += `${successBar}\n\n`;
      
      statsMessage += `👥 <b>Groups Reached:</b> ${formatNumber(groups)}\n\n`;
      
      // Comparison with yesterday
      if (yesterdayStats) {
        const yesterdaySent = yesterdayStats.messages_sent || 0;
        const trend = getTrendEmoji(sent, yesterdaySent);
        const change = yesterdaySent > 0 ? (((sent - yesterdaySent) / yesterdaySent) * 100).toFixed(1) : 'N/A';
        statsMessage += `${trend} <b>vs Yesterday:</b> ${change > 0 ? '+' : ''}${change}%\n\n`;
      }
    } else {
      statsMessage += `📅 <b>${periodLabel}</b>\n\n`;
      statsMessage += `No broadcasts today yet.\n\n`;
    }
  } else if (period === 'all') {
    const allTimeData = await broadcastStatsService.getAllTimeStats(accountId);
    currentStats = allTimeData.stats;
    periodLabel = 'All Time';
    
    if (currentStats) {
      const sent = parseInt(currentStats.total_sent || 0);
      const failed = parseInt(currentStats.total_failed || 0);
      const total = sent + failed;
      const successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : 0;
      const broadcasts = parseInt(currentStats.total_broadcasts || 0);
      const avgRate = parseFloat(currentStats.avg_success_rate || 0).toFixed(1);
      const bestRate = parseFloat(currentStats.best_day_rate || 0).toFixed(1);
      
      statsMessage += `📅 <b>${periodLabel}</b>\n\n`;
      statsMessage += `📡 <b>Total Broadcasts:</b> ${formatNumber(broadcasts)}\n`;
      statsMessage += `✅ <b>Total Sent:</b> ${formatNumber(sent)}\n`;
      statsMessage += `❌ <b>Total Failed:</b> ${formatNumber(failed)}\n\n`;
      
      const successBar = createProgressBar(parseFloat(successRate), 100, 15);
      statsMessage += `🎯 <b>Overall Success Rate:</b> ${successRate}%\n`;
      statsMessage += `${successBar}\n\n`;
      
      statsMessage += `📊 <b>Average Rate:</b> ${avgRate}%\n`;
      statsMessage += `🏆 <b>Best Day Rate:</b> ${bestRate}%\n\n`;
      
      if (currentStats.first_broadcast) {
        statsMessage += `📅 <b>First Broadcast:</b> ${currentStats.first_broadcast}\n`;
        statsMessage += `📅 <b>Last Broadcast:</b> ${currentStats.last_broadcast || 'N/A'}\n`;
      }
    } else {
      statsMessage += `📅 <b>${periodLabel}</b>\n\n`;
      statsMessage += `No statistics available yet.\n\n`;
    }
  } else {
    // Week or Month
    const periodData = await broadcastStatsService.getPeriodStats(accountId, days);
    currentStats = periodData.stats;
    periodLabel = period === 'week' ? 'Last 7 Days' : 'Last 30 Days';
    
    // Get comparison
    const compData = await broadcastStatsService.getPeriodComparison(accountId, days);
    comparison = compData;
    
    if (currentStats) {
      const sent = parseInt(currentStats.total_sent || 0);
      const failed = parseInt(currentStats.total_failed || 0);
      const total = sent + failed;
      const successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : 0;
      const broadcasts = parseInt(currentStats.total_broadcasts || 0);
      const avgRate = parseFloat(currentStats.avg_success_rate || 0).toFixed(1);
      const maxRate = parseFloat(currentStats.max_success_rate || 0).toFixed(1);
      const minRate = parseFloat(currentStats.min_success_rate || 0).toFixed(1);
      
      statsMessage += `📅 <b>${periodLabel}</b>\n\n`;
      statsMessage += `📡 <b>Broadcasts:</b> ${formatNumber(broadcasts)}\n`;
      statsMessage += `✅ <b>Sent:</b> ${formatNumber(sent)}\n`;
      statsMessage += `❌ <b>Failed:</b> ${formatNumber(failed)}\n\n`;
      
      const successBar = createProgressBar(parseFloat(successRate), 100, 15);
      statsMessage += `🎯 <b>Success Rate:</b> ${successRate}%\n`;
      statsMessage += `${successBar}\n\n`;
      
      statsMessage += `📊 <b>Average:</b> ${avgRate}% | <b>Best:</b> ${maxRate}% | <b>Worst:</b> ${minRate}%\n\n`;
      
      // Comparison with previous period
      if (comparison && comparison.current && comparison.previous) {
        const prevSent = parseInt(comparison.previous.total_sent || 0);
        const prevRate = parseFloat(comparison.previous.avg_success_rate || 0);
        if (prevSent > 0) {
          const sentChange = (((sent - prevSent) / prevSent) * 100).toFixed(1);
          const rateChange = (parseFloat(successRate) - prevRate).toFixed(1);
          const trend = getTrendEmoji(sent, prevSent);
          statsMessage += `${trend} <b>vs Previous Period:</b>\n`;
          statsMessage += `   Messages: ${sentChange > 0 ? '+' : ''}${sentChange}%\n`;
          statsMessage += `   Success Rate: ${rateChange > 0 ? '+' : ''}${rateChange}%\n\n`;
        }
      }
    } else {
      statsMessage += `📅 <b>${periodLabel}</b>\n\n`;
      statsMessage += `No statistics available for this period.\n\n`;
    }
  }

  // Add insights
  if (currentStats && (currentStats.messages_sent || currentStats.total_sent)) {
    statsMessage += `━━━━━━━━━━━━━━━━━━\n`;
    statsMessage += `💡 <b>Quick Insights</b>\n\n`;
    
    const sent = parseInt(currentStats.messages_sent || currentStats.total_sent || 0);
    const failed = parseInt(currentStats.messages_failed || currentStats.total_failed || 0);
    const total = sent + failed;
    const successRate = total > 0 ? ((sent / total) * 100) : 0;
    
    if (successRate >= 95) {
      statsMessage += `✨ Excellent performance! Keep it up!\n`;
    } else if (successRate >= 85) {
      statsMessage += `👍 Good performance with room for improvement.\n`;
    } else if (successRate >= 70) {
      statsMessage += `⚠️ Performance needs attention. Check problematic groups.\n`;
    } else {
      statsMessage += `🔴 Critical issues detected. Review your settings.\n`;
    }
  }

  await safeEditMessage(bot, chatId, callbackQuery.message.message_id, statsMessage, { 
    parse_mode: 'HTML', 
    ...createStatsKeyboard(period) 
  });
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleStatsPeriod(bot, callbackQuery, period) {
  await handleStatsButton(bot, callbackQuery, period);
}

export async function handleTopGroups(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  
  const topGroups = await analyticsService.getTopGroups(accountId, 15);
  const totalGroups = await groupService.getActiveGroupsCount(accountId);
  
  let message = `🏆 <b>Top Performing Groups</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━\n\n`;
  
  if (topGroups.groups && topGroups.groups.length > 0) {
    message += `Showing top ${topGroups.groups.length} of ${totalGroups} groups\n\n`;
    
    topGroups.groups.forEach((group, i) => {
      const sent = group.messages_sent || 0;
      const failed = group.messages_failed || 0;
      const total = sent + failed;
      const successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : 0;
      const bar = createProgressBar(parseFloat(successRate), 100, 8);
      
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
      message += `${medal} <b>${group.group_title || 'Unknown'}</b>\n`;
      message += `   ✅ ${sent} | ❌ ${failed} | ${successRate}% ${bar}\n\n`;
    });
  } else {
    message += `No statistics available yet.\n`;
    message += `Start broadcasting to see group performance! 📊\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Back to Stats', callback_data: 'btn_stats' }]
      ],
    },
  };

  await safeEditMessage(bot, callbackQuery.message.chat.id, callbackQuery.message.message_id, message, { 
    parse_mode: 'HTML', 
    ...keyboard 
  });
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleProblematicGroups(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  
  const problematic = await analyticsService.getProblematicGroups(accountId, 15);
  
  let message = `⚠️ <b>Problematic Groups</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━\n\n`;
  
  if (problematic.groups && problematic.groups.length > 0) {
    message += `Groups with high failure rates:\n\n`;
    
    problematic.groups.forEach((group, i) => {
      const failed = group.messages_failed || 0;
      const sent = group.messages_sent || 0;
      const total = sent + failed;
      const failureRate = parseFloat(group.failure_rate || 0).toFixed(1);
      const bar = createProgressBar(parseFloat(failureRate), 100, 8);
      
      message += `${i + 1}. <b>${group.group_title || 'Unknown'}</b>\n`;
      message += `   ❌ Failed: ${failed} | Rate: ${failureRate}% ${bar}\n`;
      if (group.last_error) {
        const error = group.last_error.length > 60 
          ? group.last_error.substring(0, 60) + '...' 
          : group.last_error;
        message += `   ⚠️ ${error}\n`;
      }
      message += `\n`;
    });
    
    message += `💡 <b>Tip:</b> Review these groups and consider adding them to blacklist if issues persist.\n`;
  } else {
    message += `🎉 <b>Great news!</b>\n\n`;
    message += `No problematic groups found. All groups are performing well! ✨\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Back to Stats', callback_data: 'btn_stats' }]
      ],
    },
  };

  await safeEditMessage(bot, callbackQuery.message.chat.id, callbackQuery.message.message_id, message, { 
    parse_mode: 'HTML', 
    ...keyboard 
  });
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleABResults(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  
  const abResults = await analyticsService.getABResults(accountId);
  
  let message = `🔄 <b>A/B Test Results</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━\n\n`;
  
  if (abResults.results && abResults.results.length > 0) {
    let bestVariant = null;
    let bestEngagement = 0;
    
    abResults.results.forEach(result => {
      const variant = result.variant;
      const totalSent = result.total_sent || 0;
      const avgEngagement = parseFloat(result.avg_engagement || 0);
      const engagedCount = result.engaged_count || 0;
      const engagementRate = totalSent > 0 ? ((engagedCount / totalSent) * 100).toFixed(1) : 0;
      
      if (avgEngagement > bestEngagement) {
        bestEngagement = avgEngagement;
        bestVariant = variant;
      }
      
      const bar = createProgressBar(parseFloat(engagementRate), 100, 10);
      message += `<b>Variant ${variant}</b> ${variant === bestVariant ? '🏆' : ''}\n`;
      message += `   📤 Sent: ${formatNumber(totalSent)}\n`;
      message += `   👆 Engaged: ${engagedCount} (${engagementRate}%)\n`;
      message += `   ${bar}\n`;
      message += `   📊 Avg Engagement: ${avgEngagement.toFixed(2)}\n\n`;
    });
    
    if (bestVariant) {
      message += `━━━━━━━━━━━━━━━━━━\n`;
      message += `🏆 <b>Winner:</b> Variant ${bestVariant}\n`;
    }
  } else {
    message += `No A/B test data available yet.\n`;
    message += `Enable A/B testing in settings to start comparing variants.\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Back to Stats', callback_data: 'btn_stats' }]
      ],
    },
  };

  await safeEditMessage(bot, callbackQuery.message.chat.id, callbackQuery.message.message_id, message, { 
    parse_mode: 'HTML', 
    ...keyboard 
  });
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleDetailedStats(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  
  const stats = await broadcastStatsService.getStats(accountId, 
    new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    new Date().toISOString().split('T')[0]
  );
  
  let message = `📈 <b>Detailed Statistics</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━\n\n`;
  message += `📅 <b>Last 7 Days Breakdown</b>\n\n`;
  
  if (stats.stats && stats.stats.length > 0) {
    let totalSent = 0;
    let totalFailed = 0;
    
    stats.stats.forEach((stat, i) => {
      const sent = stat.messages_sent || 0;
      const failed = stat.messages_failed || 0;
      const total = sent + failed;
      const successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : 0;
      const bar = createProgressBar(parseFloat(successRate), 100, 10);
      
      totalSent += sent;
      totalFailed += failed;
      
      const date = new Date(stat.broadcast_date);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
      
      message += `<b>${dayName} ${stat.broadcast_date}</b>\n`;
      message += `   ✅ ${sent} | ❌ ${failed} | ${successRate}%\n`;
      message += `   ${bar}\n\n`;
    });
    
    const overallTotal = totalSent + totalFailed;
    const overallRate = overallTotal > 0 ? ((totalSent / overallTotal) * 100).toFixed(1) : 0;
    const overallBar = createProgressBar(parseFloat(overallRate), 100, 15);
    
    message += `━━━━━━━━━━━━━━━━━━\n`;
    message += `<b>7-Day Summary</b>\n`;
    message += `✅ Total Sent: ${formatNumber(totalSent)}\n`;
    message += `❌ Total Failed: ${formatNumber(totalFailed)}\n`;
    message += `🎯 Overall Rate: ${overallRate}%\n`;
    message += `${overallBar}\n`;
  } else {
    message += `No statistics available for the last 7 days.\n`;
    message += `Start broadcasting to see detailed statistics! 📊\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Back to Stats', callback_data: 'btn_stats' }]
      ],
    },
  };

  await safeEditMessage(bot, callbackQuery.message.chat.id, callbackQuery.message.message_id, message, { 
    parse_mode: 'HTML', 
    ...keyboard 
  });
  await safeAnswerCallback(bot, callbackQuery.id);
}

export async function handleStatsTrends(bot, callbackQuery) {
  const userId = callbackQuery.from.id;
  const accountId = accountLinker.getActiveAccountId(userId);
  
  const trend = await broadcastStatsService.getDailyTrend(accountId, 14);
  
  let message = `📈 <b>Trend Analysis</b>\n`;
  message += `━━━━━━━━━━━━━━━━━━\n\n`;
  message += `📅 <b>Last 14 Days Trend</b>\n\n`;
  
  if (trend.trend && trend.trend.length > 0) {
    // Find max for scaling
    const maxSent = Math.max(...trend.trend.map(t => t.messages_sent || 0), 1);
    
    trend.trend.forEach((day, i) => {
      const sent = day.messages_sent || 0;
      const failed = day.messages_failed || 0;
      const total = sent + failed;
      const successRate = total > 0 ? ((sent / total) * 100).toFixed(1) : 0;
      
      // Visual bar chart
      const barLength = Math.round((sent / maxSent) * 20);
      const bar = '█'.repeat(barLength) + '░'.repeat(20 - barLength);
      
      const date = new Date(day.broadcast_date);
      const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });
      
      message += `${dayName} ${day.broadcast_date.substring(5)}\n`;
      message += `${bar} ${sent} (${successRate}%)\n\n`;
    });
    
    // Calculate trend direction
    if (trend.trend.length >= 2) {
      const recent = trend.trend.slice(-7);
      const older = trend.trend.slice(0, 7);
      const recentAvg = recent.reduce((sum, d) => sum + (d.messages_sent || 0), 0) / recent.length;
      const olderAvg = older.length > 0 
        ? older.reduce((sum, d) => sum + (d.messages_sent || 0), 0) / older.length 
        : recentAvg;
      
      const change = olderAvg > 0 ? (((recentAvg - olderAvg) / olderAvg) * 100).toFixed(1) : '0';
      const trendEmoji = getTrendEmoji(recentAvg, olderAvg);
      
      message += `━━━━━━━━━━━━━━━━━━\n`;
      message += `${trendEmoji} <b>Trend:</b> ${change > 0 ? '+' : ''}${change}% vs previous week\n`;
    }
  } else {
    message += `No trend data available yet.\n`;
    message += `Continue broadcasting to see trends! 📊\n`;
  }

  const keyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: '◀️ Back to Stats', callback_data: 'btn_stats' }]
      ],
    },
  };

  await safeEditMessage(bot, callbackQuery.message.chat.id, callbackQuery.message.message_id, message, { 
    parse_mode: 'HTML', 
    ...keyboard 
  });
  await safeAnswerCallback(bot, callbackQuery.id);
}
