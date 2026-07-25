export default defineEventHandler((event) => {
  return event.context.frameOfMindUser || { authMode: "off" as const };
});
