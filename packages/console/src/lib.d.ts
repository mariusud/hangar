export type ConsoleDevice = { platform: string; model: string; os: string; host: string; state: string; image?: string | null };
export type DeviceRow = { platform: string; model: string; os: string; host: string; free: number; total: number };
export type LeaseClass = { platform?: string; model?: string; os?: string; image?: string };

export function deviceRows(devices: ConsoleDevice[], image: string | null): DeviceRow[];
export function leaseClass(row: DeviceRow | null, image: string | null): LeaseClass;
export function withView(path: string, view: string | null): string;
export function viewExpiry(view: string | null): number | null;
export const LANGUAGES: [string, string][];
export function isLanguageTag(tag: string): boolean;

export type ConsoleFlow = { flow: string; status: string; recording?: string; firstRecording?: string };
export type FlowLink = { label: string; href: string };
export type LimitField = { key: 'idle' | 'max' | 'grace'; label: string; unit: string; ms: number };

export function duration(ms: number): string;
export function limitsText(limits: { idleMs: number; maxMs: number }): string;
export function flowRecordings(flow: ConsoleFlow): FlowLink[];
export function canRerun(run: { state: string }, flow: ConsoleFlow): boolean;
export function parseEnv(text: string): Record<string, string>;
export function percent(rate: number): string;
export function canRotate(platform: string): boolean;
export const LIMIT_FIELDS: LimitField[];
export function capSeconds(value: string, field: LimitField): number | null;
export function capValue(ms: number, field: LimitField): string;
