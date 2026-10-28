import { readFile } from 'node:fs/promises';
const start = Number(process.argv[2] || 0);
const count = Number(process.argv[3] || 5);
const file = process.argv[4] || 'artifacts/recipe-normalization-20261027/ingredient-prepared-review-input.json';
const recipes = JSON.parse(await readFile(file, 'utf8'));
for (const [offset, recipe] of recipes.slice(start, start + count).entries()) {
  console.log(JSON.stringify({ index: start + offset, title: recipe.title, minutes: recipe.minutes, ingredients: recipe.ingredients.map(ingredient => `${ingredient.name}:${ingredient.amountText ?? `${ingredient.quantity}${ingredient.unit}`}`), steps: recipe.steps.map(step => step.title ? `[已有标题:${step.title}]${step.text}` : step.text || `[仅图片${step.imageCount}张]`) }));
}
