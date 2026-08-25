const KEY = 'ak_active_ig_account';

export function getActiveIgAccount() {
  return localStorage.getItem(KEY) || '';
}

export function setActiveIgAccount(id) {
  if (!id) {
    localStorage.removeItem(KEY);
  } else {
    localStorage.setItem(KEY, String(id));
  }

  window.dispatchEvent(new Event('ig-account-changed'));
}

export function clearActiveIgAccount() {
  localStorage.removeItem(KEY);
  window.dispatchEvent(new Event('ig-account-changed'));
}