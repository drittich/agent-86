export type ModelTier = 'small' | 'balanced' | 'high';

export interface ModelProfile {
  tier: ModelTier;
  /** Max discovery steps before a file-read is required */
  maxDiscoveryStepsBeforeRead: number;
  /** Max file reads before evidence summary is injected */
  maxFileReadsBeforeSummary: number;
  /** Whether broad list_directory glob is allowed as the first call */
  allowBroadListingFirst: boolean;
  /** Empty response count before recovery triggers */
  emptyResponseRecoveryThreshold: number;
  /** 'aggressive' | 'moderate' | 'light' */
  historyCompactionLevel: 'aggressive' | 'moderate' | 'light';
}

export const MODEL_PROFILES: Record<ModelTier, ModelProfile> = {
  small: {
    tier: 'small',
    maxDiscoveryStepsBeforeRead: 1,
    maxFileReadsBeforeSummary: 2,
    allowBroadListingFirst: false,
    emptyResponseRecoveryThreshold: 1,
    historyCompactionLevel: 'aggressive',
  },
  balanced: {
    tier: 'balanced',
    maxDiscoveryStepsBeforeRead: 2,
    maxFileReadsBeforeSummary: 3,
    allowBroadListingFirst: false,
    emptyResponseRecoveryThreshold: 2,
    historyCompactionLevel: 'moderate',
  },
  high: {
    tier: 'high',
    maxDiscoveryStepsBeforeRead: 3,
    maxFileReadsBeforeSummary: 4,
    allowBroadListingFirst: false,
    emptyResponseRecoveryThreshold: 2,
    historyCompactionLevel: 'light',
  },
};

export function getModelProfile(tier: ModelTier): ModelProfile {
  return MODEL_PROFILES[tier];
}
