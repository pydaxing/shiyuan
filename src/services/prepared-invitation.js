import { computed, ref, watch } from 'vue';

export function familyInvitationContext(snapshot, session) {
  const family = snapshot.family;
  if (session.phase !== 'ready' || !session.userId || !session.familyId || family.ownerId !== session.userId) return null;
  if (!family.members.some(member => member.id === session.userId)) return null;
  return {
    familyId: session.familyId,
    key: JSON.stringify([session.userId, session.familyId, family.ownerId, family.members.map(member => member.id).sort()]),
  };
}

export function createPreparedInvitation({ getContext, request, now = Date.now, schedule = setTimeout, cancel = clearTimeout, maxAge = 15 * 60000 }) {
  const context = computed(getContext);
  const identity = computed(() => context.value?.key || '');
  const saved = ref(null);
  const error = ref('');
  const pendingKey = ref('');
  const prepared = computed(() => saved.value?.key === identity.value ? saved.value.value : null);
  const busy = computed(() => Boolean(identity.value && pendingKey.value === identity.value));
  let pending;
  let generation = 0;
  let timer;
  let active = false;
  function pause() { active = false; cancel(timer); }
  function arm() {
    cancel(timer);
    if (active && saved.value) timer = schedule(() => { ensure().catch(() => {}); }, Math.max(1000, saved.value.until - now()));
  }
  function clear() {
    generation += 1;
    cancel(timer); saved.value = null; pending = null; pendingKey.value = ''; error.value = '';
  }
  function ensure() {
    const current = context.value;
    if (!current) { clear(); return Promise.resolve(null); }
    if (saved.value?.key === current.key && saved.value.until > now()) { arm(); return Promise.resolve(saved.value.value); }
    if (pending && pendingKey.value === current.key) return pending;
    clear();
    const version = generation;
    pendingKey.value = current.key;
    pending = Promise.resolve().then(() => {
      if (version !== generation || identity.value !== current.key) throw new Error('家庭已变更，请重新邀请');
      return request({ familyId: current.familyId });
    }).then(invite => {
      if (version !== generation || identity.value !== current.key) throw new Error('家庭已变更，请重新邀请');
      if (!/^[a-f0-9]{48}$/.test(invite?.token || '') || !Number.isFinite(invite.expiresAt) || invite.expiresAt <= now() + 60000) throw new Error('邀请暂时不可用，请重试');
      saved.value = { key: current.key, value: invite, until: Math.min(now() + maxAge, invite.expiresAt - 60000) };
      arm();
      return invite;
    }).catch(failure => {
      if (version === generation) error.value = failure.message || '邀请暂时不可用，请重试';
      throw failure;
    }).finally(() => {
      if (version === generation) { pending = null; pendingKey.value = ''; }
    });
    return pending;
  }
  const stop = watch(identity, () => { clear(); if (active) ensure().catch(() => {}); });
  function resume() { active = true; return ensure(); }
  function dispose() { pause(); clear(); stop(); }
  return { prepared, busy, error, ensure, resume, pause, dispose };
}
