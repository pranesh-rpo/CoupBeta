import automationService from '../services/automationService.js';
import accountLinker from '../services/accountLinker.js';
import messageService from '../services/messageService.js';

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

    let statusText = '\n\n📊 <b>Status</b>\n';
    statusText += `🔗 <b>Account:</b> ${isLinked ? '✅ Linked' : '❌ Not linked'}\n`;

    if (isLinked && accounts.length > 0) {
      const activeAccount = accounts.find(acc => acc.accountId === activeAccountId);
      const displayName = activeAccount ? (activeAccount.firstName || activeAccount.phone) : 'None';
      statusText += `👤 <b>Active:</b> ${displayName}\n`;
      if (accounts.length > 1) {
        statusText += `📋 <b>Total:</b> ${accounts.length} accounts\n`;
      }
    }

    // Show broadcast status - if broadcasting for a different account, show which one
    if (isBroadcasting) {
      statusText += `📢 <b>Broadcast:</b> ✅ <b>Active</b> (this account)\n`;
    } else if (broadcastingAccountId && broadcastingAccountId !== activeAccountId) {
      const broadcastingAccount = accounts.find(acc => acc.accountId === broadcastingAccountId);
      const broadcastName = broadcastingAccount ? (broadcastingAccount.firstName || broadcastingAccount.phone) : `Account ${broadcastingAccountId}`;
      statusText += `📢 <b>Broadcast:</b> ✅ <b>Active</b> (${broadcastName})\n`;
    } else {
      statusText += `📢 <b>Broadcast:</b> ❌ Inactive\n`;
    }

    // Get message info
    if (activeAccountId) {
      const currentMessage = await messageService.getActiveMessage(activeAccountId);
      if (currentMessage) {
        const preview = currentMessage.length > 50 
          ? currentMessage.substring(0, 50) + '...' 
          : currentMessage;
        // Escape HTML to prevent tags from being rendered
        const escapeHtml = (text) => {
          if (!text) return '';
          return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        };
        statusText += `📝 <b>Message:</b> <i>${escapeHtml(preview)}</i>\n`;
      } else {
        statusText += `📝 <b>Message:</b> <i>Not set</i>\n`;
      }
    } else if (isLinked) {
      statusText += `📝 <b>Message:</b> <i>Not set</i>\n`;
    }

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

  // Show toggle button based on broadcast state
  const broadcastButton = isBroadcasting
    ? [{ text: '✅ Started', callback_data: 'btn_start_broadcast' }]
    : [{ text: '▶️ Start Broadcast', callback_data: 'btn_start_broadcast' }];

  // Get account info to show in button text
  let accountButtonText = '👤 Account';
  if (userId) {
    try {
      const accounts = await accountLinker.getAccounts(userId);
      const activeAccountId = accountLinker.getActiveAccountId(userId);
      
      if (activeAccountId && accounts.length > 0) {
        const activeAccount = accounts.find(acc => acc.accountId === activeAccountId);
        if (activeAccount && activeAccount.firstName) {
          accountButtonText = `👤 ${activeAccount.firstName}`;
        } else if (activeAccount && activeAccount.phone) {
          accountButtonText = `👤 ${activeAccount.phone}`;
        }
      }
    } catch (error) {
      // If check fails, use default text
      console.log(`[KEYBOARD] Error getting account info: ${error.message}`);
    }
  }

  return {
    reply_markup: {
      inline_keyboard: [
        // Account section - full width
        [{ text: accountButtonText, callback_data: 'btn_account' }],
        // Messages section - 2 columns
        [
          { text: '📝 Set Message', callback_data: 'btn_set_start_msg' },
          { text: '🔄 A/B Testing', callback_data: 'btn_ab_messages' }
        ],
        [{ text: '💎 Saved Templates', callback_data: 'btn_saved_templates' }],
        // Management section - 2 columns
        [
          { text: '👥 Groups', callback_data: 'btn_groups' },
          { text: '📊 Statistics', callback_data: 'btn_stats' }
        ],
        [
          { text: '⚙️ Settings', callback_data: 'btn_config' },
          { text: '👥 Mentions', callback_data: 'btn_mention' }
        ],
        // Support button - full width
        [{ text: '💬 Support Bot', url: 'https://t.me/HelpmeOrabot' }],
        // Broadcast control - full width, prominent
        broadcastButton,
      ],
    },
  };
}

export function createGroupsMenu() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔄 Refresh Groups', callback_data: 'btn_refresh_groups' },
          { text: '📋 List Groups', callback_data: 'btn_list_groups' }
        ],
        [{ text: '◀️ Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createAccountSwitchKeyboard(accounts, currentAccountId) {
  const buttons = accounts.map(account => {
    const prefix = account.isActive ? '✅' : '⚪';
    // Use first name if available, otherwise fallback to phone number
    const displayName = account.firstName || account.phone;
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
  
  buttons.push([{ text: '◀️ Back to Menu', callback_data: 'btn_main_menu' }]);
  
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
        [{ text: '◀️ Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createStopButton() {
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🛑 Stop Broadcast', callback_data: 'stop_broadcast' }],
        [{ text: '◀️ Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createConfigMenu(currentPreset = 'default', quietHours = null, abMode = false, abModeType = 'single') {
  const presetLabels = {
    '1': '1 msg/hr',
    '3': '3 msg/hr',
    '5': '5 msg/hr',
    'default': 'Default',
    'custom': 'Custom'
  };
  
  const quietHoursText = quietHours && quietHours.start && quietHours.end 
    ? `${quietHours.start} - ${quietHours.end}` 
    : 'Not set';
  
  const abModeText = abMode ? `${abModeType.charAt(0).toUpperCase() + abModeType.slice(1)}` : 'Disabled';
  
  return {
    reply_markup: {
      inline_keyboard: [
        // Rate limiting and timing
        [
          { text: '⚡ Rate Limit', callback_data: 'btn_config_rate_limit' },
          { text: `🌙 ${quietHoursText === 'Not set' ? 'Quiet Hours' : quietHoursText}`, callback_data: 'btn_config_quiet_hours' }
        ],
        // A/B testing
        [{ text: `🔄 ${abModeText}`, callback_data: 'btn_config_ab' }],
        // Schedule
        [{ text: '⏰ Schedule', callback_data: 'btn_config_schedule' }],
        [{ text: '◀️ Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createRateLimitKeyboard(currentPreset = 'default') {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: currentPreset === '1' ? '✅ 1/hr' : '1/hr', callback_data: 'config_rate_1' },
          { text: currentPreset === '3' ? '✅ 3/hr' : '3/hr', callback_data: 'config_rate_3' }
        ],
        [
          { text: currentPreset === '5' ? '✅ 5/hr' : '5/hr', callback_data: 'config_rate_5' },
          { text: currentPreset === 'default' ? '✅ Default' : 'Default', callback_data: 'config_rate_default' }
        ],
        [{ text: '◀️ Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}

export function createQuietHoursKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '⏰ Set Quiet Hours', callback_data: 'config_quiet_set' },
          { text: '📋 View', callback_data: 'config_quiet_view' }
        ],
        [{ text: '❌ Clear', callback_data: 'config_quiet_clear' }],
        [{ text: '◀️ Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}

export function createABModeKeyboard(abMode = false, abModeType = 'single') {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: abMode && abModeType === 'single' ? '✅ Single' : 'Single', callback_data: 'config_ab_single' },
          { text: abMode && abModeType === 'rotate' ? '✅ Rotate' : 'Rotate', callback_data: 'config_ab_rotate' }
        ],
        [
          { text: abMode && abModeType === 'split' ? '✅ Split' : 'Split', callback_data: 'config_ab_split' },
          { text: !abMode ? '✅ Disabled' : 'Disable', callback_data: 'config_ab_disable' }
        ],
        [{ text: '◀️ Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}

export function createScheduleKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '⏰ Set Schedule', callback_data: 'config_schedule_normal' },
          { text: '📋 View', callback_data: 'config_schedule_view' }
        ],
        [{ text: '❌ Clear', callback_data: 'config_schedule_clear' }],
        [{ text: '◀️ Back to Settings', callback_data: 'btn_config' }],
      ],
    },
  };
}

export function createABMessagesKeyboard(hasA, hasB) {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: hasA ? '✅ Message A' : '📝 Message A', callback_data: 'ab_set_a' },
          { text: hasB ? '✅ Message B' : '📝 Message B', callback_data: 'ab_set_b' }
        ],
        [{ text: '👁️ View Messages', callback_data: 'ab_view_messages' }],
        [{ text: '◀️ Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}

export function createSavedTemplatesKeyboard(activeSlot, hasSlot1, hasSlot2, hasSlot3) {
  return {
    reply_markup: {
      inline_keyboard: [
        // Slot selection - 2 columns
        [
          { text: activeSlot === 1 ? '✅ Slot 1' : hasSlot1 ? '📦 Slot 1' : '⬜ Slot 1', callback_data: 'template_select_1' },
          { text: activeSlot === 2 ? '✅ Slot 2' : hasSlot2 ? '📦 Slot 2' : '⬜ Slot 2', callback_data: 'template_select_2' }
        ],
        [
          { text: activeSlot === 3 ? '✅ Slot 3' : hasSlot3 ? '📦 Slot 3' : '⬜ Slot 3', callback_data: 'template_select_3' },
          { text: activeSlot === null ? '✅ None' : '⚪ None', callback_data: 'template_select_none' }
        ],
        // Actions
        [{ text: '🔄 Sync from Saved Messages', callback_data: 'template_sync' }],
        // Clear buttons - 3 columns
        [
          { text: '🗑️ Slot 1', callback_data: 'template_clear_1' },
          { text: '🗑️ Slot 2', callback_data: 'template_clear_2' },
          { text: '🗑️ Slot 3', callback_data: 'template_clear_3' }
        ],
        [{ text: '◀️ Back to Menu', callback_data: 'btn_main_menu' }],
      ],
    },
  };
}
