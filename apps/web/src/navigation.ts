import { useSyncExternalStore } from 'react';
const subscribe = (notify: () => void) => {
  window.addEventListener('popstate', notify);
  return () => window.removeEventListener('popstate', notify);
};
export function usePath() {
  return useSyncExternalStore(subscribe, () => location.pathname);
}
export function navigate(path: string) {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid navigation.');
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
