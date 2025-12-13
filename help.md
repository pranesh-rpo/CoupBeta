# Complete Migration Guide: Python to Node.js
## OraBot V2 - Complete Feature Analysis & Migration Guide

---

## Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture Analysis](#architecture-analysis)
3. [Complete Feature List](#complete-feature-list)
4. [Technology Stack Mapping](#technology-stack-mapping)
5. [Database Schema & Operations](#database-schema--operations)
6. [File-by-File Migration Guide](#file-by-file-migration-guide)
7. [Dependencies Mapping](#dependencies-mapping)
8. [Key Implementation Details](#key-implementation-details)
9. [Testing & Deployment](#testing--deployment)
10. [Migration Checklist](#migration-checklist)

---

## Project Overview

**OraBot V2** is a sophisticated Telegram automation bot built with Python that enables users to:
- Link multiple Telegram accounts via OTP/2FA authentication
- Automatically broadcast messages to all joined groups/channels
- Manage scheduling, rate limiting, and anti-spam protection
- Monitor account health and activity logs
- Support A/B testing with multiple message variants
- Handle saved message templates with premium emoji support

**Core Technologies:**
- **Bot Framework**: Aiogram 3.4.1 (Python) → Telegraf (Node.js)
- **Telegram Client**: Telethon 1.34.0 (Python) → GramJS (Node.js) or TelethonJS
- **Database**: PostgreSQL with asyncpg → PostgreSQL with pg (Node.js)
- **Async Runtime**: asyncio → Node.js native async/await

---

## Architecture Analysis

### Current Python Architecture

```
main.py (Entry Point)
├── Bot Initialization (Aiogram)
├── Database Initialization (PostgreSQL)
├── Router Registration
│   ├── handlers_start.py (Start/Verification)
│   ├── handlers_account.py (Account Management)
│   ├── handlers_verification.py (Verification Flow)
│   ├── handlers_health.py (Health Monitoring)
│   └── schedule_handlers.py (Schedule Setup)
├── Background Tasks
│   ├── NormalScheduleTaskManager (Auto Start/Stop)
│   ├── LogCleanupTask (24h cleanup)
│   └── LogFileSender (Daily reports)
└── Client Management
    ├── SessionManager (Telethon clients)
    ├── BroadcastWorker (Message broadcasting)
    └── TagListener (Profile change monitoring)
```

### Proposed Node.js Architecture

```
src/
├── index.js (Entry Point)
├── config/
│   └── config.js (Environment & Config)
├── bot/
│   ├── handlers/
│   │   ├── start.js
│   │   ├── account.js
│   │   ├── verification.js
│   │   ├── health.js
│   │   └── schedule.js
│   ├── keyboards.js
│   ├── menus.js
│   └── utils.js
├── client/
│   ├── sessionManager.js
│   ├── broadcastWorker.js
│   └── tagListener.js
├── database/
│   ├── models.js (Schema)
│   └── operations.js (CRUD)
├── scheduler/
│   ├── normalScheduleManager.js
│   └── taskManager.js
├── utils/
│   ├── encryption.js
│   ├── antiSpam.js
│   ├── logger.js
│   ├── aiText.js
│   ├── logCleanup.js
│   ├── logFileSender.js
│   ├── healthMonitor.js
│   ├── recoveryManager.js
│   └── lock.js
└── middleware/
    └── verification.js
```

---

## Complete Feature List

### 1. **User Management & Verification**
- ✅ User registration via `/start` command
- ✅ Channel verification requirement (must join verification channel)
- ✅ User verification status tracking
- ✅ Admin broadcast to all users (`/abroadcast`, `/abroadcast_last`)

### 2. **Account Linking & Authentication**
- ✅ Phone number input with validation (+country code format)
- ✅ OTP code sending via Telegram API
  - Extensive error handling (FLOOD_WAIT, PHONE_NUMBER_BANNED, etc.)
  - Phone code hash generation
- ✅ Interactive OTP keypad (numeric buttons)
  - Backspace functionality
  - Clear functionality
  - Submit button
- ✅ OTP code verification with retry logic (3 attempts)
- ✅ 2FA password support (cloud password)
- ✅ Session string encryption/decryption
- ✅ Auto-join updates channel on account link
  - Checks if already joined
  - Provides join link if not joined
- ✅ Profile tag setting ("| OraAdbot 🪽" in last name)
- ✅ Bio tag setting (predefined bio text)
- ✅ Tag verification and warnings
- ✅ Concurrent group fetching during account setup
- ✅ Account creation/update logic (handles existing accounts)
- ✅ Detailed success/error messages

### 3. **Account Management**
- ✅ Multiple account support per user
- ✅ Account dashboard with status (broadcasting/idle)
  - Next send ETA calculation
  - Active/total groups count
  - Account info display
- ✅ Account deletion with two-step confirmation
  - Step 1: Confirmation dialog
  - Step 2: Token verification (6-digit random token)
- ✅ Account info display (phone, status, settings)
- ✅ Account switching interface
- ✅ Account settings menu (separate from config)
- ✅ Account about page
- ✅ Account privacy page
- ✅ Client disconnection on account deletion
- ✅ Broadcast stop on account deletion

### 4. **Message Management**
- ✅ Set broadcast message (text with HTML formatting)
- ✅ AI-powered message enhancement (Groq API integration)
  - Tone selection: Friendly, Professional, Bold
  - Original vs Enhanced preview
  - Regenerate with different tone
  - Choose original or enhanced version
- ✅ Saved Messages templates (3 slots)
  - Sync last 3 messages from Saved Messages
  - Preserve premium emoji and formatting entities
  - Message forwarding with entity preservation
  - Active slot selection (1, 2, 3, or None)
  - Clear slot functionality
  - Entity deserialization for stored templates
  - Fallback to normal message if slot empty
- ✅ A/B Testing support
  - Variant A and B messages
  - Modes: Single (use A only), Rotate (alternate A/B), Split (random 50/50)
  - Last variant tracking (for rotate mode)
  - Variant selection during broadcast
- ✅ Message source tracking (normal, saved_slot_X, ai_enhanced)

### 5. **Broadcasting System**
- ✅ Start/Stop broadcast per account
- ✅ Per-group interval tracking (12 minutes minimum)
- ✅ Smart timing: ~5 messages/hour default
- ✅ Manual interval override (minutes, 7-1440 range)
- ✅ Schedule-based broadcasting (IST timezone)
  - Start/End time windows
  - Supports schedules spanning midnight (e.g., 22:00 - 06:00)
  - Auto-start when within schedule
  - Auto-stop when outside schedule
  - Schedule boundary checking during wait periods
- ✅ Quiet hours support (pause during specific times, can span midnight)
- ✅ Daily message cap (default 50, configurable)
- ✅ Daily counter reset at midnight IST
- ✅ Daily counter refresh logic
- ✅ Auto-break feature (38-minute break after 3 hours of continuous broadcasting)
- ✅ Manual override flag (prevents auto-stop during manual broadcasts)
- ✅ Flood wait handling with backoff
- ✅ Group refresh before each cycle
- ✅ Inactive group detection and marking
- ✅ Error handling (ChatWriteForbidden, UserBannedInChannel, ChatAdminRequiredError, etc.)
- ✅ Entity resolution with retry logic (2 retries)
- ✅ Connection reconnection on disconnect
- ✅ Session expiration detection
- ✅ Message forwarding for saved templates (preserves premium emoji)
- ✅ A/B message selection during broadcast
- ✅ Broadcast status sync on startup (cleans stale statuses)
- ✅ Heartbeat updates during broadcast
- ✅ Periodic summary logging (every 15 minutes)
- ✅ Cycle completion logging with statistics
- ✅ Eligible groups calculation (respects per-group intervals)

### 6. **Group Management**
- ✅ Auto-fetch groups on account link
- ✅ Manual group refresh
- ✅ Batch group joining
  - Manual link input (one-by-one with `/done` to finish)
  - File upload (.txt file with multiple links)
  - Batch processing: 5 groups every 5 minutes
  - Progress updates during batch operations
  - Cancel batch join functionality
  - Supports all link formats: `@username`, `https://t.me/group`, `t.me/joinchat/xxxxx`
- ✅ Group list display
- ✅ Inactive group pruning (manual cleanup)
- ✅ Last message sent timestamp per group
- ✅ Group entity resolution with retry logic
- ✅ Automatic group refresh before each broadcast cycle
- ✅ Group inactive marking on errors (ChatWriteForbidden, UserBannedInChannel, etc.)

### 7. **Scheduling System**
- ✅ Normal schedule (time window in IST)
- ✅ Schedule auto-start/stop via background task (checks every 60 seconds)
- ✅ Schedule validation (start < end or spans midnight)
- ✅ Manual override flag (prevents auto-stop)
- ✅ Schedule time parsing (handles both time objects and strings)
- ✅ User notification on auto-stop
- ✅ Schedule check during broadcast wait periods

### 8. **Rate Limiting & Anti-Spam**
- ✅ Per-account flood wait tracking
- ✅ Minimum delay between messages (10 seconds)
- ✅ Random micro-delays (1-3 seconds)
- ✅ Per-group interval enforcement
- ✅ Rate limit presets (1, 3, 5 messages/hour, default)
  - 1 msg/hr = 60 min interval
  - 3 msg/hr = 20 min interval
  - 5 msg/hr = 12 min interval
- ✅ Daily cap enforcement
- ✅ Flood wait extraction from error messages
- ✅ Safe send with entity support
- ✅ Safe forward for message templates

### 9. **Logging System**
- ✅ Per-account activity logs (PostgreSQL)
- ✅ Log types: broadcast, error, info, success, warning, settings, groups, join_group, health_monitor
- ✅ Log viewing in bot interface (last 20 logs)
- ✅ Log export (24-hour logs as text file)
  - Formatted text file generation
  - Document upload to Telegram
- ✅ External logger bot integration
  - Admin-facing logger bot
  - User-facing logger bot (optional, falls back to admin bot)
  - Formatted log messages with timestamps
  - Send to user flag (for admin-only logs)
- ✅ Log cleanup (deletes logs older than 24 hours, runs every 24h)
- ✅ Daily log file sending to admins (runs every 24h)
- ✅ Log message building with consistent formatting
- ✅ Error logging convenience method

### 10. **Health Monitoring**
- ✅ Health dashboard (admin interface)
- ✅ Account health status (healthy/warning/critical)
- ✅ Comprehensive health checks:
  - Client connection status
  - Session authorization status
  - Broadcast status consistency (DB vs memory)
  - Recent activity monitoring
  - Last message time tracking
  - Session age monitoring
- ✅ Frozen task detection (10-minute timeout via heartbeat)
- ✅ Heartbeat system for task monitoring
- ✅ Auto-recovery system
  - Stalled broadcast recovery
  - Inactive broadcast handling
  - Session expiration handling
  - Broadcast inconsistency auto-fix
- ✅ Database pool health monitoring
- ✅ Health check force trigger
- ✅ Recovery trigger
- ✅ Health status caching
- ✅ Periodic health logging (every 5 minutes)

### 11. **Tag Monitoring**
- ✅ Real-time profile change detection (via TagListener)
- ✅ Tag verification cache (30-minute cache)
- ✅ Tag verification on critical operations
- ✅ Tag auto-fix functionality
  - Auto-set name tag: "| OraAdbot 🪽"
  - Auto-set bio tag: "🚀 Telegram's first AI-powered automation bot — @OraAdbot"
  - Legacy tag cleanup (removes old "| Ora Ads" format)
  - Tag verification after fix
- ✅ Tag warning system (blocks operations if tags missing)
- ✅ Tag invalidation on profile changes
- ✅ Auto-stop broadcast on tag removal
- ✅ Tag check before broadcast start
- ✅ Tag check before group operations

### 12. **Security Features**
- ✅ Session string encryption (Fernet/AES-256-CBC)
- ✅ Single-instance lock (prevents duplicate runs)
  - Platform-specific lock file handling (Windows/Unix)
  - Process ID tracking
  - Stale lock cleanup
- ✅ Environment variable validation
- ✅ Admin-only commands protection
- ✅ User verification requirement
- ✅ Account deletion with two-step verification (token confirmation)
- ✅ Session expiration detection and handling

### 13. **UI/UX Features**
- ✅ Responsive inline keyboards (2 buttons per row)
- ✅ HTML message formatting
- ✅ Status indicators (🟢/🔴)
- ✅ Progress indicators during operations
- ✅ Error messages with helpful suggestions
- ✅ Confirmation dialogs for destructive actions
- ✅ Safe message editing (handles "message not modified" errors)
- ✅ Message deletion for cleaner UI (removes user input messages)
- ✅ Interactive OTP keypad (numeric buttons)
- ✅ Message preview before saving (original vs enhanced)
- ✅ Tone selection UI (Friendly, Professional, Bold)
- ✅ About/Privacy pages per account
- ✅ Settings menu (separate from config menu)
- ✅ Utils menu (utility functions)
- ✅ Cancel operations support
- ✅ Back button navigation
- ✅ Menu message ID tracking for edit operations

---

## Technology Stack Mapping

### Python → Node.js Equivalents

| Python Package | Node.js Package | Purpose |
|---------------|-----------------|---------|
| `aiogram==3.4.1` | `telegraf` | Telegram Bot Framework |
| `Telethon==1.34.0` | `telegram` (GramJS) or `@mtproto/core` | Telegram Client Library |
| `asyncpg==0.29.0` | `pg` + `pg-pool` | PostgreSQL Async Driver |
| `cryptography==41.0.7` | `crypto` (built-in) | Encryption/Decryption |
| `aiohttp==3.9.5` | `axios` or `node-fetch` | HTTP Client |
| `APScheduler==3.10.4` | `node-cron` or `agenda` | Task Scheduling |
| `python-dotenv==1.0.0` | `dotenv` | Environment Variables |
| `pydantic==2.5.3` | `joi` or `zod` | Data Validation |
| `asyncio` | Native `async/await` | Async Runtime |

### Key Differences

1. **Async/Await**: Node.js has native async/await (no need for asyncio)
2. **Event Loop**: Node.js uses libuv event loop (similar to asyncio)
3. **Error Handling**: Try/catch instead of try/except
4. **Type System**: TypeScript (optional) vs Python type hints
5. **Module System**: CommonJS or ES Modules vs Python imports

---

## Database Schema & Operations

### PostgreSQL Tables

#### 1. `users`
```sql
CREATE TABLE users (
    user_id BIGINT PRIMARY KEY,
    username VARCHAR(255),
    first_name VARCHAR(255),
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    is_verified BOOLEAN DEFAULT FALSE,
    is_active BOOLEAN DEFAULT TRUE
);
```

#### 2. `accounts`
```sql
CREATE TABLE accounts (
    id SERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    phone_number VARCHAR(20) NOT NULL UNIQUE,
    session_string TEXT NOT NULL,
    first_name VARCHAR(255),
    is_active BOOLEAN DEFAULT TRUE,
    is_broadcasting BOOLEAN DEFAULT FALSE,
    manual_override BOOLEAN DEFAULT FALSE,
    manual_interval INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    broadcast_start_time TIMESTAMP WITH TIME ZONE,
    tags_last_verified TIMESTAMP WITH TIME ZONE,
    daily_cap INTEGER DEFAULT 50,
    daily_sent INTEGER DEFAULT 0,
    cap_reset_date DATE DEFAULT CURRENT_DATE,
    quiet_start TIME,
    quiet_end TIME,
    ab_mode BOOLEAN DEFAULT FALSE,
    ab_mode_type VARCHAR(20) DEFAULT 'single',
    ab_last_variant VARCHAR(10) DEFAULT 'A',
    saved_template_slot INTEGER DEFAULT 1
);
```

#### 3. `messages`
```sql
CREATE TABLE messages (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    message_text TEXT NOT NULL,
    variant VARCHAR(10) DEFAULT 'A',
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

#### 4. `saved_templates`
```sql
CREATE TABLE saved_templates (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    slot INTEGER NOT NULL,
    message_text TEXT,
    message_entities TEXT,  -- JSON string
    message_id INTEGER,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(account_id, slot)
);
```

#### 5. `schedules`
```sql
CREATE TABLE schedules (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    min_interval INTEGER DEFAULT 5,
    max_interval INTEGER DEFAULT 15,
    schedule_type VARCHAR(50) DEFAULT 'normal',
    schedule_pattern VARCHAR(255),
    custom_settings TEXT,
    is_active BOOLEAN DEFAULT TRUE
);
```

#### 6. `logs`
```sql
CREATE TABLE logs (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id BIGINT,
    log_type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'info',
    timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

#### 7. `groups`
```sql
CREATE TABLE groups (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    group_id BIGINT NOT NULL,
    group_title VARCHAR(255),
    last_message_sent TIMESTAMP WITH TIME ZONE,
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE(account_id, group_id)
);
```

#### 8. `warnings`
```sql
CREATE TABLE warnings (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    warning_type VARCHAR(50) NOT NULL,
    warning_count INTEGER DEFAULT 1,
    last_warning_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    admin_notified BOOLEAN DEFAULT FALSE,
    UNIQUE(account_id, warning_type)
);
```

### Database Operations (Node.js Implementation)

```javascript
// Example: database/operations.js structure
class DatabaseOperations {
    // User Operations
    async addUser(userId, username, firstName) { }
    async getUser(userId) { }
    async updateUserVerification(userId, isVerified) { }
    
    // Account Operations
    async addAccount(userId, phoneNumber, sessionString, firstName) { }
    async getAccount(accountId) { }
    async getAccountsByUser(userId) { }
    async updateAccountStatus(accountId, isActive) { }
    async updateAccountBroadcastStatus(accountId, isBroadcasting) { }
    async deleteAccount(accountId) { }
    
    // Message Operations
    async saveMessage(accountId, messageText, variant) { }
    async getActiveMessage(accountId, variant) { }
    async getAccountMessage(accountId) { }
    
    // Template Operations
    async saveTemplate(accountId, slot, messageText, messageEntities, messageId) { }
    async getSavedTemplate(accountId, slot) { }
    async getSavedTemplates(accountId) { }
    
    // Schedule Operations
    async saveSchedule(accountId, startTime, endTime, minInterval, maxInterval) { }
    async getActiveSchedule(accountId) { }
    async getAllActiveSchedules() { }
    
    // Log Operations
    async addLog(accountId, logType, message, status, userId) { }
    async getLogsByAccount(accountId, limit) { }
    async getRecentLogs(accountId, hours) { }
    async cleanupOldLogs(days, hours) { }
    
    // Group Operations
    async addGroup(accountId, groupId, groupTitle) { }
    async getActiveGroups(accountId) { }
    async updateGroupLastMessage(accountId, groupId) { }
    async saveGroups(accountId, groups) { }
    async markGroupInactive(accountId, groupId) { }
    
    // Warning Operations
    async addWarning(accountId, warningType) { }
    async getWarnings(accountId) { }
    
    // Utility Operations
    async resetDailyCaps() { }
    async refreshDailyCounter(accountId) { }
    async incrementDailySent(accountId) { }
}
```

---

## File-by-File Migration Guide

### 1. Configuration (`config.py` → `src/config/config.js`)

**Python:**
```python
import os
from dotenv import load_dotenv

class Config:
    BOT_TOKEN = os.getenv("BOT_TOKEN")
    API_ID = os.getenv("API_ID")
    API_HASH = os.getenv("API_HASH")
    # ... more config
```

**Node.js:**
```javascript
require('dotenv').config();

class Config {
    static BOT_TOKEN = process.env.BOT_TOKEN;
    static API_ID = parseInt(process.env.API_ID);
    static API_HASH = process.env.API_HASH;
    static POSTGRES_DSN = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
    static ENCRYPTION_KEY = Buffer.from(process.env.ENCRYPTION_KEY);
    
    static validate() {
        const required = ['BOT_TOKEN', 'API_ID', 'API_HASH', 'VERIFICATION_CHANNEL_ID', 'ENCRYPTION_KEY'];
        const missing = required.filter(key => !this[key]);
        if (missing.length > 0) {
            throw new Error(`Missing required config: ${missing.join(', ')}`);
        }
    }
}

module.exports = Config;
```

### 2. Main Entry Point (`main.py` → `src/index.js`)

**Python:**
```python
from aiogram import Bot, Dispatcher
from aiogram.fsm.storage.memory import MemoryStorage

async def main():
    bot = Bot(token=Config.BOT_TOKEN)
    dp = Dispatcher(storage=MemoryStorage())
    # ... setup
    await dp.start_polling(bot)
```

**Node.js:**
```javascript
const { Telegraf } = require('telegraf');
const { session } = require('telegraf-session-memory');
const Config = require('./config/config');
const Database = require('./database/models');

async function main() {
    Config.validate();
    
    const bot = new Telegraf(Config.BOT_TOKEN);
    bot.use(session());
    
    // Register handlers
    require('./bot/handlers/start')(bot);
    require('./bot/handlers/account')(bot);
    // ... more handlers
    
    // Initialize database
    await Database.init();
    
    // Start background tasks
    require('./scheduler/normalScheduleManager').start();
    require('./utils/logCleanup').start();
    
    // Start bot
    bot.launch();
    console.log('Bot started');
}

main().catch(console.error);
```

### 3. Bot Handlers (`handlers_account.py` → `src/bot/handlers/account.js`)

**Key Features to Migrate:**
- FSM (Finite State Machine) for multi-step flows
- Callback query handlers
- Message handlers
- State management

**Python (Aiogram FSM):**
```python
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.context import FSMContext

class LinkAccount(StatesGroup):
    phone = State()
    code = State()
    password = State()

@router.message(LinkAccount.phone)
async def process_phone(message: Message, state: FSMContext):
    await state.set_state(LinkAccount.code)
```

**Node.js (Telegraf Scenes):**
```javascript
const { Scenes, Telegraf } = require('telegraf');
const { enter, leave } = Scenes.Stage;

const linkAccountScene = new Scenes.BaseScene('linkAccount');

linkAccountScene.enter(async (ctx) => {
    await ctx.reply('Enter phone number...');
});

linkAccountScene.on('text', async (ctx) => {
    const phone = ctx.message.text;
    // Validate phone
    await ctx.scene.enter('otpCode');
});

const stage = new Scenes.Stage([linkAccountScene]);
bot.use(stage.middleware());
```

### 4. Session Manager (`session_manager.py` → `src/client/sessionManager.js`)

**Python (Telethon):**
```python
from telethon import TelegramClient
from telethon.sessions import StringSession

async def create_client(phone: str) -> TelegramClient:
    client = TelegramClient(StringSession(), API_ID, API_HASH)
    await client.connect()
    return client
```

**Node.js (GramJS/Telegram):**
```javascript
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

async function createClient(phone) {
    const client = new TelegramClient(
        new StringSession(''),
        Config.API_ID,
        Config.API_HASH,
        { connectionRetries: 5 }
    );
    await client.connect();
    return client;
}

async function sendCode(client, phone) {
    const result = await client.sendCode({
        apiId: Config.API_ID,
        apiHash: Config.API_HASH
    }, phone);
    return result.phoneCodeHash;
}

async function signIn(client, phone, code, phoneCodeHash, password) {
    await client.invoke({
        _: 'auth.signIn',
        phoneNumber: phone,
        phoneCodeHash: phoneCodeHash,
        phoneCode: code
    });
    
    if (password) {
        await client.invoke({
            _: 'auth.checkPassword',
            password: password
        });
    }
    
    const sessionString = client.session.save();
    return sessionString;
}
```

### 5. Broadcast Worker (`broadcast_worker.py` → `src/client/broadcastWorker.js`)

**Key Features:**
- Main broadcast loop
- Per-group interval tracking
- Schedule checking
- Flood wait handling
- Group refresh
- Daily cap enforcement

**Node.js Implementation:**
```javascript
class BroadcastWorker {
    constructor() {
        this.runningTasks = new Map();
        this.taskHeartbeats = new Map();
        this.broadcastStartTimes = new Map();
        this.ist = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
    }
    
    async startBroadcast(accountId) {
        // Check if already running
        if (this.runningTasks.has(accountId)) {
            return [false, 'Broadcast already running'];
        }
        
        // Get account, message, groups
        const account = await db.getAccount(accountId);
        const groups = await db.getAccountGroups(accountId);
        const message = await db.getAccountMessage(accountId);
        
        // Load client
        const client = await sessionManager.loadClient(
            account.session_string,
            accountId
        );
        
        // Start broadcast loop
        const task = this._broadcastLoop(
            accountId,
            account,
            client,
            message,
            groups
        );
        
        this.runningTasks.set(accountId, task);
        await db.updateAccountBroadcastStatus(accountId, true);
        
        return [true, `Broadcast started for ${groups.length} groups`];
    }
    
    async _broadcastLoop(accountId, account, client, message, groups) {
        while (true) {
            // Refresh schedule, quiet hours, message
            const schedule = await db.getSchedule(accountId);
            const quiet = await db.getQuietHours(accountId);
            const currentMessage = await db.getAccountMessage(accountId);
            
            // Check schedule
            if (schedule && !this._isWithinSchedule(schedule, new Date())) {
                await this._sleep(60000); // Wait 1 minute
                continue;
            }
            
            // Check quiet hours
            if (this._isWithinQuiet(quiet, new Date())) {
                await this._sleep(60000);
                continue;
            }
            
            // Refresh groups
            const fetchedGroups = await sessionManager.getDialogs(client);
            await db.saveGroups(accountId, fetchedGroups);
            groups = await db.getAccountGroups(accountId);
            
            // Send to eligible groups
            for (const group of groups) {
                const lastSent = group.last_message_sent;
                const interval = this._perGroupIntervalSeconds(
                    account.manual_interval,
                    schedule
                );
                
                if (lastSent) {
                    const elapsed = (Date.now() - new Date(lastSent).getTime()) / 1000;
                    if (elapsed < interval) continue;
                }
                
                try {
                    await antiSpam.safeSend(client, group.group_id, currentMessage, accountId);
                    await db.updateGroupLastMessage(accountId, group.group_id);
                    await db.incrementDailySent(accountId);
                } catch (error) {
                    // Handle errors
                    if (error.message.includes('FLOOD_WAIT')) {
                        // Extract wait time and break
                        break;
                    }
                }
            }
            
            // Wait before next cycle
            await this._sleep(60000); // 1 minute
        }
    }
    
    _perGroupIntervalSeconds(manualInterval, schedule) {
        const floorMinutes = 12; // 5 messages/hour = 12 minutes
        if (manualInterval) {
            return Math.max(floorMinutes, manualInterval) * 60;
        }
        if (schedule) {
            return Math.max(floorMinutes, schedule.min_interval || 5) * 60;
        }
        return floorMinutes * 60;
    }
    
    _isWithinSchedule(schedule, now) {
        if (!schedule) return true;
        const start = this._parseTime(schedule.start_time);
        const end = this._parseTime(schedule.end_time);
        const current = this._getISTTime(now);
        
        if (start > end) {
            return current >= start || current <= end;
        }
        return start <= current && current <= end;
    }
    
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
```

### 6. Database Operations (`operations.py` → `src/database/operations.js`)

**Node.js Implementation:**
```javascript
const { Pool } = require('pg');
const Config = require('../config/config');

class DatabaseOperations {
    constructor() {
        this.pool = new Pool({
            connectionString: Config.POSTGRES_DSN,
            max: 30,
            idleTimeoutMillis: 300000,
            connectionTimeoutMillis: 30000
        });
    }
    
    async addAccount(userId, phoneNumber, sessionString, firstName) {
        const client = await this.pool.connect();
        try {
            // Ensure user exists
            await client.query(
                'INSERT INTO users (user_id, username, first_name) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO UPDATE SET username = EXCLUDED.username',
                [userId, null, firstName]
            );
            
            // Add account
            const result = await client.query(
                'INSERT INTO accounts (user_id, phone_number, session_string, first_name, created_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING id',
                [userId, phoneNumber, sessionString, firstName]
            );
            
            return result.rows[0].id;
        } catch (error) {
            if (error.code === '23505') { // Unique violation
                // Update existing account
                const result = await client.query(
                    'UPDATE accounts SET session_string = $1, first_name = $2 WHERE phone_number = $3 AND user_id = $4 RETURNING id',
                    [sessionString, firstName, phoneNumber, userId]
                );
                return result.rows[0]?.id;
            }
            throw error;
        } finally {
            client.release();
        }
    }
    
    async getAccount(accountId) {
        const result = await this.pool.query(
            'SELECT * FROM accounts WHERE id = $1',
            [accountId]
        );
        return result.rows[0] || null;
    }
    
    async saveMessage(accountId, messageText, variant = 'A') {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            // Deactivate existing messages
            await client.query(
                'UPDATE messages SET is_active = FALSE WHERE account_id = $1 AND variant = $2',
                [accountId, variant]
            );
            
            // Insert new message
            const result = await client.query(
                'INSERT INTO messages (account_id, message_text, variant, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id',
                [accountId, messageText, variant]
            );
            
            await client.query('COMMIT');
            return result.rows[0].id;
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }
    
    // ... more methods
}
```

### 7. Encryption (`encryption.py` → `src/utils/encryption.js`)

**Node.js Implementation:**
```javascript
const crypto = require('crypto');
const Config = require('../config/config');

class Encryption {
    constructor() {
        // Ensure key is 32 bytes
        let key = Config.ENCRYPTION_KEY;
        if (Buffer.isBuffer(key)) {
            key = key.toString();
        }
        
        // Hash to 32 bytes
        const keyHash = crypto.createHash('sha256').update(key).digest();
        this.cipherKey = keyHash;
    }
    
    encrypt(data) {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', this.cipherKey, iv);
        
        let encrypted = cipher.update(data, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        return iv.toString('hex') + ':' + encrypted;
    }
    
    decrypt(encryptedData) {
        const parts = encryptedData.split(':');
        const iv = Buffer.from(parts[0], 'hex');
        const encrypted = parts[1];
        
        const decipher = crypto.createDecipheriv('aes-256-cbc', this.cipherKey, iv);
        
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    }
}

module.exports = new Encryption();
```

### 8. Anti-Spam (`anti_spam.py` → `src/utils/antiSpam.js`)

**Node.js Implementation:**
```javascript
class AntiSpam {
    constructor() {
        this.lastMessageTime = new Map();
        this.floodWaitUntil = new Map();
    }
    
    async safeSend(client, entity, message, accountId, entities = null) {
        // Check flood wait
        if (this.floodWaitUntil.has(accountId)) {
            const waitUntil = this.floodWaitUntil.get(accountId);
            if (Date.now() < waitUntil) {
                const waitTime = Math.ceil((waitUntil - Date.now()) / 1000);
                throw new Error(`FLOOD_WAIT_${waitTime}`);
            }
            this.floodWaitUntil.delete(accountId);
        }
        
        // Ensure minimum delay
        if (this.lastMessageTime.has(accountId)) {
            const elapsed = (Date.now() - this.lastMessageTime.get(accountId)) / 1000;
            if (elapsed < 10) {
                await this._sleep((10 - elapsed) * 1000);
            }
        }
        
        // Random micro-delay
        await this._sleep(Math.random() * 2000 + 1000); // 1-3 seconds
        
        try {
            const result = await client.sendMessage(entity, {
                message: message,
                parseMode: 'html',
                formattingEntities: entities
            });
            
            this.lastMessageTime.set(accountId, Date.now());
            return result;
        } catch (error) {
            if (error.message.includes('FLOOD_WAIT')) {
                const waitTime = this._extractWaitTime(error.message);
                this.floodWaitUntil.set(accountId, Date.now() + waitTime * 1000);
            }
            throw error;
        }
    }
    
    _extractWaitTime(errorMessage) {
        const match = errorMessage.match(/FLOOD_WAIT_(\d+)/);
        return match ? parseInt(match[1]) : 60;
    }
    
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = new AntiSpam();
```

### 9. Scheduler (`normal_schedule_manager.py` → `src/scheduler/normalScheduleManager.js`)

**Node.js Implementation:**
```javascript
const cron = require('node-cron');
const db = require('../database/operations');
const broadcastWorker = require('../client/broadcastWorker');

class NormalScheduleTaskManager {
    constructor(bot) {
        this.bot = bot;
        this.ist = 'Asia/Kolkata';
    }
    
    start() {
        // Check every minute
        cron.schedule('* * * * *', async () => {
            await this._checkSchedules();
        });
    }
    
    async _checkSchedules() {
        const accounts = await this._fetchAccountsWithNormalSchedules();
        const now = new Date();
        
        for (const acc of accounts) {
            const within = this._isWithinSchedule(
                acc.start_time,
                acc.end_time,
                now
            );
            const isRunning = acc.is_broadcasting;
            const manualOverride = acc.manual_override;
            
            if (within && !isRunning && !manualOverride) {
                // Auto-start
                const [ok, info] = await broadcastWorker.startBroadcast(acc.account_id);
                await db.addLog(
                    acc.account_id,
                    'broadcast',
                    `Normal schedule auto-start: ${info}`,
                    ok ? 'success' : 'error'
                );
            }
            
            if (!within && isRunning && !manualOverride) {
                // Auto-stop
                const [ok, info] = await broadcastWorker.stopBroadcast(acc.account_id);
                await db.addLog(
                    acc.account_id,
                    'broadcast',
                    `Normal schedule auto-stop: ${info}`,
                    ok ? 'success' : 'error'
                );
                
                // Notify user
                if (this.bot && ok) {
                    await this.bot.telegram.sendMessage(
                        acc.user_id,
                        `⏰ Schedule Auto-Stop\n\nBroadcast automatically stopped as schedule window ended.`
                    );
                }
            }
        }
    }
    
    _isWithinSchedule(startTime, endTime, now) {
        const start = this._parseTime(startTime);
        const end = this._parseTime(endTime);
        const current = this._getISTTime(now);
        
        if (start > end) {
            return current >= start || current <= end;
        }
        return start <= current && current <= end;
    }
    
    _getISTTime(date) {
        return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    }
    
    _parseTime(timeValue) {
        if (typeof timeValue === 'string') {
            const [hours, minutes] = timeValue.split(':');
            return { hours: parseInt(hours), minutes: parseInt(minutes) };
        }
        return { hours: timeValue.hour, minutes: timeValue.minute };
    }
}

module.exports = new NormalScheduleTaskManager();
```

### 10. Batch Group Joining (`handlers_account.py` → `src/bot/handlers/account.js`)

**Key Features:**
- File upload processing
- Batch processing (5 groups every 5 minutes)
- Progress updates
- Cancel functionality

**Node.js Implementation:**
```javascript
const batchJoinTasks = new Map();

async function processFileUpload(ctx, accountId) {
    const document = ctx.message.document;
    
    // Validate file
    if (!document.file_name.endsWith('.txt')) {
        await ctx.reply('❌ Please upload a .txt file only.');
        return;
    }
    
    if (document.file_size > 1024 * 1024) { // 1MB
        await ctx.reply('❌ File too large. Maximum 1MB.');
        return;
    }
    
    // Download and parse file
    const file = await ctx.telegram.getFile(document.file_id);
    const fileStream = await downloadFile(file.file_path);
    const content = fileStream.toString('utf-8');
    const links = content.split('\n')
        .map(line => line.trim())
        .filter(line => line && (line.includes('t.me/') || line.includes('@') || line.includes('joinchat')));
    
    if (links.length > 1000) {
        await ctx.reply('❌ Too many links. Maximum 1000.');
        return;
    }
    
    // Start batch join task
    const task = batchJoinGroups(accountId, links, ctx.from.id, ctx.chat.id);
    batchJoinTasks.set(accountId, task);
    
    await ctx.reply(
        `📄 File processed! Found ${links.length} valid links.\n` +
        `⚡ Batch joining started: 5 groups every 5 minutes.\n` +
        `🕐 Estimated time: ${Math.ceil(links.length / 5) * 5} minutes`,
        {
            reply_markup: {
                inline_keyboard: [[
                    { text: '⏹ Stop Joining', callback_data: `cancel_join_${accountId}` }
                ]]
            }
        }
    );
}

async function batchJoinGroups(accountId, links, userId, chatId) {
    const account = await db.getAccount(accountId);
    const client = await sessionManager.loadClient(account.session_string, accountId);
    
    // Pin client to prevent cleanup
    sessionManager.pinClient(accountId);
    
    let joined = 0, failed = 0, alreadyMember = 0;
    
    // Process in batches of 5
    for (let i = 0; i < links.length; i += 5) {
        const batch = links.slice(i, i + 5);
        
        for (const link of batch) {
            try {
                const result = await joinSingleGroup(client, link);
                if (result.status === 'joined') joined++;
                else if (result.status === 'already_member') alreadyMember++;
                else failed++;
            } catch (error) {
                failed++;
            }
        }
        
        // Send progress update
        const progress = Math.min(i + 5, links.length);
        await bot.telegram.sendMessage(
            chatId,
            `📊 Progress: ${progress}/${links.length} (${(progress/links.length*100).toFixed(1)}%)\n` +
            `✅ Joined: ${joined}\n` +
            `ℹ️ Already member: ${alreadyMember}\n` +
            `❌ Failed: ${failed}`
        );
        
        // Wait 5 minutes between batches (except last)
        if (progress < links.length) {
            await sleep(300000); // 5 minutes
            sessionManager.pinClient(accountId); // Keep alive
        }
    }
    
    // Final summary
    await bot.telegram.sendMessage(
        chatId,
        `🎉 Batch joining completed!\n` +
        `✅ Joined: ${joined}\n` +
        `ℹ️ Already member: ${alreadyMember}\n` +
        `❌ Failed: ${failed}`
    );
    
    sessionManager.unpinClient(accountId);
    batchJoinTasks.delete(accountId);
}

async function joinSingleGroup(client, link) {
    // Extract group identifier
    let identifier = null;
    if (link.includes('joinchat')) {
        identifier = link.split('joinchat/')[1].split('?')[0].split('/')[0].trim();
    } else if (link.includes('t.me/')) {
        identifier = link.split('t.me/')[1].split('?')[0].split('/')[0].replace('@', '').trim();
    } else if (link.startsWith('@')) {
        identifier = link.replace('@', '').trim();
    }
    
    if (!identifier) {
        return { status: 'error', message: 'Invalid format' };
    }
    
    try {
        const isInviteLink = link.includes('joinchat') || (identifier.length > 20 && !identifier.includes('/'));
        
        if (isInviteLink) {
            // Import chat invite
            const result = await client.invoke({
                _: 'messages.importChatInvite',
                hash: identifier
            });
            return {
                status: 'joined',
                title: result.chats[0].title,
                id: result.chats[0].id
            };
        } else {
            // Join channel/group
            const entity = await client.getEntity(identifier);
            try {
                await client.invoke({
                    _: 'channels.joinChannel',
                    channel: entity
                });
            } catch (error) {
                if (error.message.includes('USER_ALREADY_PARTICIPANT')) {
                    return { status: 'already_member', title: entity.title, id: entity.id };
                }
                throw error;
            }
            return {
                status: 'joined',
                title: entity.title,
                id: entity.id
            };
        }
    } catch (error) {
        return { status: 'error', message: error.message };
    }
}
```

### 11. Health Monitor (`health_monitor.py` → `src/utils/healthMonitor.js`)

**Node.js Implementation:**
```javascript
class HealthMonitor {
    constructor() {
        this.healthCache = new Map();
        this.monitoringActive = false;
        this.lastCheckTime = new Date();
    }
    
    async startMonitoring() {
        if (this.monitoringActive) return;
        
        this.monitoringActive = true;
        this._monitoringLoop();
    }
    
    async _monitoringLoop() {
        while (this.monitoringActive) {
            try {
                await this._checkDatabasePoolHealth();
                await this._checkAllAccountsHealth();
                await sleep(30000); // 30 seconds
            } catch (error) {
                await externalLogger.logError('health_monitor', error);
                await sleep(60000); // Wait longer on error
            }
        }
    }
    
    async _checkAccountHealth(accountId, account) {
        const healthStatus = {
            health: 'healthy',
            issues: [],
            checks: {}
        };
        
        // Check client connection
        const client = sessionManager.getClient(accountId);
        if (client) {
            try {
                const isConnected = client.isConnected();
                healthStatus.checks.client_connected = isConnected;
                
                if (!isConnected) {
                    healthStatus.issues.push('client_disconnected');
                    healthStatus.health = 'unhealthy';
                } else {
                    const isAuthorized = await client.isUserAuthorized();
                    healthStatus.checks.authorized = isAuthorized;
                    
                    if (!isAuthorized) {
                        healthStatus.issues.push('session_expired');
                        healthStatus.health = 'critical';
                    }
                }
            } catch (error) {
                healthStatus.issues.push(`client_error: ${error.message}`);
                healthStatus.health = 'critical';
            }
        } else {
            healthStatus.issues.push('no_client');
            healthStatus.health = 'warning';
        }
        
        // Check broadcast status consistency
        const isBroadcastingDB = account.is_broadcasting;
        const isBroadcastingMemory = broadcastWorker.runningTasks.has(accountId);
        
        if (isBroadcastingDB !== isBroadcastingMemory) {
            healthStatus.issues.push('broadcast_status_inconsistent');
            await this._fixBroadcastInconsistency(accountId, isBroadcastingDB, isBroadcastingMemory);
        }
        
        // Check recent activity
        const recentLogs = await db.getRecentLogs(accountId, 1); // Last hour
        healthStatus.checks.recent_logs = recentLogs.length;
        
        if (account.is_broadcasting && recentLogs.length === 0) {
            healthStatus.issues.push('broadcast_no_activity');
            healthStatus.health = 'critical';
        }
        
        return healthStatus;
    }
    
    async _fixBroadcastInconsistency(accountId, dbStatus, memoryStatus) {
        if (dbStatus && !memoryStatus) {
            // DB says broadcasting but no task - reset DB
            await db.updateAccountBroadcastStatus(accountId, false);
        } else if (!dbStatus && memoryStatus) {
            // Memory has task but DB says not broadcasting - stop task
            await broadcastWorker.stopBroadcast(accountId);
        }
    }
    
    async getHealthSummary() {
        const accounts = await db.getAllAccounts();
        const summary = {
            total_accounts: accounts.length,
            healthy: 0,
            warning: 0,
            critical: 0,
            inactive: 0,
            details: []
        };
        
        for (const account of accounts) {
            if (!account.is_active) {
                summary.inactive++;
                continue;
            }
            
            const healthData = this.healthCache.get(account.id);
            if (healthData) {
                const health = healthData.status.health;
                summary[health]++;
                
                summary.details.push({
                    account_id: account.id,
                    phone: account.phone_number,
                    health: health,
                    issues: healthData.status.issues
                });
            }
        }
        
        return summary;
    }
}

module.exports = new HealthMonitor();
```

### 12. Tag Auto-Fix (`handlers_account.py` → `src/bot/handlers/account.js`)

**Node.js Implementation:**
```javascript
async function applyRequiredTags(ctx, accountId) {
    const account = await db.getAccount(accountId);
    if (!account || account.user_id !== ctx.from.id) {
        await ctx.answerCbQuery('Account not found', { show_alert: true });
        return;
    }
    
    await ctx.answerCbQuery('⏳ Setting tags...');
    
    const client = await sessionManager.loadClient(account.session_string, accountId);
    
    if (!client.isConnected()) {
        await client.connect();
    }
    
    const me = await client.getMe();
    
    // Clean legacy tags
    const cleanedFirstName = me.firstName
        .replace('| Ora Ads', '')
        .replace(' | Ora Ads', '')
        .trim();
    
    const nameTag = '| OraAdbot 🪽';
    const bioTag = '🚀 Telegram\'s first AI-powered automation bot — @OraAdbot';
    
    // Update profile
    await client.invoke({
        _: 'account.updateProfile',
        firstName: cleanedFirstName,
        lastName: nameTag,
        about: bioTag
    });
    
    await sleep(2000); // Wait for update
    
    // Verify tags
    const meUpdated = await client.getMe();
    const fullUser = await client.invoke({
        _: 'users.getFullUser',
        id: meUpdated.id
    });
    
    const bioUpdated = fullUser.fullUser.about || '';
    const hasNameTag = meUpdated.lastName && meUpdated.lastName.includes(nameTag);
    const hasBioTag = bioMatches(bioUpdated);
    
    if (hasNameTag && hasBioTag) {
        await db.resetWarning(accountId, 'name');
        await db.resetWarning(accountId, 'bio');
        await db.addLog(accountId, 'settings', 'Auto-fixed: All tags restored', 'success');
        await ctx.answerCbQuery('✅ Tags updated.', { show_alert: true });
    } else {
        await db.addLog(accountId, 'warning', 
            `Tags set but verification failed - name: ${hasNameTag}, bio: ${hasBioTag}`, 
            'warning');
        await ctx.answerCbQuery('⚠️ Tags set but verification failed', { show_alert: true });
    }
    
    // Update dashboard
    const accountInfo = await accountInfoMessage(account, db);
    await ctx.editMessageText(accountInfo, {
        reply_markup: accountDashboardKeyboard(accountId, account.is_broadcasting),
        parse_mode: 'HTML'
    });
}

function bioMatches(bio) {
    const normalized = bio.toLowerCase().replace(/\s+/g, ' ').trim();
    const target = 'telegram\'s first ai-powered automation bot — @orabot';
    return normalized.includes(target);
}
```

### 13. Single Instance Lock (`lock.py` → `src/utils/lock.js`)

**Node.js Implementation:**
```javascript
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

class SingleInstanceLock {
    constructor(lockfile = null) {
        if (!lockfile) {
            const lockDir = process.platform === 'win32' 
                ? process.env.TEMP || 'C:\\temp'
                : '/tmp';
            this.lockfile = path.join(lockDir, 'ora_ads_bot.lock');
        } else {
            this.lockfile = lockfile;
        }
        this.fd = null;
    }
    
    async acquire() {
        try {
            // Check if lock file exists and process is running
            if (fs.existsSync(this.lockfile)) {
                try {
                    const pid = parseInt(fs.readFileSync(this.lockfile, 'utf8').trim());
                    if (this._isProcessRunning(pid)) {
                        return false;
                    } else {
                        // Process is dead, clean up
                        fs.unlinkSync(this.lockfile);
                    }
                } catch (error) {
                    // Ignore errors reading lock file
                }
            }
            
            // Create lock file
            this.fd = fs.openSync(this.lockfile, 'w');
            fs.writeSync(this.fd, process.pid.toString());
            fs.fsyncSync(this.fd);
            
            return true;
        } catch (error) {
            if (this.fd) {
                try {
                    fs.closeSync(this.fd);
                } catch (e) {}
                this.fd = null;
            }
            return false;
        }
    }
    
    _isProcessRunning(pid) {
        try {
            if (process.platform === 'win32') {
                // Windows: use tasklist or try kill
                const { execSync } = require('child_process');
                try {
                    execSync(`tasklist /FI "PID eq ${pid}"`, { stdio: 'ignore' });
                    return true;
                } catch {
                    return false;
                }
            } else {
                // Unix: send signal 0 (doesn't kill, just checks)
                process.kill(pid, 0);
                return true;
            }
        } catch {
            return false;
        }
    }
    
    release() {
        if (this.fd) {
            try {
                fs.closeSync(this.fd);
                if (fs.existsSync(this.lockfile)) {
                    fs.unlinkSync(this.lockfile);
                }
            } catch (error) {
                // Ignore errors
            }
            this.fd = null;
        }
    }
}

module.exports = new SingleInstanceLock();
```

### 14. Special Schedule Manager (`special_schedule_manager.py` → `src/scheduler/specialScheduleManager.js`)

**Features:**
- Advanced scheduling patterns (days of week, specific dates, hour patterns)
- Custom settings JSON parsing
- Fallback to normal schedule check

**Node.js Implementation:**
```javascript
class SpecialScheduleTaskManager {
    constructor(bot) {
        this.db = require('../database/operations');
        this.bot = bot;
        this.ist = 'Asia/Kolkata';
    }
    
    async _isWithinSpecialSchedule(account, currentTime) {
        try {
            const customSettings = account.custom_settings;
            if (customSettings) {
                const settings = JSON.parse(customSettings);
                
                // Days of week filter
                if (settings.days_of_week) {
                    const currentDay = currentTime.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
                    if (!settings.days_of_week.map(d => d.toLowerCase()).includes(currentDay)) {
                        return false;
                    }
                }
                
                // Specific dates filter
                if (settings.specific_dates) {
                    const currentDate = currentTime.toISOString().split('T')[0];
                    if (!settings.specific_dates.includes(currentDate)) {
                        return false;
                    }
                }
                
                // Hour pattern (even/odd/custom interval)
                if (settings.hour_pattern) {
                    const currentHour = currentTime.getHours();
                    if (settings.hour_pattern === 'even' && currentHour % 2 !== 0) {
                        return false;
                    } else if (settings.hour_pattern === 'odd' && currentHour % 2 === 0) {
                        return false;
                    } else if (typeof settings.hour_pattern === 'number' && currentHour % settings.hour_pattern !== 0) {
                        return false;
                    }
                }
            }
            
            // Fall back to normal time window check
            return this._isWithinNormalSchedule(account, currentTime);
        } catch (error) {
            // Fall back to normal schedule on error
            return this._isWithinNormalSchedule(account, currentTime);
        }
    }
}
```

### 15. Helper Functions & Utilities

#### OTP Keypad (`keyboards.py` → `src/bot/keyboards.js`)

**Features:**
- Numeric buttons (0-9, 00)
- Backspace button
- Clear button
- Submit button
- Cancel button

**Node.js Implementation:**
```javascript
function otpKeypad() {
    return {
        inline_keyboard: [
            [
                { text: '1', callback_data: 'otp_1' },
                { text: '2', callback_data: 'otp_2' },
                { text: '3', callback_data: 'otp_3' }
            ],
            [
                { text: '4', callback_data: 'otp_4' },
                { text: '5', callback_data: 'otp_5' },
                { text: '6', callback_data: 'otp_6' }
            ],
            [
                { text: '7', callback_data: 'otp_7' },
                { text: '8', callback_data: 'otp_8' },
                { text: '9', callback_data: 'otp_9' }
            ],
            [
                { text: '🔢 00', callback_data: 'otp_00' },
                { text: '0', callback_data: 'otp_0' },
                { text: '⌫', callback_data: 'otp_backspace' }
            ],
            [
                { text: '✅ Submit', callback_data: 'otp_submit' },
                { text: '🧹 Clear', callback_data: 'otp_clear' },
                { text: '❌ Cancel', callback_data: 'otp_cancel' }
            ]
        ]
    };
}
```

#### Message Preview Builder (`handlers_account.py` → `src/bot/handlers/account.js`)

**Node.js Implementation:**
```javascript
function buildMessagePreview(original, enhanced, tone) {
    const toneLabel = TONE_LABELS[tone] || tone;
    const originalHtml = escapeHtml(original.trim());
    
    let header = '💬 <b>Review Broadcast Message</b>';
    let toneLine = `<b>Tone:</b> ${toneLabel}`;
    
    let enhancedBlock;
    if (enhanced) {
        const enhancedHtml = escapeHtml(enhanced.trim());
        enhancedBlock = `<b>✨ Enhanced</b>\n${enhancedHtml}`;
    } else {
        enhancedBlock = '⚠️ <i>AI enhancement is unavailable right now. You can still use your original message.</i>';
    }
    
    const originalBlock = `<b>✍️ Original</b>\n${originalHtml}`;
    
    return `${header}\n\n${toneLine}\n\n${enhancedBlock}\n\n${originalBlock}\n\nUse the buttons below to switch tones or pick which version to save.`;
}
```

#### Bio Normalization & Matching (`handlers_account.py` → `src/bot/handlers/account.js`)

**Node.js Implementation:**
```javascript
function normalizeBio(text) {
    let normalized = text.toLowerCase();
    normalized = normalized.replace(/'/g, "'").replace(/–/g, '-').replace(/—/g, '-');
    normalized = normalized.replace(/🚀/g, '');
    normalized = normalized.split(/\s+/).join(' ');
    return normalized.trim();
}

function bioMatches(bio) {
    if (!bio) return false;
    const normalized = normalizeBio(bio);
    const phrase = normalizeBio("telegram's first ai-powered automation bot");
    const hasHandle = normalized.includes('@oraadbot');
    const hasPhrase = normalized.includes(phrase);
    return hasHandle && hasPhrase;
}
```

#### Next Send ETA Calculator (`handlers_account.py` → `src/bot/handlers/account.js`)

**Node.js Implementation:**
```javascript
async function computeNextSendETA(accountId) {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    
    const [schedule, quiet, manualInterval, groups] = await Promise.all([
        db.getSchedule(accountId),
        db.getQuietHours(accountId),
        db.getManualInterval(accountId),
        db.getAccountGroups(accountId)
    ]);
    
    if (!groups || groups.length === 0) {
        return 'No groups';
    }
    
    if (quiet && isWithinQuiet(quiet, now)) {
        return 'Paused (quiet hours)';
    }
    
    if (schedule && !isWithinSchedule(schedule, now)) {
        return 'Paused (schedule)';
    }
    
    const intervalSec = perGroupIntervalSeconds(manualInterval, schedule);
    const nextTimes = [];
    
    for (const group of groups) {
        const last = group.last_message_sent;
        if (!last) {
            nextTimes.push(now);
            continue;
        }
        
        try {
            const lastDt = new Date(last);
            nextTimes.push(new Date(lastDt.getTime() + intervalSec * 1000));
        } catch (error) {
            nextTimes.push(now);
        }
    }
    
    if (nextTimes.length === 0) {
        return 'Unknown';
    }
    
    const earliest = new Date(Math.min(...nextTimes.map(t => t.getTime())));
    if (earliest <= now) {
        return 'Now';
    }
    
    const delta = earliest - now;
    const minutes = Math.floor(delta / 60000);
    
    if (minutes <= 0) {
        return 'Now';
    }
    
    if (minutes < 60) {
        return `In ${minutes} min`;
    }
    
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return `In ${hours}h ${rem}m`;
}
```

#### Updates Channel Auto-Join (`handlers_account.py` → `src/bot/handlers/account.js`)

**Node.js Implementation:**
```javascript
async function ensureUpdatesChannelJoined(client, accountId) {
    const updatesChannel = Config.UPDATES_CHANNEL || '';
    if (!updatesChannel.trim()) {
        return { joined: false, detail: 'missing_config' };
    }
    
    // Normalize channel identifier
    let target = updatesChannel;
    if (target.startsWith('http')) {
        target = target.split('/').pop();
    }
    target = target.replace('joinchat/', '').replace('t.me/', '').trim();
    
    try {
        if (updatesChannel.toLowerCase().includes('joinchat') || target.startsWith('+')) {
            const inviteHash = target.replace('+', '').split('/').pop();
            await client.invoke({
                _: 'messages.importChatInvite',
                hash: inviteHash
            });
        } else {
            if (!target.startsWith('@')) {
                target = `@${target}`;
            }
            const entity = await client.getEntity(target);
            await client.invoke({
                _: 'channels.joinChannel',
                channel: entity
            });
        }
        
        await db.addLog(accountId, 'join_updates', `Joined updates channel: ${updatesChannel}`, 'success');
        return { joined: true, detail: updatesChannel };
    } catch (error) {
        if (error.message.includes('USER_ALREADY_PARTICIPANT')) {
            await db.addLog(accountId, 'join_updates', `Already in updates channel: ${updatesChannel}`, 'info');
            return { joined: true, detail: updatesChannel };
        }
        
        if (error.message.includes('FLOOD_WAIT')) {
            const waitTime = parseInt(error.message.match(/FLOOD_WAIT_(\d+)/)?.[1] || '60');
            await db.addLog(accountId, 'join_updates', `Flood wait ${waitTime}s while joining updates channel`, 'warning');
            return { joined: false, detail: `flood_wait_${waitTime}` };
        }
        
        await db.addLog(accountId, 'join_updates', `Failed to join updates channel: ${error.message}`, 'error');
        return { joined: false, detail: error.message };
    }
}
```

#### Admin Broadcast (`handlers_start.py` → `src/bot/handlers/start.js`)

**Features:**
- Copy message (preserves premium emoji)
- Fallback to forward if copy fails
- Rate limiting (sleep every 30 messages)
- Progress tracking

**Node.js Implementation:**
```javascript
async function adminBroadcastSend(ctx) {
    if (!Config.ADMIN_IDS.includes(ctx.from.id)) {
        return;
    }
    
    const users = await db.getAllUserIds();
    const total = users.length;
    let sent = 0;
    let failed = 0;
    
    const messageId = ctx.message.message_id;
    const chatId = ctx.message.chat.id;
    
    await ctx.reply(`🚀 Broadcasting to ${total} users...`);
    
    for (let idx = 0; idx < users.length; idx++) {
        const userId = users[idx];
        try {
            try {
                // Try copy first (preserves premium emoji)
                await ctx.telegram.copyMessage(userId, chatId, messageId);
                sent++;
            } catch (error) {
                // Fallback to forward
                await ctx.telegram.forwardMessage(userId, chatId, messageId);
                sent++;
            }
        } catch (error) {
            failed++;
            console.error(`Broadcast to ${userId} failed:`, error);
        }
        
        // Rate limiting
        if (idx % 30 === 0) {
            await sleep(100);
        }
    }
    
    await ctx.reply(`✅ Done. Sent: ${sent}/${total}. Failed: ${failed}.`);
}
```

#### Schedule Validation (`schedule_handlers.py` → `src/bot/handlers/schedule.js`)

**Features:**
- Checks if message exists before allowing schedule setup
- Validates time format (HH:MM)
- Auto-starts broadcast if within schedule window
- Shows message source (normal vs saved template)

**Node.js Implementation:**
```javascript
async function startScheduleSetup(ctx, accountId) {
    // Check if account has a message set
    const activeSlot = await db.getActiveTemplateSlot(accountId);
    const activeTemplate = activeSlot ? await db.getSavedTemplate(accountId, activeSlot) : null;
    const currentMessage = await db.getAccountMessage(accountId);
    
    let hasMessage = false;
    let messageSource = null;
    
    if (activeTemplate && (activeTemplate.message_text || activeTemplate.message_id)) {
        hasMessage = true;
        messageSource = `Saved Template Slot ${activeSlot}`;
    } else if (currentMessage) {
        hasMessage = true;
        messageSource = 'Normal Message';
    }
    
    if (!hasMessage) {
        await ctx.editMessageText(
            '❌ <b>No Message Set</b>\n\n' +
            'Please set a message first before creating a schedule.\n\n' +
            'You can:\n' +
            '• Set a normal message\n' +
            '• Sync Saved Messages from your account',
            { reply_markup: cancelKeyboard(`account_${accountId}`), parse_mode: 'HTML' }
        );
        return;
    }
    
    await ctx.editMessageText(
        `⏰ <b>Normal Schedule Setup</b>\n\n` +
        `📝 <b>Using:</b> ${messageSource}\n\n` +
        `Enter the <b>start time</b> in 24-hour format (IST) like <code>09:00</code> or <code>14:30</code>.`,
        { reply_markup: cancelKeyboard(`account_${accountId}`), parse_mode: 'HTML' }
    );
    
    await ctx.scene.enter('schedule_start_time');
    await ctx.scene.state.update({ accountId, scheduleType: 'normal', messageSource });
}
```

#### Safe Edit Message (`utils.py` → `src/bot/utils.js`)

**Node.js Implementation:**
```javascript
async function safeEditMessage(message, text, replyMarkup = null, parseMode = null) {
    // Check if content is already the same
    if (message.text === text && JSON.stringify(message.reply_markup) === JSON.stringify(replyMarkup)) {
        return false;
    }
    
    try {
        await message.editText(text, { reply_markup: replyMarkup, parse_mode: parseMode });
        return true;
    } catch (error) {
        if (error.message.includes('message is not modified')) {
            return false; // Ignore "not modified" errors
        }
        throw error; // Re-raise other errors
    }
}

async function safeAnswer(callback, text = null, showAlert = false) {
    try {
        await callback.answer(text, { show_alert: showAlert });
        return true;
    } catch (error) {
        if (error.message.includes('query is too old') || error.message.includes('query id is invalid')) {
            return false; // Query expired, ignore
        }
        throw error; // Re-raise other errors
    }
}
```

#### Interval to Preset Mapping (`handlers_account.py` → `src/bot/handlers/account.js`)

**Node.js Implementation:**
```javascript
function intervalToPreset(intervalMinutes) {
    if (intervalMinutes === null || intervalMinutes === undefined) {
        return 'default';
    }
    if (intervalMinutes <= 12) {
        return '5'; // 5 messages/hour
    }
    if (intervalMinutes <= 20) {
        return '3'; // 3 messages/hour
    }
    if (intervalMinutes >= 60) {
        return '1'; // 1 message/hour
    }
    return 'custom';
}
```

#### Saved Templates Formatting (`handlers_account.py` → `src/bot/handlers/account.js`)

**Node.js Implementation:**
```javascript
function formatSavedTemplatesText(templates, activeSlot) {
    const lines = [
        '💎 <b>Saved Messages Slots</b>',
        'Source: latest messages from your Saved Messages.',
        '',
        `Active slot: ${activeSlot || 'None (using normal message)'}\n`
    ];
    
    for (let slot = 1; slot <= 3; slot++) {
        const template = templates.find(t => t.slot === slot);
        const prefix = activeSlot === slot ? '✅' : '⬜';
        
        if (template) {
            const snippetRaw = (template.message_text || '').trim().replace(/\n/g, ' ');
            const snippet = escapeHtml(snippetRaw.length > 120 ? snippetRaw.substring(0, 120) + '…' : snippetRaw);
            const updated = template.updated_at || '-';
            lines.push(`${prefix} Slot ${slot}: ${snippet} <i>(${updated})</i>`);
        } else {
            lines.push(`${prefix} Slot ${slot}: <i>Empty</i>`);
        }
    }
    
    lines.push('\n🔄 Sync to pull the latest 3 from Saved Messages, then choose a slot.');
    return lines.join('\n');
}
```

#### Date Formatting (`menus.py` → `src/bot/menus.js`)

**Node.js Implementation:**
```javascript
function formatDate(value) {
    if (!value) {
        return 'N/A';
    }
    
    if (typeof value === 'string') {
        return value.substring(0, 10);
    }
    
    if (value instanceof Date) {
        return value.toISOString().substring(0, 10);
    }
    
    try {
        return String(value).substring(0, 10);
    } catch (error) {
        return 'N/A';
    }
}
```

#### Logs Message Formatting (`menus.py` → `src/bot/menus.js`)

**Node.js Implementation:**
```javascript
function logsMessage(logs) {
    if (!logs || logs.length === 0) {
        return '<b>📊 Activity Logs</b>\n\n<i>No logs yet.</i>';
    }
    
    const ist = 'Asia/Kolkata';
    let logText = '<b>📊 Activity Logs</b>\n\n';
    
    for (const log of logs.slice(0, 20)) { // Show last 20 logs
        const emoji = {
            'info': 'ℹ️',
            'success': '✅',
            'error': '❌',
            'broadcast': '📢'
        }[log.status] || '📝';
        
        const safeMessage = escapeHtml(log.message || '');
        const safeType = escapeHtml(String(log.log_type || ''));
        
        logText += `${emoji} <b>${safeType}</b>\n`;
        logText += `   ${safeMessage}\n`;
        
        // Convert timestamp to IST
        let timestampText = 'N/A';
        if (log.timestamp) {
            try {
                const timestamp = new Date(log.timestamp);
                const istTimestamp = new Date(timestamp.toLocaleString('en-US', { timeZone: ist }));
                timestampText = istTimestamp.toISOString().replace('T', ' ').substring(0, 19);
            } catch (error) {
                timestampText = String(log.timestamp);
            }
        }
        
        logText += `   <i>${timestampText} IST</i>\n\n`;
    }
    
    return logText;
}
```

### 16. Keyboard Functions (`keyboards.py` → `src/bot/keyboards.js`)

**All Keyboard Functions:**

1. **Main Menu Keyboard** - Dynamic based on account existence
2. **Accounts List Keyboard** - Shows all accounts with status indicators
3. **Account Dashboard Keyboard** - Primary action buttons (2 per row)
4. **Message Enhance Keyboard** - Tone selection + save options
5. **Saved Templates Keyboard** - Slot selection (3 slots) + sync/clear
6. **Config Menu Keyboard** - Settings options (interval, schedule, rate, quiet, A/B)
7. **Rate Limit Keyboard** - Presets (1/3/5/hr, default) + daily cap controls
8. **Quiet Hours Keyboard** - Set/clear quiet hours
9. **A/B Menu Keyboard** - Set A/B messages + mode selection (single/rotate/split)
10. **Settings Menu Keyboard** - About, Privacy, Fix Tags
11. **Utils Menu Keyboard** - Join Groups, Logs, Export, Prune, Delete
12. **Delete Confirmation Keyboard** - Two-step deletion
13. **Delete Token Keyboard** - Token confirmation step
14. **OTP Keypad** - Numeric input with backspace/clear/submit/cancel
15. **Schedule Type Keyboard** - Normal schedule selection
16. **Back Button** - Simple navigation
17. **Join Groups Method Keyboard** - Manual vs File upload
18. **Verification Keyboard** - Join channel + verify button
19. **Cancel Keyboard** - Cancel operation with destination
20. **Tag Warning Keyboard** - Auto-fix tag option

**Key Patterns:**
- `_chunk_buttons()` - Arranges buttons in rows (default 2 per row)
- `_create_nav_buttons()` - Creates back button row
- `_create_action_row()` - Creates responsive action rows
- Status indicators (✅ for selected, 🟢/🔴 for status)
- Dynamic button text based on state

### 17. Menu Functions (`menus.py` → `src/bot/menus.js`)

**All Menu Functions:**

1. **Welcome Message** - Dynamic with user name and APP_VERSION
2. **Verification Message** - Channel join requirement explanation
3. **About Message** - Bot information and features
4. **Privacy Message** - Privacy policy and data handling
5. **Account Info Message** - Dashboard with phone, status, settings, schedule
6. **Link Account Start** - Phone number format instructions with examples
7. **Logs Message** - Formatted log list with timestamps (IST), emojis, HTML escaping

**Key Features:**
- HTML formatting with `<b>`, `<i>`, `<code>` tags
- Dynamic content (user names, account status, dates)
- IST timezone conversion for timestamps
- HTML escaping for user-generated content
- Date formatting utility (`_format_date()`)
- Emoji mapping for log statuses

### 18. Configuration Details (`config.py` → `src/config/config.js`)

**All Configuration Variables:**

```javascript
class Config {
    // Bot Configuration
    BOT_TOKEN = process.env.BOT_TOKEN;
    BOT_USERNAME = process.env.BOT_USERNAME || 'OraAdbot';
    APP_VERSION = process.env.APP_VERSION || 'v0.2.3';
    
    // Telegram API
    API_ID = parseInt(process.env.API_ID);
    API_HASH = process.env.API_HASH;
    
    // Database - PostgreSQL
    POSTGRES_DSN = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
    PGHOST = process.env.PGHOST;
    PGPORT = parseInt(process.env.PGPORT || '5432');
    PGUSER = process.env.PGUSER || process.env.POSTGRES_USER;
    PGPASSWORD = process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD;
    PGDATABASE = process.env.PGDATABASE || process.env.POSTGRES_DB;
    
    // Verification
    VERIFICATION_CHANNEL = process.env.VERIFICATION_CHANNEL;
    VERIFICATION_CHANNEL_ID = parseInt(process.env.VERIFICATION_CHANNEL_ID);
    
    // Updates Channel (auto-join on account link)
    UPDATES_CHANNEL = process.env.UPDATES_CHANNEL || 'channelOraUpdates';
    
    // Logger Bots
    LOGGER_BOT_TOKEN = process.env.LOGGER_BOT_TOKEN;
    USER_LOGGER_BOT_TOKEN = process.env.USER_LOGGER_BOT_TOKEN;
    
    // Security
    ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
    
    // AI / Text Enhancement
    GROQ_API_KEY = process.env.GROQ_API_KEY;
    HUGGINGFACE_API_KEY = process.env.HUGGINGFACE_API_KEY;
    OLLAMA_API_URL = process.env.OLLAMA_API_URL;
    AI_DEFAULT_PROVIDER = process.env.AI_DEFAULT_PROVIDER || 'groq';
    AI_MODEL_GROQ = process.env.AI_MODEL_GROQ || 'llama-3.1-8b-instant';
    AI_MAX_TOKENS = parseInt(process.env.AI_MAX_TOKENS || '500');
    AI_TEMPERATURE = parseFloat(process.env.AI_TEMPERATURE || '0.7');
    AI_TIMEOUT = parseInt(process.env.AI_TIMEOUT || '30');
    
    // Admin
    ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').filter(x => x).map(x => parseInt(x));
    
    // Sessions Directory
    SESSIONS_DIR = path.join(process.cwd(), 'sessions');
    
    // Broadcast Settings
    MIN_INTERVAL = 5; // minutes
    MAX_INTERVAL = 15; // minutes
    MESSAGES_PER_HOUR = 5;
    
    // Auto-breaking Settings
    AUTO_BREAK_DURATION = 3.27; // hours before taking a break
    AUTO_BREAK_LENGTH = 53; // minutes break duration
    
    static validate() {
        const required = ['BOT_TOKEN', 'API_ID', 'API_HASH', 'VERIFICATION_CHANNEL_ID', 'ENCRYPTION_KEY'];
        const missing = required.filter(key => !this[key]);
        if (missing.length > 0) {
            throw new Error(`Missing required config: ${missing.join(', ')}`);
        }
        
        // Type validation
        if (isNaN(this.API_ID)) {
            throw new Error('API_ID must be a valid integer');
        }
        if (isNaN(this.VERIFICATION_CHANNEL_ID)) {
            throw new Error('VERIFICATION_CHANNEL_ID must be a valid integer');
        }
        if (!this.ENCRYPTION_KEY) {
            throw new Error('ENCRYPTION_KEY must be a valid string');
        }
        
        // Create sessions directory
        if (!fs.existsSync(this.SESSIONS_DIR)) {
            fs.mkdirSync(this.SESSIONS_DIR, { recursive: true });
        }
        
        return true;
    }
    
    static getPgDsn() {
        if (this.POSTGRES_DSN) {
            return this.POSTGRES_DSN;
        }
        if (this.PGHOST && this.PGPORT && this.PGUSER && this.PGPASSWORD && this.PGDATABASE) {
            return `postgresql://${this.PGUSER}:${this.PGPASSWORD}@${this.PGHOST}:${this.PGPORT}/${this.PGDATABASE}`;
        }
        return null;
    }
}
```

### 19. Error Handling Patterns

**Common Error Handling Patterns:**

1. **Telegram API Errors:**
   - `FloodWaitError` → Extract wait time, pause, retry
   - `ChatWriteForbiddenError` → Mark group inactive
   - `UserBannedInChannelError` → Mark group inactive
   - `ChatAdminRequiredError` → Mark group inactive
   - `UserAlreadyParticipantError` → Treat as success
   - `InviteHashExpiredError` → Show error to user
   - `ChannelPrivateError` → Show error to user
   - `UsernameNotOccupiedError` → Show error to user

2. **Database Errors:**
   - Unique violation → Update existing record
   - Connection errors → Retry with exponential backoff
   - Query timeout → Log and continue

3. **Session Errors:**
   - Session expired → Deactivate account, notify user
   - Connection lost → Reconnect automatically
   - Authorization failed → Require re-login

4. **Callback Query Errors:**
   - Query expired → Ignore gracefully
   - Invalid query ID → Log and continue

5. **Message Edit Errors:**
   - Message not modified → Ignore (content unchanged)
   - Message not found → Send new message

### 20. State Management Details

**FSM States:**

1. **LinkAccount:**
   - `phone` - Waiting for phone number
   - `code` - Waiting for OTP code (text input)
   - `otp_code` - Waiting for OTP via keypad
   - `password` - Waiting for 2FA password

2. **SetMessage:**
   - `message` - Waiting for message text
   - `review` - Showing preview with tone selection

3. **SetInterval:**
   - `interval` - Waiting for interval in minutes

4. **RateLimitCap:**
   - `cap` - Waiting for daily cap number

5. **QuietHours:**
   - `start` - Waiting for start time
   - `end` - Waiting for end time

6. **SetABMessage:**
   - `variant` - Waiting for A or B message text

7. **JoinGroups:**
   - `group_link` - Waiting for group links (manual)
   - `file_upload` - Waiting for file upload

8. **ScheduleSetup:**
   - `schedule_type` - Selecting schedule type
   - `start_time` - Waiting for start time
   - `end_time` - Waiting for end time

9. **AdminBroadcast:**
   - `payload` - Waiting for broadcast message

**State Data Storage:**
- `account_id` - Current account being configured
- `menu_message_id` - Message ID for editing
- `client` - Telethon client instance (for linking)
- `phone` - Phone number being linked
- `phone_code_hash` - OTP hash from Telegram
- `original_message` - User's original message
- `enhanced_message` - AI-enhanced message
- `tone` - Selected tone for enhancement
- `ab_variant` - A or B variant being set
- `quiet_start` - Quiet hours start time
- `delete_token` - Token for account deletion
- `schedule_type` - Type of schedule being set

### 21. UI/UX Details

**Message Deletion:**
- User input messages are deleted for cleaner UI
- Menu messages are edited instead of sending new ones
- Fallback to new message if edit fails

**Progress Indicators:**
- "⏳ Setting tags..."
- "🔄 Verifying Code..."
- "📊 Setting Up Account..."
- "⏳ Fetching groups..."
- "🔍 Performing health check..."

**Status Indicators:**
- 🟢 Active/Broadcasting
- 🔴 Inactive/Stopped
- ✅ Success/Selected
- ⚠️ Warning
- ❌ Error
- ℹ️ Info

**Button Text Patterns:**
- Dynamic text based on state (e.g., "▶️ Start" vs "⏸️ Stop")
- Checkmarks for selected options (✅)
- Emoji prefixes for visual clarity

**Error Messages:**
- User-friendly error messages
- Helpful suggestions
- Format examples for invalid input
- Retry instructions

**Confirmation Dialogs:**
- Two-step deletion (confirm → token)
- Clear warnings for destructive actions
- Back button always available

### 22. Time Parsing & Formatting

**Time Parsing Utilities:**

```javascript
function parseTime(timeValue) {
    // Handle time objects
    if (timeValue && typeof timeValue === 'object' && 'hour' in timeValue && 'minute' in timeValue) {
        return timeValue;
    }
    
    // Handle strings (HH:MM)
    if (typeof timeValue === 'string') {
        const [hours, minutes] = timeValue.split(':');
        return { hour: parseInt(hours), minute: parseInt(minutes) };
    }
    
    return timeValue;
}

function formatTime(timeValue) {
    const time = parseTime(timeValue);
    if (time && typeof time === 'object') {
        const hours = String(time.hour || time.hours || 0).padStart(2, '0');
        const minutes = String(time.minute || time.minutes || 0).padStart(2, '0');
        return `${hours}:${minutes}`;
    }
    return String(timeValue);
}

function getISTTime(date = new Date()) {
    return new Date(date.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}
```

### 23. HTML Escaping Utility

```javascript
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
```

### 24. Phone Number Validation

```javascript
function validatePhoneNumber(phone) {
    // Must start with +
    if (!phone.startsWith('+')) {
        return { valid: false, error: 'Phone number must start with +' };
    }
    
    // Remove all non-digit characters except +
    const cleaned = phone.replace(/[^\d+]/g, '');
    
    // Check length (minimum 8 digits after +)
    if (cleaned.length < 9) {
        return { valid: false, error: 'Phone number too short' };
    }
    
    // Check maximum length (15 digits + 1 for +)
    if (cleaned.length > 16) {
        return { valid: false, error: 'Phone number too long' };
    }
    
    return { valid: true, cleaned };
}
```

### 25. OTP Keypad Handler Logic

```javascript
async function handleOTPKeypad(ctx, action) {
    const data = await ctx.scene.state.get();
    let currentCode = data.otp_code || '';
    
    if (action === 'backspace') {
        currentCode = currentCode.slice(0, -1);
    } else if (action === 'clear') {
        currentCode = '';
    } else if (action === 'submit') {
        if (currentCode.length < 5) {
            await ctx.answerCbQuery('Code must be at least 5 digits', { show_alert: true });
            return;
        }
        await processOTPVerification(ctx, currentCode);
        return;
    } else if (action === 'cancel') {
        await ctx.scene.leave();
        return;
    } else {
        // Numeric input (0-9, 00)
        if (action === '00') {
            currentCode += '00';
        } else {
            currentCode += action;
        }
        
        // Limit to 10 digits
        if (currentCode.length > 10) {
            await ctx.answerCbQuery('Code too long', { show_alert: true });
            return;
        }
    }
    
    await ctx.scene.state.update({ otp_code: currentCode });
    
    // Update display
    const maskedCode = '*'.repeat(currentCode.length) || 'Enter code';
    await ctx.editMessageText(
        `✅ <b>OTP sent! 🚀</b>\n\n` +
        `Enter the OTP using the keypad below ✨\n\n` +
        `Current: <b>${maskedCode}</b>\n` +
        `Format: <code>12345</code> (no spaces needed) 🌟\n` +
        `Valid for: 5 minutes`,
        { reply_markup: otpKeypad(), parse_mode: 'HTML' }
    );
    
    await ctx.answerCbQuery();
}
```

---

## Dependencies Mapping

### package.json

```json
{
  "name": "orabot-v2-nodejs",
  "version": "0.2.3",
  "description": "Telegram automation bot - Node.js version",
  "main": "src/index.js",
  "type": "module",
  "scripts": {
    "start": "node src/index.js",
    "dev": "nodemon src/index.js"
  },
  "dependencies": {
    "telegraf": "^4.15.0",
    "telegram": "^2.23.0",
    "pg": "^8.11.3",
    "dotenv": "^16.3.1",
    "axios": "^1.6.2",
    "node-cron": "^3.0.3",
    "joi": "^17.11.0",
    "crypto": "built-in",
    "fs": "built-in",
    "path": "built-in"
  },
  "devDependencies": {
    "nodemon": "^3.0.2"
  }
}
```

---

## Key Implementation Details

### 1. **Telegram Client Library Choice**

**Option A: GramJS (telegram)**
- Pros: Most similar to Telethon, good documentation
- Cons: Less maintained, smaller community

**Option B: @mtproto/core**
- Pros: Low-level control, actively maintained
- Cons: More complex API, requires more setup

**Recommendation**: Use `telegram` (GramJS) for easier migration from Telethon.

### 2. **State Management**

**Python (Aiogram FSM):**
```python
await state.set_state(LinkAccount.phone)
data = await state.get_data()
await state.update_data(phone=phone)
```

**Node.js (Telegraf Scenes):**
```javascript
await ctx.scene.enter('linkAccount');
ctx.scene.state.phone = phone;
const phone = ctx.scene.state.phone;
```

### 3. **Error Handling**

**Python:**
```python
try:
    result = await operation()
except SpecificError as e:
    handle_error(e)
```

**Node.js:**
```javascript
try {
    const result = await operation();
} catch (error) {
    if (error instanceof SpecificError) {
        handleError(error);
    }
}
```

### 4. **Async Operations**

**Python:**
```python
async def fetch_data():
    result1 = await op1()
    result2 = await op2()
    return [result1, result2]

# Parallel
results = await asyncio.gather(op1(), op2())
```

**Node.js:**
```javascript
async function fetchData() {
    const result1 = await op1();
    const result2 = await op2();
    return [result1, result2];
}

// Parallel
const results = await Promise.all([op1(), op2()]);
```

### 5. **Time Zone Handling**

**Python:**
```python
from datetime import timezone, timedelta
ist = timezone(timedelta(hours=5, minutes=30))
now = datetime.now(tz=ist)
```

**Node.js:**
```javascript
const { DateTime } = require('luxon'); // or use date-fns-tz

const now = DateTime.now().setZone('Asia/Kolkata');
// Or
const now = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' });
```

---

## Testing & Deployment

### Testing Strategy

1. **Unit Tests**: Test individual functions (encryption, validation, etc.)
2. **Integration Tests**: Test database operations, API calls
3. **E2E Tests**: Test complete flows (account linking, broadcasting)

### Deployment Considerations

1. **Environment Variables**: Use `.env` file or platform-specific config
2. **Process Management**: Use PM2 or systemd
3. **Logging**: Use Winston or Pino for structured logging
4. **Monitoring**: Use PM2 monitoring or external services
5. **Database Migrations**: Use `node-pg-migrate` or similar

### PM2 Configuration

```json
{
  "name": "orabot-v2",
  "script": "src/index.js",
  "instances": 1,
  "exec_mode": "fork",
  "env": {
    "NODE_ENV": "production"
  },
  "error_file": "./logs/error.log",
  "out_file": "./logs/out.log",
  "log_date_format": "YYYY-MM-DD HH:mm:ss Z"
}
```

---

## Migration Checklist

### Phase 1: Setup & Configuration
- [ ] Create Node.js project structure
- [ ] Install all dependencies
- [ ] Set up environment variables
- [ ] Configure database connection
- [ ] Set up logging

### Phase 2: Core Infrastructure
- [ ] Migrate config system
- [ ] Migrate database models & operations
- [ ] Migrate encryption utilities
- [ ] Migrate anti-spam utilities
- [ ] Set up Telegram bot framework

### Phase 3: Bot Handlers
- [ ] Migrate start/verification handlers
- [ ] Migrate account management handlers
- [ ] Migrate message handlers
- [ ] Migrate schedule handlers
- [ ] Migrate health monitoring handlers

### Phase 4: Client Management
- [ ] Migrate session manager
- [ ] Migrate broadcast worker
- [ ] Migrate tag listener
- [ ] Test account linking flow
- [ ] Test broadcasting flow

### Phase 5: Background Tasks
- [ ] Migrate schedule manager
- [ ] Migrate log cleanup task
- [ ] Migrate log file sender
- [ ] Migrate health monitor
- [ ] Migrate recovery manager

### Phase 6: Testing & Refinement
- [ ] Test all user flows
- [ ] Test error handling
- [ ] Test edge cases
- [ ] Performance testing
- [ ] Security audit

### Phase 7: Deployment
- [ ] Set up production environment
- [ ] Configure process manager (PM2)
- [ ] Set up monitoring
- [ ] Deploy and monitor
- [ ] Document deployment process

### 14. **Client Management & Session Handling**
- ✅ Client pooling system
  - Active clients tracking
  - Last used timestamp
  - Client pinning/unpinning (prevents cleanup during operations)
  - Idle connection cleanup (periodic task)
- ✅ Client lifecycle management
  - Create client for new logins
  - Load client from session string
  - Reconnect on disconnect
  - Disconnect on account deletion
- ✅ Session string management
  - StringSession serialization
  - Session encryption/decryption
  - Session expiration detection
- ✅ Custom HTML parser for message entities
  - Premium emoji support
  - Spoiler text support
  - Custom emoji entities
- ✅ Dialog fetching (groups/channels)
- ✅ Saved message template fetching (last 3 messages)

### 15. **Background Tasks & Services**
- ✅ Normal schedule task manager (runs every 60 seconds)
- ✅ Log cleanup task (runs every 24 hours)
- ✅ Log file sender task (runs every 24 hours)
- ✅ Health monitoring loop (runs every 30 seconds)
- ✅ Recovery service loop (runs every 5 minutes)
- ✅ Idle client cleanup task (periodic)
- ✅ Frozen task check (via health monitor)
- ✅ Broadcast status sync on startup

### 16. **Error Handling & Recovery**
- ✅ Comprehensive error handling
  - FloodWaitError handling with backoff
  - ChatWriteForbiddenError → mark group inactive
  - UserBannedInChannelError → mark group inactive
  - ChatAdminRequiredError → mark group inactive
  - Connection errors → reconnect logic
  - Session expiration → deactivate account
- ✅ Retry logic for entity resolution (2 retries)
- ✅ Error type detection and appropriate handling
- ✅ Broadcast loop error recovery
- ✅ Frozen task recovery
- ✅ Stalled broadcast recovery
- ✅ Broadcast inconsistency auto-fix

### 17. **Database Operations**
- ✅ Connection pool management
- ✅ Retry logic for database operations
- ✅ Transaction support
- ✅ Schema migrations (e.g., adding ab_mode_type column)
- ✅ Index creation for performance
- ✅ Pool health monitoring
- ✅ Parallel query execution (asyncio.gather)
- ✅ Batch operations support

### 18. **Utilities & Helpers**
- ✅ Safe message editing (handles "message not modified")
- ✅ Safe callback answer
- ✅ Time parsing utilities (handles multiple formats)
- ✅ IST timezone handling
- ✅ Interval calculation utilities
- ✅ Preset to interval conversion
- ✅ Bio normalization and matching
- ✅ Tag verification helpers
- ✅ Message preview building
- ✅ ETA calculation for next send
- ✅ Entity deserialization
- ✅ Legacy tag cleanup

---

## Additional Notes

### Important Considerations

1. **Session Compatibility**: Telethon and GramJS sessions are NOT compatible. Users will need to re-link accounts.

2. **Timezone Handling**: Ensure IST timezone is consistently used throughout (Asia/Kolkata).

3. **Error Messages**: Maintain user-friendly error messages with helpful suggestions.

4. **Rate Limiting**: Respect Telegram's rate limits and implement proper backoff strategies.

5. **Security**: Never log or expose session strings, passwords, or sensitive data.

6. **Database**: The PostgreSQL schema remains the same, so existing data can be migrated.

7. **Testing**: Test thoroughly with a single account before scaling.

### Performance Optimizations

1. **Connection Pooling**: Use pg-pool for database connections
2. **Caching**: Cache frequently accessed data (schedules, account info)
3. **Batch Operations**: Batch database queries where possible
4. **Async Operations**: Use Promise.all for parallel operations
5. **Memory Management**: Clean up unused clients and connections

---

## Conclusion

This migration guide provides a comprehensive roadmap for converting OraBot V2 from Python to Node.js. The key challenges are:

1. **Telegram Client Library**: Choose between GramJS and @mtproto/core
2. **State Management**: Migrate from Aiogram FSM to Telegraf Scenes
3. **Async Patterns**: Convert asyncio patterns to Node.js async/await
4. **Error Handling**: Adapt Python exception handling to JavaScript try/catch
5. **Testing**: Ensure all features work correctly after migration

The migration should be done incrementally, testing each component as it's migrated. Start with core infrastructure, then handlers, then background tasks.

Good luck with your migration! 🚀
