function globSource(glob: string): string {
  let source = ''
  let index = 0
  while (index < glob.length) {
    const char = glob.charAt(index)
    if (glob.startsWith('**/', index)) {
      source += '(?:.*/)?'
      index += 3
    } else if (glob.startsWith('**', index)) {
      source += '.*'
      index += 2
    } else if (char === '*') {
      source += '[^/]*'
      index += 1
    } else if (char === '?') {
      source += '[^/]'
      index += 1
    } else if (char === '{' && glob.indexOf('}', index) > index) {
      const end = glob.indexOf('}', index)
      source += `(?:${glob
        .slice(index + 1, end)
        .split(',')
        .map(globSource)
        .join('|')})`
      index = end + 1
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
      index += 1
    }
  }
  return source
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globSource(glob)}$`)
}
