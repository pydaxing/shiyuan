const targets = new Set(['button', 'view', 'text', 'image', 'input', 'textarea', 'scroll-view']);

export function syncNativeTaps(node) {
  if (node.type !== 1 || !targets.has(node.tag)) return;
  if (node.props.some((prop) => prop.name === 'data-eventsync')) return;
  node.props.push({ type: 6, name: 'data-eventsync', value: { type: 2, content: 'true', loc: node.loc }, loc: node.loc });
}
