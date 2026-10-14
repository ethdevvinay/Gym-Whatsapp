/**
 * THE CLUB 777° — PM2 ECOSYSTEM CONFIGURATION
 * Optimized for Hostinger Cloud Startup Plan (Ubuntu LTS / CloudLinux)
 * Ensures 24x7 operation, automatic crash recovery, memory capping, and log rotation.
 */

module.exports = {
  apps: [
    {
      name: 'club777-whatsapp-worker',
      script: './server.js',
      cwd: __dirname,
      instances: 1, // Single instance required to prevent multiple WhatsApp Web sessions for 1 phone number
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M', // Protects Hostinger VPS from OOM crashes
      restart_delay: 5000,
      max_restarts: 10,
      min_uptime: '30s',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        HOST: '127.0.0.1'
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true
    }
  ]
};
