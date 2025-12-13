# Ora Telegram Bot

A professional Telegram bot that automates sending messages to all groups your account is joined to, using Telegram's MTProto API.

## Features

- 🔗 **Account Linking**: Link your Telegram account using API ID and Hash
- 🔐 **OTP Verification**: Secure OTP verification with interactive keypad
- 📝 **Message Management**: Set custom start and stop messages
- 📢 **Automated Broadcasting**: Send messages to all groups automatically
- 🛑 **Stop Control**: Easy stop button to halt broadcasting

## Prerequisites

1. **Telegram Bot Token**: Get it from [@BotFather](https://t.me/BotFather)
2. **Telegram API Credentials**: Get them from [my.telegram.org/apps](https://my.telegram.org/apps)
   - API ID
   - API Hash
3. **PostgreSQL Database**: PostgreSQL 12+ installed and running

## Installation

1. Clone or download this repository

2. Install dependencies:
```bash
npm install
```

3. Set up PostgreSQL database:
```bash
# Create database
createdb orabot

# Or using psql:
psql -U postgres
CREATE DATABASE orabot;
\q
```

4. Create a `.env` file in the root directory:
```env
# Telegram Bot Configuration
BOT_TOKEN=your_bot_token_here
API_ID=your_api_id_here
API_HASH=your_api_hash_here
SESSION_PATH=./sessions

# PostgreSQL Database Configuration
DB_HOST=localhost
DB_PORT=5432
DB_NAME=orabot
DB_USER=postgres
DB_PASSWORD=your_db_password_here
DB_SSL=false

# Admin Bot Configuration (Optional - for error notifications)
# Create a separate Telegram bot for admin notifications via @BotFather
ADMIN_BOT_TOKEN=your_admin_bot_token_here
# Comma-separated list of chat IDs where notifications will be sent
# To get your chat ID: Start a chat with your admin bot and send /start, or use @userinfobot
ADMIN_CHAT_IDS=123456789,987654321
# Comma-separated list of admin user IDs
ADMIN_IDS=123456789,987654321
```

**Setting up Admin Bot (Optional but Recommended):**
1. Create a new bot via [@BotFather](https://t.me/BotFather) for admin notifications
2. Copy the bot token and add it to `.env` as `ADMIN_BOT_TOKEN`
3. Start a chat with your admin bot and send `/start`
4. Get your chat ID using [@userinfobot](https://t.me/userinfobot) or check bot logs
5. Add your chat ID(s) to `ADMIN_CHAT_IDS` in `.env` (comma-separated for multiple admins)
6. The admin bot will automatically send notifications for:
   - Bot startup/shutdown
   - Critical errors (start errors, linking errors, OTP errors, 2FA errors)
   - Session revocations
   - Account deletions
   - Database errors

5. Create the sessions directory:
```bash
mkdir sessions
```

## Usage

1. Start the bot:
```bash
npm start
```

2. Open Telegram and find your bot

3. Use `/start` to see the main menu with buttons

4. Link your account:
   - Click the "🔗 Link Account" button
   - Enter your phone number in international format (e.g., +1234567890)
   - Enter the verification code using the interactive keypad

5. Set your messages:
   - Click "📝 Set Start Message" button and send your message
   - Click "🛑 Set Stop Message" button and send your message

6. Start broadcasting:
   - Click "▶️ Start Broadcast" to begin sending messages to all groups
   - Use the "🛑 Stop Broadcast" button to halt broadcasting

## Navigation

All features are accessible through buttons in the main menu:
- **🔗 Link Account** - Link your Telegram account
- **📝 Set Start Message** - Set message to send when broadcasting starts
- **🛑 Set Stop Message** - Set message to show when stopping
- **▶️ Start Broadcast** - Start sending messages to all groups
- **⏹️ Stop Broadcast** - Stop the current broadcast
- **📊 Status** - Check your account status and settings
- **◀️ Back to Menu** - Return to main menu from any screen

## Project Structure

```
OraDev/
├── src/
│   ├── index.js                 # Main bot entry point
│   ├── config.js                # Configuration management
│   ├── database/
│   │   ├── db.js                # Database connection
│   │   └── schema.js            # Database schema initialization
│   ├── handlers/
│   │   ├── commandHandler.js    # Command handlers
│   │   ├── keyboardHandler.js   # Keyboard/button handlers
│   │   └── otpHandler.js        # OTP verification handler
│   └── services/
│       ├── accountLinker.js      # Account linking service
│       ├── messageManager.js     # Message management service
│       └── automationService.js  # Broadcasting automation
├── sessions/                    # Session storage (created automatically)
├── package.json
├── .env                         # Your environment variables
└── README.md
```

## Important Notes

⚠️ **Rate Limiting**: The bot includes delays between messages to avoid Telegram rate limits. Adjust if needed.

⚠️ **Privacy**: Your session data and account information are stored in PostgreSQL. Keep your database credentials secure.

⚠️ **API Limits**: Be aware of Telegram's API limits when sending messages to many groups.

## Troubleshooting

- **"Account not linked"**: Make sure you've completed the account linking process using the "Link Account" button
- **"Verification failed"**: Check that you're entering the correct OTP code
- **"Client not available"**: Try linking your account again using the "Link Account" button
- **Database connection errors**: 
  - Ensure PostgreSQL is running: `pg_isready` or `sudo systemctl status postgresql`
  - Verify database credentials in `.env` file
  - Check if database exists: `psql -U postgres -l`
  - Ensure user has proper permissions

## License

ISC
