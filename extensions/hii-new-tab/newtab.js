const destination = 'https://humaninformationinterface.com/';
const status = document.getElementById('status');
const retry = document.getElementById('retry');

function openCanvas() {
  if (!navigator.onLine) {
    status.textContent = 'You are offline. Your canvas will open when this browser reconnects.';
    retry.hidden = false;
    return;
  }
  window.location.replace(destination);
}

retry.addEventListener('click', openCanvas);
window.addEventListener('online', openCanvas, { once: true });
openCanvas();
