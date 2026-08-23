<script setup lang="ts">
import {
  loadIntentDraft,
  persistIntentDraft,
} from "../../app/studio/intent-composer.js";
import { commitVideoOnlyContextDraft } from "../../app/studio/context-composer.js";
import { hostedStorage } from "./hosted-adapter";
import HostedComposerStepper from "./composer-stepper.vue";

interface Recipe { id: string; label: string; description: string; revision: string }
const route = useRoute();
useSeoMeta({
  title: "Choose what to find · Frame of Mind",
  description: "Choose the goal for a private hosted recording analysis.",
});
const { data: catalog, error } = await useFetch<{ defaultModel: string; recipes: Recipe[] }>("/api/hosted/recipes");
if (error.value) throw createError({ statusCode: 404, statusMessage: "Not found" });
const selected = ref("");
const focus = ref("");
const saved = ref(false);
let restoring = true;
onMounted(() => {
  const draft = loadIntentDraft(hostedStorage(sessionStorage)).draft;
  if (draft && !("custom" in draft.recipe)) {
    selected.value = draft.recipe.id;
    focus.value = draft.focus ?? "";
    saved.value = true;
    commitVideoOnlyContextDraft(hostedStorage(sessionStorage));
  }
  restoring = false;
});
function save(): boolean {
  const recipe = catalog.value?.recipes.find((item) => item.id === selected.value);
  if (!recipe) return false;
  saved.value = persistIntentDraft(hostedStorage(sessionStorage), {
    recipe: { id: recipe.id, revision: recipe.revision },
    ...(focus.value.trim() ? { focus: focus.value.trim() } : {}),
    model: catalog.value!.defaultModel,
  });
  if (saved.value) commitVideoOnlyContextDraft(hostedStorage(sessionStorage));
  return saved.value;
}
function selectRecipe(id: string): void {
  selected.value = id;
  save();
}
watch(focus, () => { if (!restoring && selected.value) save(); });
</script>

<template>
  <main class="fom-shell py-8" data-hosted-composer="intent">
    <HostedComposerStepper current="intent" :intent-ready="saved" :recording-ready="false" />
    <UAlert
      v-if="typeof route.query.reason === 'string'"
      class="mb-6"
      color="warning"
      variant="soft"
      :description="route.query.reason"
    />
    <h1 class="text-4xl font-black">What should we find?</h1>
    <p class="mt-3 max-w-2xl text-muted">What should we look for in this recording? Pick one.</p>
    <div class="mt-8 grid gap-4 md:grid-cols-2">
      <UCard
        v-for="recipe in catalog?.recipes"
        :key="recipe.id"
        as="button"
        type="button"
        class="text-left transition-shadow hover:ring-2 hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-primary"
        :class="selected === recipe.id ? 'ring-2 ring-primary' : ''"
        :aria-pressed="selected === recipe.id"
        :aria-label="`Choose ${recipe.label}`"
        @click="selectRecipe(recipe.id)"
      >
        <h2 class="font-black">{{ recipe.label }}</h2>
        <p class="mt-2 text-sm text-muted">{{ recipe.description }}</p>
        <p class="mt-4 text-sm font-bold text-primary">{{ selected === recipe.id ? "Selected" : "Choose" }}</p>
      </UCard>
    </div>
    <UFormField
      class="mt-6"
      name="focus"
      label="Optional focus"
      help="Optional. Narrows what the analysis pays attention to."
    >
      <UTextarea
        v-model="focus"
        :maxlength="10000"
        class="w-full"
        placeholder="e.g. only the part about the billing bug"
      />
    </UFormField>
    <UButton v-if="saved" class="mt-6" to="/hosted/new/recording" label="Continue" trailing-icon="i-lucide-arrow-right" />
  </main>
</template>
