import automationService from '../services/automationService.js';
import accountLinker from '../services/accountLinker.js';
import messageService from '../services/messageService.js';
import premiumService from '../services/premiumService.js';

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
 * Generate status text for the main menu
 */
export async function generateStatusText(userId) {
  if (!userId) {
    return '';
  }

  try {
    const isLinked = accountLinker.isLinked(userId);
    const accounts = await accountLinker.getAccounts(userId);
    const activeAccountId = accountLinker.getActiveAccountId(userId);
    
    // Check if broadcast is running for the current active account
    const isBroadcasting = activeAccountId ? automationService.isBroadcasting(userId, activeAccountId) : false;
    const broadcastingAccountId = automationService.getBroadcastingAccountId(userId);

    // Modern status display with better formatting
    let statusText = '\n\n━━━━━━━━━━━━━━━━━━\n';
    
    if (isLinked && accounts.length > 0) {
      const activeAccount = accounts.find(acc => acc.accountId === activeAccountId);
      const displayName = activeAccount ? (activeAccount.firstName || activeAccount.phone) : 'None';
      statusText += `👤 <b>Account:</b> ${escapeHtml(displayName)}\n`;
      
      if (isBroadcasting) {
        statusText += `📡 <b>Broadcast:</b> <code>🟢 Active</code>\n`;
      } else {
        statusText += `📡 <b>Broadcast:</b> <code>⚪ Inactive</code>\n`;
      }
    } else {
      statusText += `👤 <b>Account:</b> <code>Not linked</code>\n`;
    }
    
    statusText += '━━━━━━━━━━━━━━━━━━';

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
      // Check if broadcast is running for the current active account
      const activeAccountId = accountLinker.getActiveAccountId(userId);
      isBroadcasting = activeAccountId ? automationService.isBroadcasting(userId, activeAccountId) : false;
    } catch (error) {
      // If check fails, default to false
      isBroadcasting = false;
    }
  }

  // Show toggle button based on broadcast state with modern design
  const broadcastButton = isBroadcasting
    ? [{ text: '🟢 Broadcast Active', callback_data: 'btn_start_broadcast' }]
    : [{ text: '🚀 Start Broadcast', callback_data: 'btn_start_broadcast' }];

  // Get account info to show in button text
  let accountButtonText = '👤 Manage Account';
  let premiumButtonText = '⭐ Premium';
  if (userId) {
    try {
      const accounts = await accountLinker.getAccounts(userId);
      const activeAccountId = accountLinker.getActiveAccountId(userId);
      
      if (activeAccountId && accounts.length > 0) {
        const activeAccount = accounts.find(acc => acc.accountId === activeAccountId);
        if (activeAccount && activeAccount.firstName) {
          accountButtonText = `👤 ${escapeHtml(activeAccount.firstName)}`;
        } else if (activeAccount && activeAccount.phone) {
          accountButtonText = `👤 ${escapeHtml(activeAccount.phone)}`;
        }
      }

      // Premium button is just the star symbol
      premiumButtonText = '⭐';
    } catch (error) {
      // If check fails, use default text
      console.log(`[KEYBOARD] Error getting account info: ${error.message}`);
    }
  }

  return {
    reply_markup: {
      inline_keyboard: [
        // Account Management - Full Width (Top Priority)
        [{ text: accountButtonText, callback_data: 'btn_account' }],
        // Premium - Full Width (Prominent)
        [{ text: premiumButtonText, callback_data: 'btn_premium' }],
        // Core Functions - 2 columns (most used)
        [
          { text: '💬 Messages', callback_data: 'btn_messages_menu' },
          { text: '⚙️ Settings', callback_data: 'btn_config' }
        ],
        // Advanced Features - 2 columns
        [
          { text: '📊 Statistics', callback_data: 'btn_stats' },
          { text: '🔔 Mentions', callback_data: 'btn_mention' }
        ],
        // Additional Tools - Full Width
        [{ text: '💬 Auto Reply', callback_data: 'btn_auto_reply' }],
        // Groups - Full Width
        [{ text: '👥 Groups', callback_data: 'btn_groups' }],
        // Broadcast Control - Moved Down (Full Width)
        broadcastButton,
        // Support - Full Width
        [{ text: '💬 Get Support', url: 'https://t.me/CoupSupportBot' }],
      ],
    },
  };
}

export function createGroupsMenu(groupDelayMin = null, groupDelayMax = null, blacklistCount = 0) {
  const groupDelayText = groupDelayMin !== null && groupDelayMax !== null
    ? `${groupDelayMin}-${groupDelayMax}s`
    : 'Default (5-10s)';
  
  return {
    reply_markup: {
      inline_keyboard: [
        // Group Management Actions - 2 per row
        [
          { text: '🔄 Refresh Groups', callback_data: 'btn_refresh_groups' },
          { text: '📋 List Groups', callback_data: 'btn_list_groups' }
        ],
        // Group Settings - 2 per row
        [
          { text: '⏳ Group Delay', callback_data: 'btn_config_group_delay' },
          { text: '🚫 Blacklist', callback_data: 'btn_config_blacklist' }
        ],
        // Back - Full Width
        [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createAccountSwitchKeyboard(accounts, currentAccountId) {
  const buttons = accounts.map(account => {
    const prefix = account.isActive ? '🟢' : '⚪';
    // Use first name if available, otherwise fallback to phone number
    const displayName = account.firstName || account.phone;
    // Note: Button text doesn't need HTML escaping, but we'll escape it anyway for safety
    return [
      {
        text: `${prefix} ${displayName}${account.isActive ? ' (Active)' : ''}`,
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

export function createConfigMenu(currentInterval = 11, quietHours = null, forwardMode = false) {
  return {
    reply_markup: {
      inline_keyboard: [
        // Core Broadcast Settings - 2 per row
        [
          { text: '⏱️ Interval', callback_data: 'btn_config_interval_menu' },
          { text: '🌙 Quiet Hours', callback_data: 'btn_config_quiet_hours' }
        ],
        [
          { text: '📅 Schedule', callback_data: 'btn_config_schedule' },
          { text: '📤 Forward Mode', callback_data: 'btn_config_forward_mode' }
        ],
        // Back - Full Width
        [{ text: '🔙 Back', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

// Removed createRateLimitKeyboard - replaced with custom interval input

export function createQuietHoursKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '➕ Set Quiet Hours', callback_data: 'config_quiet_set' },
          { text: '👁️ View', callback_data: 'config_quiet_view' }
        ],
        [{ text: '🗑️ Clear', callback_data: 'config_quiet_clear' }],
        [{ text: '🔙 Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}


export function createScheduleKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '➕ Set Schedule', callback_data: 'config_schedule_normal' },
          { text: '👁️ View', callback_data: 'config_schedule_view' }
        ],
        [{ text: '🗑️ Clear', callback_data: 'config_schedule_clear' }],
        [{ text: '🔙 Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}


export function createMessagePoolKeyboard(poolSize, poolMode = 'random', usePool = false) {
  const buttons = [];
  
  // Main actions
  buttons.push([
    { text: '➕ Add Message', callback_data: 'pool_add_message' },
    { text: '👁️ View Pool', callback_data: 'pool_view_messages' }
  ]);
  
  // Enable/Disable toggle
  buttons.push([
    { text: usePool ? '✅ Enabled' : '❌ Disabled', callback_data: 'pool_toggle' }
  ]);
  
  // Mode selection - 3 modes
  buttons.push([
    { text: poolMode === 'random' ? '🟢 🎲 Random' : '⚪ 🎲 Random', callback_data: 'pool_mode_random' },
    { text: poolMode === 'rotate' ? '🟢 🔄 Rotate' : '⚪ 🔄 Rotate', callback_data: 'pool_mode_rotate' }
  ]);
  buttons.push([
    { text: poolMode === 'sequential' ? '🟢 ➡️ Sequential' : '⚪ ➡️ Sequential', callback_data: 'pool_mode_sequential' }
  ]);
  
  if (poolSize > 0) {
    buttons.push([
      { text: `🗑️ Clear Pool (${poolSize})`, callback_data: 'pool_clear_confirm' },
      { text: '📋 Export', callback_data: 'pool_export' }
    ]);
  }
  
  buttons.push([{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }]);
  
  return {
    reply_markup: {
      inline_keyboard: buttons,
    },
  };
}

export function createMessagePoolListKeyboard(messages, page = 0, pageSize = 5) {
  const buttons = [];
  const start = page * pageSize;
  const end = Math.min(start + pageSize, messages.length);
  const pageMessages = messages.slice(start, end);
  
  // Message buttons
  pageMessages.forEach((msg, idx) => {
    const displayText = msg.text.length > 30 ? msg.text.substring(0, 30) + '...' : msg.text;
    buttons.push([
      { text: `📝 ${start + idx + 1}. ${displayText}`, callback_data: `pool_view_${msg.id}` }
    ]);
    buttons.push([
      { text: '🗑️ Delete', callback_data: `pool_delete_${msg.id}` }
    ]);
  });
  
  // Pagination
  if (messages.length > pageSize) {
    const navButtons = [];
    if (page > 0) {
      navButtons.push({ text: '◀️ Prev', callback_data: `pool_page_${page - 1}` });
    }
    if (end < messages.length) {
      navButtons.push({ text: 'Next ▶️', callback_data: `pool_page_${page + 1}` });
    }
    if (navButtons.length > 0) {
      buttons.push(navButtons);
    }
  }
  
  buttons.push([{ text: '🔙 Back to Pool', callback_data: 'pool_menu' }]);
  
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

export function createAutoReplyMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        // Auto Reply Options - 2 per row
        [
          { text: '💬 Auto Reply DM', callback_data: 'btn_config_auto_reply_dm' },
          { text: '💬 Auto Reply Groups', callback_data: 'btn_config_auto_reply_groups' }
        ],
        // Back - Full Width
        [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createIntervalMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        // Interval Options - 2 per row
        [
          { text: '📡 Broadcast Interval', callback_data: 'btn_config_custom_interval' },
          { text: '💬 Auto Reply Interval', callback_data: 'auto_reply_set_interval' }
        ],
        // Back - Full Width
        [{ text: '🔙 Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}

export function createMessagesMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        // Message Options - 2 per row
        [
          { text: '✍️ Set Message', callback_data: 'btn_set_start_msg' },
          { text: '🎲 Message Pool', callback_data: 'btn_message_pool' }
        ],
        // Back - Full Width
        [{ text: '🔙 Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}
