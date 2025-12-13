# Code Review: Edge Cases and Potential Errors

## Critical Issues

### 1. Database Connection Failures
**Location**: `src/database/db.js`, `src/index.js`

**Issue**: 
- Database queries don't handle connection failures gracefully
- If database connection is lost during runtime, queries will fail without retry
- No connection pooling error handling

**Edge Cases**:
- Database server restarts while bot is running
- Network timeout during query
- Connection pool exhaustion
- Database credentials expire

**Fix Needed**:
```javascript
// In db.js query method
async query(text, params) {
  if (!this.pool) {
    await this.connect();
  }
  
  try {
    return await this.pool.query(text, params);
  } catch (error) {
    // Check if it's a connection error
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || 
        error.message?.includes('Connection terminated')) {
      console.log('[DB] Connection lost, attempting reconnect...');
      this.pool = null; // Reset pool
      await this.connect(); // Reconnect
      return await this.pool.query(text, params); // Retry query
    }
    throw error;
  }
}
```

### 2. Null/Undefined Access Without Checks
**Location**: Multiple files, especially `src/index.js`, `src/handlers/commandHandler.js`

**Issues Found**:

#### 2.1 Missing `msg.from` check
```javascript
// Line 235-238 in index.js
bot.onText(/\/start/, async (msg) => {
  await ensureUserStored(msg);
  await handleStart(bot, msg);
});
```
**Problem**: If `msg.from` is undefined (can happen with channel posts), `ensureUserStored` will fail.

**Fix**:
```javascript
bot.onText(/\/start/, async (msg) => {
  if (!msg.from) {
    console.log('[ERROR] Message without from field:', msg);
    return;
  }
  await ensureUserStored(msg);
  await handleStart(bot, msg);
});
```

#### 2.2 Missing `callbackQuery.message` check
```javascript
// Line 651 in index.js
const chatId = callbackQuery.message?.chat?.id;
```
**Problem**: If `callbackQuery.message` is null, accessing `.chat.id` will throw.

**Fix**: Already using optional chaining, but need to handle null case:
```javascript
const chatId = callbackQuery.message?.chat?.id;
if (!chatId) {
  console.log('[ERROR] Callback query without message or chat:', callbackQuery);
  return;
}
```

#### 2.3 Missing `msg.text` check in message handler
```javascript
// Line 562 in index.js
console.log(`[MESSAGE HANDLER] User ${userId} sent message: "${msg.text?.substring(0, 50) || 'non-text'}"`);
```
**Problem**: While using optional chaining, if `msg.text` is null, `substring` will still be called.

**Fix**: Already handled with `|| 'non-text'`, but could be safer.

### 3. Race Conditions

#### 3.1 Multiple Broadcast Starts
**Location**: `src/services/automationService.js`

**Issue**: If user clicks "Start Broadcast" multiple times rapidly, multiple broadcasts could start.

**Current Protection**: 
```javascript
if (existingBroadcast && existingBroadcast.isRunning) {
  return { success: false, error: 'Broadcast already running for this account' };
}
```
**Problem**: Race condition between check and set. Two requests could both pass the check before either sets `isRunning`.

**Fix**: Use atomic operation or lock:
```javascript
// Add a pending starts Set
this.pendingStarts = new Set();

async startBroadcast(userId, message) {
  // ... existing checks ...
  
  const broadcastKey = this._getBroadcastKey(userId, accountId);
  
  // Atomic check and set
  if (this.pendingStarts.has(broadcastKey)) {
    return { success: false, error: 'Broadcast start already in progress' };
  }
  
  const existingBroadcast = this.activeBroadcasts.get(broadcastKey);
  if (existingBroadcast && existingBroadcast.isRunning) {
    return { success: false, error: 'Broadcast already running for this account' };
  }
  
  this.pendingStarts.add(broadcastKey);
  
  try {
    // ... rest of start logic ...
    this.activeBroadcasts.set(broadcastKey, broadcastData);
  } finally {
    this.pendingStarts.delete(broadcastKey);
  }
}
```

#### 3.2 Account Switching During Broadcast
**Location**: `src/handlers/commandHandler.js`, `src/services/automationService.js`

**Issue**: If user switches account while broadcast is running, the broadcast might continue with wrong account or fail.

**Current State**: Broadcasts are keyed by `userId_accountId`, so switching accounts should be safe, but need to verify.

### 4. Memory Leaks

#### 4.1 Pending States Never Cleared
**Location**: `src/index.js` lines 228-232

**Issue**: Pending states (`pendingPhoneNumbers`, `pendingStartMessages`, etc.) are stored in Sets/Maps but may never be cleared if:
- User never responds
- Bot restarts
- User blocks bot

**Fix**: Add timeout to clear pending states:
```javascript
// Add timeout for pending states (5 minutes)
const PENDING_STATE_TIMEOUT = 5 * 60 * 1000;

function addPendingStateWithTimeout(setOrMap, userId, data = null) {
  if (setOrMap instanceof Set) {
    setOrMap.add(userId);
  } else {
    setOrMap.set(userId, data);
  }
  
  setTimeout(() => {
    if (setOrMap instanceof Set) {
      setOrMap.delete(userId);
    } else {
      setOrMap.delete(userId);
    }
    console.log(`[CLEANUP] Cleared pending state for user ${userId} after timeout`);
  }, PENDING_STATE_TIMEOUT);
}
```

#### 4.2 Active Broadcasts Map Growth
**Location**: `src/services/automationService.js`

**Issue**: If `stopBroadcast` fails or is never called, broadcasts remain in `activeBroadcasts` Map forever.

**Current Protection**: Timeouts are cleared in `stopBroadcast`, but if it fails, memory leak occurs.

**Fix**: Add periodic cleanup:
```javascript
// Add cleanup method
cleanupStoppedBroadcasts() {
  for (const [key, broadcast] of this.activeBroadcasts.entries()) {
    if (!broadcast.isRunning && broadcast.timeouts.length === 0) {
      this.activeBroadcasts.delete(key);
      console.log(`[CLEANUP] Removed stopped broadcast ${key}`);
    }
  }
}

// Call periodically (every hour)
setInterval(() => {
  this.cleanupStoppedBroadcasts();
}, 60 * 60 * 1000);
```

### 5. Error Handling Issues

#### 5.1 Unhandled Promise Rejections in Async IIFE
**Location**: `src/index.js` lines 838-901, 915-978

**Issue**: Background async operations in IIFE don't have catch blocks:
```javascript
(async () => {
  try {
    // ... code ...
  } catch (error) {
    // ... error handling ...
  }
})();
```
**Problem**: If error occurs outside try-catch or in nested async, it becomes unhandled rejection.

**Fix**: Add global error handler for IIFE:
```javascript
(async () => {
  try {
    // ... code ...
  } catch (error) {
    logger.logError('BROADCAST_STOP', userId, error, 'Error stopping broadcast');
    // ... existing error handling ...
  }
})().catch(error => {
  logger.logError('BROADCAST_STOP', userId, error, 'Unhandled error in broadcast stop IIFE');
});
```

#### 5.2 Database Query Errors Not Caught
**Location**: Multiple service files

**Issue**: Many database queries don't have try-catch blocks:
```javascript
// Example from accountLinker.js
const result = await db.query('SELECT ...');
```
**Problem**: If query fails, error propagates and may crash the service.

**Fix**: Add error handling in critical paths:
```javascript
try {
  const result = await db.query('SELECT ...');
  // ... use result ...
} catch (error) {
  logError('[DB ERROR] Query failed:', error);
  // Return safe default or throw with context
  throw new Error(`Database query failed: ${error.message}`);
}
```

### 6. Input Validation Issues

#### 6.1 Phone Number Validation
**Location**: `src/index.js` line 569

**Issue**: Only checks if phone starts with '+', doesn't validate format:
```javascript
if (phoneNumber && phoneNumber.startsWith('+')) {
  await handlePhoneNumber(bot, msg, phoneNumber);
}
```
**Problem**: Invalid formats like "+123" or "+abc123" will pass.

**Fix**: Add proper validation:
```javascript
const phoneRegex = /^\+[1-9]\d{1,14}$/; // E.164 format
if (phoneNumber && phoneRegex.test(phoneNumber)) {
  await handlePhoneNumber(bot, msg, phoneNumber);
} else {
  await bot.sendMessage(chatId, '❌ Invalid phone number format. Please use international format (e.g., +1234567890)');
}
```

#### 6.2 OTP Code Validation
**Location**: `src/handlers/commandHandler.js` line 345

**Issue**: Only checks length, not format:
```javascript
if (code.length < 5) {
  // error
}
```
**Problem**: Non-numeric codes could pass if length is 5.

**Fix**: Validate numeric:
```javascript
if (code.length !== 5 || !/^\d{5}$/.test(code)) {
  await safeAnswerCallback(bot, callbackQuery.id, {
    text: 'Please enter a valid 5-digit code',
    show_alert: true,
  });
  return false;
}
```

#### 6.3 Time Format Validation
**Location**: `src/index.js` line 625

**Issue**: Regex validates format but doesn't check if time is valid (e.g., 25:00):
```javascript
const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
```
**Current**: Actually correct - `2[0-3]` limits hours to 00-23, `[0-5][0-9]` limits minutes to 00-59.

**Status**: ✅ Already correct

### 7. State Management Edge Cases

#### 7.1 Pending State Conflicts
**Location**: `src/index.js` message handler

**Issue**: User could be in multiple pending states simultaneously (though code prevents this).

**Current Protection**: Code clears states when entering new ones, but edge case exists if user sends message while state is being set.

**Fix**: Add state lock:
```javascript
const userStateLocks = new Set();

async function setPendingState(userId, stateType, data) {
  if (userStateLocks.has(userId)) {
    console.log(`[STATE] User ${userId} already has pending state, ignoring`);
    return false;
  }
  userStateLocks.add(userId);
  // ... set state ...
  return true;
}
```

#### 7.2 Account Deletion During Broadcast
**Location**: `src/handlers/commandHandler.js` line 2107

**Issue**: If account is deleted while broadcast is running, broadcast might continue with invalid account.

**Current Protection**: 
```javascript
if (automationService.isBroadcasting(userId, accountId)) {
  await automationService.stopBroadcast(userId, accountId);
}
```
**Status**: ✅ Already handled

### 8. Telegram API Error Handling

#### 8.1 Rate Limiting
**Location**: `src/index.js` admin broadcast (lines 378-392)

**Issue**: Admin broadcast sends messages with only 50ms delay, which may hit rate limits.

**Current**: 
```javascript
await new Promise(resolve => setTimeout(resolve, 50));
```
**Problem**: Telegram allows ~30 messages/second, 50ms = 20/second, but if other operations are happening, could still hit limits.

**Fix**: Increase delay or add exponential backoff:
```javascript
await new Promise(resolve => setTimeout(resolve, 100)); // 10/second is safer
```

#### 8.2 Message Too Long
**Location**: Multiple handlers

**Issue**: Telegram messages have 4096 character limit. No validation before sending.

**Fix**: Add validation:
```javascript
function validateMessageLength(text) {
  if (text && text.length > 4096) {
    return { valid: false, error: 'Message too long (max 4096 characters)' };
  }
  return { valid: true };
}
```

#### 8.3 Chat Not Found / User Blocked Bot
**Location**: `src/index.js` admin broadcast

**Issue**: If user blocked bot, `sendMessage` throws error, but code continues.

**Current**: Error is caught and logged, but could be improved:
```javascript
} catch (error) {
  failedCount++;
  console.log(`[ADMIN_BROADCAST] Failed to send to user ${targetUserId}: ${error.message}`);
}
```
**Status**: ✅ Already handled, but could categorize errors (blocked vs network error)

### 9. Session Management Issues

#### 9.1 Session Revoked During Operation
**Location**: `src/services/accountLinker.js`

**Issue**: If session is revoked during broadcast, error handling exists but broadcast might not stop cleanly.

**Current**: `handleSessionRevoked` is called, but broadcast cleanup might not happen.

**Fix**: Ensure broadcast is stopped when session revoked:
```javascript
async handleSessionRevoked(accountId) {
  // ... existing code ...
  
  // Stop any running broadcasts for this account
  for (const [key, broadcast] of automationService.activeBroadcasts.entries()) {
    if (broadcast.accountId === accountId && broadcast.isRunning) {
      await automationService.stopBroadcast(broadcast.userId, accountId);
      console.log(`[SESSION_REVOKED] Stopped broadcast for revoked account ${accountId}`);
    }
  }
}
```

#### 9.2 Client Disconnection During Send
**Location**: `src/services/automationService.js`

**Issue**: If client disconnects mid-send, error might not be handled properly.

**Current**: Errors are caught in `sendSingleMessageToAllGroups`, but need to verify reconnection logic.

### 10. Configuration Edge Cases

#### 10.1 Missing Environment Variables
**Location**: `src/config.js`

**Issue**: Some config values have defaults, but critical ones throw errors:
```javascript
if (!config.botToken) {
  throw new Error('BOT_TOKEN is required in .env file');
}
```
**Status**: ✅ Already handled correctly

#### 10.2 Invalid Admin IDs
**Location**: `src/config.js` line 46

**Issue**: 
```javascript
adminIds: (process.env.ADMIN_IDS || '').split(',').filter(x => x).map(x => parseInt(x)),
```
**Problem**: If `ADMIN_IDS` contains non-numeric values, `parseInt` returns `NaN`, which could cause issues in `isAdmin` check.

**Fix**:
```javascript
adminIds: (process.env.ADMIN_IDS || '')
  .split(',')
  .filter(x => x)
  .map(x => parseInt(x))
  .filter(x => !isNaN(x)), // Remove NaN values
```

### 11. Division by Zero

#### 11.1 Success Rate Calculation
**Location**: `src/index.js` line 400

**Issue**: 
```javascript
`• Success Rate: ${((successCount / userIds.length) * 100).toFixed(1)}%\n\n`
```
**Problem**: If `userIds.length` is 0, division by zero (though this case is handled earlier).

**Status**: ✅ Already handled (line 365-370 checks for empty array)

### 12. Array Access Without Bounds Check

#### 12.1 Array Indexing
**Location**: Multiple locations

**Issue**: Some array accesses don't check bounds:
```javascript
// Example from commandHandler.js
const activeAccount = accounts.find(acc => acc.accountId === activeAccountId);
```
**Status**: ✅ Using `find` is safe (returns undefined if not found)

### 13. String Operations

#### 13.1 Substring on Null
**Location**: Multiple locations

**Issue**: Some substring operations:
```javascript
messageA.substring(0, 50)
```
**Problem**: If `messageA` is null, will throw.

**Fix**: Already using optional chaining in most places, but verify all:
```javascript
(messageA || '').substring(0, 50)
```

## Recommendations Summary

### High Priority
1. ✅ Add database connection retry logic
2. ✅ Add null checks for `msg.from` and `callbackQuery.message`
3. ✅ Add race condition protection for broadcast starts
4. ✅ Add timeout cleanup for pending states
5. ✅ Add phone number format validation
6. ✅ Add OTP code format validation

### Medium Priority
1. ✅ Add memory leak cleanup for stopped broadcasts
2. ✅ Improve error categorization in admin broadcast
3. ✅ Add message length validation
4. ✅ Fix admin IDs parsing to filter NaN
5. ✅ Ensure broadcast stops when session revoked

### Low Priority
1. ✅ Add state locks to prevent conflicts
2. ✅ Increase rate limit delays
3. ✅ Add more detailed error messages

## Testing Recommendations

1. **Load Testing**: Test with multiple users clicking buttons rapidly
2. **Network Failure Testing**: Simulate database disconnections
3. **Memory Testing**: Run bot for extended periods to check for leaks
4. **Edge Case Testing**: 
   - Empty messages
   - Very long messages
   - Invalid phone numbers
   - Rapid account switching
   - Broadcast start/stop during account operations
