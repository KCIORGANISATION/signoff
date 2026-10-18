export const PAYMENT_LINK_MAX = 500;
export const PAYMENT_NOTE_MAX = 500;

// Checks a payment link typed by the developer. Only plain https URLs are
// accepted: no javascript:, data: or http:, no spaces, and no "user@host"
// part that could make the link look like it goes somewhere else.
// Returns the normalized URL, null when empty, or false when invalid.
export function parsePaymentLink(input) {
  const text = String(input ?? '').trim();
  if (text === '') return null;
  if (text.length > PAYMENT_LINK_MAX || /[\s\u0000-\u001f\u007f]/.test(text)) return false;

  let url;
  try {
    url = new URL(text);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return false;
  if (url.href.length > PAYMENT_LINK_MAX) return false;
  return url.href;
}

// Domain shown next to the "Pay now" button, so the client knows where they are going.
export function paymentDomain(link) {
  return new URL(link).hostname;
}

// Free text for bank transfer details. Returns null when empty, or false when too long.
export function parsePaymentNote(input) {
  const text = String(input ?? '').replace(/\r\n?/g, '\n').trim();
  if (text === '') return null;
  return text.length > PAYMENT_NOTE_MAX ? false : text;
}
