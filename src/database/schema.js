import db from './db.js';
import { logError } from '../utils/logger.js';

/**
 * Check if a column exists in a table
 * @param {string} tableName - Name of the table
 * @param {string} columnName - Name of the column
 * @returns {Promise<boolean>} - True if column exists, false otherwise
 */
async function columnExists(tableName, columnName) {
  try {
    // PRAGMA table_info returns columns: cid, name, type, notnull, dflt_value, pk
    // Note: tableName is safe as it comes from our code, not user input
    // Use quotes around table name for safety
    const result = await db.query(`PRAGMA table_info("${tableName}")`);
    if (result && result.rows && Array.isArray(result.rows)) {
      return result.rows.some(row => row && row.name === columnName);
    }
    // Also check if result is an array directly (better-sqlite3 might return array)
    if (Array.isArray(result)) {
      return result.some(row => row && row.name === columnName);
    }
    return false;
  } catch (error) {
    // If table doesn't exist or query fails, column doesn't exist
    // Log the error for debugging but don't throw
    if (error.message && !error.message.includes('no such table')) {
      console.log(`[SCHEMA] Note: Error checking column ${columnName} in ${tableName}: ${error.message}`);
    }
    return false;
  }
}

/**
 * Safely add a column to a table if it doesn't exist
 * @param {string} tableName - Name of the table
 * @param {string} columnName - Name of the column
 * @param {string} columnDefinition - Column definition (e.g., "TEXT", "INTEGER DEFAULT 0")
 */
async function addColumnIfNotExists(tableName, columnName, columnDefinition) {
  try {
    const exists = await columnExists(tableName, columnName);
    if (exists) {
      // Column already exists, skip
      return;
    }
    await db.query(`ALTER TABLE "${tableName}" ADD COLUMN "${columnName}" ${columnDefinition}`);
  } catch (error) {
    // Silently ignore duplicate column errors - these are expected if column already exists
    // SQLite error messages can vary: "duplicate column", "duplicate column name", "duplicate column: column_name"
    const errorMessage = (error?.message || '').toLowerCase();
    const isDuplicateColumnError = 
      errorMessage.includes('duplicate column') ||
      errorMessage.includes('duplicate column name') ||
      errorMessage.includes('duplicate column:') ||
      errorMessage.includes('sqlite_error') && errorMessage.includes('duplicate');
    
    if (isDuplicateColumnError) {
      // Column already exists, which is fine - silently ignore
      return;
    }
    // Only log non-duplicate errors
    console.log(`[SCHEMA] Note: Could not add column ${columnName} to ${tableName}: ${error?.message || 'Unknown error'}`);
  }
}

export async function initializeSchema() {
  try {
    db.connect();

    // Create users table
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_verified INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        logger_bot_started INTEGER DEFAULT 0
      )
    `);

    // Create accounts table - supports multiple accounts per user
    await db.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        phone TEXT NOT NULL,
        session_string TEXT NOT NULL,
        first_name TEXT,
        is_active INTEGER DEFAULT 0,
        is_broadcasting INTEGER DEFAULT 0,
        manual_override INTEGER DEFAULT 0,
        manual_interval INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        broadcast_start_time DATETIME,
        tags_last_verified DATETIME,
        daily_cap INTEGER DEFAULT 1500,
        daily_sent INTEGER DEFAULT 0,
        cap_reset_date DATE DEFAULT CURRENT_DATE,
        quiet_start TIME,
        quiet_end TIME,
        ab_mode INTEGER DEFAULT 0,
        ab_mode_type TEXT DEFAULT 'single',
        ab_last_variant TEXT DEFAULT 'A',
        auto_mention INTEGER DEFAULT 0,
        mention_count INTEGER DEFAULT 5,
        group_delay_min INTEGER,
        group_delay_max INTEGER,
        forward_mode INTEGER DEFAULT 0,
        forward_message_id INTEGER,
        forward_chat_id INTEGER,
        UNIQUE(user_id, phone)
      )
    `);

    // Create messages table (per account, supports A/B testing)
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        message_text TEXT NOT NULL,
        message_entities TEXT,
        variant TEXT DEFAULT 'A',
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add message_entities column if it doesn't exist (for existing databases)
    await addColumnIfNotExists('messages', 'message_entities', 'TEXT');
    // Add saved_message_id column to track messages sent to Saved Messages
    await addColumnIfNotExists('messages', 'saved_message_id', 'INTEGER');

    // Create saved_templates table (for Saved Messages sync)
    await db.query(`
      CREATE TABLE IF NOT EXISTS saved_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        slot INTEGER NOT NULL,
        message_text TEXT,
        message_entities TEXT,
        message_id INTEGER,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, slot)
      )
    `);

    // Create schedules table
    await db.query(`
      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        min_interval INTEGER DEFAULT 5,
        max_interval INTEGER DEFAULT 15,
        schedule_type TEXT DEFAULT 'normal',
        schedule_pattern TEXT,
        custom_settings TEXT,
        is_active INTEGER DEFAULT 1
      )
    `);

    // Create logs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        user_id INTEGER,
        log_type TEXT NOT NULL,
        message TEXT NOT NULL,
        status TEXT DEFAULT 'info',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create groups table
    await db.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL,
        group_title TEXT,
        last_message_sent DATETIME,
        is_active INTEGER DEFAULT 1,
        UNIQUE(account_id, group_id)
      )
    `);

    // Create group_links table for storing all group invite links
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_link TEXT NOT NULL UNIQUE,
        account_id INTEGER,
        group_id INTEGER,
        group_title TEXT,
        collected_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create warnings table
    await db.query(`
      CREATE TABLE IF NOT EXISTS warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        warning_type TEXT NOT NULL,
        warning_count INTEGER DEFAULT 1,
        last_warning_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        admin_notified INTEGER DEFAULT 0,
        UNIQUE(account_id, warning_type)
      )
    `);

    // Create pending_verifications table (for OTP verification state)
    await db.query(`
      CREATE TABLE IF NOT EXISTS pending_verifications (
        user_id INTEGER PRIMARY KEY,
        phone TEXT NOT NULL,
        phone_code_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Group categories table
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        category_name TEXT NOT NULL,
        color TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, category_name)
      )
    `);

    // Group category assignments
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_category_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL,
        category_id INTEGER NOT NULL REFERENCES group_categories(id) ON DELETE CASCADE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, group_id, category_id)
      )
    `);

    // Group filters (whitelist/blacklist)
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_filters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        filter_type TEXT NOT NULL CHECK (filter_type IN ('whitelist', 'blacklist')),
        group_id INTEGER,
        group_name_pattern TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Group filter presets
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_filter_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        preset_name TEXT NOT NULL,
        filter_criteria TEXT NOT NULL,
        is_default INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, preset_name)
      )
    `);

    // Message templates with variables
    await db.query(`
      CREATE TABLE IF NOT EXISTS message_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        template_name TEXT NOT NULL,
        template_text TEXT NOT NULL,
        variables TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, template_name)
      )
    `);

    // Scheduled messages
    await db.query(`
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        message_text TEXT NOT NULL,
        scheduled_time DATETIME NOT NULL,
        timezone TEXT DEFAULT 'Asia/Kolkata',
        repeat_type TEXT CHECK (repeat_type IN ('once', 'daily', 'weekly', 'monthly')),
        repeat_until DATETIME,
        is_sent INTEGER DEFAULT 0,
        sent_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Broadcast statistics
    await db.query(`
      CREATE TABLE IF NOT EXISTS broadcast_stats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        broadcast_date DATE NOT NULL,
        total_groups INTEGER DEFAULT 0,
        messages_sent INTEGER DEFAULT 0,
        messages_failed INTEGER DEFAULT 0,
        success_rate REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, broadcast_date)
      )
    `);

    // Message queue
    await db.query(`
      CREATE TABLE IF NOT EXISTS message_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        message_text TEXT NOT NULL,
        priority INTEGER DEFAULT 5,
        scheduled_for DATETIME,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
        attempts INTEGER DEFAULT 0,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME
      )
    `);

    // Group analytics
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        group_id INTEGER NOT NULL,
        group_title TEXT,
        messages_sent INTEGER DEFAULT 0,
        messages_failed INTEGER DEFAULT 0,
        last_message_sent DATETIME,
        last_error TEXT,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, group_id)
      )
    `);

    // User roles and permissions
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id INTEGER PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        role TEXT DEFAULT 'user' CHECK (role IN ('admin', 'moderator', 'user')),
        permissions TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Account backups
    await db.query(`
      CREATE TABLE IF NOT EXISTS account_backups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        backup_name TEXT NOT NULL,
        backup_data TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, backup_name)
      )
    `);

    // Audit logs
    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER REFERENCES users(user_id) ON DELETE SET NULL,
        account_id INTEGER REFERENCES accounts(account_id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        resource_type TEXT,
        resource_id TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Media attachments
    await db.query(`
      CREATE TABLE IF NOT EXISTS media_attachments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        file_type TEXT,
        file_name TEXT,
        file_size INTEGER,
        mime_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Auto-reply rules
    await db.query(`
      CREATE TABLE IF NOT EXISTS auto_reply_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        trigger_type TEXT CHECK (trigger_type IN ('keyword', 'mention', 'dm', 'all')),
        trigger_value TEXT,
        reply_message TEXT NOT NULL,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Content moderation rules
    await db.query(`
      CREATE TABLE IF NOT EXISTS moderation_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        rule_type TEXT CHECK (rule_type IN ('keyword', 'user', 'spam')),
        rule_value TEXT NOT NULL,
        action TEXT CHECK (action IN ('delete', 'warn', 'ban', 'kick')),
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // A/B testing analytics
    await db.query(`
      CREATE TABLE IF NOT EXISTS ab_testing_analytics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        variant TEXT NOT NULL CHECK (variant IN ('A', 'B')),
        group_id INTEGER,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        engagement_score REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Message pool (alternative to A/B testing - supports multiple messages)
    await db.query(`
      CREATE TABLE IF NOT EXISTS message_pool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        message_text TEXT NOT NULL,
        message_entities TEXT,
        display_order INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    await db.query(`CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(user_id, is_active)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_accounts_broadcasting ON accounts(is_broadcasting)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_messages_account_id ON messages(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_messages_active ON messages(account_id, is_active)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_schedules_account_id ON schedules(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_schedules_active ON schedules(account_id, is_active)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_account_id ON logs(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_groups_account_id ON groups(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_groups_active ON groups(account_id, is_active)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_group_links_link ON group_links(group_link)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_group_links_account_id ON group_links(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_pending_verifications_user_id ON pending_verifications(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_group_categories_account_id ON group_categories(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_group_category_assignments_account_id ON group_category_assignments(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_group_filters_account_id ON group_filters(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_message_templates_account_id ON message_templates(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_messages_account_id ON scheduled_messages(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_messages_time ON scheduled_messages(scheduled_time)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_broadcast_stats_account_id ON broadcast_stats(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_message_queue_account_id ON message_queue(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_message_queue_status ON message_queue(status, scheduled_for)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_group_analytics_account_id ON group_analytics(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_account_id ON audit_logs(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_auto_reply_rules_account_id ON auto_reply_rules(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_moderation_rules_account_id ON moderation_rules(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ab_testing_analytics_account_id ON ab_testing_analytics(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_message_pool_account_id ON message_pool(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_message_pool_active ON message_pool(account_id, is_active)`);

    // Premium subscriptions table
    await db.query(`
      CREATE TABLE IF NOT EXISTS premium_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled')),
        amount REAL NOT NULL DEFAULT 30.0,
        currency TEXT DEFAULT 'INR',
        payment_method TEXT,
        payment_reference TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        cancelled_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id)
      )
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_premium_subscriptions_user_id ON premium_subscriptions(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_premium_subscriptions_status ON premium_subscriptions(status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_premium_subscriptions_expires_at ON premium_subscriptions(expires_at)`);

    // Payment submissions table for payment verification (manual)
    await db.query(`
      CREATE TABLE IF NOT EXISTS payment_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        transaction_id TEXT NOT NULL,
        order_id TEXT,
        amount REAL NOT NULL DEFAULT 30.0,
        currency TEXT DEFAULT 'INR',
        payment_method TEXT,
        payment_gateway TEXT,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'rejected', 'expired')),
        verification_method TEXT,
        screenshot_file_id TEXT,
        screenshot_path TEXT,
        verified_at DATETIME,
        verified_by INTEGER,
        rejection_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(transaction_id)
      )
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_submissions_user_id ON payment_submissions(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_submissions_status ON payment_submissions(status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_submissions_transaction_id ON payment_submissions(transaction_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_submissions_order_id ON payment_submissions(order_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_payment_submissions_created_at ON payment_submissions(created_at DESC)`);

    // Add group_delay and forward_mode columns if they don't exist (for existing databases)
    await addColumnIfNotExists('accounts', 'group_delay_min', 'INTEGER');
    await addColumnIfNotExists('accounts', 'group_delay_max', 'INTEGER');
    await addColumnIfNotExists('accounts', 'forward_mode', 'INTEGER DEFAULT 0');
    await addColumnIfNotExists('accounts', 'forward_message_id', 'INTEGER');
    await addColumnIfNotExists('accounts', 'forward_chat_id', 'INTEGER');
    await addColumnIfNotExists('accounts', 'auto_reply_dm_enabled', 'INTEGER DEFAULT 0');
    await addColumnIfNotExists('accounts', 'auto_reply_dm_message', 'TEXT');
    await addColumnIfNotExists('accounts', 'auto_reply_groups_enabled', 'INTEGER DEFAULT 0');
    await addColumnIfNotExists('accounts', 'auto_reply_groups_message', 'TEXT');
    await addColumnIfNotExists('accounts', 'auto_reply_check_interval', 'INTEGER DEFAULT 30');
    await addColumnIfNotExists('accounts', 'auto_reply_native_mode', 'INTEGER DEFAULT 0');
    await addColumnIfNotExists('accounts', 'auto_reply_shortcut_id', 'INTEGER');
    await addColumnIfNotExists('accounts', 'use_message_pool', 'INTEGER DEFAULT 0');
    await addColumnIfNotExists('accounts', 'message_pool_mode', 'TEXT DEFAULT \'random\'');
    await addColumnIfNotExists('accounts', 'message_pool_last_index', 'INTEGER DEFAULT 0');
    
    // Add logger_bot_started column to users table
    await addColumnIfNotExists('users', 'logger_bot_started', 'INTEGER DEFAULT 0');
    
    // Update existing accounts with NULL or 0 to default to 30 seconds
    try {
      await db.query(`UPDATE accounts SET auto_reply_check_interval = 30 WHERE auto_reply_check_interval IS NULL OR auto_reply_check_interval = 0`);
    } catch (error) {
      // Ignore error if update fails
      console.log(`[SCHEMA] Note: Could not update existing auto_reply_check_interval values: ${error.message}`);
    }

    // Fix existing message pool entries - ensure is_active uses 1/0 integers
    try {
      // Update any 'true' or 'TRUE' string values to 1
      await db.query(`UPDATE message_pool SET is_active = 1 WHERE is_active NOT IN (0, 1) OR is_active IS NULL`);
      console.log('[SCHEMA] Fixed message pool is_active values');
    } catch (error) {
      console.log(`[SCHEMA] Note: Could not fix message pool is_active values: ${error.message}`);
    }

    // Create banned_users table for user moderation
    await db.query(`
      CREATE TABLE IF NOT EXISTS banned_users (
        user_id INTEGER PRIMARY KEY,
        banned_by INTEGER NOT NULL,
        banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        reason TEXT,
        FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
      )
    `);

    console.log('✅ Database schema initialized');
  } catch (error) {
    logError('❌ Error initializing database schema:', error);
    throw error;
  }
}
