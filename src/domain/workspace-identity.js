// Personal workspace names are storage labels, never publisher nicknames.
export function workspaceDisplayName(family, profile, fallback = '我') {
  const clean = value => typeof value === 'string' ? value.trim() : '';
  if (family?.kind !== 'personal') return clean(family?.name);
  const owner = family.members?.find(member => member.id === family.ownerId)
    || (family.members?.length === 1 ? family.members[0] : null);
  return clean(profile?.name) || clean(owner?.name) || fallback;
}
