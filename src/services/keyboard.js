let focusedField = null;
let releaseField = null;

export function focusKeyboardField(token, release) { focusedField = token; releaseField = release; }

export function blurKeyboardField(token) {
  if (focusedField === token) { focusedField = null; releaseField = null; }
}

export function isKeyboardFieldEvent(event) {
  const target = event?.target;
  return event?.mark?.keyboardfield === true || event?.mark?.keyboardfield === 'true' || target?.dataset?.keyboardField === true || target?.dataset?.keyboardField === 'true' || Boolean(target?.closest?.('[data-keyboard-field="true"]'));
}

export function dismissFocusedKeyboard(event) {
  if (!focusedField || isKeyboardFieldEvent(event)) return false;
  const release = releaseField;
  focusedField = null;
  releaseField = null;
  release?.();
  uni.hideKeyboard();
  return true;
}

export function createKeyboardDismissGesture({ enabled = () => true, onDrag = () => {} } = {}) {
  let start;
  let field;
  const point = event => event.touches?.[0] || event.changedTouches?.[0] || event;
  function cancel() { start = null; field = null; }
  function begin(event) {
    cancel();
    if (isKeyboardFieldEvent(event)) return;
    start = point(event); field = focusedField;
  }
  function move(event) {
    const current = point(event);
    if (start && Math.hypot(current.clientX - start.clientX, current.clientY - start.clientY) > 10) { cancel(); onDrag(); }
  }
  function end(event) {
    if (isKeyboardFieldEvent(event)) { cancel(); return; }
    move(event);
    if (enabled() && start && field && field === focusedField) dismissFocusedKeyboard();
    cancel();
  }
  return { begin, move, end, cancel };
}
