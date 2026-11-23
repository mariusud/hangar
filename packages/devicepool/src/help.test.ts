import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONNECT_TARGETS } from './client.ts';
import { commandBlocks, DESCRIPTION_COLUMN, helpSection } from './help.ts';
import { OPTION_TABLES } from './options.ts';
import { HELP } from './usage.ts';

test('every option a parser accepts is in the help for its command', () => {
  const missing: string[] = [];
  for (const [command, table] of Object.entries(OPTION_TABLES)) {
    const block = commandBlocks(HELP, command);
    assert.ok(block, `the help has no entry for devicepool ${command}`);
    for (const [name, option] of Object.entries(table)) {
      const isMentioned = block.includes(`--${name}`) || (option.short !== undefined && block.includes(`-${option.short}`));
      if (name !== 'lease' && !isMentioned) {
        missing.push(`${command} --${name}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

test('the help names every command', () => {
  for (const command of ['up', 'doctor', 'broker', 'join-token', 'join', 'export', 'import', 'run ios', 'run android', 'run maestro', 'run xcuitest', 'run espresso', 'night open', 'night close', 'night list', 'night report', 'login', 'connect', 'book', 'bookings', 'held', 'devices', 'lease', 'attach', 'keepalive', 'tests', 'images', 'image set', 'image refresh', 'image capture', 'image secret', 'image rm', 'screenshot', 'ui', 'tap', 'type', 'install', 'launch', 'open-url', 'push', 'permission', 'location', 'appearance', 'language', 'dev-menu', 'record', 'recordings', 'watch', 'release']) {
    assert.ok(commandBlocks(HELP, command), `the help has no entry for devicepool ${command}`);
  }
});

test('descriptions start in one column in every section', () => {
  for (const section of HELP.split('\n\n')) {
    for (const line of section.split('\n')) {
      const inline = /^( {2}(?:sudo )?devicepool .*?\S) {2,}(\S.*)$/.exec(line);
      if (inline?.[1]) {
        assert.equal(inline[1].length + (line.length - inline[1].length - inline[2]!.length), DESCRIPTION_COLUMN, line);
      }
    }
  }
  const out = helpSection('T', [{ usage: 'devicepool a', about: ['one', 'two'] }, { usage: ['devicepool b [--long-option-that-fills-the-line] [--another-option]'], about: ['three'] }]);
  assert.deepEqual(out.split('\n').map((l) => l.search(/\S/) === DESCRIPTION_COLUMN || l.includes('devicepool') || l === 'T'), [true, true, true, true, true]);
});

test('the connect targets are the names a booking cannot take', () => {
  assert.deepEqual(CONNECT_TARGETS, ['claude', 'cursor', 'codex', 'ci']);
});
