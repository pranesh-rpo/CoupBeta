// PM2 Ecosystem Configuration - Keep bot online always
module.exports = {
  apps: [{
    name: 'beige-bot',
    script: 'src/index.js',
    instances: 1,
    exec_mode: 'fork',
    watch: false,
    
    // Memory management
    max_memory_restart: '500M',
    
    // Auto-restart configuration - keep bot online always
    autorestart: true,              // Always restart if crashes
    max_restarts: 1000000,          // Very high number (effectively unlimited)
    min_uptime: '10s',              // Consider it stable after 10 seconds
    restart_delay: 4000,            // Wait 4 seconds before restart
    exp_backoff_restart_delay: 100, // Exponential backoff minimum delay
    
    // Environment variables
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production'
    },
    
    // Logging configuration
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_file: './logs/pm2-combined.log',
    time: true,                     // Add timestamps to logs
    merge_logs: true,               // Merge all log types
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    
    // Graceful shutdown
    kill_timeout: 10000,            // Wait 10 seconds for graceful shutdown
    wait_ready: true,               // Wait for ready event
    listen_timeout: 10000,          // Timeout for ready event
    
    // Process management
    ignore_watch: ['node_modules', 'logs', 'data', '.git'],
    
    // Cron restart (optional - uncomment to restart daily at 3 AM)
    // cron_restart: '0 3 * * *',
  }]
};
