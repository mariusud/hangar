import type { Adb } from './index.ts';

export class FakePhone {
  serial: string;
  model = 'Pixel 8a';
  packages = new Map<string, string>([['com.example.kept', '/data/app/~~a==/com.example.kept-b==/base.apk']]);
  system = ['android', 'com.android.chrome'];
  files = new Set(['/sdcard', '/sdcard/DCIM', '/sdcard/DCIM/holiday.jpg', '/data/local/tmp']);
  settings = new Map<string, string>([
    ['global/window_animation_scale', '1.0'],
    ['global/transition_animation_scale', '1.0'],
    ['global/animator_duration_scale', '1.0'],
    ['global/stay_on_while_plugged_in', '0'],
    ['system/accelerometer_rotation', '1'],
    ['system/user_rotation', '0'],
  ]);
  night = 'no';
  reverses: string[] = [];
  forwards: string[] = [];
  cleared: string[] = [];
  locked = new Set<string>();
  calls: string[][] = [];
  ceAvailable = 'true';
  findExit = 0;
  mounted = true;
  hasNightCommand = true;
  dead = false;
  private gates: { prefix: string; wait: Promise<void> }[] = [];

  constructor(serial = '39051FDJH000AB') {
    this.serial = serial;
  }

  adb(): Adb {
    return {
      serial: this.serial,
      run: async (...args) => {
        const line = args.join(' ');
        this.calls.push(args);
        for (const gate of this.gates.filter((g) => line.startsWith(g.prefix))) {
          await gate.wait;
        }
        return this.run(args, line);
      },
    };
  }

  hold(prefix: string): () => void {
    let release = (): void => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gates.push({ prefix, wait });
    return release;
  }

  changes(): string[] {
    const reads = ['shell getprop', 'shell find', 'shell settings get', 'shell cmd uimode night', 'shell pm list', 'shell wm size', 'reverse --list', 'forward --list'];
    return this.calls.map((c) => c.join(' ')).filter((line) => line.startsWith('shell cmd uimode night ') || !reads.some((r) => line.startsWith(r)));
  }

  private run(args: string[], line: string): string {
    if (this.dead) {
      throw new Error(`adb: device '${this.serial}' not found`);
    }
    if (line === 'shell getprop sys.user.0.ce_available') {
      return `${this.ceAvailable}\n`;
    }
    if (line === 'shell getprop ro.product.model') {
      return `${this.model}\n`;
    }
    if (line === 'shell getprop ro.build.version.release') {
      return '15\n';
    }
    if (line === 'shell wm size') {
      return 'Physical size: 1080x2400\n';
    }
    if (line === 'shell pm list packages -3 -f') {
      return [...this.packages].map(([pkg, path]) => `package:${path}=${pkg}`).join('\n');
    }
    if (line === 'shell pm list packages') {
      return [...this.system, ...this.packages.keys()].map((pkg) => `package:${pkg}`).join('\n');
    }
    if (line.startsWith('shell find ')) {
      const listed = this.findExit === 0 && this.mounted ? ['/sdcard/Android', ...this.files] : ['/sdcard', '/data/local/tmp'];
      return `${listed.map((f) => `${f}\0`).join('')}devicepool-find-exit=${this.findExit}`;
    }
    if (line.startsWith('shell settings get ')) {
      return `${this.settings.get(`${args[3]}/${args[4]}`) ?? 'null'}\n`;
    }
    if (line.startsWith('shell settings put ')) {
      this.settings.set(`${args[3]}/${args[4]}`, args[5] ?? '');
      return '';
    }
    if (line.startsWith('shell settings delete ')) {
      this.settings.delete(`${args[3]}/${args[4]}`);
      return '';
    }
    if (line === 'shell cmd uimode night') {
      if (!this.hasNightCommand) {
        throw new Error('adb shell failed: Unknown command: night');
      }
      return `Night mode: ${this.night}\n`;
    }
    if (line.startsWith('shell cmd uimode night ')) {
      this.night = args[4] ?? '';
      return '';
    }
    if (line === 'reverse --list') {
      return this.reverses.map((r) => `UsbFfs ${r}`).join('\n');
    }
    if (line === 'forward --list') {
      return [...this.forwards.map((f) => `${this.serial} ${f}`), 'emulator-5600 tcp:7001 tcp:7001'].join('\n');
    }
    if (line.startsWith('reverse --remove ')) {
      this.reverses = this.reverses.filter((r) => !r.startsWith(`${args[2]} `));
      return '';
    }
    if (line.startsWith('forward --remove ')) {
      this.forwards = this.forwards.filter((f) => !f.startsWith(`${args[2]} `));
      return '';
    }
    if (line.startsWith('uninstall ')) {
      if (this.locked.has(args[1] ?? '')) {
        throw new Error('Failure [DELETE_FAILED_DEVICE_POLICY_MANAGER]');
      }
      this.packages.delete(args[1] ?? '');
      return 'Success';
    }
    if (line.startsWith('shell pm clear ')) {
      const pkg = args[3] ?? '';
      if (this.locked.has(pkg) || !(this.packages.has(pkg) || this.system.includes(pkg))) {
        return 'Failed';
      }
      this.cleared.push(pkg);
      return 'Success';
    }
    if (line.startsWith('shell rm -rf -- ')) {
      for (const m of line.matchAll(/'((?:[^']|'\\'')*)'/g)) {
        const path = (m[1] ?? '').replaceAll(String.raw`'\''`, "'");
        for (const f of [...this.files]) {
          if (f === path || f.startsWith(`${path}/`)) {
            this.files.delete(f);
          }
        }
      }
      return '';
    }
    if (line === 'shell svc power stayon usb') {
      this.settings.set('global/stay_on_while_plugged_in', '2');
      return '';
    }
    if (line.startsWith('shell am force-stop ') || line.startsWith('shell input keyevent ') || line === 'shell wm dismiss-keyguard') {
      return '';
    }
    throw new Error(`The fake phone does not know: adb ${line}`);
  }

  useForALease(): void {
    this.packages.set('com.example.app', '/data/app/~~c==/com.example.app-d==/base.apk');
    this.packages.set('dev.mobile.maestro', '/data/app/~~e==/dev.mobile.maestro-f==/base.apk');
    this.files.add('/sdcard/Download');
    this.files.add('/sdcard/Download/report.pdf');
    this.files.add('/sdcard/Movies');
    this.files.add('/sdcard/Movies/run');
    this.files.add('/sdcard/Movies/run/clip.mp4');
    this.files.add("/data/local/tmp/it's.xml");
    this.settings.set('system/accelerometer_rotation', '0');
    this.settings.set('system/user_rotation', '1');
    this.settings.set('global/stay_on_while_plugged_in', '2');
    this.settings.set('global/animator_duration_scale', '0');
    this.night = 'yes';
    this.reverses.push('tcp:8081 tcp:51234');
    this.forwards.push('tcp:7001 tcp:7001');
  }
}
