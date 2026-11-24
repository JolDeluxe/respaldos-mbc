/**
 * PM2 - mbc-backup-service
 *
 * Se agrega como UN proceso adicional:  pm2 start ecosystem.config.cjs
 * NUNCA use "pm2 restart all", "pm2 delete all" ni "pm2 kill": afectarían a los demás servicios.
 * Operar solo este proceso:  pm2 restart mbc-backup-service --update-env
 */
module.exports = {
  apps: [
    {
      name: 'mbc-backup-service',
      script: 'dist/index.js',
      cwd: __dirname,
      interpreter: 'node',
      instances: 1, // una sola instancia
      exec_mode: 'fork', // nunca cluster
      autorestart: true,
      watch: false,
      // Reinicio con retardo ante fallos (evita bucles de reinicio que carguen el servidor)
      restart_delay: 15000,
      exp_backoff_restart_delay: 5000,
      min_uptime: '30s',
      max_restarts: 20,
      // Una salida limpia (código 0) tras un apagado ordenado NO se reinicia
      stop_exit_codes: [0],
      // Apagado ordenado: señales y, en Windows, mensaje 'shutdown'
      kill_timeout: 150000, // > SHUTDOWN_GRACE_SECONDS (90) + margen para cancelar y limpiar
      shutdown_with_message: true,
      // Sin max_memory_restart: un reinicio por memoria a mitad de una copia sería abrupto.
      time: true,
      merge_logs: true,
      out_file: 'runtime/logs/pm2-out.log',
      error_file: 'runtime/logs/pm2-error.log',
      env: {
        NODE_ENV: 'production',
        MBC_MODE: 'production',
        ENABLE_SCHEDULER: 'true',
      },
    },
  ],
};
