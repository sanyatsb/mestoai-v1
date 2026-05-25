// [AUDIT TZ §6.3] Regex-based jailbreak detector.
//
// Cheap first-line defense against the standard prompt-injection payloads.
// OpenAI Moderation runs after this and catches anything more subtle.
// Adding new patterns here is intentional drift — every match increments
// the user's flag count and emits an audit event, so false positives are
// expensive. Keep the list tight.

const JAILBREAK_PATTERNS: ReadonlyArray<RegExp> = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /forget\s+(all\s+)?(your|previous)\s+(rules|instructions)/i,
  /you\s+are\s+now\s+(DAN|STAN|DUDE)\b/i,
  /act\s+as\s+(if\s+you\s+(have\s+)?no\s+restrictions|an?\s+unrestricted)/i,
  /pretend\s+(you\s+(have\s+)?no\s+(rules|restrictions))/i,
  /\bjailbroken?\b/i,
  /\bdeveloper\s+mode\b/i,
  /^\s*system\s*:/i,
  /\[\[\s*system\s*\]\]/i,
];

export interface JailbreakDetector {
  detect(text: string): { matched: boolean; pattern?: string };
}

export function createJailbreakDetector(): JailbreakDetector {
  return {
    detect(text) {
      for (const pattern of JAILBREAK_PATTERNS) {
        if (pattern.test(text)) {
          return { matched: true, pattern: pattern.source };
        }
      }
      return { matched: false };
    },
  };
}
