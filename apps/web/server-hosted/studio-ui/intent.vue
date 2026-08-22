<script setup lang="ts">
import {
  loadIntentDraft,
  persistIntentDraft,
} from "../../app/studio/intent-composer.js";
import { hostedStorage } from "./hosted-adapter";

interface Recipe { id: string; label: string; description: string; revision: string }
const { data: catalog, error } = await useFetch<{ defaultModel: string; recipes: Recipe[] }>("/api/hosted/recipes");
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
const selected = ref(catalog.value?.recipes[0]?.id ?? "");
const focus = ref("");
const saved = ref(false);
onMounted(() => {
  const draft = loadIntentDraft(hostedStorage(sessionStorage)).draft;
  if (!draft || "custom" in draft.recipe) return;
  selected.value = draft.recipe.id;
  focus.value = draft.focus ?? "";
  saved.value = true;
});
function save(): void {
  const recipe = catalog.value?.recipes.find((item) => item.id === selected.value);
  if (!recipe) return;
  saved.value = persistIntentDraft(hostedStorage(sessionStorage), {
    recipe: { id: recipe.id, revision: recipe.revision },
    ...(focus.value.trim() ? { focus: focus.value.trim() } : {}),
    model: catalog.value!.defaultModel,
  });
}
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="intent">
    <p class="fom-kicker text-primary">Step 1 of 4</p>
    <h1 class="mt-3 text-4xl font-black">Choose intent</h1>
    <p class="mt-3 max-w-2xl text-muted">Choose the validated analysis recipe that will be frozen into the run manifest.</p>
    <div class="mt-8 grid gap-4 md:grid-cols-2">
      <UCard v-for="recipe in catalog?.recipes" :key="recipe.id" :class="selected === recipe.id ? 'ring-2 ring-primary' : ''">
        <h2 class="font-black">{{ recipe.label }}</h2>
        <p class="mt-2 text-sm text-muted">{{ recipe.description }}</p>
        <UButton class="mt-4" :variant="selected === recipe.id ? 'solid' : 'outline'" :label="selected === recipe.id ? 'Selected' : 'Select'" @click="selected = recipe.id; saved = false" />
      </UCard>
    </div>
    <UFormField class="mt-6" label="Optional focus">
      <UTextarea v-model="focus" :maxlength="10000" class="w-full" @input="saved = false" />
    </UFormField>
    <div class="mt-6 flex gap-3">
      <UButton label="Save intent" icon="i-lucide-save" @click="save" />
      <UButton v-if="saved" to="/hosted/new/context" color="neutral" variant="outline" label="Continue to context" />
    </div>
  </main>
</template>
