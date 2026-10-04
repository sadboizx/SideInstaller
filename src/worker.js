/**
 * SideInstaller website — Cloudflare Worker
 *
 * - Serves static assets with correct MIME types for iOS OTA
 * - Dynamic /api/certs endpoint:
 *     Reads public/certificates/index.json (list of folder names)
 *     Fetches each folder's .mobileprovision, parses ExpirationDate etc.
 *     Returns JSON array used by index.html to render cert-cards
 * - Dynamic POST /api/sign endpoint:
 *     Body: { "cert": "<folder name from certificates/index.json>" }
 *     Validates the certificate, then dispatches the "Sign Feather IPA"
 *     GitHub Actions workflow (.github/workflows/sign.yml) via the GitHub API.
 *     zsign cannot run on Workers, so signing happens on a GitHub-hosted
 *     Ubuntu runner; the Worker only dispatches the job and polls its status.
 *     Deduplicates: reuses an already-running job, or reuses the last
 *     successful signed build instead of starting a new run.
 * - Dynamic GET /api/sign-status?cert=<folder> endpoint:
 *     Polls the newest workflow run for that certificate and reports:
 *       not_started | running | finishing | complete | failed
 *     On "complete" it returns the OTA manifest URL (plistUrl), which the
 *     page opens via itms-services:// automatically.
 *
 * Full flow (also described in the UI, "How to install"):
 *   1. User taps Install on a certificate card → POST /api/sign {cert}
 *   2. Worker dispatches the workflow → workflow builds zsign, signs
 *      public/feather/Feather.ipa with the cert's .p12 + .mobileprovision,
 *      uploads the signed IPA to a GitHub Release, generates
 *      public/output/feather-<cert>.plist and commits it.
 *   3. The page polls GET /api/sign-status until the run succeeds and the
 *      manifest is live, then opens
 *      itms-services://?action=download-manifest&url=<manifest>.
 *
 * How to add a new certificate (no local machine needed):
 *   1. Create folder: public/certificates/My Cert Name/
 *   2. Put  .mobileprovision  and  .p12  inside
 *   3. Add "My Cert Name" to public/certificates/index.json
 *   4. (Optional) add its .p12 password to the P12_PASSWORDS repo secret
 *   5. Deploy → /api/certs automatically picks it up, and /api/sign can
 *      sign with it immediately.
 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".plist": "application/xml",
  ".mobileconfig": "application/x-apple-aspen-config",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".ipa": "application/octet-stream",
  ".mobileprovision": "application/octet-stream",
  ".p12": "application/x-pkcs12",
};

function contentType(path) {
  const i = path.lastIndexOf(".");
  if (i === -1) return "application/octet-stream";
  return MIME[path.slice(i).toLowerCase()] || "application/octet-stream";
}

/** Extract the clear-text XML plist from a .mobileprovision (CMS signed) */
function extractPlistXml(buffer) {
  const bytes = new Uint8Array(buffer);
  // Look for "<?xml"
  const startTag = [0x3c, 0x3f, 0x78, 0x6d, 0x6c]; // <?xml
  let start = -1;
  for (let i = 0; i < bytes.length - 5; i++) {
    if (
      bytes[i] === startTag[0] &&
      bytes[i + 1] === startTag[1] &&
      bytes[i + 2] === startTag[2] &&
      bytes[i + 3] === startTag[3] &&
      bytes[i + 4] === startTag[4]
    ) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;

  // Look for "</plist>"
  const endStr = "</plist>";
  const endBytes = new TextEncoder().encode(endStr);
  let end = -1;
  for (let i = start; i < bytes.length - endBytes.length; i++) {
    let match = true;
    for (let j = 0; j < endBytes.length; j++) {
      if (bytes[i + j] !== endBytes[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      end = i + endBytes.length;
      break;
    }
  }
  if (end < 0) return null;

  return new TextDecoder("utf-8").decode(bytes.subarray(start, end));
}

/** Very small XML → object parser for the keys we need from mobileprovision */
function parseProvisionXml(xml) {
  const get = (tag) => {
    const re = new RegExp(`<key>${tag}</key>\\s*<string>([^<]*)</string>`, "i");
    const m = xml.match(re);
    return m ? m[1] : null;
  };
  const getDate = (tag) => {
    const re = new RegExp(`<key>${tag}</key>\\s*<date>([^<]*)</date>`, "i");
    const m = xml.match(re);
    return m ? m[1] : null;
  };

  return {
    Name: get("Name"),
    AppIDName: get("AppIDName"),
    TeamName: get("TeamName"),
    UUID: get("UUID"),
    ExpirationDate: getDate("ExpirationDate"),
    CreationDate: getDate("CreationDate"),
  };
}

async function fetchAsset(env, path) {
  if (!env.ASSETS) return null;
  const res = await env.ASSETS.fetch(new Request(new URL(path, "https://assets.local")));
  if (res.status === 404) return null;
  return res;
}

/* ---------------- GitHub sign integration ---------------- */

const RUN_NAME_PREFIX = "sign :: ";
const STALE_AFTER_MS = 45 * 60 * 1000; // a sign job older than this is dead

function safeSlug(name) {
  const s = String(name)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s || "cert";
}

function plistPathFor(cert) {
  return `/output/feather-${safeSlug(cert)}.plist`;
}

function releaseTagFor(cert) {
  return `feather-signed-${safeSlug(cert)}`;
}

function releaseAssetNameFor(cert) {
  return `Feather-${safeSlug(cert)}.ipa`;
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sideinstaller-worker",
  };
}

async function gh(env, path, init = {}) {
  if (!env.GH_REPO) throw Object.assign(new Error("GH_REPO is not configured"), { status: 500 });
  if (!env.GITHUB_TOKEN) {
    throw Object.assign(new Error("GITHUB_TOKEN secret is not configured"), { status: 500 });
  }
  const res = await fetch(`https://api.github.com/repos/${env.GH_REPO}${path}`, {
    ...init,
    headers: { ...ghHeaders(env), ...(init.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`GitHub API ${res.status}: ${text.slice(0, 200)}`), { status: 502 });
  }
  if (res.status === 204) return null;
  return res.json();
}

async function getIndexFolders(env) {
  const r = await fetchAsset(env, "/certificates/index.json");
  if (!r) return null;
  try {
    const j = await r.json();
    if (!Array.isArray(j)) return null;
    return j.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  } catch {
    return null;
  }
}

/** Newest workflow_dispatch run of the sign workflow whose run-name matches the cert */
async function latestRunForCert(env, cert) {
  const workflow = env.GH_WORKFLOW || "sign.yml";
  const data = await gh(
    env,
    `/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=30`
  );
  const runs = (data && data.workflow_runs) || [];
  const want = RUN_NAME_PREFIX + cert;
  return runs.find((r) => r.name === want) || null;
}

async function releaseAsset(env, tag, assetName) {
  let rel;
  try {
    rel = await gh(env, `/releases/tags/${encodeURIComponent(tag)}`);
  } catch {
    return null;
  }
  const assets = (rel && rel.assets) || [];
  return assets.find((a) => a.name === assetName) || null;
}

function absUrl(request, path) {
  const url = new URL(request.url);
  let origin = url.origin;
  if (origin.startsWith("http://")) origin = "https://" + origin.slice(7);
  return origin + path;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

function runAgeMs(run) {
  const t = Date.parse(run.created_at);
  return isNaN(t) ? Infinity : Date.now() - t;
}

/**
 * POST /api/sign  { cert }
 * Validates the certificate against certificates/index.json, then either
 * reuses an in-flight/successful job or dispatches a fresh workflow run.
 */
async function handleSign(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const cert = body && typeof body.cert === "string" ? body.cert.trim() : "";
  const folders = await getIndexFolders(env);
  if (!folders) return json({ error: "certificates/index.json not found" }, 500);
  if (!cert || !folders.includes(cert)) return json({ error: "Unknown certificate" }, 400);

  const workflow = env.GH_WORKFLOW || "sign.yml";
  const ref = env.GH_REF || "main";
  const tag = releaseTagFor(cert);
  const assetName = releaseAssetNameFor(cert);
  const plistPath = plistPathFor(cert);

  const alreadyComplete = async () => {
    const asset = await releaseAsset(env, tag, assetName);
    if (!asset) return null;
    return {
      state: "complete",
      reused: true,
      plistUrl: absUrl(request, plistPath),
      ipaUrl: asset.browser_download_url,
      tag,
    };
  };

  try {
    const run = await latestRunForCert(env, cert);

    if (run && (run.status === "queued" || run.status === "in_progress")) {
      if (runAgeMs(run) < STALE_AFTER_MS) {
        // Don't start a second expensive run — the page will poll this one.
        return json({ state: "running", runUrl: run.html_url });
      }
      // Stale job: fall through and dispatch a fresh run below.
    } else if (run && run.status === "completed") {
      if (run.conclusion === "success") {
        const done = await alreadyComplete();
        if (done) return json(done);
        // Successful run but the release asset is gone → re-dispatch below.
      }
      // failed / cancelled / timed_out → allow a fresh dispatch below.
    }

    await gh(env, `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, inputs: { cert } }),
    });
    return json({ state: "started" });
  } catch (e) {
    return json({ error: e.message || "Sign request failed" }, e.status || 502);
  }
}

/**
 * GET /api/sign-status?cert=<folder>
 * Reports the sign job state for a certificate. "complete" is only returned
 * once the OTA manifest is actually reachable (the workflow commits it, then
 * the Worker redeploys).
 */
async function handleSignStatus(request, env) {
  const url = new URL(request.url);
  const cert = (url.searchParams.get("cert") || "").trim();
  const folders = await getIndexFolders(env);
  if (!folders) return json({ error: "certificates/index.json not found" }, 500);
  if (!cert || !folders.includes(cert)) return json({ error: "Unknown certificate" }, 400);

  const tag = releaseTagFor(cert);
  const assetName = releaseAssetNameFor(cert);
  const plistPath = plistPathFor(cert);

  try {
    const run = await latestRunForCert(env, cert);
    if (!run) return json({ state: "not_started" });

    if (run.status === "queued" || run.status === "in_progress") {
      if (runAgeMs(run) >= STALE_AFTER_MS) {
        return json({
          state: "failed",
          conclusion: "timed_out",
          runUrl: run.html_url,
          error: "The sign job timed out. Please try again.",
        });
      }
      return json({ state: "running", since: run.created_at, runUrl: run.html_url });
    }

    if (run.status === "completed" && run.conclusion === "success") {
      const asset = await releaseAsset(env, tag, assetName);
      if (!asset) {
        return json({
          state: "failed",
          conclusion: run.conclusion,
          runUrl: run.html_url,
          error: "Sign succeeded but the release asset is missing.",
        });
      }
      const plistRes = await fetchAsset(env, plistPath);
      if (!plistRes) {
        return json({ state: "finishing", runUrl: run.html_url, ipaUrl: asset.browser_download_url });
      }
      return json({
        state: "complete",
        plistUrl: absUrl(request, plistPath),
        ipaUrl: asset.browser_download_url,
        tag,
        runUrl: run.html_url,
      });
    }

    return json({
      state: "failed",
      conclusion: run.conclusion,
      runUrl: run.html_url,
      error: `The sign job ${run.conclusion || "failed"}. Try again or pick another certificate.`,
    });
  } catch (e) {
    return json({ error: e.message || "Status check failed" }, e.status || 502);
  }
}

/* ---------------- /api/certs (unchanged) ---------------- */

/** Build the list of certs from certificates/index.json + each folder's provision */
async function buildCerts(env) {
  const indexRes = await fetchAsset(env, "/certificates/index.json");
  if (!indexRes) {
    return { error: "certificates/index.json not found", certs: [] };
  }

  let folders;
  try {
    folders = await indexRes.json();
  } catch {
    return { error: "invalid certificates/index.json", certs: [] };
  }
  if (!Array.isArray(folders)) {
    return { error: "certificates/index.json must be an array of folder names", certs: [] };
  }

  const now = Date.now();
  const certs = [];

  for (const folder of folders) {
    if (typeof folder !== "string" || !folder.trim()) continue;
    const name = folder.trim();

    // Try common provision filenames
    const candidates = [
      `/certificates/${name}/${name}.mobileprovision`,
      `/certificates/${name}/${name.replace(/ /g, "-")}.mobileprovision`,
      `/certificates/${name}/profile.mobileprovision`,
    ];

    let provisionBuf = null;
    for (const p of candidates) {
      const r = await fetchAsset(env, p);
      if (r) {
        provisionBuf = await r.arrayBuffer();
        break;
      }
    }

    if (!provisionBuf) {
      const safeName = name.replace(/ /g, "-");
      certs.push({
        name: safeName,
        displayName: name,
        days: -999999,
        rank: 1,
        status: "unknown",
        expires: null,
        teamName: name,
        appIdName: "",
        uuid: "",
        plist: `/output/sideinstaller-${safeName}.plist`,
        hasP12: false,
        hasProvision: false,
        folder: name,
        note: "mobileprovision not found",
      });
      continue;
    }

    const xml = extractPlistXml(provisionBuf);
    if (!xml) {
      const safeName = name.replace(/ /g, "-");
      certs.push({
        name: safeName,
        displayName: name,
        days: -999999,
        rank: 1,
        status: "unknown",
        expires: null,
        teamName: name,
        appIdName: "",
        uuid: "",
        plist: `/output/sideinstaller-${safeName}.plist`,
        hasP12: true,
        hasProvision: true,
        folder: name,
        note: "could not parse mobileprovision",
      });
      continue;
    }

    const info = parseProvisionXml(xml);
    const safeName = name.replace(/ /g, "-");

    let days = -999999;
    let expStr = null;
    let status = "unknown";
    let rank = 1;

    if (info.ExpirationDate) {
      const expMs = Date.parse(info.ExpirationDate);
      if (!isNaN(expMs)) {
        days = Math.floor((expMs - now) / 86400000);
        expStr = new Date(expMs).toISOString().slice(0, 10);
        if (days > 0) {
          status = "valid";
          rank = 0;
        } else {
          status = "expired";
          rank = 2;
        }
      }
    }

    // Check if a .p12 exists (best-effort)
    let hasP12 = false;
    const p12Candidates = [
      `/certificates/${name}/${name}.p12`,
      `/certificates/${name}/${name.replace(/ /g, "-")}.p12`,
    ];
    for (const p of p12Candidates) {
      const r = await fetchAsset(env, p);
      if (r) {
        hasP12 = true;
        break;
      }
    }

    certs.push({
      name: safeName,
      displayName: name,
      days,
      rank,
      status,
      expires: expStr,
      teamName: info.TeamName || name,
      appIdName: info.AppIDName || "",
      uuid: info.UUID || "",
      plist: `/output/sideinstaller-${safeName}.plist`,
      hasP12,
      hasProvision: true,
      folder: name,
    });
  }

  // Sort: valid first, then by days descending
  certs.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return (b.days || 0) - (a.days || 0);
  });

  return { certs };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    let path = url.pathname;

    // ---------- Dynamic API ----------
    if (path === "/api/certs" || path === "/api/certs/") {
      const result = await buildCerts(env);
      return new Response(JSON.stringify(result.certs, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=60",
        },
      });
    }

    // Sign flow: dispatch + poll the "Sign Feather IPA" GitHub Actions workflow
    if (path === "/api/sign" || path === "/api/sign/") {
      if (request.method !== "POST") return json({ error: "Use POST" }, 405);
      return handleSign(request, env);
    }
    if (path === "/api/sign-status" || path === "/api/sign-status/") {
      return handleSignStatus(request, env);
    }

    // ---------- Static assets ----------
    if (path === "/" || path === "") path = "/index.html";

    if (env.ASSETS) {
      let assetReq = new Request(new URL(path, url.origin), request);
      let res = await env.ASSETS.fetch(assetReq);

      // SPA-style: /terms → terms.html
      if (res.status === 404) {
        if (!path.endsWith("/") && !path.includes(".")) {
          const tryHtml = path + ".html";
          res = await env.ASSETS.fetch(new Request(new URL(tryHtml, url.origin), request));
          if (res.status !== 404) path = tryHtml;
        }
      }

      if (res.status !== 404) {
        const ct = contentType(path);
        const headers = new Headers(res.headers);
        headers.set("Content-Type", ct);
        headers.set("Access-Control-Allow-Origin", "*");

        if (
          path.endsWith(".png") ||
          path.endsWith(".plist") ||
          path.endsWith(".mobileconfig") ||
          path.endsWith(".mobileprovision") ||
          path.endsWith(".p12")
        ) {
          headers.set("Cache-Control", "public, max-age=3600");
        } else if (path.endsWith(".html")) {
          headers.set("Cache-Control", "public, max-age=60");
        }

        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers,
        });
      }
    }

    return new Response("Not Found", {
      status: 404,
      headers: { "Content-Type": "text/plain" },
    });
  },
};
