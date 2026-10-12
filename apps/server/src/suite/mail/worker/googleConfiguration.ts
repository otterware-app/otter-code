/** Safe configuration metadata; credentials never leave the worker. */
export function googleConfiguration(
  build: { clientId: string; clientSecret: string },
  runtime: { clientId?: string; clientSecret?: string },
) {
  const hasBuildClientSecret = build.clientSecret.trim().length > 0;
  const hasClientSecret = Boolean(runtime.clientSecret?.trim() || build.clientSecret.trim());
  return {
    configured: Boolean((runtime.clientId?.trim() || build.clientId.trim()) && hasClientSecret),
    hasBuildClientSecret,
    hasClientSecret,
  };
}
