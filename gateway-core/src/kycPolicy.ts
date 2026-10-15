export const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const CATEGORIES = ["retail", "saas", "education", "services", "food", "travel", "nonprofit", "other"] as const;
export const BUSINESS_TYPES = ["individual", "proprietorship", "partnership", "llp", "private_limited", "public_limited", "trust_ngo"] as const;

// Business types this platform does not serve. Matches are FLAGGED for a human reviewer, never auto-rejected.
const RISK_TERMS = ["casino", "betting", "satta", "matka", "rummy", "poker", "teen patti", "fantasy", "lottery", "jackpot",
  "loan app", "instant loan", "payday", "forex", "binary option", "crypto", "bitcoin", "escort", "adult", "porn", "nutra"];

export function screenRisk(...texts: Array<string | undefined>): string[] {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  return RISK_TERMS.filter((k) => t.includes(k));
}
