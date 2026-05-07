module.exports = {
  apps: [
    {
      name: 'flutter-ssl-patch',
      script: 'server.js',
      cwd: '/home/user/webapp',
      instances: 1,
      exec_mode: 'fork',
      watch: false,

      // ── Auto-restart on crash ──────────────────────────────────────────
      autorestart: true,          // restart jika proses crash/exit
      max_restarts: 20,           // maks 20x restart sebelum dianggap unstable
      min_uptime: '10s',          // harus hidup minimal 10 detik agar tidak dihitung restart
      restart_delay: 2000,        // tunggu 2 detik sebelum restart

      // ── Memory threshold ──────────────────────────────────────────────
      max_memory_restart: '400M', // restart otomatis jika RAM > 400 MB

      // ── Graceful shutdown ──────────────────────────────────────────────
      kill_timeout: 5000,         // tunggu 5 detik untuk graceful shutdown sebelum SIGKILL
      listen_timeout: 8000,       // tunggu 8 detik untuk proses siap

      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },

      // ── Logging ───────────────────────────────────────────────────────
      error_file:      '/home/user/webapp/logs/err.log',
      out_file:        '/home/user/webapp/logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs:      true,      // gabung stdout+stderr ke satu file
    },
  ],
};
