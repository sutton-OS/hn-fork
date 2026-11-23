export default {
  async scheduled(_event, env) {
    if (!env.ALERTS_ORIGIN || !env.CRON_SECRET) throw new Error("HNx alert scheduler is missing configuration.");
    const response = await fetch(new URL("/api/alert-job", env.ALERTS_ORIGIN), {
      headers: { authorization: "Bearer " + env.CRON_SECRET },
      redirect: "error",
    });
    if (!response.ok) throw new Error("HNx alert scan returned HTTP " + response.status);
  },
};
