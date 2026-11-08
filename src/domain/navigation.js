export function hasIngredientManagement(features = {}) {
  return Boolean(features.fridge || features.shopping);
}

// Shared with the fixed section header and menu scroll geometry.
export const SECTION_TABS_HEIGHT = 44;

export function mainNavigationTab(tab) {
  return tab === 'activity' ? 'menu' : tab;
}

export function mainNavigation(features = {}) {
  return [
    { id: 'menu', label: '小灶', icon: 'menu' },
    { id: 'community', label: '美食', icon: 'community' },
    { id: 'square', label: '发现', icon: 'moments' },
    { id: 'family', label: '我的', icon: 'family' },
  ];
}
