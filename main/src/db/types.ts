// Shared discriminator for the conversations.feature_type column. Adding a
// new conversation kind here forces the type-checker to surface every guard
// that needs to handle it.
export type FeatureType = 'message' | 'review' | 'debate' | 'surf' | 'portrait';
