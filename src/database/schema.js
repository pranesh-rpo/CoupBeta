import db from './db.js';
import { logError } from '../utils/logger.js';

export async function initializeSchema() {
  try {
    await db.connect();

    // Create users table
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        joined_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        is_verified BOOLEAN DEFAULT FALSE,
        is_active BOOLEAN DEFAULT TRUE
      )
    `);

    // Check if accounts table exists and if it has account_id
    const tableExists = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'accounts'
      )
    `);
    
    if (tableExists.rows[0].exists) {
      // Check if account_id column exists
      const accountIdCheck = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'accounts' AND column_name = 'account_id'
      `);
      
      if (accountIdCheck.rows.length === 0) {
        // Table exists but doesn't have account_id - need to migrate or recreate
        console.log('🔄 Accounts table exists but missing account_id column. Migrating...');
        
        try {
          // Try to get existing data
          const existingData = await db.query(`
            SELECT user_id, phone, session_string, 
                   COALESCE(is_active, TRUE) as is_active,
                   created_at, updated_at
            FROM accounts
            LIMIT 1
          `);
          
          // Drop old table and recreate (CASCADE will drop dependent tables)
          console.log('⚠️ Dropping old accounts table structure...');
          await db.query(`DROP TABLE IF EXISTS accounts CASCADE`);
          console.log('✅ Old table dropped');
        } catch (error) {
          // If we can't read from table, just drop it
          console.log('⚠️ Could not read from accounts table, dropping...');
          await db.query(`DROP TABLE IF EXISTS accounts CASCADE`);
        }
      }
    }
    
    // Create accounts table - supports multiple accounts per user
    await db.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
        phone VARCHAR(20) NOT NULL,
        session_string TEXT NOT NULL,
        first_name VARCHAR(255),
        is_active BOOLEAN DEFAULT FALSE,
        is_broadcasting BOOLEAN DEFAULT FALSE,
        manual_override BOOLEAN DEFAULT FALSE,
        manual_interval INTEGER,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
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
        saved_template_slot INTEGER DEFAULT 1,
        auto_mention BOOLEAN DEFAULT FALSE,
        mention_count INTEGER DEFAULT 5,
        UNIQUE(user_id, phone)
      )
    `);
    
    // Add auto_mention columns if they don't exist (for existing databases)
    try {
      await db.query(`
        ALTER TABLE accounts 
        ADD COLUMN IF NOT EXISTS auto_mention BOOLEAN DEFAULT FALSE
      `);
      await db.query(`
        ALTER TABLE accounts 
        ADD COLUMN IF NOT EXISTS mention_count INTEGER DEFAULT 5
      `);
    } catch (error) {
      // Column might already exist, ignore error
      console.log('Note: auto_mention columns may already exist');
    }

    // Check if accounts table has 'id' column (old schema) and rename it BEFORE creating dependent tables
    const idColumnCheck = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'accounts' AND column_name = 'id'
    `);
    
    if (idColumnCheck.rows.length > 0) {
      // Still has 'id', rename it to account_id
      console.log('🔄 Renaming id to account_id in accounts table...');
      try {
        // Drop dependent tables first (they reference accounts)
        console.log('🔄 Dropping dependent tables...');
        await db.query(`DROP TABLE IF EXISTS messages CASCADE`);
        await db.query(`DROP TABLE IF EXISTS logs CASCADE`);
        await db.query(`DROP TABLE IF EXISTS groups CASCADE`);
        await db.query(`DROP TABLE IF EXISTS schedules CASCADE`);
        await db.query(`DROP TABLE IF EXISTS saved_templates CASCADE`);
        await db.query(`DROP TABLE IF EXISTS warnings CASCADE`);
        
        console.log('🔄 Renaming id column to account_id...');
        await db.query(`ALTER TABLE accounts RENAME COLUMN id TO account_id`);
        await db.query(`ALTER SEQUENCE IF EXISTS accounts_id_seq RENAME TO accounts_account_id_seq`);
        await db.query(`ALTER TABLE accounts ALTER COLUMN account_id SET DEFAULT nextval('accounts_account_id_seq')`);
        
        // Also rename phone_number to phone if it exists
        const phoneNumberCheck = await db.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'accounts' AND column_name = 'phone_number'
        `);
        if (phoneNumberCheck.rows.length > 0) {
          console.log('🔄 Renaming phone_number to phone...');
          await db.query(`ALTER TABLE accounts RENAME COLUMN phone_number TO phone`);
        }
        
        // Verify rename succeeded
        const verifyRename = await db.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'accounts' AND column_name = 'account_id'
        `);
        if (verifyRename.rows.length === 0) {
          throw new Error('Column rename failed - account_id still does not exist');
        }
        
        console.log('✅ Column renamed successfully');
      } catch (error) {
        logError('❌ Error renaming column:', error);
        throw error;
      }
    }

    // Add missing columns to existing accounts table (migration)
    const existingColumns = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'accounts'
    `);
    const columnNames = existingColumns.rows.map(row => row.column_name);

    const requiredColumns = [
      { name: 'first_name', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS first_name VARCHAR(255)' },
      { name: 'is_broadcasting', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_broadcasting BOOLEAN DEFAULT FALSE' },
      { name: 'manual_override', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS manual_override BOOLEAN DEFAULT FALSE' },
      { name: 'manual_interval', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS manual_interval INTEGER' },
      { name: 'broadcast_start_time', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS broadcast_start_time TIMESTAMP WITH TIME ZONE' },
      { name: 'tags_last_verified', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tags_last_verified TIMESTAMP WITH TIME ZONE' },
      { name: 'daily_cap', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_cap INTEGER DEFAULT 50' },
      { name: 'daily_sent', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_sent INTEGER DEFAULT 0' },
      { name: 'cap_reset_date', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS cap_reset_date DATE DEFAULT CURRENT_DATE' },
      { name: 'quiet_start', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS quiet_start TIME' },
      { name: 'quiet_end', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS quiet_end TIME' },
      { name: 'ab_mode', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ab_mode BOOLEAN DEFAULT FALSE' },
      { name: 'ab_mode_type', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ab_mode_type VARCHAR(20) DEFAULT \'single\'' },
      { name: 'ab_last_variant', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ab_last_variant VARCHAR(10) DEFAULT \'A\'' },
      { name: 'saved_template_slot', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS saved_template_slot INTEGER DEFAULT 1' },
      { name: 'auto_mention', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS auto_mention BOOLEAN DEFAULT FALSE' },
      { name: 'mention_count', sql: 'ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mention_count INTEGER DEFAULT 5' },
    ];

    for (const col of requiredColumns) {
      if (!columnNames.includes(col.name)) {
        console.log(`[SCHEMA] Adding missing column: ${col.name}`);
        await db.query(col.sql);
      }
    }

    // Verify accounts table has account_id before creating dependent tables
    const accountIdCheck = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'accounts' AND column_name = 'account_id'
    `);
    
    if (accountIdCheck.rows.length === 0) {
      // Check if table has 'id' column instead of 'account_id'
      const idCheck = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'accounts' AND column_name = 'id'
      `);
      
      if (idCheck.rows.length > 0) {
        console.log('🔄 Renaming id to account_id and phone_number to phone...');
        // Rename id to account_id
        await db.query(`ALTER TABLE accounts RENAME COLUMN id TO account_id`);
        // Rename phone_number to phone if it exists
        const phoneNumberCheck = await db.query(`
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = 'accounts' AND column_name = 'phone_number'
        `);
        if (phoneNumberCheck.rows.length > 0) {
          await db.query(`ALTER TABLE accounts RENAME COLUMN phone_number TO phone`);
        }
        // Update sequence name
        await db.query(`ALTER SEQUENCE IF EXISTS accounts_id_seq RENAME TO accounts_account_id_seq`);
        await db.query(`ALTER TABLE accounts ALTER COLUMN account_id SET DEFAULT nextval('accounts_account_id_seq')`);
        
        // Drop and recreate dependent tables to fix foreign key references
        console.log('🔄 Dropping dependent tables to fix foreign key references...');
        await db.query(`DROP TABLE IF EXISTS messages CASCADE`);
        await db.query(`DROP TABLE IF EXISTS logs CASCADE`);
        await db.query(`DROP TABLE IF EXISTS groups CASCADE`);
        await db.query(`DROP TABLE IF EXISTS schedules CASCADE`);
        await db.query(`DROP TABLE IF EXISTS saved_templates CASCADE`);
        await db.query(`DROP TABLE IF EXISTS warnings CASCADE`);
        
        console.log('✅ Column renaming completed, dependent tables will be recreated');
      } else {
        logError('❌ Accounts table exists but missing account_id/id column. Dropping and recreating...');
        // Drop accounts table and all dependent tables
        await db.query(`DROP TABLE IF EXISTS accounts CASCADE`);
        // Recreate accounts table
        await db.query(`
          CREATE TABLE accounts (
            account_id SERIAL PRIMARY KEY,
            user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
            phone VARCHAR(20) NOT NULL,
            session_string TEXT NOT NULL,
            first_name VARCHAR(255),
            is_active BOOLEAN DEFAULT FALSE,
            is_broadcasting BOOLEAN DEFAULT FALSE,
            manual_override BOOLEAN DEFAULT FALSE,
            manual_interval INTEGER,
            created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
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
            saved_template_slot INTEGER DEFAULT 1,
            UNIQUE(user_id, phone)
          )
        `);
        console.log('✅ Accounts table recreated with correct schema');
      }
    }

    // Verify accounts table has account_id before creating dependent tables
    // Check if it has 'id' column (old schema) and rename it
    const finalIdCheck = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'accounts' AND column_name = 'id'
    `);
    
    if (finalIdCheck.rows.length > 0) {
      console.log('⚠️ Accounts table still has id column. Renaming now...');
      // Drop dependent tables that might have been created
      await db.query(`DROP TABLE IF EXISTS messages CASCADE`);
      await db.query(`DROP TABLE IF EXISTS logs CASCADE`);
      await db.query(`DROP TABLE IF EXISTS groups CASCADE`);
      await db.query(`DROP TABLE IF EXISTS schedules CASCADE`);
      await db.query(`DROP TABLE IF EXISTS saved_templates CASCADE`);
      await db.query(`DROP TABLE IF EXISTS warnings CASCADE`);
      
      await db.query(`ALTER TABLE accounts RENAME COLUMN id TO account_id`);
      await db.query(`ALTER SEQUENCE IF EXISTS accounts_id_seq RENAME TO accounts_account_id_seq`);
      await db.query(`ALTER TABLE accounts ALTER COLUMN account_id SET DEFAULT nextval('accounts_account_id_seq')`);
      
      const phoneNumCheck = await db.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_name = 'accounts' AND column_name = 'phone_number'
      `);
      if (phoneNumCheck.rows.length > 0) {
        await db.query(`ALTER TABLE accounts RENAME COLUMN phone_number TO phone`);
      }
      console.log('✅ Column renamed');
    }

    // Check if messages table exists and has correct schema
    const messagesTableCheck = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'messages'
      )
    `);
    
    if (messagesTableCheck.rows[0].exists) {
      // Check if it has user_id (old schema) or account_id (new schema)
      const messagesColumnsCheck = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'messages' AND column_name IN ('user_id', 'account_id')
      `);
      
      const hasUserId = messagesColumnsCheck.rows.some(r => r.column_name === 'user_id');
      const hasAccountId = messagesColumnsCheck.rows.some(r => r.column_name === 'account_id');
      
      if (hasUserId && !hasAccountId) {
        // Old schema detected - need to migrate
        console.log('🔄 Migrating messages table from user_id to account_id...');
        
        // Drop old messages table (data will be lost, but it's user_id based which we can't map)
        await db.query('DROP TABLE IF EXISTS messages CASCADE');
        console.log('✅ Old messages table dropped');
      }
    }
    
    // Create messages table (per account, supports A/B testing)
    await db.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        message_text TEXT NOT NULL,
        variant VARCHAR(10) DEFAULT 'A',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create saved_templates table (for Saved Messages sync)
    await db.query(`
      CREATE TABLE IF NOT EXISTS saved_templates (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        slot INTEGER NOT NULL,
        message_text TEXT,
        message_entities TEXT,
        message_id INTEGER,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, slot)
      )
    `);

    // Create schedules table
    await db.query(`
      CREATE TABLE IF NOT EXISTS schedules (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        min_interval INTEGER DEFAULT 5,
        max_interval INTEGER DEFAULT 15,
        schedule_type VARCHAR(50) DEFAULT 'normal',
        schedule_pattern VARCHAR(255),
        custom_settings TEXT,
        is_active BOOLEAN DEFAULT TRUE
      )
    `);

    // Create logs table
    await db.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        user_id BIGINT,
        log_type VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(20) DEFAULT 'info',
        timestamp TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create groups table
    await db.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        group_id BIGINT NOT NULL,
        group_title VARCHAR(255),
        last_message_sent TIMESTAMP WITH TIME ZONE,
        is_active BOOLEAN DEFAULT TRUE,
        UNIQUE(account_id, group_id)
      )
    `);

    // Create warnings table
    await db.query(`
      CREATE TABLE IF NOT EXISTS warnings (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        warning_type VARCHAR(50) NOT NULL,
        warning_count INTEGER DEFAULT 1,
        last_warning_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        admin_notified BOOLEAN DEFAULT FALSE,
        UNIQUE(account_id, warning_type)
      )
    `);

    // Create pending_verifications table (for OTP verification state)
    await db.query(`
      CREATE TABLE IF NOT EXISTS pending_verifications (
        user_id BIGINT PRIMARY KEY,
        phone VARCHAR(20) NOT NULL,
        phone_code_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Verify accounts table has account_id before creating indexes
    const accountIdExists = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'accounts' AND column_name = 'account_id'
    `);
    
    if (accountIdExists.rows.length > 0) {
      // Create indexes only if account_id exists
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id)
    `);

    await db.query(`
        CREATE INDEX IF NOT EXISTS idx_accounts_active ON accounts(user_id, is_active) WHERE is_active = TRUE
      `);
      
      // Check if is_broadcasting column exists before creating index
      const broadcastingColExists = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'accounts' AND column_name = 'is_broadcasting'
      `);
      
      if (broadcastingColExists.rows.length > 0) {
        await db.query(`
          CREATE INDEX IF NOT EXISTS idx_accounts_broadcasting ON accounts(is_broadcasting) WHERE is_broadcasting = TRUE
        `);
      }
    }
    
    // Only create index if messages table exists and has account_id column
    const messagesTableCheckForIndex = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'messages'
      )
    `);
    const messagesAccountIdCheck = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'messages' AND column_name = 'account_id'
    `);
    
    if (messagesTableCheckForIndex.rows[0].exists && messagesAccountIdCheck.rows.length > 0) {
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_messages_account_id ON messages(account_id)
      `);
    }

    if (messagesTableCheckForIndex.rows[0].exists && messagesAccountIdCheck.rows.length > 0) {
      const messagesIsActiveCheck = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'messages' AND column_name = 'is_active'
      `);
      if (messagesIsActiveCheck.rows.length > 0) {
        await db.query(`
          CREATE INDEX IF NOT EXISTS idx_messages_active ON messages(account_id, is_active) WHERE is_active = TRUE
        `);
      }
    }

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_schedules_account_id ON schedules(account_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_schedules_active ON schedules(account_id, is_active) WHERE is_active = TRUE
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_logs_account_id ON logs(account_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_groups_account_id ON groups(account_id)
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_groups_active ON groups(account_id, is_active) WHERE is_active = TRUE
    `);

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_pending_verifications_user_id ON pending_verifications(user_id)
    `);

    // ========== NEW FEATURES TABLES ==========
    
    // Group categories table
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_categories (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        category_name VARCHAR(255) NOT NULL,
        color VARCHAR(20),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, category_name)
      )
    `);

    // Group category assignments
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_category_assignments (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        group_id BIGINT NOT NULL,
        category_id INTEGER NOT NULL REFERENCES group_categories(id) ON DELETE CASCADE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, group_id, category_id)
      )
    `);

    // Group filters (whitelist/blacklist)
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_filters (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        filter_type VARCHAR(20) NOT NULL CHECK (filter_type IN ('whitelist', 'blacklist')),
        group_id BIGINT,
        group_name_pattern VARCHAR(255),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Message templates with variables
    await db.query(`
      CREATE TABLE IF NOT EXISTS message_templates (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        template_name VARCHAR(255) NOT NULL,
        template_text TEXT NOT NULL,
        variables JSONB,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, template_name)
      )
    `);

    // Scheduled messages
    await db.query(`
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        message_text TEXT NOT NULL,
        scheduled_time TIMESTAMP WITH TIME ZONE NOT NULL,
        timezone VARCHAR(50) DEFAULT 'Asia/Kolkata',
        repeat_type VARCHAR(20) CHECK (repeat_type IN ('once', 'daily', 'weekly', 'monthly')),
        repeat_until TIMESTAMP WITH TIME ZONE,
        is_sent BOOLEAN DEFAULT FALSE,
        sent_at TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Broadcast statistics
    await db.query(`
      CREATE TABLE IF NOT EXISTS broadcast_stats (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        broadcast_date DATE NOT NULL,
        total_groups INTEGER DEFAULT 0,
        messages_sent INTEGER DEFAULT 0,
        messages_failed INTEGER DEFAULT 0,
        success_rate DECIMAL(5,2),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, broadcast_date)
      )
    `);

    // Message queue
    await db.query(`
      CREATE TABLE IF NOT EXISTS message_queue (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        message_text TEXT NOT NULL,
        priority INTEGER DEFAULT 5,
        scheduled_for TIMESTAMP WITH TIME ZONE,
        status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
        attempts INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        processed_at TIMESTAMP WITH TIME ZONE
      )
    `);

    // Group analytics
    await db.query(`
      CREATE TABLE IF NOT EXISTS group_analytics (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        group_id BIGINT NOT NULL,
        group_title VARCHAR(255),
        messages_sent INTEGER DEFAULT 0,
        messages_failed INTEGER DEFAULT 0,
        last_message_sent TIMESTAMP WITH TIME ZONE,
        last_error TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, group_id)
      )
    `);

    // User roles and permissions
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
        role VARCHAR(50) DEFAULT 'user' CHECK (role IN ('admin', 'moderator', 'user')),
        permissions JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Account backups
    await db.query(`
      CREATE TABLE IF NOT EXISTS account_backups (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        backup_name VARCHAR(255) NOT NULL,
        backup_data JSONB NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(account_id, backup_name)
      )
    `);

    // Audit logs
    await db.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
        account_id INTEGER REFERENCES accounts(account_id) ON DELETE SET NULL,
        action VARCHAR(100) NOT NULL,
        resource_type VARCHAR(50),
        resource_id VARCHAR(255),
        details JSONB,
        ip_address VARCHAR(45),
        user_agent TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Media attachments
    await db.query(`
      CREATE TABLE IF NOT EXISTS media_attachments (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
        file_id VARCHAR(255) NOT NULL,
        file_type VARCHAR(50),
        file_name VARCHAR(255),
        file_size BIGINT,
        mime_type VARCHAR(100),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Auto-reply rules
    await db.query(`
      CREATE TABLE IF NOT EXISTS auto_reply_rules (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        trigger_type VARCHAR(50) CHECK (trigger_type IN ('keyword', 'mention', 'dm', 'all')),
        trigger_value VARCHAR(255),
        reply_message TEXT NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Content moderation rules
    await db.query(`
      CREATE TABLE IF NOT EXISTS moderation_rules (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        rule_type VARCHAR(50) CHECK (rule_type IN ('keyword', 'user', 'spam')),
        rule_value VARCHAR(255) NOT NULL,
        action VARCHAR(50) CHECK (action IN ('delete', 'warn', 'ban', 'kick')),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // A/B testing analytics
    await db.query(`
      CREATE TABLE IF NOT EXISTS ab_testing_analytics (
        id SERIAL PRIMARY KEY,
        account_id INTEGER NOT NULL REFERENCES accounts(account_id) ON DELETE CASCADE,
        variant VARCHAR(10) NOT NULL CHECK (variant IN ('A', 'B')),
        group_id BIGINT,
        sent_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        engagement_score DECIMAL(5,2),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes for new tables
    await db.query(`CREATE INDEX IF NOT EXISTS idx_group_categories_account_id ON group_categories(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_group_category_assignments_account_id ON group_category_assignments(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_group_filters_account_id ON group_filters(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_message_templates_account_id ON message_templates(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_messages_account_id ON scheduled_messages(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_messages_time ON scheduled_messages(scheduled_time) WHERE is_sent = FALSE`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_broadcast_stats_account_id ON broadcast_stats(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_message_queue_account_id ON message_queue(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_message_queue_status ON message_queue(status, scheduled_for) WHERE status = 'pending'`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_group_analytics_account_id ON group_analytics(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_account_id ON audit_logs(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_auto_reply_rules_account_id ON auto_reply_rules(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_moderation_rules_account_id ON moderation_rules(account_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_ab_testing_analytics_account_id ON ab_testing_analytics(account_id)`);
    
    // Verify accounts table has account_id before running updates
    const finalAccountIdCheck = await db.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'accounts' AND column_name = 'account_id'
    `);
    
    if (finalAccountIdCheck.rows.length > 0) {
      // Migrate existing data if needed (set first account as active)
      await db.query(`
        UPDATE accounts 
        SET is_active = TRUE 
        WHERE account_id IN (
          SELECT MIN(account_id) 
          FROM accounts 
          GROUP BY user_id
        ) AND (is_active IS NULL OR is_active = FALSE)
      `);
    }

    console.log('✅ Database schema initialized');
  } catch (error) {
    logError('❌ Error initializing database schema:', error);
    throw error;
  }
}
