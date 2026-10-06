const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const token = required("VERCEL_TOKEN");
const projectId = required("VERCEL_PROJECT_ID");
const teamId = required("VERCEL_ORG_ID");
const deploymentUrl = new URL(required("DEPLOYMENT_URL"));
if (
  deploymentUrl.protocol !== "https:" ||
  !deploymentUrl.hostname.endsWith(".vercel.app") ||
  deploymentUrl.username ||
  deploymentUrl.password ||
  deploymentUrl.pathname !== "/" ||
  deploymentUrl.search ||
  deploymentUrl.hash
)
  throw new Error("Expected a Vercel deployment URL");

const request = async (path, options = {}, allowMissing = false) => {
  const url = new URL(path, "https://api.vercel.com");
  url.searchParams.set("teamId", teamId);
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (allowMissing && response.status === 404) return null;
  const data = await response.json();
  if (!response.ok || data.error)
    throw new Error(`Vercel HTTP ${response.status}: ${data.error?.message ?? "request failed"}`);
  return data;
};
const deployment = await request(`/v13/deployments/${deploymentUrl.hostname}`);
if (deployment.projectId !== projectId || deployment.readyState !== "READY")
  throw new Error("Deployment must be ready and belong to the Otter Code project");

const domains = [
  "code.otterware.app",
  "latest.code.otterware.app",
  "nightly.code.otterware.app",
  "code.otterware.dev",
  "latest.code.otterware.dev",
  "nightly.code.otterware.dev",
];
for (const name of domains) {
  const path = `/v9/projects/${projectId}/domains/${name}`;
  let domain = await request(path, {}, true);
  if (!domain)
    domain = await request(`/v10/projects/${projectId}/domains`, {
      method: "POST",
      body: JSON.stringify({ name }),
    });
  if (!domain.verified) {
    console.log(JSON.stringify({ name, verification: domain.verification }));
    domain = await request(`${path}/verify`, { method: "POST" });
    if (!domain.verified) throw new Error(`Domain ownership verification required: ${name}`);
  }
}
for (const name of domains) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await request(`/v2/deployments/${deployment.id}/aliases`, {
        method: "POST",
        body: JSON.stringify({ alias: name }),
      });
      console.log(`Promoted ${name}`);
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.includes("missing a SSL certificate") ||
        attempt >= 11
      )
        throw error;
      console.log(`Waiting for Vercel to issue the certificate for ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}
