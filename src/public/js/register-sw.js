if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {
      // Installability is a nice-to-have; ignore failures (e.g. non-secure context).
    });
  });
}
