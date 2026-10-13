const ESCAPE = /[.+^$()|[\]\\]/g;

function body(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end < 0) { out += '\\{'; continue; }
      out += `(?:${glob.slice(i + 1, end).split(',').map(body).join('|')})`;
      i = end;
    } else out += c.replace(ESCAPE, '\\$&');
  }
  return out;
}

/** Path glob: `**`, `*`, `?`, `{a,b}`. A pattern without wildcards also matches everything below it. */
export function globToRegExp(glob: string): RegExp {
  const g = glob.replace(/^\.\//, '').replace(/^\//, '');
  if (g.endsWith('/')) return new RegExp(`^${body(g)}.*$`);
  return new RegExp(`^${body(g)}${/[*?{]/.test(g) ? '' : '(?:/.*)?'}$`);
}

/** CODEOWNERS pattern, gitignore style. */
export function ownersPatternToRegExp(pattern: string): RegExp {
  const anchored = pattern.startsWith('/') || pattern.slice(0, -1).includes('/');
  const p = pattern.replace(/^\//, '');
  const head = anchored ? '^' : '^(?:.*/)?';
  if (p.endsWith('/')) return new RegExp(`${head}${body(p)}.*$`);
  if (p.endsWith('/*')) return new RegExp(`${head}${body(p)}$`);
  return new RegExp(`${head}${body(p)}(?:/.*)?$`);
}
