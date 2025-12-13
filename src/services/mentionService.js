/**
 * Mention Service
 * Handles auto-mentioning users in group messages
 */

import db from '../database/db.js';
import { logError } from '../utils/logger.js';

class MentionService {
  /**
   * Get recent message senders from a group
   * @param {Object} client - Telegram client
   * @param {Object} groupEntity - Group entity
   * @param {number} limit - Number of users to get (default: 5)
   * @param {number} excludeUserId - User ID to exclude (the account sending the message)
   * @returns {Promise<Array>} Array of user entities
   */
  async getMostActiveUsers(client, groupEntity, limit = 5, excludeUserId = null) {
    try {
      console.log(`[MENTION] Getting recent message senders for group ${groupEntity.id?.toString() || groupEntity.id}`);
      if (excludeUserId) {
        console.log(`[MENTION] Excluding own user ID: ${excludeUserId}`);
      }
      
      // Get recent messages from the group to find who sent them
      let messages = [];
      try {
        messages = await client.getMessages(groupEntity, {
          limit: Math.min(limit * 10, 100), // Get more messages to find unique senders
        });
        console.log(`[MENTION] Got ${messages?.length || 0} recent messages`);
      } catch (error) {
        console.log(`[MENTION] Could not get messages: ${error.message}, falling back to participants`);
        // Fallback to participants if messages fail
        return await this.getUsersFromParticipants(client, groupEntity, limit, excludeUserId);
      }

      if (!messages || messages.length === 0) {
        console.log(`[MENTION] No messages found, falling back to participants`);
        return await this.getUsersFromParticipants(client, groupEntity, limit, excludeUserId);
      }

      // Extract unique user IDs from message senders
      // Skip messages from the account itself and find other users
      const userMap = new Map(); // userId -> { userId, accessHash, entity, lastMessageDate }
      
      for (const message of messages) {
        if (!message) continue;
        
        let userId = null;
        let accessHash = null;
        let userEntity = null;
        
        // Method 1: Extract from message.author (most reliable for user messages)
        if (message.author) {
          if (message.author.className === 'User') {
            // Direct User object
            if (message.author.id !== undefined && message.author.id !== null) {
              if (typeof message.author.id === 'object') {
                // Handle nested id structure: author.id.id.rawValue
                if (message.author.id.id && message.author.id.id.rawValue !== undefined) {
                  userId = message.author.id.id.rawValue;
                } else if (message.author.id.value !== undefined) {
                  userId = message.author.id.value;
                } else if (message.author.id.rawValue !== undefined) {
                  userId = message.author.id.rawValue;
                } else if (typeof message.author.id.valueOf === 'function') {
                  userId = message.author.id.valueOf();
                }
              } else if (typeof message.author.id === 'number' || typeof message.author.id === 'bigint') {
                userId = message.author.id;
              }
            }
            
            // Extract accessHash from author
            if (message.author.accessHash !== undefined && message.author.accessHash !== null) {
              if (typeof message.author.accessHash === 'object') {
                // Handle nested accessHash: author.accessHash.personal
                if (message.author.accessHash.personal !== undefined) {
                  accessHash = message.author.accessHash.personal;
                } else if (message.author.accessHash.value !== undefined) {
                  accessHash = message.author.accessHash.value;
                } else if (message.author.accessHash.rawValue !== undefined) {
                  accessHash = message.author.accessHash.rawValue;
                } else if (typeof message.author.accessHash.valueOf === 'function') {
                  accessHash = message.author.accessHash.valueOf();
                }
              } else {
                accessHash = message.author.accessHash;
              }
            }
            
            // Store user entity directly if available
            userEntity = message.author;
          }
        }
        
        // Method 2: Extract from message.fromId (fallback)
        if (!userId && message.fromId) {
          if (message.fromId.className === 'PeerUser') {
            userId = message.fromId.userId;
          } else if (message.fromId && typeof message.fromId === 'object' && message.fromId.userId) {
            userId = message.fromId.userId;
          }
        }
        
        // Method 3: Extract from message.senderId (fallback)
        if (!userId && message.senderId) {
          if (message.senderId.className === 'PeerUser') {
            userId = message.senderId.userId;
          } else if (typeof message.senderId === 'object' && message.senderId.userId) {
            userId = message.senderId.userId;
          }
        }
        
        // Skip if no userId
        if (!userId) {
          console.log(`[MENTION] Could not extract userId from message, skipping`);
          continue;
        }
        
        // Convert userId to number
        const userIdNum = typeof userId === 'bigint' ? Number(userId) : 
                         typeof userId === 'number' ? userId : 
                         parseInt(userId);
        
        if (isNaN(userIdNum)) {
          console.log(`[MENTION] Invalid userId extracted: ${userId}, skipping`);
          continue;
        }
        
        // ALWAYS skip excluded user (account itself) - don't mention yourself
        if (excludeUserId && userIdNum === excludeUserId) {
          console.log(`[MENTION] Skipping excluded user ID (account itself): ${userIdNum}`);
          continue;
        }
        
        // Skip if we already processed this user
        if (userMap.has(userIdNum)) {
          continue;
        }
        
        // If we have userEntity from author, use it directly
        if (userEntity && userEntity.className === 'User') {
          // Skip bots
          if (userEntity.bot) {
            console.log(`[MENTION] Skipping bot user: ${userIdNum}`);
            continue;
          }
          
          // Ensure accessHash is extracted properly
          if (!accessHash && userEntity.accessHash) {
            if (typeof userEntity.accessHash === 'object') {
              if (userEntity.accessHash.personal !== undefined) {
                accessHash = userEntity.accessHash.personal;
              } else if (userEntity.accessHash.value !== undefined) {
                accessHash = userEntity.accessHash.value;
              } else if (userEntity.accessHash.rawValue !== undefined) {
                accessHash = userEntity.accessHash.rawValue;
              }
            } else {
              accessHash = userEntity.accessHash;
            }
          }
          
          // Convert accessHash to BigInt if needed
          let accessHashBigInt = null;
          if (accessHash !== null && accessHash !== undefined) {
            accessHashBigInt = typeof accessHash === 'bigint' ? accessHash : BigInt(accessHash);
          }
          
          userMap.set(userIdNum, {
            userId: userIdNum,
            accessHash: accessHashBigInt,
            entity: userEntity,
            lastMessageDate: message.date || message.timestamp || 0
          });
          console.log(`[MENTION] ✅ Added user ${userIdNum} from message author (accessHash: ${accessHashBigInt ? 'yes' : 'no'})`);
        } else {
          // Try to get user entity if not available from message
          try {
            userEntity = await client.getEntity(userIdNum);
            if (userEntity && userEntity.className === 'User') {
              // Skip bots
              if (userEntity.bot) {
                console.log(`[MENTION] Skipping bot user: ${userIdNum}`);
                continue;
              }
              
              // Extract accessHash
              if (userEntity.accessHash !== undefined && userEntity.accessHash !== null) {
                if (typeof userEntity.accessHash === 'object') {
                  if (userEntity.accessHash.personal !== undefined) {
                    accessHash = userEntity.accessHash.personal;
                  } else if (userEntity.accessHash.value !== undefined) {
                    accessHash = userEntity.accessHash.value;
                  } else if (userEntity.accessHash.rawValue !== undefined) {
                    accessHash = userEntity.accessHash.rawValue;
                  }
                } else {
                  accessHash = userEntity.accessHash;
                }
              }
              
              const accessHashBigInt = accessHash !== null && accessHash !== undefined 
                ? (typeof accessHash === 'bigint' ? accessHash : BigInt(accessHash))
                : null;
              
              userMap.set(userIdNum, {
                userId: userIdNum,
                accessHash: accessHashBigInt,
                entity: userEntity,
                lastMessageDate: message.date || message.timestamp || 0
              });
              console.log(`[MENTION] ✅ Added user ${userIdNum} from entity lookup (accessHash: ${accessHashBigInt ? 'yes' : 'no'})`);
            }
          } catch (entityError) {
            console.log(`[MENTION] ⚠️ Could not get entity for user ${userIdNum}: ${entityError.message}`);
            // Still add user without entity (we'll try to get it later when creating mentions)
            userMap.set(userIdNum, {
              userId: userIdNum,
              accessHash: null,
              entity: null,
              lastMessageDate: message.date || message.timestamp || 0
            });
            console.log(`[MENTION] Added user ${userIdNum} without entity (will try to resolve later)`);
          }
        }
      }
      
      // Convert map to array and sort by last message date (most recent first)
      let users = Array.from(userMap.values())
        .sort((a, b) => (b.lastMessageDate || 0) - (a.lastMessageDate || 0));
      
      // Filter out excluded user one more time (just to be safe)
      if (excludeUserId) {
        users = users.filter(u => u.userId !== excludeUserId);
      }
      
      // Take only the requested limit
      users = users.slice(0, limit);
      
      if (users.length === 0) {
        console.log(`[MENTION] No other users found (all messages were from account itself or bots)`);
      } else {
        console.log(`[MENTION] Found ${users.length} unique users from recent messages (excluding account itself): ${users.map(u => u.userId).join(', ')}`);
      }
      
      return users;
    } catch (error) {
      logError('MENTION_SERVICE', null, error, `Error getting recent message senders for group ${groupEntity.id?.toString() || groupEntity.id}`);
      console.log(`[MENTION] Error details:`, error);
      // Fallback to participants
      return await this.getUsersFromParticipants(client, groupEntity, limit, excludeUserId);
    }
  }

  /**
   * Fallback method: Get users from participants
   * @param {Object} client - Telegram client
   * @param {Object} groupEntity - Group entity
   * @param {number} limit - Number of users to get
   * @param {number} excludeUserId - User ID to exclude
   * @returns {Promise<Array>} Array of user entities
   */
  async getUsersFromParticipants(client, groupEntity, limit = 5, excludeUserId = null) {
    try {
      console.log(`[MENTION] Falling back to getting participants`);
      
      // Get group participants - try different methods
      let participants = [];
      
      try {
        // Method 1: Get recent participants
        participants = await client.getParticipants(groupEntity, {
          filter: { _: 'channelParticipantsRecent' },
          limit: Math.min(limit * 10, 200), // Get more to filter
        });
        console.log(`[MENTION] Got ${participants?.length || 0} participants with filter`);
      } catch (error) {
        console.log(`[MENTION] Filter method failed: ${error.message}, trying without filter`);
        // Method 2: Try without filter
        try {
          participants = await client.getParticipants(groupEntity, {
            limit: Math.min(limit * 10, 200),
          });
          console.log(`[MENTION] Got ${participants?.length || 0} participants without filter`);
        } catch (err) {
          console.log(`[MENTION] Could not get participants: ${err.message}`);
          return [];
        }
      }

      if (!participants || participants.length === 0) {
        console.log(`[MENTION] No participants found for group ${groupEntity.id?.toString() || groupEntity.id}`);
        return [];
      }

      // Filter out bots and get user info (userId and accessHash)
      // Participants can be ChannelParticipant or ChatParticipant
      const users = [];
      
      console.log(`[MENTION] Processing ${participants.length} participants...`);
      
      for (const participant of participants) {
        if (!participant) continue;
        
        // Log participant structure for debugging (only first time)
        if (users.length === 0) {
          console.log(`[MENTION] Participant structure:`, {
            className: participant.className,
            id: participant.id,
            idType: typeof participant.id,
            accessHash: participant.accessHash ? 'yes' : 'no',
            hasPeerId: !!participant.peerId,
          });
        }
        
        // Handle different participant structures
        let userId = null;
        let accessHash = null;
        
        // Method 1: Check participant.peerId (most common)
        if (participant.peerId) {
          if (participant.peerId.className === 'PeerUser') {
            userId = participant.peerId.userId;
            accessHash = participant.peerId.accessHash;
          } else if (participant.peerId.userId) {
            userId = participant.peerId.userId;
            accessHash = participant.peerId.accessHash;
          }
        }
        
        // Method 2: Check participant.userId directly
        if (!userId && participant.userId) {
          userId = participant.userId;
          accessHash = participant.accessHash;
        }
        
        // Method 3: Check if participant itself is a User object (most common case)
        if (!userId && participant.className === 'User') {
          // For User objects, id can be an Integer object with value property
          if (participant.id !== undefined && participant.id !== null) {
            if (typeof participant.id === 'object') {
              // Check for Integer object with value property (BigInt)
              if (participant.id.value !== undefined) {
                // Integer object: { value: 7351209111n }
                const idValue = participant.id.value;
                userId = typeof idValue === 'bigint' ? Number(idValue) : 
                        typeof idValue === 'number' ? idValue : 
                        parseInt(idValue);
              } else if (participant.id.userId !== undefined) {
                userId = participant.id.userId;
              } else if (participant.id.id !== undefined) {
                userId = participant.id.id;
              } else if (participant.id.rawValue !== undefined) {
                userId = participant.id.rawValue;
              } else {
                // Try to get the value using valueOf() method
                try {
                  const idValue = participant.id.valueOf();
                  userId = typeof idValue === 'bigint' ? Number(idValue) : 
                          typeof idValue === 'number' ? idValue : 
                          parseInt(idValue);
                } catch (e) {
                  // If valueOf fails, try direct conversion
                  userId = Number(participant.id);
                }
              }
            } else if (typeof participant.id === 'number') {
              userId = participant.id;
            } else if (typeof participant.id === 'bigint') {
              userId = Number(participant.id);
            } else if (typeof participant.id === 'string') {
              userId = parseInt(participant.id);
            }
          }
          accessHash = participant.accessHash;
          
          // Also check if there's a direct userId property on User object
          if (!userId && participant.userId !== undefined) {
            userId = typeof participant.userId === 'number' ? participant.userId : parseInt(participant.userId);
          }
        }
        
        // Method 4: Try to get from participant.id structure
        if (!userId && participant.id) {
          if (participant.id.className === 'PeerUser') {
            userId = participant.id.userId;
            accessHash = participant.id.accessHash;
          } else if (typeof participant.id === 'object' && participant.id.userId) {
            userId = participant.id.userId;
            accessHash = participant.id.accessHash;
          } else if (typeof participant.id === 'number') {
            userId = participant.id;
          }
        }
        
        // Ensure userId is a number
        if (userId) {
          userId = typeof userId === 'number' ? userId : parseInt(userId);
          if (isNaN(userId)) {
            console.log(`[MENTION] Invalid userId extracted: ${participant.userId || participant.peerId?.userId}`);
            continue;
          }
          
          // Skip excluded user (account itself)
          if (excludeUserId && userId === excludeUserId) {
            console.log(`[MENTION] Skipping excluded user ID: ${userId}`);
            continue;
          }
          
          // Skip if we already have this user
          const exists = users.find(u => u.userId === userId);
          if (!exists) {
            // Check if user is a bot (skip bots)
            if (participant.className === 'User' && participant.bot) {
              console.log(`[MENTION] Skipping bot user: ${userId}`);
              continue;
            }
            
            users.push({ 
              userId, 
              accessHash: accessHash || null,
              entity: participant // Store the actual participant entity for proper resolution
            });
            console.log(`[MENTION] Added user ${userId} (accessHash: ${accessHash ? 'yes' : 'no'})`);
            if (users.length >= limit) break;
          }
        } else {
          console.log(`[MENTION] Could not extract userId from participant:`, participant.className);
        }
      }

      console.log(`[MENTION] Found ${users.length} unique users to mention: ${users.map(u => u.userId).join(', ')}`);
      return users;
    } catch (error) {
      logError('MENTION_SERVICE', null, error, `Error getting active users for group ${groupEntity.id?.toString() || groupEntity.id}`);
      console.log(`[MENTION] Error details:`, error);
      return [];
    }
  }

  /**
   * Create mention entities for message
   * @param {Array} userEntities - Array of user peer entities
   * @param {string} messageText - Original message text
   * @returns {Object} Message with entities
   */
  createMentionEntities(users, messageText) {
    if (!users || users.length === 0) {
      return { message: messageText, entities: [] };
    }

    const entities = [];
    let newMessage = messageText;
    
    // Add mentions - use zero-width space for truly hidden mentions
    // Important: Don't place mentions at the very end of message (Telegram may strip them)
    // Add a space or character after the last mention to prevent stripping
    users.forEach((user, index) => {
      const userId = typeof user === 'object' ? user.userId : user;
      const accessHash = typeof user === 'object' ? user.accessHash : null;
      const entity = typeof user === 'object' ? user.entity : null;
      
      // Ensure userId is a number
      let userIdNum;
      if (typeof userId === 'number') {
        userIdNum = userId;
      } else if (typeof userId === 'bigint') {
        userIdNum = Number(userId);
      } else {
        userIdNum = parseInt(userId);
      }
      
      if (isNaN(userIdNum)) {
        console.log(`[MENTION] Invalid user ID: ${userId}, skipping`);
        return; // Skip invalid entries
      }
      
      // Add space separator before mention (except first one)
      if (index > 0) {
        newMessage += ' ';
      }
      
      // Use zero-width space (U+200B) for truly hidden mentions
      // Zero-width space is more reliably invisible and doesn't render as a dot
      // This is invisible but still a valid character for text URLs
      const mentionOffset = newMessage.length;
      newMessage += '\u200B'; // Zero-width space (U+200B) - invisible character
      
      // Create entity data with all necessary information
      entities.push({
        offset: mentionOffset,
        length: 1, // Zero-width space is 1 UTF-16 code unit
        url: `tg://user?id=${userIdNum}`,
        userId: userIdNum,
        accessHash: accessHash,
        entity: entity,
      });
      
      console.log(`[MENTION] Created entity for userId ${userIdNum} at offset ${mentionOffset}, hasEntity=${!!entity}`);
    });
    
    // IMPORTANT: Add a space or character at the end to prevent Telegram from stripping trailing entities
    // Telegram may strip leading/trailing whitespace, which could remove mentions at the end
    if (entities.length > 0) {
      newMessage += ' '; // Add trailing space to protect last mention
    }

    console.log(`[MENTION] Created ${entities.length} mention entities. Message length: ${newMessage.length}`);
    
    return {
      message: newMessage,
      entities: entities,
    };
  }

  /**
   * Add mentions to message when sending
   * @param {Object} client - Telegram client
   * @param {Object} groupEntity - Group entity
   * @param {string} messageText - Message text
   * @param {number} mentionCount - Number of users to mention (default: 5)
   * @returns {Promise<Object>} Message with mentions
   */
  async addMentionsToMessage(client, groupEntity, messageText, mentionCount = 5, excludeUserId = null) {
    try {
      console.log(`[MENTION] Attempting to get ${mentionCount} users for mentions`);
      
      // Get recent message senders (excluding the account itself)
      let activeUsers = await this.getMostActiveUsers(client, groupEntity, mentionCount, excludeUserId);
      
      console.log(`[MENTION] Found ${activeUsers.length} users from recent messages (requested: ${mentionCount})`);
      
      // If we didn't find enough users from messages, try to supplement with participants
      if (activeUsers.length < mentionCount) {
        console.log(`[MENTION] Not enough users from messages (${activeUsers.length}/${mentionCount}), trying participants...`);
        try {
          const participantUsers = await this.getUsersFromParticipants(client, groupEntity, mentionCount, excludeUserId);
          
          // Merge and deduplicate users (prefer users from messages as they're more active)
          const existingUserIds = new Set(activeUsers.map(u => u.userId));
          const additionalUsers = participantUsers.filter(u => !existingUserIds.has(u.userId));
          
          activeUsers = [...activeUsers, ...additionalUsers].slice(0, mentionCount);
          console.log(`[MENTION] Added ${additionalUsers.length} users from participants, total: ${activeUsers.length}/${mentionCount}`);
        } catch (participantError) {
          console.log(`[MENTION] Could not get participants: ${participantError.message}, using ${activeUsers.length} users from messages`);
        }
      }
      
      // Limit to requested count
      activeUsers = activeUsers.slice(0, mentionCount);
      
      if (activeUsers.length === 0) {
        console.log(`[MENTION] No users to mention, sending message without mentions`);
        return { message: messageText, entities: [] };
      }

      console.log(`[MENTION] Using ${activeUsers.length} user(s) for mentions: ${activeUsers.map(u => u.userId).join(', ')}`);

      // Create mention entities
      const { message, entities } = this.createMentionEntities(activeUsers, messageText);
      
      return {
        message: message,
        entities: entities,
      };
    } catch (error) {
      logError('MENTION_SERVICE', null, error, 'Error adding mentions to message');
      // Return original message if mention fails
      return { message: messageText, entities: [] };
    }
  }
}

export default new MentionService();
