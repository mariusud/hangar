import type { PrivacyService } from './index.ts';

// env lists the names the flow reads; values holds the ones the broker's secret store has.
// The host fills any other name from its own environment.
export type ImageSignIn = { flow: string; env: string[]; values: Record<string, string> };

export type ImageSetup = { grants?: PrivacyService[]; signIn?: ImageSignIn };
