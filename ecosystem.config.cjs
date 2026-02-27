// PM2 Konfiguration für MCP Project Context Server
module.exports = {
  apps: [
    {
      name: 'mcp-project-context',
      script: 'src/index.js',
      cwd: '/home/jtebbert/projects/mcp-project-context',

      // Interpreter für ES Modules
      interpreter: 'node',

      // Umgebungsvariablen
      env: {
        NODE_ENV: 'production',
        MCP_CONFIG_PATH: '/home/jtebbert/projects/mcp-project-context/config.json'
      },

      // Auto-Restart bei Crashes
      autorestart: true,
      max_restarts: 10,
      restart_delay: 1000,

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: '/home/jtebbert/projects/mcp-project-context/logs/error.log',
      out_file: '/home/jtebbert/projects/mcp-project-context/logs/out.log',
      merge_logs: true,

      // Speicher-Limit (für Raspberry Pi)
      max_memory_restart: '200M',

      // Watch für Development (auskommentiert für Production)
      // watch: ['src'],
      // ignore_watch: ['node_modules', 'logs']
    }
  ]
};
