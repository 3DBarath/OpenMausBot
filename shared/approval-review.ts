import type { ModelSelection } from "./wire.ts";

export const MAX_APPROVAL_REVIEW_INSTRUCTIONS_LENGTH = 24_000;

/** Provider-native review takes precedence. An absent selection follows the
 * session's exact model and variant. Isolated review reasoning defaults off;
 * an explicitly configured reviewer effort overrides that default. */
export interface ApprovalReviewSettings {
  model?: ModelSelection;
  instructions?: string;
}

export const DEFAULT_APPROVAL_REVIEW_SETTINGS: Readonly<ApprovalReviewSettings> = {};
