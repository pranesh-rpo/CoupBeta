import dotenv from 'dotenv';

dotenv.config();

export const config = {
  botToken: process.env.BOT_TOKEN,
  apiId: parseInt(process.env.API_ID),
  apiHash: process.env.API_HASH,
  sessionPath: process.env.SESSION_PATH || './sessions',
  botUsername: process.env.BOT_USERNAME || 'Coup Bot',
  appVersion: process.env.APP_VERSION || 'v0.2.3',
  
  // SQLite Database Configuration
  dbPath: process.env.DB_PATH || './data/bot.db',
  
  // Verification Channel
  verificationChannel: process.env.VERIFICATION_CHANNEL,
  verificationChannelId: parseInt(process.env.VERIFICATION_CHANNEL_ID),
  
  // Updates Channel (auto-join on account link)
  // Can be a single channel or comma-separated list: "channel1,channel2"
  updatesChannel: process.env.UPDATES_CHANNEL || 'BeigeBotUpdates',
  // Parse multiple updates channels
  getUpdatesChannels() {
    if (!this.updatesChannel) return [];
    return this.updatesChannel.split(',').map(ch => ch.trim()).filter(ch => ch);
  },
  
  // Logger Bots
  loggerBotToken: process.env.LOGGER_BOT_TOKEN,
  userLoggerBotToken: process.env.USER_LOGGER_BOT_TOKEN,
  
  // Security
  encryptionKey: process.env.ENCRYPTION_KEY,
  
  // AI / Text Enhancement
  groqApiKey: process.env.GROQ_API_KEY,
  huggingfaceApiKey: process.env.HUGGINGFACE_API_KEY,
  ollamaApiUrl: process.env.OLLAMA_API_URL,
  aiDefaultProvider: process.env.AI_DEFAULT_PROVIDER || 'groq',
  aiModelGroq: process.env.AI_MODEL_GROQ || 'llama-3.1-8b-instant',
  aiMaxTokens: parseInt(process.env.AI_MAX_TOKENS || '500'),
  aiTemperature: parseFloat(process.env.AI_TEMPERATURE || '0.7'),
  aiTimeout: parseInt(process.env.AI_TIMEOUT || '30'),
  
  // Admin
  adminIds: (process.env.ADMIN_IDS || '')
    .split(',')
    .filter(x => x)
    .map(x => parseInt(x))
    .filter(x => !isNaN(x)), // Remove NaN values from invalid entries
  adminBotToken: process.env.ADMIN_BOT_TOKEN,
  adminChatIds: (process.env.ADMIN_CHAT_IDS || '').split(',').filter(x => x).map(x => parseInt(x)),
  
  // Main Account (the account used to create the bot and APIs)
  // This account should never be deleted or marked for re-authentication
  mainAccountPhone: process.env.MAIN_ACCOUNT_PHONE ? process.env.MAIN_ACCOUNT_PHONE.trim() : null,
  
  // Broadcast Settings
  minInterval: 5, // minutes
  maxInterval: 15, // minutes
  messagesPerHour: 5,
  
  // Auto-breaking Settings
  autoBreakDuration: 3.27, // hours before taking a break
  autoBreakLength: 53, // minutes break duration
  
  // Anti-Freeze Security Settings - Aggressive settings to prevent bans
  antiFreeze: {
    // Minimum delay between messages (milliseconds) - INCREASED for safety
    minDelayBetweenMessages: parseInt(process.env.MIN_DELAY_BETWEEN_MESSAGES) || 5000, // 5 seconds (was 2)
    // Maximum delay between messages (milliseconds) - INCREASED for safety
    maxDelayBetweenMessages: parseInt(process.env.MAX_DELAY_BETWEEN_MESSAGES) || 10000, // 10 seconds (was 5)
    // Randomize group order to avoid patterns
    randomizeOrder: true,
    // Add random jitter to cycle timing (±10%)
    cycleJitterPercent: 10,
    // Progressive delay multiplier on rate limit (multiplies base delay)
    rateLimitDelayMultiplier: 3, // Increased from 2
    // Maximum delay when rate limited (milliseconds)
    maxRateLimitDelay: 120000, // 120 seconds (increased from 60)
    // Batch size before taking a break - REDUCED for safety
    batchSize: parseInt(process.env.BATCH_SIZE) || 25, // 25 groups (was 50)
    // Break duration after batch (milliseconds) - INCREASED for safety
    batchBreakDuration: parseInt(process.env.BATCH_BREAK_DURATION) || 60000, // 60 seconds (was 30)
    // Maximum messages per minute globally (safety limit)
    maxMessagesPerMinute: parseInt(process.env.MAX_MESSAGES_PER_MINUTE) || 20, // Max 20 messages/minute
    // Maximum messages per hour globally (safety limit) - REDUCED for ban prevention
    maxMessagesPerHour: parseInt(process.env.MAX_MESSAGES_PER_HOUR) || 300, // Max 300 messages/hour (reduced from 500)
    // Per-group cooldown period (milliseconds) - prevent sending to same group too frequently
    perGroupCooldown: parseInt(process.env.PER_GROUP_COOLDOWN) || 300000, // 5 minutes between messages to same group
    // Maximum messages per day per account (configurable, safe default)
    maxMessagesPerDay: parseInt(process.env.MAX_MESSAGES_PER_DAY) || 1500, // Max 1500 messages/day (reasonable limit)
  },
  
  // Webhook Settings
  webhookUrl: process.env.WEBHOOK_URL, // Full URL where Telegram will send updates (e.g., https://yourdomain.com/webhook)
  webhookPort: parseInt(process.env.WEBHOOK_PORT) || 3000, // Port for webhook server
  webhookSecretToken: process.env.WEBHOOK_SECRET_TOKEN || '', // Optional secret token for webhook verification
  
  
  // Profile Settings
  firstName: process.env.FIRSTNAME || '', // First name for account profile
  lastNameTag: process.env.LASTNAME_TAG || '| Coup Bot 🪽', // Last name tag for account profile
  bioTag: process.env.BIO_TAG || 'Powered by @CoupBot  🤖🚀', // Bio tag for account profile
};

if (!config.botToken) {
  throw new Error('BOT_TOKEN is required in .env file');
}

if (!config.apiId || !config.apiHash) {
  throw new Error('API_ID and API_HASH are required in .env file');
}

// SQLite doesn't require DB_NAME - it uses a file path (dbPath)
// dbPath defaults to ./data/bot.db if not specified
