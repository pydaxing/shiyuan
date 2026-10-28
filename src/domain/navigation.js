export function hasIngredientManagement(features = {}) {
  return Boolean(features.fridge || features.shopping);
}

export function mainNavigation(features = {}) {
  return [
    { id: 'menu', label: '菜单', icon: 'menu' },
    { id: 'kitchen', label: '厨房', icon: 'chef' },
    { id: 'community', label: '美食', icon: 'community' },
    { id: 'ingredients', label: features.fridge ? '食材' : '采购', icon: features.fridge ? 'inventory' : 'shopping' },
    { id: 'family', label: '我家', icon: 'family' },
  ];
}
