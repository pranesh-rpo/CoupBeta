/**
 * Group Blacklist Service
 * Manages group blacklist functionality
 */

import db from '../database/db.js';
import logger from '../utils/logger.js';

/**
 * Normalize text for search by:
 * 1. Converting special Unicode font variants to base ASCII characters
 * 2. Handling emojis (keeping text parts, normalizing emojis)
 * 3. Converting to lowercase
 * 4. Removing diacritics where possible
 */
function normalizeTextForSearch(text) {
  if (!text || typeof text !== 'string') {
    return '';
  }

  // Convert each character using correct Unicode mathematical alphanumeric ranges
  let normalized = Array.from(text).map(char => {
    const code = char.codePointAt(0);
    
    // Mathematical Bold: A-Z: U+1D400-U+1D419, a-z: U+1D41A-U+1D433
    if (code >= 0x1D400 && code <= 0x1D419) {
      return String.fromCharCode(0x41 + (code - 0x1D400)); // A-Z
    }
    if (code >= 0x1D41A && code <= 0x1D433) {
      return String.fromCharCode(0x61 + (code - 0x1D41A)); // a-z
    }
    
    // Mathematical Italic: A-Z: U+1D434-U+1D44D, a-z: U+1D44E-U+1D467
    if (code >= 0x1D434 && code <= 0x1D44D) {
      return String.fromCharCode(0x41 + (code - 0x1D434)); // A-Z
    }
    if (code >= 0x1D44E && code <= 0x1D467) {
      return String.fromCharCode(0x61 + (code - 0x1D44E)); // a-z
    }
    
    // Mathematical Bold Italic: A-Z: U+1D468-U+1D481, a-z: U+1D482-U+1D49B
    if (code >= 0x1D468 && code <= 0x1D481) {
      return String.fromCharCode(0x41 + (code - 0x1D468)); // A-Z
    }
    if (code >= 0x1D482 && code <= 0x1D49B) {
      return String.fromCharCode(0x61 + (code - 0x1D482)); // a-z
    }
    
    // Mathematical Script: A-Z: U+1D49C-U+1D4B5, a-z: U+1D4B6-U+1D4CF
    if (code >= 0x1D49C && code <= 0x1D4B5) {
      return String.fromCharCode(0x41 + (code - 0x1D49C)); // A-Z
    }
    if (code >= 0x1D4B6 && code <= 0x1D4CF) {
      return String.fromCharCode(0x61 + (code - 0x1D4B6)); // a-z
    }
    
    // Mathematical Bold Script: A-Z: U+1D4D0-U+1D4E9, a-z: U+1D4EA-U+1D503
    if (code >= 0x1D4D0 && code <= 0x1D4E9) {
      return String.fromCharCode(0x41 + (code - 0x1D4D0)); // A-Z
    }
    if (code >= 0x1D4EA && code <= 0x1D503) {
      return String.fromCharCode(0x61 + (code - 0x1D4EA)); // a-z
    }
    
    // Mathematical Fraktur: A-Z: U+1D504-U+1D51D, a-z: U+1D51E-U+1D537
    if (code >= 0x1D504 && code <= 0x1D51D) {
      return String.fromCharCode(0x41 + (code - 0x1D504)); // A-Z
    }
    if (code >= 0x1D51E && code <= 0x1D537) {
      return String.fromCharCode(0x61 + (code - 0x1D51E)); // a-z
    }
    
    // Mathematical Double-Struck: A-Z: U+1D538-U+1D551, a-z: U+1D552-U+1D56B
    if (code >= 0x1D538 && code <= 0x1D551) {
      return String.fromCharCode(0x41 + (code - 0x1D538)); // A-Z
    }
    if (code >= 0x1D552 && code <= 0x1D56B) {
      return String.fromCharCode(0x61 + (code - 0x1D552)); // a-z
    }
    
    // Mathematical Bold Fraktur: A-Z: U+1D56C-U+1D585, a-z: U+1D586-U+1D59F
    if (code >= 0x1D56C && code <= 0x1D585) {
      return String.fromCharCode(0x41 + (code - 0x1D56C)); // A-Z
    }
    if (code >= 0x1D586 && code <= 0x1D59F) {
      return String.fromCharCode(0x61 + (code - 0x1D586)); // a-z
    }
    
    // Mathematical Sans-Serif: A-Z: U+1D5A0-U+1D5B9, a-z: U+1D5BA-U+1D5D3
    if (code >= 0x1D5A0 && code <= 0x1D5B9) {
      return String.fromCharCode(0x41 + (code - 0x1D5A0)); // A-Z
    }
    if (code >= 0x1D5BA && code <= 0x1D5D3) {
      return String.fromCharCode(0x61 + (code - 0x1D5BA)); // a-z
    }
    
    // Mathematical Sans-Serif Bold: A-Z: U+1D5D4-U+1D5ED, a-z: U+1D5EE-U+1D607
    if (code >= 0x1D5D4 && code <= 0x1D5ED) {
      return String.fromCharCode(0x41 + (code - 0x1D5D4)); // A-Z
    }
    if (code >= 0x1D5EE && code <= 0x1D607) {
      return String.fromCharCode(0x61 + (code - 0x1D5EE)); // a-z
    }
    
    // Mathematical Sans-Serif Italic: A-Z: U+1D608-U+1D621, a-z: U+1D622-U+1D63B
    if (code >= 0x1D608 && code <= 0x1D621) {
      return String.fromCharCode(0x41 + (code - 0x1D608)); // A-Z
    }
    if (code >= 0x1D622 && code <= 0x1D63B) {
      return String.fromCharCode(0x61 + (code - 0x1D622)); // a-z
    }
    
    // Mathematical Sans-Serif Bold Italic: A-Z: U+1D63C-U+1D655, a-z: U+1D656-U+1D66F
    if (code >= 0x1D63C && code <= 0x1D655) {
      return String.fromCharCode(0x41 + (code - 0x1D63C)); // A-Z
    }
    if (code >= 0x1D656 && code <= 0x1D66F) {
      return String.fromCharCode(0x61 + (code - 0x1D656)); // a-z
    }
    
    // Mathematical Monospace: A-Z: U+1D670-U+1D689, a-z: U+1D68A-U+1D6A3
    if (code >= 0x1D670 && code <= 0x1D689) {
      return String.fromCharCode(0x41 + (code - 0x1D670)); // A-Z
    }
    if (code >= 0x1D68A && code <= 0x1D6A3) {
      return String.fromCharCode(0x61 + (code - 0x1D68A)); // a-z
    }
    
    // Fullwidth characters (U+FF01-FF5E) - convert to halfwidth
    if (code >= 0xFF01 && code <= 0xFF5E) {
      return String.fromCharCode(code - 0xFF00 + 0x20);
    }
    
    // Circled Latin letters: Ⓐ-Ⓩ (U+24B6-U+24CF) -> A-Z, ⓐ-ⓩ (U+24D0-U+24E9) -> a-z
    if (code >= 0x24B6 && code <= 0x24CF) {
      return String.fromCharCode(0x41 + (code - 0x24B6)); // A-Z
    }
    if (code >= 0x24D0 && code <= 0x24E9) {
      return String.fromCharCode(0x61 + (code - 0x24D0)); // a-z
    }
    
    // Regional Indicator Symbols (🇦-🇿) U+1F1E6-U+1F1FF -> A-Z
    if (code >= 0x1F1E6 && code <= 0x1F1FF) {
      return String.fromCharCode(0x41 + (code - 0x1F1E6)); // A-Z
    }
    
    // Squared Latin letters: 🄰-🅉 (U+1F130-U+1F149) -> A-Z
    if (code >= 0x1F130 && code <= 0x1F149) {
      return String.fromCharCode(0x41 + (code - 0x1F130)); // A-Z
    }
    
    // Negative Squared Latin: 🅰-🆉 (U+1F170-U+1F189) -> A-Z
    if (code >= 0x1F170 && code <= 0x1F189) {
      return String.fromCharCode(0x41 + (code - 0x1F170)); // A-Z
    }
    
    // Keep emojis and other characters as-is
    return char;
  }).join('');

  // Convert to lowercase for case-insensitive search
  normalized = normalized.toLowerCase();

  // Normalize Unicode (NFD to NFC) to handle diacritics consistently
  try {
    normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    normalized = normalized.normalize('NFC');
  } catch (e) {
    // If normalization fails, continue with what we have
  }

  return normalized;
}

class GroupBlacklistService {
  /**
   * Search groups by keyword
   * Handles special fonts and emojis by normalizing text before comparison
   */
  async searchGroups(accountId, keyword) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      
      // Normalize the search keyword
      const normalizedKeyword = normalizeTextForSearch(keyword);
      
      if (!normalizedKeyword && keyword.trim().length > 0) {
        // If keyword only contains emojis/special chars, search for exact match
        // Fetch all groups and filter in JavaScript
        const result = await db.query(
          `SELECT id, group_id, group_title 
           FROM groups 
           WHERE account_id = $1 
             AND is_active = TRUE 
           ORDER BY group_title
           LIMIT 100`,
          [accountIdNum]
        );
        
        // Filter groups that contain the keyword (case-insensitive, handling emojis)
        const filtered = result.rows.filter(group => {
          const title = group.group_title || '';
          return title.includes(keyword) || normalizeTextForSearch(title).includes(normalizeTextForSearch(keyword));
        });
        
        return { success: true, groups: filtered.slice(0, 20) };
      }
      
      // Fetch all active groups for the account
      const result = await db.query(
        `SELECT id, group_id, group_title 
         FROM groups 
         WHERE account_id = $1 
           AND is_active = TRUE 
         ORDER BY group_title
         LIMIT 100`,
        [accountIdNum]
      );
      
      // Filter groups by normalized text matching
      const matchingGroups = result.rows.filter(group => {
        const groupTitle = group.group_title || '';
        const normalizedTitle = normalizeTextForSearch(groupTitle);
        
        // Check if normalized title contains normalized keyword
        // Also check original title for emoji/exact matches (case-insensitive)
        const keywordLower = keyword.toLowerCase();
        const titleLower = groupTitle.toLowerCase();
        
        return normalizedTitle.includes(normalizedKeyword) || 
               titleLower.includes(keywordLower) ||
               groupTitle.includes(keyword); // For emoji/exact character matches
      });
      
      // Sort by relevance (exact matches first, then partial matches)
      matchingGroups.sort((a, b) => {
        const aTitle = normalizeTextForSearch(a.group_title || '');
        const bTitle = normalizeTextForSearch(b.group_title || '');
        const aExact = aTitle === normalizedKeyword || aTitle.startsWith(normalizedKeyword);
        const bExact = bTitle === normalizedKeyword || bTitle.startsWith(normalizedKeyword);
        
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
        return (a.group_title || '').localeCompare(b.group_title || '');
      });
      
      return { success: true, groups: matchingGroups.slice(0, 20) };
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to search groups');
      return { success: false, error: error.message, groups: [] };
    }
  }

  /**
   * Add group to blacklist
   */
  async addToBlacklist(accountId, groupId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const groupIdNum = typeof groupId === 'string' ? parseInt(groupId) : groupId;
      
      // Get group title
      const groupResult = await db.query(
        'SELECT group_title FROM groups WHERE account_id = $1 AND group_id = $2',
        [accountIdNum, groupIdNum]
      );
      
      if (groupResult.rows.length === 0) {
        return { success: false, error: 'Group not found' };
      }
      
      const groupTitle = groupResult.rows[0]?.group_title;
      
      // Check if already blacklisted
      const existing = await db.query(
        'SELECT id FROM group_filters WHERE account_id = $1 AND group_id = $2 AND filter_type = $3',
        [accountIdNum, groupIdNum, 'blacklist']
      );
      
      if (existing.rows.length > 0) {
        return { success: false, error: 'Group already blacklisted' };
      }
      
      // Add to blacklist
      await db.query(
        `INSERT INTO group_filters (account_id, filter_type, group_id, is_active)
         VALUES ($1, 'blacklist', $2, 1)`,
        [accountIdNum, groupIdNum]
      );
      
      logger.logChange('BLACKLIST', accountId, `Added group "${groupTitle}" to blacklist`);
      return { success: true, groupTitle };
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to add to blacklist');
      return { success: false, error: error.message };
    }
  }

  /**
   * Remove group from blacklist
   */
  async removeFromBlacklist(accountId, groupId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const groupIdNum = typeof groupId === 'string' ? parseInt(groupId) : groupId;
      
      await db.query(
        `UPDATE group_filters 
         SET is_active = 0 
         WHERE account_id = $1 AND group_id = $2 AND filter_type = 'blacklist'`,
        [accountIdNum, groupIdNum]
      );
      
      logger.logChange('BLACKLIST', accountId, `Removed group from blacklist`);
      return { success: true };
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to remove from blacklist');
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all blacklisted groups
   */
  async getBlacklistedGroups(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      
      const result = await db.query(
        `SELECT gf.group_id, g.group_title
         FROM group_filters gf
         LEFT JOIN groups g ON gf.account_id = g.account_id AND gf.group_id = g.group_id
         WHERE gf.account_id = $1 
           AND gf.filter_type = 'blacklist' 
           AND gf.is_active = 1
         ORDER BY g.group_title`,
        [accountIdNum]
      );
      
      return { success: true, groups: result.rows };
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to get blacklisted groups');
      return { success: false, error: error.message, groups: [] };
    }
  }

  /**
   * Check if group is blacklisted
   */
  async isBlacklisted(accountId, groupId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      const groupIdNum = typeof groupId === 'string' ? parseInt(groupId) : groupId;
      
      const result = await db.query(
        `SELECT 1 FROM group_filters 
         WHERE account_id = $1 
           AND group_id = $2 
           AND filter_type = 'blacklist' 
           AND is_active = 1`,
        [accountIdNum, groupIdNum]
      );
      
      return result.rows.length > 0;
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to check blacklist');
      return false;
    }
  }

  /**
   * Get all blacklisted group IDs for an account (optimized batch check)
   * Returns a Set for O(1) lookup performance
   * @param {number} accountId - Account ID
   * @returns {Promise<Set<string|number>>} Set of blacklisted group IDs
   */
  async getBlacklistedGroupIdsSet(accountId) {
    try {
      const accountIdNum = typeof accountId === 'string' ? parseInt(accountId) : accountId;
      
      const result = await db.query(
        `SELECT group_id FROM group_filters 
         WHERE account_id = $1 
           AND filter_type = 'blacklist' 
           AND is_active = 1`,
        [accountIdNum]
      );
      
      // Return Set for O(1) lookup - convert all IDs to strings for consistent comparison
      const blacklistedSet = new Set();
      result.rows.forEach(row => {
        if (row.group_id !== null && row.group_id !== undefined) {
          blacklistedSet.add(row.group_id.toString());
        }
      });
      
      return blacklistedSet;
    } catch (error) {
      logger.logError('BLACKLIST', accountId, error, 'Failed to get blacklisted group IDs');
      return new Set(); // Return empty set on error
    }
  }
}

export default new GroupBlacklistService();




