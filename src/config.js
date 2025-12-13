import dotenv from 'dotenv';

dotenv.config();

export const config = {
  botToken: process.env.BOT_TOKEN,
  apiId: parseInt(process.env.API_ID),
  apiHash: process.env.API_HASH,
  sessionPath: process.env.SESSION_PATH || './sessions',
  botUsername: process.env.BOT_USERNAME || 'OraAdbot',
  appVersion: process.env.APP_VERSION || 'v0.2.3',
  
  // PostgreSQL Database Configuration
  dbHost: process.env.DB_HOST || 'localhost',
  dbPort: parseInt(process.env.DB_PORT) || 5432,
  dbName: process.env.DB_NAME || 'orabot',
  dbUser: process.env.DB_USER || 'postgres',
  dbPassword: process.env.DB_PASSWORD || '',
  dbSsl: process.env.DB_SSL === 'true',
  
  // Verification Channel
  verificationChannel: process.env.VERIFICATION_CHANNEL,
  verificationChannelId: parseInt(process.env.VERIFICATION_CHANNEL_ID),
  
  // Updates Channel (auto-join on account link)
  updatesChannel: process.env.UPDATES_CHANNEL || 'channelOraUpdates',
  
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
  
  // Broadcast Settings
  minInterval: 5, // minutes
  maxInterval: 15, // minutes
  messagesPerHour: 5,
  
  // Auto-breaking Settings
  autoBreakDuration: 3.27, // hours before taking a break
  autoBreakLength: 53, // minutes break duration
};

if (!config.botToken) {
  throw new Error('BOT_TOKEN is required in .env file');
}

if (!config.apiId || !config.apiHash) {
  throw new Error('API_ID and API_HASH are required in .env file');
}

if (!config.dbName) {
  throw new Error('DB_NAME is required in .env file');
}
