function fill(item) {
  const password = document.querySelector('input[type="password"]');
  const username = document.querySelector('input[autocomplete="username"], input[type="email"], input[name*="user" i]');
  const set = (element, value) => {
    if (!element || !value) return;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  set(username, item.username);
  set(password, item.password);
}

if (document.querySelector('input[type="password"]')) {
  chrome.runtime.sendMessage({ type: 'vault-candidates', origin: location.origin }, (response) => {
    if (response?.items?.length === 1 && confirm(`Fill login for ${response.items[0].username || location.hostname}?`)) fill(response.items[0]);
  });
}
