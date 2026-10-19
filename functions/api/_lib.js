/**
 * Shared helpers for the SideInstaller Pages Functions.
 * Ported from src/worker.js — same logic, same API response shapes.
 *
 * Difference vs the Worker: Pages has no ASSETS binding, so static files
 * (certificates/index.json, ipas.json, .mobileprovision, output/*.plist)
 * are read with a subrequest to the site's own origin.
 *
 * Required Pages environment variables (Pages dashboard → Settings →
 * Environment variables → Production):
 *   GH_REPO     e.g. "sadboizx/SideInstaller"
 *   GH_REF      e.g. "main"
 *   GH_WORKFLOW e.g. "sign.yml"
 * Secret:
 *   GITHUB_TOKEN — fine-grained PAT: Actions read+write, Contents read+write
 */

/** Extract the clear-text XML plist from a .mobileprovision (CMS signed) */
function extractPlistXml(buffer) {
  const bytes = new Uint8Array(buffer);
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

/** Read a static file from this Pages deployment (same origin subrequest). */
async function fetchAsset(request, path) {
  const url = new URL(path, new URL(request.url).origin);
  const res = await fetch(url.toString());
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

function plistPathFor(ipa, cert) {
  return `/output/${ipa}-${safeSlug(cert)}.plist`;
}

function releaseTagFor(ipa, cert) {
  return `${ipa}-signed-${safeSlug(cert)}`;
}

function releaseAssetNameFor(ipa, cert) {
  return `${ipa}-${safeSlug(cert)}.ipa`;
}

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "sideinstaller-pages",
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

async function getIndexFolders(request, env) {
  const r = await fetchAsset(request, "/certificates/index.json");
  if (!r) return null;
  try {
    const j = await r.json();
    if (!Array.isArray(j)) return null;
    return j.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim());
  } catch {
    return null;
  }
}

/** Signable apps, from public/ipas.json (single source of truth) */
async function getIpas(request, env) {
  const r = await fetchAsset(request, "/ipas.json");
  if (!r) return null;
  try {
    const j = await r.json();
    if (!Array.isArray(j)) return null;
    return j.filter((x) => x && typeof x.id === "string" && x.id.trim());
  } catch {
    return null;
  }
}

/** Newest workflow_dispatch run of the sign workflow for a cert + app pair */
async function latestRunForCert(env, cert, ipa) {
  const workflow = env.GH_WORKFLOW || "sign.yml";
  const data = await gh(
    env,
    `/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=30`
  );
  const runs = (data && data.workflow_runs) || [];
  const want = `${RUN_NAME_PREFIX}${cert} :: ${ipa}`;
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

export function json(data, status = 200) {
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
 * POST /api/sign  { cert, ipa }
 * 1. Fast path: if the release already holds the signed IPA for this
 *    app + cert pair, reuse it immediately — the workflow is NEVER
 *    dispatched for an already-signed IPA.
 * 2. Otherwise join an in-flight run, or dispatch a fresh one.
 */
export async function handleSign(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const cert = body && typeof body.cert === "string" ? body.cert.trim() : "";
  const ipa = body && typeof body.ipa === "string" ? body.ipa.trim() : "";

  const folders = await getIndexFolders(request, env);
  if (!folders) return json({ error: "certificates/index.json not found" }, 500);
  const ipas = await getIpas(request, env);
  if (!ipas) return json({ error: "ipas.json not found" }, 500);
  if (!cert || !folders.includes(cert)) return json({ error: "Unknown certificate" }, 400);
  if (!ipa || !ipas.some((x) => x.id === ipa)) return json({ error: "Unknown app" }, 400);

  const workflow = env.GH_WORKFLOW || "sign.yml";
  const ref = env.GH_REF || "main";
  const tag = releaseTagFor(ipa, cert);
  const assetName = releaseAssetNameFor(ipa, cert);
  const plistPath = plistPathFor(ipa, cert);

  try {
    // ---- Fast path: already signed? Reuse it — no workflow dispatched. ----
    const existing = await releaseAsset(env, tag, assetName);
    if (existing) {
      const base = {
        ipaUrl: existing.browser_download_url,
        tag,
      };
      const plistRes = await fetchAsset(request, plistPath);
      if (plistRes) {
        return json({
          state: "complete",
          reused: true,
          plistUrl: absUrl(request, plistPath),
          ...base,
        });
      }
      return json({ state: "finishing", ...base });
    }

    // ---- No signed build yet: join an in-flight run, else dispatch. ----
    const run = await latestRunForCert(env, cert, ipa);
    if (run && (run.status === "queued" || run.status === "in_progress")) {
      if (runAgeMs(run) < STALE_AFTER_MS) {
        return json({ state: "running", runUrl: run.html_url });
      }
    }

    await gh(env, `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref, inputs: { cert, ipa } }),
    });
    return json({ state: "started" });
  } catch (e) {
    return json({ error: e.message || "Sign request failed" }, e.status || 502);
  }
}

/**
 * GET /api/sign-status?cert=<folder>&ipa=<app id>
 * "complete" is only returned once the OTA manifest is actually reachable.
 */
export async function handleSignStatus(request, env) {
  const url = new URL(request.url);
  const cert = (url.searchParams.get("cert") || "").trim();
  const ipa = (url.searchParams.get("ipa") || "").trim();

  const folders = await getIndexFolders(request, env);
  if (!folders) return json({ error: "certificates/index.json not found" }, 500);
  const ipas = await getIpas(request, env);
  if (!ipas) return json({ error: "ipas.json not found" }, 500);
  if (!cert || !folders.includes(cert)) return json({ error: "Unknown certificate" }, 400);
  if (!ipa || !ipas.some((x) => x.id === ipa)) return json({ error: "Unknown app" }, 400);

  const tag = releaseTagFor(ipa, cert);
  const assetName = releaseAssetNameFor(ipa, cert);
  const plistPath = plistPathFor(ipa, cert);

  try {
    const run = await latestRunForCert(env, cert, ipa);
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
      const plistRes = await fetchAsset(request, plistPath);
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

/** Build the certificate list from certificates/index.json + provisions */
export async function buildCerts(request, env) {
  const indexRes = await fetchAsset(request, "/certificates/index.json");
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
    const safeName = name.replace(/ /g, "-");

    const candidates = [
      `/certificates/${name}/${name}.mobileprovision`,
      `/certificates/${name}/${name.replace(/ /g, "-")}.mobileprovision`,
      `/certificates/${name}/profile.mobileprovision`,
    ];

    let provisionBuf = null;
    for (const p of candidates) {
      const r = await fetchAsset(request, p);
      if (r) {
        provisionBuf = await r.arrayBuffer();
        break;
      }
    }

    if (!provisionBuf) {
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

    let hasP12 = false;
    const p12Candidates = [
      `/certificates/${name}/${name}.p12`,
      `/certificates/${name}/${name.replace(/ /g, "-")}.p12`,
    ];
    for (const p of p12Candidates) {
      const r = await fetchAsset(request, p);
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

  certs.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return (b.days || 0) - (a.days || 0);
  });

  return { certs };
}
