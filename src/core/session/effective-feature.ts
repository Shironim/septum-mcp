import type { ValidatedSeptumConfig } from "../config/schema.ts";
import { SessionManager } from "./session-manager.ts";

/** The active lease applies to every checker, regardless of the checking process owner. */
export function resolveEffectiveFeature(root: string, config: ValidatedSeptumConfig, requested?: string): string | undefined {
  const session = SessionManager.getActiveSession(root);
  if (!session) return requested;
  if (requested && requested !== session.feature_key) {
    throw new Error(`Active feature lock is '${session.feature_key}' (owner: ${session.owner_id}). Cannot check different feature '${requested}'.`);
  }
  config.features ??= {};
  config.features[session.feature_key] = {
    ...config.features[session.feature_key], domain: session.domain,
    allowed_touchpoints: session.touchpoints,
  };
  return session.feature_key;
}
