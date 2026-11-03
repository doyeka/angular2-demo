/** Split on `;` at top level, keeping CREATE TRIGGER ... BEGIN ... END; bodies intact. */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let inTrigger = false;
  for (const line of sql.split('\n')) {
    buf += line + '\n';
    if (/CREATE\s+TRIGGER/i.test(line)) inTrigger = true;
    if (inTrigger ? /^\s*END;\s*$/i.test(line) : /;\s*$/.test(line)) {
      if (buf.trim()) out.push(buf.trim());
      buf = '';
      inTrigger = false;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}
