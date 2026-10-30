// Scope the Bridge's multi-institution response to this app's Fidelity feed.
import { isFidelityOrg } from './simplefin-map.js';

export function filterSimplefinErrors(errors) {
  const messages = Array.isArray(errors) ? errors : typeof errors === 'string' ? [errors] : [];
  return messages.flatMap((message) => String(message).split(/;\s*/)).map((message) => message.trim()).filter((message) => {
    if (!message) return false;
    // Only discard a recognized institution-specific warning. Unknown messages
    // and global failures must remain visible even without "Fidelity" in them.
    const connection = /^Connection to (.+?) may need attention\.\s*Auth required\.?$/i.exec(message);
    return !connection || isFidelityOrg({ name: connection[1] });
  });
}

export function simplefinLastError(errors) {
  return filterSimplefinErrors(errors).join('; ') || null;
}

export function fidelityOnlyPayload(payload) {
  return {
    accounts: (Array.isArray(payload?.accounts) ? payload.accounts : []).filter((account) => isFidelityOrg(account?.org)),
    errors: filterSimplefinErrors(payload?.errors),
  };
}
