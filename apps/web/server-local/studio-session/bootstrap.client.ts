import {
  LOCAL_STUDIO_BOOTSTRAP_FRAGMENT,
  LOCAL_STUDIO_BOOTSTRAP_PATH,
  LOCAL_STUDIO_CLEAN_PATH,
} from "./contract";

export default defineNuxtPlugin(() => {
  const hash = window.location.hash;
  if (!hash.startsWith(LOCAL_STUDIO_BOOTSTRAP_FRAGMENT)) return;

  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  let token: string;
  try {
    token = decodeURIComponent(
      hash.slice(LOCAL_STUDIO_BOOTSTRAP_FRAGMENT.length),
    );
  } catch {
    window.location.replace("/");
    return;
  }

  void $fetch<{ redirect: string }>(LOCAL_STUDIO_BOOTSTRAP_PATH, {
    method: "POST",
    body: { token },
  }).then(({ redirect }) => {
    window.location.replace(redirect || LOCAL_STUDIO_CLEAN_PATH);
  }).catch(() => {
    window.location.replace("/");
  });
});
