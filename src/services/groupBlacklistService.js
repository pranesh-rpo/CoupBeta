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

  let normalized = text;

  // Helper function to convert Unicode font variant to base ASCII
  const convertFontVariant = (code, baseOffset, baseChar) => {
    if (code >= baseOffset && code < baseOffset + 26) {
      return String.fromCharCode(baseChar + (code - baseOffset));
    }
    return null;
  };

  // Convert each character
  normalized = Array.from(normalized).map(char => {
    const code = char.codePointAt(0);
    
    // Mathematical Bold (U+1D400-1D433 for A-Z, U+1D434-1D45D for a-z)
    if (code >= 0x1D400 && code <= 0x1D433) {
      return String.fromCharCode(0x41 + (code - 0x1D400)); // A-Z
    }
    if (code >= 0x1D434 && code <= 0x1D45D) {
      return String.fromCharCode(0x61 + (code - 0x1D434)); // a-z
    }
    
    // Mathematical Italic (U+1D434-1D45D for A-Z, U+1D45E-1D487 for a-z)
    // Note: U+1D434-1D45D overlaps with bold, handle italic separately
    if (code >= 0x1D45E && code <= 0x1D487) {
      return String.fromCharCode(0x61 + (code - 0x1D45E)); // a-z
    }
    
    // Mathematical Bold Italic (U+1D468-1D491 for A-Z, U+1D492-1D4BB for a-z)
    if (code >= 0x1D468 && code <= 0x1D491) {
      return String.fromCharCode(0x41 + (code - 0x1D468)); // A-Z
    }
    if (code >= 0x1D492 && code <= 0x1D4BB) {
      return String.fromCharCode(0x61 + (code - 0x1D492)); // a-z
    }
    
    // Mathematical Script (U+1D49C-1D4C5 for A-Z, U+1D4C6-1D4EF for a-z)
    if (code >= 0x1D49C && code <= 0x1D4C5) {
      return String.fromCharCode(0x41 + (code - 0x1D49C)); // A-Z
    }
    if (code >= 0x1D4C6 && code <= 0x1D4EF) {
      return String.fromCharCode(0x61 + (code - 0x1D4C6)); // a-z
    }
    
    // Mathematical Fraktur (U+1D504-1D51D for A-Z, U+1D51E-1D547 for a-z)
    if (code >= 0x1D504 && code <= 0x1D51D) {
      return String.fromCharCode(0x41 + (code - 0x1D504)); // A-Z
    }
    if (code >= 0x1D51E && code <= 0x1D547) {
      return String.fromCharCode(0x61 + (code - 0x1D51E)); // a-z
    }
    
    // Mathematical Double-Struck (U+1D538-1D551 for A-Z, U+1D552-1D56B for a-z)
    if (code >= 0x1D538 && code <= 0x1D551) {
      return String.fromCharCode(0x41 + (code - 0x1D538)); // A-Z
    }
    if (code >= 0x1D552 && code <= 0x1D56B) {
      return String.fromCharCode(0x61 + (code - 0x1D552)); // a-z
    }
    
    // Mathematical Sans-Serif (U+1D5A0-1D5B9 for A-Z, U+1D5BA-1D5D3 for a-z)
    if (code >= 0x1D5A0 && code <= 0x1D5B9) {
      return String.fromCharCode(0x41 + (code - 0x1D5A0)); // A-Z
    }
    if (code >= 0x1D5BA && code <= 0x1D5D3) {
      return String.fromCharCode(0x61 + (code - 0x1D5BA)); // a-z
    }
    
    // Mathematical Sans-Serif Bold (U+1D5D4-1D5ED for A-Z, U+1D5EE-1D607 for a-z)
    if (code >= 0x1D5D4 && code <= 0x1D5ED) {
      return String.fromCharCode(0x41 + (code - 0x1D5D4)); // A-Z
    }
    if (code >= 0x1D5EE && code <= 0x1D607) {
      return String.fromCharCode(0x61 + (code - 0x1D5EE)); // a-z
    }
    
    // Mathematical Monospace (U+1D670-1D689 for A-Z, U+1D68A-1D69B for a-z)
    if (code >= 0x1D670 && code <= 0x1D689) {
      return String.fromCharCode(0x41 + (code - 0x1D670)); // A-Z
    }
    if (code >= 0x1D68A && code <= 0x1D69B) {
      return String.fromCharCode(0x61 + (code - 0x1D68A)); // a-z
    }
    
    // Fullwidth characters (U+FF01-FF5E) - convert to halfwidth
    if (code >= 0xFF01 && code <= 0xFF5E) {
      return String.fromCharCode(code - 0xFF00 + 0x20);
    }
    
    // Keep emojis and other characters as-is for now
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
      
      const groupTitle = groupResult.rows[0].group_title;
      
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




