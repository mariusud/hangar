import type { PrivacyService } from './index.ts';

export type ImageSignIn = { flow: string; env: string[]; values: Record<string, string> };

export type ImageSetup = { grants?: PrivacyService[]; signIn?: ImageSignIn };
