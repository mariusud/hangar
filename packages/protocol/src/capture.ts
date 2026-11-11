/**
 * How an agent gets a device's live H.264 stream: the IOSurface screen helper, idb's video stream,
 * or neither, in which case viewers get JPEG screenshots.
 */
export type CapturePath = 'iosurface' | 'idb' | 'jpeg';

export const CAPTURE_PATHS: readonly CapturePath[] = ['iosurface', 'idb', 'jpeg'];

/** What an agent adds to a device in its inventory. `null` until the device's first H.264 stream starts. */
export type DeviceCapture = { capture?: CapturePath | null };

const isCapturePath = (v: unknown): v is CapturePath => CAPTURE_PATHS.some((p) => p === v);

/** The capture path an agent reported for a device, or null for agents that report none. */
export function captureOf(device: object): CapturePath | null {
  return 'capture' in device && isCapturePath(device.capture) ? device.capture : null;
}
