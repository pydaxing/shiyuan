import { onScopeDispose, ref } from 'vue';
import { afterNativeRender } from './nativeRender.js';

let accordionSequence = 0;

export function useRecipeAccordion({ scrollTo, isActive = () => true } = {}) {
  const expanded = ref('');
  const scrollAnchor = ref('');
  const prefix = `recipe-accordion-${++accordionSequence}`;
  let revision = 0;
  const recipeAnchor = index => `${prefix}-${index}`;
  function cancelRecipeScroll() {
    revision += 1;
    scrollAnchor.value = '';
  }
  function resetRecipes() {
    cancelRecipeScroll();
    expanded.value = '';
  }
  async function toggleRecipe(recipeId, index) {
    cancelRecipeScroll();
    const opening = expanded.value !== recipeId;
    expanded.value = opening ? recipeId : '';
    if (!opening) return;
    const request = revision;
    await afterNativeRender();
    if (request !== revision || !isActive()) return;
    const anchor = recipeAnchor(index);
    if (scrollTo) { scrollTo(anchor); return; }
    scrollAnchor.value = anchor;
    await afterNativeRender();
    if (request === revision) scrollAnchor.value = '';
  }
  onScopeDispose(cancelRecipeScroll);
  return { expanded, scrollAnchor, recipeAnchor, toggleRecipe, resetRecipes, cancelRecipeScroll };
}
