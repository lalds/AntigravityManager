try {
  if (window.electron?.SENTRY_ENABLED && process.env.NODE_ENV === 'production') {
    import('@sentry/electron/renderer').then((Sentry) => {
      setTimeout(() => {
        Sentry.init({
          dsn: process.env.SENTRY_DSN,
        });
      }, 2000);
    });
  }
} catch (e) {
  console.warn('Sentry initialization failed:', e);
}

import '@/App';
