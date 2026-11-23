export type HelpEntry = { usage: string | string[]; about?: string[] };

export const DESCRIPTION_COLUMN = 48;

export function helpSection(title: string | null, entries: HelpEntry[]): string {
  const lines: string[] = title ? [title] : [];
  const pad = ' '.repeat(DESCRIPTION_COLUMN);
  for (const { usage, about = [] } of entries) {
    const rows = typeof usage === 'string' ? [usage] : usage;
    const text = rows.map((row, i) => `${i === 0 ? '  ' : '      '}${row}`);
    const last = text.pop() ?? '';
    const rest = [...about];
    if (rest.length && last.length + 2 <= DESCRIPTION_COLUMN) {
      lines.push(...text, `${last.padEnd(DESCRIPTION_COLUMN)}${rest.shift()}`);
    } else {
      lines.push(...text, last);
    }
    lines.push(...rest.map((row) => `${pad}${row}`));
  }
  return lines.join('\n');
}

export function commandBlocks(help: string, command: string): string {
  const blocks: string[] = [];
  let current: string[] | null = null;
  for (const line of help.split('\n')) {
    const starts = new RegExp(`^ {2}(sudo )?devicepool ${command}( |$)`).test(line);
    if (/^ {2}(sudo )?devicepool /.test(line)) {
      current = starts ? [line] : null;
      if (current) {
        blocks.push('');
      }
    } else if (!line.trim()) {
      current = null;
    } else if (current) {
      current.push(line);
    }
    if (current) {
      blocks[blocks.length - 1] = current.join('\n');
    }
  }
  return blocks.join('\n');
}
