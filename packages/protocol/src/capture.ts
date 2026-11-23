export type CapturePath = 'iosurface' | 'idb' | 'jpeg';

export const CAPTURE_PATHS: readonly CapturePath[] = ['iosurface', 'idb', 'jpeg'];

export type DeviceCapture = { capture?: CapturePath | null };

const isCapturePath = (v: unknown): v is CapturePath => CAPTURE_PATHS.some((p) => p === v);

export function captureOf(device: object): CapturePath | null {
  return 'capture' in device && isCapturePath(device.capture) ? device.capture : null;
}
