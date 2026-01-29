import db from './db.js';
import { logError } from '../utils/logger.js';

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
        is_active INTEGER DEFAULT 1
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
        saved_template_slot INTEGER DEFAULT 1,
        auto_mention INTEGER DEFAULT 0,
        mention_count INTEGER DEFAULT 5,
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
    // Use direct database access to avoid error logging from db.query()
    try {
      // Ensure database is connected
      const dbInstance = db.connect();
      
      // Check if column already exists by querying table info
      const tableInfo = dbInstance.prepare(`PRAGMA table_info(messages)`).all();
      const hasMessageEntities = tableInfo.some(col => col.name === 'message_entities');
      
      if (!hasMessageEntities) {
        // Column doesn't exist, add it
        dbInstance.prepare(`ALTER TABLE messages ADD COLUMN message_entities TEXT`).run();
        console.log('✅ Added message_entities column to messages table');
      } else {
        // Column already exists, skip silently
        // No need to log - this is expected for existing databases
      }
    } catch (error) {
      // If check fails, column might already exist or table might not exist yet
      // This is safe to ignore - CREATE TABLE IF NOT EXISTS above handles new tables
      // Only log unexpected errors (not "duplicate column" or "no such table")
      const errorMsg = error.message || String(error);
      if (!errorMsg.includes('duplicate column') && !errorMsg.includes('no such table')) {
        console.log(`⚠️  Could not check/add message_entities column: ${errorMsg}`);
      }
    }

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

    console.log('✅ Database schema initialized');
  } catch (error) {
    logError('❌ Error initializing database schema:', error);
    throw error;
  }
}
