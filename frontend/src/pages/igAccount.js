const STORAGE_KEY = 'activeInstagramAccount';

export function getActiveIgAccount() {
    return localStorage.getItem(STORAGE_KEY) || '';
}

export function setActiveIgAccount(accountId) {
    if (!accountId) {
        localStorage.removeItem(STORAGE_KEY);
        window.dispatchEvent(new Event('instagram-account-changed'));
        return;
    }

    localStorage.setItem(STORAGE_KEY, String(accountId));
    window.dispatchEvent(new Event('instagram-account-changed'));
}

export function clearActiveIgAccount() {
    localStorage.removeItem(STORAGE_KEY);
    window.dispatchEvent(new Event('instagram-account-changed'));
}
