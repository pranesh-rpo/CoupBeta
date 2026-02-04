import automationService from '../services/automationService.js';
import accountLinker from '../services/accountLinker.js';
import messageService from '../services/messageService.js';
import premiumService from '../services/premiumService.js';
import configService from '../services/configService.js';
import groupService from '../services/groupService.js';
import { escapeHtml, sanitizeButtonText } from '../utils/textHelpers.js';

/**
 * Generate status text for the main menu - Clean Dashboard
 */
export async function generateStatusText(userId) {
  if (!userId) {
    return '';
  }

  try {
    const isLinked = accountLinker.isLinked(userId);
    const accounts = await accountLinker.getAccounts(userId);
    const activeAccountId = accountLinker.getActiveAccountId(userId);
    
    const isBroadcasting = activeAccountId ? automationService.isBroadcasting(userId, activeAccountId) : false;

    if (!isLinked || accounts.length === 0) {
      return `

<i>No account linked yet</i>
<i>Tap the button below to get started</i>`;
    }

    const activeAccount = accounts.find(acc => acc.accountId === activeAccountId);
    const displayName = activeAccount ? (activeAccount.firstName || activeAccount.phone) : 'Unknown';

    // Get account settings and group count in parallel
    let settings = null;
    let groupCount = 0;
    
    if (activeAccountId) {
      try {
        [settings, groupCount] = await Promise.all([
          configService.getAccountSettings(activeAccountId).catch(e => {
            console.log('[DASHBOARD] Error fetching account settings:', e.message);
            return null;
          }),
          groupService.getActiveGroupsCount(activeAccountId).catch(() => 0)
        ]);
      } catch (e) {
        console.log('[DASHBOARD] Error in Promise.all:', e.message);
      }
    }

    // Build dashboard
    const broadcastStatus = isBroadcasting ? '🟢 LIVE' : '⚪ OFF';
    
    const dailySent = settings?.dailySent || 0;
    const dailyCap = settings?.dailyCap || 999999;
    const progress = dailyCap > 0 ? Math.min(Math.round((dailySent / dailyCap) * 100), 100) : 0;
    const interval = settings?.manualInterval || 11;
    
    // Build active features list
    const active = [];
    if (settings?.quietStart && settings?.quietEnd) active.push(`🌙 Quiet: ${settings.quietStart}-${settings.quietEnd}`);
    if (settings?.useMessagePool) active.push('📚 Pool: ON');
    if (settings?.forwardMode) active.push('↗️ Forward: ON');
    if (settings?.autoReplyDmEnabled) active.push('💬 DM Reply: ON');
    if (settings?.autoReplyGroupsEnabled) active.push('👥 Grp Reply: ON');
    if (settings?.autoMention) active.push(`🔔 Mentions: @${settings.mentionCount}`);
    
    let statusText = `
━━━━━━━━━━━━━━━━━━━━━━━━━━

👤 <b>${escapeHtml(displayName)}</b>
📡 ${broadcastStatus}  •  👥 ${groupCount} groups
📨 ${dailySent}/${dailyCap} sent (${progress}%)
⏱️ ${interval} min interval`;

    if (active.length > 0) {
      statusText += `

<b>ACTIVE</b>
${active.join('\n')}`;
    }
    
    statusText += `
━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    return statusText;
  } catch (error) {
    console.log(`[STATUS] Error generating status: ${error.message}`);
    return '';
  }
}

export async function createMainMenu(userId = null) {
  // Check broadcast state if userId is provided
  let isBroadcasting = false;
  if (userId) {
    try {
      const activeAccountId = accountLinker.getActiveAccountId(userId);
      isBroadcasting = activeAccountId ? automationService.isBroadcasting(userId, activeAccountId) : false;
    } catch (error) {
      isBroadcasting = false;
    }
  }

  // Dynamic broadcast button
  const broadcastButton = isBroadcasting
    ? [{ text: '⏹️ STOP BROADCAST', callback_data: 'btn_start_broadcast' }]
    : [{ text: '▶️ START BROADCAST', callback_data: 'btn_start_broadcast' }];

  // Get account info
  let accountButtonText = '➕ Link Account';
  let hasAccount = false;
  
  if (userId) {
    try {
      const accounts = await accountLinker.getAccounts(userId);
      const activeAccountId = accountLinker.getActiveAccountId(userId);
      
      if (activeAccountId && accounts.length > 0) {
        hasAccount = true;
        const activeAccount = accounts.find(acc => acc.accountId === activeAccountId);
        if (activeAccount && activeAccount.firstName) {
          // Use sanitizeButtonText instead of escapeHtml for button text (must be UTF-8)
          accountButtonText = `👤 ${sanitizeButtonText(activeAccount.firstName.substring(0, 15))}`;
        } else if (activeAccount && activeAccount.phone) {
          accountButtonText = `👤 ${sanitizeButtonText(activeAccount.phone)}`;
        } else {
          accountButtonText = '👤 Account';
        }
      }
    } catch (error) {
      console.log(`[KEYBOARD] Error getting account info: ${error.message}`);
    }
  }

  return {
    reply_markup: {
      inline_keyboard: [
        // ═══ ACCOUNT (Top Row) ═══
        [{ text: accountButtonText, callback_data: 'btn_account' }],
        
        // ═══ CORE FEATURES ═══
        [
          { text: '📝 Messages', callback_data: 'btn_messages_menu' },
          { text: '⚙️ Settings', callback_data: 'btn_config' }
        ],
        
        // ═══ GROUPS & AUTO REPLY ═══
        [
          { text: '👥 Groups', callback_data: 'btn_groups' },
          { text: '💬 Auto Reply', callback_data: 'btn_auto_reply' }
        ],
        
        // ═══ MENTIONS & PREMIUM ═══
        [
          { text: '🔔 Mentions', callback_data: 'btn_mention' },
          { text: '⭐ Premium', callback_data: 'btn_premium' }
        ],
        
        // ═══ BROADCAST (Bottom) ═══
        broadcastButton,
        
        // ═══ SUPPORT ═══
        [{ text: '💭 Support', url: 'https://t.me/CoupSupBot' }],
      ],
    },
  };
}

export function createGroupsMenu(groupDelayMin = null, groupDelayMax = null, blacklistCount = 0) {
  return {
    reply_markup: {
      inline_keyboard: [
        // Actions Row
        [
          { text: '🔄 Refresh', callback_data: 'btn_refresh_groups' },
          { text: '📋 View All', callback_data: 'btn_list_groups' }
        ],
        // Auto Join
        [{ text: '➕ Auto Join Groups', callback_data: 'btn_auto_join_groups' }],
        // Management Row
        [
          { text: `🚫 Blacklist${blacklistCount > 0 ? ` (${blacklistCount})` : ''}`, callback_data: 'btn_config_blacklist' }
        ],
        // Navigation
        [{ text: '← Back', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createAccountSwitchKeyboard(accounts, currentAccountId) {
  const buttons = accounts.map(account => {
    const prefix = account.isActive ? '🟢' : '⚪';
    // Use first name if available, otherwise fallback to phone number
    const displayName = account.firstName || account.phone;
    // Sanitize button text to ensure valid UTF-8 encoding
    return [
      {
        text: `${prefix} ${sanitizeButtonText(displayName)}${account.isActive ? ' (Active)' : ''}`,
        callback_data: `switch_account_${account.accountId}`
      },
      {
        text: '🗑️ Delete',
        callback_data: `delete_account_${account.accountId}`
      }
    ];
  });
  
  buttons.push([{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]);
  
  return {
    reply_markup: {
      inline_keyboard: buttons,
    },
  };
}

export function createBackButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createBackToGroupsButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔙 Back to Groups', callback_data: 'btn_groups' }],
      ],
    },
  };
}

export function createLoginOptionsKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📱 Share Phone Number', callback_data: 'btn_login_share_phone' }],
        [{ text: '⌨️ Type Phone Number', callback_data: 'btn_login_type_phone' }],
        [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

/**
 * Create unified phone input keyboard (reply keyboard with share contact button)
 * User can either tap the button to share OR type the number directly
 */
export function createPhoneInputKeyboard() {
  return {
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
  };
}

/**
 * Remove reply keyboard
 */
export function removeReplyKeyboard() {
  return {
    reply_markup: {
      remove_keyboard: true,
    },
  };
}

export function createStopButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⏹️ Stop Broadcast', callback_data: 'stop_broadcast' }],
        [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createConfigMenu(currentInterval = 11, quietHours = null) {
  const intervalText = `${currentInterval} min`;
  const quietText = quietHours ? '✓' : '✗';
  
  return {
    reply_markup: {
      inline_keyboard: [
        // Timing
        [
          { text: `⏱️ Interval (${intervalText})`, callback_data: 'btn_config_interval_menu' },
          { text: `🌙 Quiet [${quietText}]`, callback_data: 'btn_config_quiet_hours' }
        ],
        // Tools
        [
          { text: '📅 Schedule', callback_data: 'btn_config_schedule' },
          { text: '📝 Logger', callback_data: 'btn_logger_bot' }
        ],
        // Stats
        [{ text: '📊 Statistics', callback_data: 'btn_stats' }],
        [{ text: '← Back', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

// Removed createRateLimitKeyboard - replaced with custom interval input

export function createQuietHoursKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        // Actions - 2 columns
        [
          { text: '➕ Set', callback_data: 'config_quiet_set' },
          { text: '👁️ View', callback_data: 'config_quiet_view' }
        ],
        // Clear - Full width
        [{ text: '🗑️ Clear Quiet Hours', callback_data: 'config_quiet_clear' }],
        // Back - Full width
        [{ text: '🔙 Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}


export function createScheduleKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        // Actions - 2 columns
        [
          { text: '➕ Set', callback_data: 'config_schedule_normal' },
          { text: '👁️ View', callback_data: 'config_schedule_view' }
        ],
        // Clear - Full width
        [{ text: '🗑️ Clear Schedule', callback_data: 'config_schedule_clear' }],
        // Back - Full width
        [{ text: '🔙 Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}


export function createMessagePoolKeyboard(poolSize, poolMode = 'random', usePool = false) {
  const buttons = [];
  
  // Actions
  buttons.push([
    { text: '📋 View All', callback_data: 'pool_view_messages' },
    { text: '🔄 Refresh', callback_data: 'pool_add_message' }
  ]);
  
  // Toggle
  const poolStatus = usePool ? '✓ ON' : '✗ OFF';
  buttons.push([
    { text: `Pool: ${poolStatus}`, callback_data: 'pool_toggle' }
  ]);
  
  // Mode selection - cleaner icons
  const modeIcons = {
    random: poolMode === 'random' ? '●' : '○',
    rotate: poolMode === 'rotate' ? '●' : '○',
    sequential: poolMode === 'sequential' ? '●' : '○'
  };
  buttons.push([
    { text: `${modeIcons.random} Random`, callback_data: 'pool_mode_random' },
    { text: `${modeIcons.rotate} Rotate`, callback_data: 'pool_mode_rotate' },
    { text: `${modeIcons.sequential} Sequential`, callback_data: 'pool_mode_sequential' }
  ]);
  
  buttons.push([{ text: '← Back', callback_data: 'btn_main_menu' }]);
  
  return {
    reply_markup: {
      inline_keyboard: buttons,
    },
  };
}

export function createMessagePoolListKeyboard(messages, page = 0, pageSize = 3) {
  const buttons = [];
  const start = page * pageSize;
  const end = Math.min(start + pageSize, messages.length);
  const pageMessages = messages.slice(start, end);
  
  // Message buttons with enable/disable
  pageMessages.forEach((msg, idx) => {
    // Extend title text to take maximum space (longer text = wider button)
    const displayText = msg.text.length > 60 ? msg.text.substring(0, 60) + '...' : msg.text;
    // Sanitize button text to ensure valid UTF-8 encoding
    const sanitizedText = sanitizeButtonText(displayText);
    const statusIcon = msg.is_active ? '✅' : '❌';
    const globalIndex = start + idx + 1;
    
    // Message title (extended) and small bin button (just emoji)
    buttons.push([
      { text: `${statusIcon} ${globalIndex}. ${sanitizedText}`, callback_data: `pool_toggle_${msg.id}` },
      { text: '🗑️', callback_data: `pool_delete_${msg.id}` }
    ]);
  });
  
  // Pagination controls - Modern centered layout
  if (messages.length > pageSize) {
    const maxPage = Math.ceil(messages.length / pageSize) - 1;
    const navButtons = [];
    
    // Left navigation
    if (page > 0) {
      navButtons.push({ text: '◀️', callback_data: `pool_page_${page - 1}` });
    } else {
      navButtons.push({ text: '⚪', callback_data: 'pool_page_info' }); // Placeholder for alignment
    }
    
    // Page indicator - centered
    navButtons.push({ text: `📄 ${page + 1}/${maxPage + 1}`, callback_data: 'pool_page_info' });
    
    // Right navigation
    if (page < maxPage) {
      navButtons.push({ text: '▶️', callback_data: `pool_page_${page + 1}` });
    } else {
      navButtons.push({ text: '⚪', callback_data: 'pool_page_info' }); // Placeholder for alignment
    }
    
    buttons.push(navButtons);
  }
  
  // Back button - Full width
  buttons.push([{ text: '🔙 Back to Pool', callback_data: 'btn_message_pool' }]);
  
  return {
    reply_markup: {
      inline_keyboard: buttons,
    },
  };
}

export function createSavedTemplatesKeyboard(activeSlot, hasSlot1, hasSlot2, hasSlot3) {
  return {
    reply_markup: {
      inline_keyboard: [
        // Slot selection - 2 columns
        [
          { text: activeSlot === 1 ? '🟢 Slot 1' : hasSlot1 ? '📦 Slot 1' : '⚪ Slot 1', callback_data: 'template_select_1' },
          { text: activeSlot === 2 ? '🟢 Slot 2' : hasSlot2 ? '📦 Slot 2' : '⚪ Slot 2', callback_data: 'template_select_2' }
        ],
        [
          { text: activeSlot === 3 ? '🟢 Slot 3' : hasSlot3 ? '📦 Slot 3' : '⚪ Slot 3', callback_data: 'template_select_3' },
          { text: activeSlot === null ? '🟢 None' : '⚪ None', callback_data: 'template_select_none' }
        ],
        // Actions
        [{ text: '🔄 Sync from Saved Messages', callback_data: 'template_sync' }],
        // Clear buttons - 3 columns
        [
          { text: '🗑️ Slot 1', callback_data: 'template_clear_1' },
          { text: '🗑️ Slot 2', callback_data: 'template_clear_2' },
          { text: '🗑️ Slot 3', callback_data: 'template_clear_3' }
        ],
        [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createAutoReplyMenu(dmEnabled = false, groupsEnabled = false) {
  const dmIcon = dmEnabled ? '✓' : '✗';
  const groupIcon = groupsEnabled ? '✓' : '✗';
  
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: `💬 DM [${dmIcon}]`, callback_data: 'btn_config_auto_reply_dm' },
          { text: `👥 Groups [${groupIcon}]`, callback_data: 'btn_config_auto_reply_groups' }
        ],
        [{ text: '← Back', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createIntervalMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        // Interval Options - 2 columns
        [
          { text: '📡 Broadcast Interval', callback_data: 'btn_config_custom_interval' },
          { text: '⏳ Group Delay', callback_data: 'btn_config_group_delay' }
        ],
        // Back - Full Width
        [{ text: '🔙 Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}

export function createMessagesMenu(forwardMode = false, savedMessagesUrl = null) {
  const forwardIcon = forwardMode ? '✓' : '✗';
  
  const keyboard = [
    // Message Setup
    [
      { text: '✏️ Set Message', callback_data: 'btn_set_start_msg' },
      { text: '📚 Pool', callback_data: 'btn_message_pool' }
    ],
    // Mode Toggle
    [{ text: `↗️ Forward Mode: ${forwardIcon}`, callback_data: 'btn_config_forward_mode' }],
  ];
  
  // Saved Messages Link
  if (savedMessagesUrl) {
    keyboard.push([{ text: '📱 Open Saved Messages', url: savedMessagesUrl }]);
  } else {
    keyboard.push([{ text: '📱 Open Saved Messages', callback_data: 'btn_go_to_saved_messages' }]);
  }
  
  keyboard.push([{ text: '← Back', callback_data: 'btn_main_menu' }]);
  
  return {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  };
}
