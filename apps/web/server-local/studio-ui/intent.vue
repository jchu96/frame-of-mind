<script setup lang="ts">
import type { CustomRecipe, IntentDraft } from "./intent-composer";
import {
  clearIntentDraft,
  loadIntentDraft,
  parseCustomRecipeImport,
  persistIntentDraft,
  reconcileBuiltInIntentDraft,
  validateIntentDraft,
} from "./intent-composer";
import { useComposerReadiness } from "./use-composer-readiness";

interface RecipeSummary {
  id: string;
  label: string;
  description: string;
  revision: string;
}

interface RecipeCatalog {
  defaultModel: string;
  recipes: RecipeSummary[];
}

useSeoMeta({
  title: "Intent · Frame of Mind",
  description: "Choose the analysis intent for a private local recording.",
});

const {
  data: catalog,
  error: catalogError,
  status: catalogStatus,
} = await useFetch<RecipeCatalog>("/api/studio/recipes", { server: false });
const {
  readiness,
  refresh: refreshReadiness,
  setIntentState,
} = useComposerReadiness();
const runtimeConfig = useRuntimeConfig();
const configuredDefaultModel = runtimeConfig.public.studioDefaultModel;
const fallbackModel = typeof configuredDefaultModel === "string"
  ? configuredDefaultModel
  : "";
const toast = useToast();

const selectedRecipeId = ref("");
const selectedRecipeRevision = ref("");
const focus = ref("");
const model = ref(catalog.value?.defaultModel ?? fallbackModel);
const customMode = ref(false);
const customText = ref("");
const validatedCustom = shallowRef<CustomRecipe>();
const validatedCustomSource = ref("");
const focusError = ref<string>();
const customError = ref<string>();
const recipeError = ref<string>();
const modelError = ref<string>();
const formError = ref<string>();
const storageWarning = ref<string>();
const unreadableDraftNotice = ref<string>();
const staleRecipeNotice = ref<string>();
const saved = ref(false);
const browserMounted = ref(false);
const advancedOpen = ref(false);
let catalogReconcilePending = false;

function markDraft(): void {
  saved.value = false;
  setIntentState("draft");
}

const catalogErrorStatus = computed(() => {
  const error = catalogError.value as {
    status?: number;
    statusCode?: number;
  } | undefined;
  return error?.statusCode ?? error?.status;
});
const catalogErrorDescription = computed(() =>
  catalogErrorStatus.value === 401
    ? "Your Studio session expired. Relaunch Studio and use its new one-time launch URL."
    : "Studio could not load recipes — see logs."
);
const modelItems = computed(() => [
  catalog.value?.defaultModel ?? fallbackModel,
].filter(Boolean));

function selectBuiltIn(recipe: RecipeSummary): void {
  selectedRecipeId.value = recipe.id;
  selectedRecipeRevision.value = recipe.revision;
  customMode.value = false;
  customError.value = undefined;
  recipeError.value = undefined;
  markDraft();
}

function useCustomRecipe(): void {
  selectedRecipeId.value = "";
  selectedRecipeRevision.value = "";
  customMode.value = true;
  recipeError.value = undefined;
  markDraft();
}

function validateCustom(): void {
  customError.value = undefined;
  validatedCustom.value = undefined;
  validatedCustomSource.value = "";
  const result = parseCustomRecipeImport(customText.value);
  if (!result.ok) {
    customError.value = result.fieldErrors.customRecipe;
    return;
  }
  validatedCustom.value = result.recipe;
  validatedCustomSource.value = customText.value;
}

function draftInput(): unknown {
  const trimmedFocus = focus.value.trim();
  const recipe: IntentDraft["recipe"] | undefined = customMode.value
    ? validatedCustom.value && validatedCustomSource.value === customText.value
      ? { custom: validatedCustom.value }
      : undefined
    : selectedRecipeId.value && selectedRecipeRevision.value
      ? {
          id: selectedRecipeId.value,
          revision: selectedRecipeRevision.value,
        }
      : undefined;
  return {
    recipe,
    ...(trimmedFocus ? { focus: trimmedFocus } : {}),
    model: model.value.trim(),
  };
}

function applyBuiltInDraft(
  draft: IntentDraft,
  recipes: RecipeSummary[] | undefined,
): void {
  if ("custom" in draft.recipe) return;
  selectedRecipeId.value = draft.recipe.id;
  selectedRecipeRevision.value = draft.recipe.revision;
  if (!recipes) {
    catalogReconcilePending = true;
    saved.value = true;
    setIntentState("ready");
    return;
  }
  catalogReconcilePending = false;
  const reconciled = reconcileBuiltInIntentDraft(draft, recipes);
  selectedRecipeId.value = reconciled.selectedRecipeId ?? draft.recipe.id;
  selectedRecipeRevision.value =
    reconciled.selectedRecipeRevision ?? draft.recipe.revision;
  if (reconciled.stale) {
    saved.value = false;
    staleRecipeNotice.value =
      "This recipe changed since it was saved. Review the selection and save again.";
    setIntentState("draft");
    return;
  }
  saved.value = true;
  staleRecipeNotice.value = undefined;
  setIntentState("ready");
}

function resetFormFields(): void {
  selectedRecipeId.value = "";
  selectedRecipeRevision.value = "";
  focus.value = "";
  model.value = catalog.value?.defaultModel ?? fallbackModel;
  customMode.value = false;
  customText.value = "";
  validatedCustom.value = undefined;
  validatedCustomSource.value = "";
  focusError.value = undefined;
  customError.value = undefined;
  recipeError.value = undefined;
  modelError.value = undefined;
  formError.value = undefined;
  staleRecipeNotice.value = undefined;
  unreadableDraftNotice.value = undefined;
  saved.value = false;
  advancedOpen.value = false;
}

function startOver(): void {
  clearIntentDraft(sessionStorage);
  resetFormFields();
  setIntentState("empty");
  void refreshReadiness();
}

function saveIntent(): void {
  focusError.value = undefined;
  customError.value = undefined;
  recipeError.value = undefined;
  modelError.value = undefined;
  formError.value = undefined;

  if (focus.value.length > 10_000) {
    focusError.value = "Focus must be 10,000 characters or fewer.";
  }
  if (customMode.value && (
    !validatedCustom.value
    || validatedCustomSource.value !== customText.value
  )) {
    customError.value = "Validate the current custom recipe JSON before saving.";
  }
  if (!model.value.trim()) {
    modelError.value = "Choose an analysis model.";
  }
  if (focusError.value || customError.value || modelError.value) {
    if (modelError.value) advancedOpen.value = true;
    return;
  }

  const result = validateIntentDraft(draftInput());
  if (!result.ok) {
    const missingRecipe = !selectedRecipeId.value && !customMode.value;
    focusError.value = result.fieldErrors.focus;
    recipeError.value = missingRecipe
      ? "Choose one built-in recipe or validate a custom recipe."
      : result.fieldErrors.recipe;
    customError.value = result.fieldErrors.customRecipe
      ?? (customMode.value ? result.fieldErrors.recipe : undefined);
    modelError.value = result.fieldErrors.model;
    formError.value = result.fieldErrors.intent
      ?? (missingRecipe
        ? "Choose one built-in recipe or validate a custom recipe."
        : "Intent needs attention before it can be saved.");
    if (modelError.value) advancedOpen.value = true;
    return;
  }
  if (!persistIntentDraft(sessionStorage, result.draft)) {
    storageWarning.value =
      "The browser could not save this intent draft. Keep this tab open and try again.";
    return;
  }
  saved.value = true;
  staleRecipeNotice.value = undefined;
  unreadableDraftNotice.value = undefined;
  setIntentState("custom" in result.draft.recipe ? "draft" : "ready");
  void refreshReadiness();
  toast.add({
    title: "Intent saved for this analysis",
    description: "Recipe, focus, and model are refresh-safe in this browser session.",
    color: "success",
    icon: "i-lucide-check",
  });
}

watch(catalog, (next) => {
  if (
    next?.defaultModel
    && (!model.value || model.value === fallbackModel)
    && !saved.value
  ) {
    model.value = next.defaultModel;
  }
  if (catalogReconcilePending && next?.recipes) {
    const restored = loadIntentDraft(sessionStorage);
    if (restored.draft && !("custom" in restored.draft.recipe)) {
      applyBuiltInDraft(restored.draft, next.recipes);
    }
  }
}, { immediate: true });

onMounted(() => {
  browserMounted.value = true;
  const restored = loadIntentDraft(sessionStorage);
  if (!restored.storageAvailable) {
    storageWarning.value =
      "Browser session storage is unavailable. Keep this tab open until the analysis starts.";
    return;
  }
  if (restored.invalid) {
    unreadableDraftNotice.value =
      "saved intent could not be read — choose again";
    setIntentState("empty");
    return;
  }
  if (!restored.draft) {
    setIntentState("empty");
    return;
  }
  const draft = restored.draft;
  model.value = draft.model;
  focus.value = draft.focus ?? "";
  if ("custom" in draft.recipe) {
    customMode.value = true;
    validatedCustom.value = draft.recipe.custom;
    customText.value = JSON.stringify(draft.recipe.custom, null, 2);
    validatedCustomSource.value = customText.value;
    saved.value = true;
    setIntentState("draft");
    return;
  }
  applyBuiltInDraft(draft, catalog.value?.recipes);
});
</script>

<template>
  <div data-intent-step="local">
    <AppHeader />
    <main class="fom-shell py-10 sm:py-14">
      <section class="grid gap-8 lg:grid-cols-[1fr_0.6fr] lg:items-end">
        <div>
          <p class="fom-kicker text-primary">Local Studio · Intent</p>
          <h1 class="mt-4 text-4xl font-black tracking-[-0.045em] sm:text-6xl">
            Choose what this analysis should find.
          </h1>
          <p class="mt-5 max-w-3xl text-base leading-7 text-muted sm:text-lg">
            Select one reviewed built-in recipe or validate a strict custom
            recipe. Focus narrows attention; it never changes safety or evidence rules.
          </p>
        </div>
        <UAlert
          color="neutral"
          variant="soft"
          icon="i-lucide-shield-check"
          title="Intent is configuration, not authority"
          description="Recipe instructions and focus are treated as untrusted analysis input. No provider key or secret is shown or stored here."
        />
      </section>

      <UAlert
        v-if="storageWarning"
        class="mt-6"
        color="warning"
        variant="soft"
        title="Refresh-safe draft is limited"
        :description="storageWarning"
      />
      <UAlert
        v-if="unreadableDraftNotice"
        class="mt-6"
        color="warning"
        variant="soft"
        title="Saved intent could not be read"
        :description="unreadableDraftNotice"
      />
      <UAlert
        v-if="staleRecipeNotice"
        class="mt-6"
        color="warning"
        variant="soft"
        title="This recipe changed"
        :description="staleRecipeNotice"
      />

      <section class="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div v-if="browserMounted" class="space-y-6">
          <UCard>
            <template #header>
              <div>
                <p class="fom-kicker text-muted">1 · Intent</p>
                <h2 class="mt-2 text-2xl font-black">Choose one analysis recipe</h2>
              </div>
            </template>

            <UAlert
              v-if="catalogError"
              color="error"
              variant="soft"
              title="Built-in recipes are unavailable"
              :description="catalogErrorDescription"
            />
            <div
              v-else-if="catalogStatus === 'idle' || catalogStatus === 'pending'"
              class="flex items-center gap-3 py-6 text-sm text-muted"
              aria-live="polite"
            >
              <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
              Reading the built-in recipe catalog…
            </div>
            <fieldset
              v-else
              :aria-describedby="recipeError
                ? 'intent-recipe-description intent-recipe-error'
                : 'intent-recipe-description'"
              :aria-invalid="recipeError ? true : undefined"
            >
              <legend class="text-sm font-medium text-highlighted">
                Analysis recipe <span aria-hidden="true" class="text-error">*</span>
              </legend>
              <p id="intent-recipe-description" class="mt-1 text-sm text-muted">
                Cards use the canonical labels and descriptions from the recipe registry.
              </p>
              <div class="mt-3 grid gap-3 sm:grid-cols-2">
                <label
                  v-for="recipe in catalog?.recipes ?? []"
                  :key="recipe.id"
                  class="flex cursor-pointer items-start gap-3 rounded-xl border p-4 transition focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary"
                  :class="selectedRecipeId === recipe.id && !customMode
                    ? 'border-primary bg-primary/10'
                    : 'border-default bg-default hover:bg-elevated'"
                >
                  <input
                    :checked="selectedRecipeId === recipe.id && !customMode"
                    type="radio"
                    name="intent-recipe"
                    :value="recipe.id"
                    class="mt-1 size-4 accent-[var(--ui-primary)]"
                    @change="selectBuiltIn(recipe)"
                  >
                  <span>
                    <span class="block text-sm font-bold text-highlighted">
                      {{ recipe.label }}
                    </span>
                    <span class="mt-1 block text-sm text-muted">
                      {{ recipe.description }}
                    </span>
                  </span>
                </label>
              </div>
              <p
                v-if="recipeError"
                id="intent-recipe-error"
                class="mt-2 text-sm text-error"
              >
                {{ recipeError }}
              </p>
            </fieldset>

            <div class="mt-5 border-t border-default pt-5">
              <UButton
                type="button"
                color="neutral"
                variant="outline"
                icon="i-lucide-braces"
                label="Use a custom recipe"
                @click="useCustomRecipe"
              />
            </div>
          </UCard>

          <UCard v-if="customMode">
            <template #header>
              <div>
                <p class="fom-kicker text-muted">Custom import</p>
                <h2 class="mt-2 text-2xl font-black">Validate strict recipe JSON</h2>
              </div>
            </template>
            <UAlert
              class="mb-5"
              color="warning"
              variant="soft"
              title="Custom recipes cannot run yet"
              description="Custom recipes are accepted as drafts but cannot run until the custom-recipe staging contract exists (custom_recipe_staging_unavailable)."
            />
            <UFormField
              label="Custom recipe JSON"
              description="Instruction-only schema. Unknown keys and charter fields are rejected."
              :error="customError"
              required
            >
              <UTextarea
                v-model="customText"
                class="w-full font-mono"
                :rows="12"
                :aria-describedby="customError ? 'intent-custom-error' : undefined"
                :aria-invalid="Boolean(customError)"
                @update:model-value="validatedCustom = undefined; validatedCustomSource = ''; customError = undefined; markDraft()"
              />
              <template #error>
                <span id="intent-custom-error">{{ customError }}</span>
              </template>
            </UFormField>
            <div class="mt-4 flex flex-wrap items-center gap-3">
              <UButton
                type="button"
                color="neutral"
                variant="outline"
                label="Validate custom recipe"
                @click="validateCustom"
              />
              <UBadge v-if="validatedCustom" color="success" variant="soft">
                Valid · {{ validatedCustom.label }}
              </UBadge>
            </div>
          </UCard>

          <UCard>
            <UFormField
              label="Optional focus"
              description="One bounded prioritization note; 10,000 characters maximum."
              :error="focusError"
            >
              <UTextarea
                v-model="focus"
                class="w-full"
                :rows="5"
                placeholder="Prioritize observable targets…"
                :aria-describedby="focusError ? 'intent-focus-error' : undefined"
                :aria-invalid="Boolean(focusError)"
                @update:model-value="focusError = undefined; markDraft()"
              />
              <template #error>
                <span id="intent-focus-error">{{ focusError }}</span>
              </template>
            </UFormField>
            <p class="mt-2 text-right text-xs text-muted">
              {{ focus.length.toLocaleString() }} / 10,000
            </p>
          </UCard>

          <UCard>
            <UCollapsible v-model:open="advancedOpen">
              <UButton
                type="button"
                color="neutral"
                variant="ghost"
                icon="i-lucide-settings-2"
                label="Advanced model selection"
                trailing-icon="i-lucide-chevron-down"
              />
              <template #content>
                <div class="mt-5">
                  <UFormField
                    label="Analysis model"
                    description="The current Studio default is shown. Provider credentials are configured separately."
                    :error="modelError"
                  >
                    <USelect
                      v-model="model"
                      class="w-full sm:max-w-sm"
                      :items="modelItems"
                      @update:model-value="modelError = undefined; markDraft()"
                    />
                  </UFormField>
                </div>
              </template>
            </UCollapsible>
            <p
              v-if="modelError"
              id="intent-model-error"
              class="mt-3 text-sm text-error"
              role="alert"
            >
              {{ modelError }}
            </p>
          </UCard>

          <UAlert
            v-if="formError"
            role="alert"
            color="error"
            variant="soft"
            title="Intent needs attention"
            :description="formError"
          />
          <UAlert
            v-if="saved"
            color="success"
            variant="soft"
            title="Intent step saved"
            description="This refresh-safe draft contains only recipe, optional focus, and model. No analysis has started."
          />

          <div class="flex flex-wrap gap-3">
            <UButton to="/context" color="neutral" variant="outline" icon="i-lucide-notebook-text">
              Open context
            </UButton>
            <UButton to="/recording" color="neutral" variant="outline" icon="i-lucide-video">
              Open recording
            </UButton>
            <UButton
              type="button"
              color="neutral"
              variant="ghost"
              icon="i-lucide-rotate-ccw"
              label="Start over"
              @click="startOver"
            />
            <UButton type="button" icon="i-lucide-save" @click="saveIntent">
              Save intent
            </UButton>
          </div>
        </div>
        <UCard v-else aria-live="polite">
          <div class="flex items-center gap-3 text-sm text-muted">
            <UIcon name="i-lucide-loader-circle" class="size-5 animate-spin" />
            Preparing the private Intent composer…
          </div>
        </UCard>

        <aside class="space-y-5" aria-label="Intent readiness details">
          <UAlert
            :color="readiness.intent === 'ready' ? 'success' : 'warning'"
            variant="soft"
            :icon="readiness.intent === 'ready' ? 'i-lucide-check-circle' : 'i-lucide-circle-dashed'"
            title="Intent readiness"
            :description="`Intent is ${readiness.intent}. Recording is ${readiness.recording}.`"
          />
          <UAlert
            color="neutral"
            variant="outline"
            icon="i-lucide-file-lock-2"
            title="Strict custom recipes"
            description="Custom JSON is parsed against the same instruction-only Studio schema before this page can save it."
          />
          <UAlert
            color="primary"
            variant="soft"
            icon="i-lucide-route"
            title="Complete sections in any order"
            description="Intent and Recording are required. Context is optional and remains an independent explicit choice."
          />
        </aside>
      </section>
    </main>
  </div>
</template>
