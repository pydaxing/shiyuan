import { readFileSync } from 'node:fs';
import { parse } from '@vue/compiler-sfc';

export function componentSource(name) {
  return readFileSync(new URL(`../../src/components/${name}.vue`, import.meta.url), 'utf8');
}

export function setupSource(name, bindings, exports) {
  const script = parse(componentSource(name)).descriptor.scriptSetup.content.replace(/^import .*;\s*$/gm, '');
  return new Function(...Object.keys(bindings), `${script}\nreturn { ${exports.join(', ')} };`)(...Object.values(bindings));
}
