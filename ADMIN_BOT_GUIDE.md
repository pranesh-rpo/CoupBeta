# 👑 Admin Bot Guide

## Overview

The Admin Bot is a separate Telegram bot that provides administrators with full control and monitoring capabilities for the main bot.

## Setup

1. **Create Admin Bot via @BotFather**
   - Open [@BotFather](https://t.me/BotFather) on Telegram
   - Send `/newbot` and follow instructions
   - Copy the bot token

2. **Add to .env file**
   ```env
   ADMIN_BOT_TOKEN=your_admin_bot_token_here
   ADMIN_CHAT_IDS=123456789,987654321
   ADMIN_IDS=123456789,987654321
   ```

3. **Get Your Chat ID**
   - Start a chat with your admin bot
   - Send `/start`
   - Use [@userinfobot](https://t.me/userinfobot) to get your chat ID
   - Add it to `ADMIN_CHAT_IDS` in `.env`

4. **Add Admin User IDs**
   - Add your Telegram user ID to `ADMIN_IDS` in `.env`
   - Multiple admins: comma-separated list

## Admin Bot Commands

### Statistics Commands

#### `/stats`
View overall bot statistics:
- Total users
- Total accounts
- Active broadcasts
- Active groups
- Total messages

#### `/users`
List all users (last 20):
- User ID
- Username
- First name
- Verification status
- Join date

#### `/accounts`
List all accounts (last 20):
- Account ID
- Phone number
- User ID
- Active status
- Broadcasting status
- Creation date

#### `/broadcasts`
View all active broadcasts:
- User ID
- Account ID
- Messages sent count
- Running status

### Monitoring Commands

#### `/logs`
View recent activity logs (last 10):
- Timestamp
- Log type
- Status (success/error/info)
- Message

#### `/errors`
View recent errors (last 10):
- Timestamp
- Error message
- Context

#### `/user <user_id>`
Get detailed user information:
- User profile
- Linked accounts
- Log entries count
- Verification status

#### `/account <account_id>`
Get detailed account information:
- Account details
- Broadcasting status
- Settings
- Statistics

### Control Commands

#### `/stop_broadcast <user_id>`
Stop a user's active broadcast:
- Immediately stops broadcasting
- Useful for emergency stops

#### `/notify <message>`
Send notification to all admins:
- Broadcast message to all admin chats
- Useful for announcements

### Help

#### `/help`
Show all available admin commands

## Automatic Notifications

The admin bot automatically sends notifications for:

### 🚨 Critical Events
- Bot startup/shutdown
- Critical errors
- Database errors
- Connection errors

### 👤 User Actions
- Account linking
- Account deletion
- Broadcast started/stopped
- Account switching
- Message setting
- Groups refreshed

### ⚠️ User Errors
- Start errors
- Linking errors
- OTP errors
- 2FA errors
- Broadcast errors

### 🔐 Security Events
- Session revocations
- Account bans
- Unauthorized access attempts

## Features

### ✅ Real-time Monitoring
- View active broadcasts
- Monitor user activity
- Track errors and logs

### ✅ User Management
- View user details
- Check account status
- Monitor user actions

### ✅ Control Capabilities
- Stop broadcasts remotely
- Send notifications
- Emergency controls

### ✅ Statistics Dashboard
- Overall bot statistics
- User statistics
- Account statistics
- Broadcast statistics

## Security

- Only users in `ADMIN_IDS` can use admin bot commands
- All admin actions are logged
- Admin notifications are sent to `ADMIN_CHAT_IDS`
- Secure authentication via user ID

## Example Usage

```
Admin: /stats
Bot: 📊 Bot Statistics
     👥 Total Users: 150
     🔑 Total Accounts: 200
     📢 Active Broadcasts: 5
     ...

Admin: /user 123456789
Bot: 👤 User Details
     ID: 123456789
     Username: @username
     Accounts: 2
     ...

Admin: /stop_broadcast 123456789
Bot: ✅ Broadcast stopped for user 123456789

Admin: /notify Server maintenance in 10 minutes
Bot: ✅ Notification sent to all admins
```

## Configuration

All admin bot settings are in `.env`:

```env
# Admin Bot Token (from @BotFather)
ADMIN_BOT_TOKEN=your_admin_bot_token_here

# Admin Chat IDs (where notifications are sent)
ADMIN_CHAT_IDS=123456789,987654321

# Admin User IDs (who can use admin commands)
ADMIN_IDS=123456789,987654321
```

## Troubleshooting

**Admin bot not responding?**
- Check `ADMIN_BOT_TOKEN` is correct
- Verify bot is started with `/start`
- Check your user ID is in `ADMIN_IDS`

**Not receiving notifications?**
- Verify your chat ID is in `ADMIN_CHAT_IDS`
- Check bot has permission to send messages
- Ensure admin notifier is initialized

**Commands not working?**
- Verify your user ID is in `ADMIN_IDS`
- Check bot is running
- Review bot logs for errors

---

**The admin bot is now fully functional and ready to use!** 🚀
