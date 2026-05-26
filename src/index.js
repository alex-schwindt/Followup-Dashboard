const ALLOWED_ORIGINS = [
  "https://followup.hoffman-hoffman.com",
  "https://followup-dashboard.pages.dev"
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
    "content-type": "application/json; charset=utf-8"
  };
}

function json(data, status = 200, origin = "*") {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: corsHeaders(origin)
  });
}

function getFieldMap(customFields = []) {
  const map = {};
  for (const field of customFields) {
    map[field.name] = field;
  }
  return map;
}

function getEnumName(field) {
  return field?.enum_value?.name || null;
}

function getMultiEnumNames(field) {
  return (field?.multi_enum_values || []).map((v) => v.name);
}

function getDateValue(field) {
  return field?.date_value?.date || null;
}

function getTextValue(field) {
  return field?.text_value || null;
}

function getNumberValue(field) {
  return field?.number_value ?? null;
}

function normalizeStage(stageName) {
  if (!stageName) return "Unknown";
  if (stageName === "Budget Round") return "Budget";
  if (stageName === "Quoted") return "Quoted";
  if (stageName.toLowerCase().includes("job lost")) return "Lost";
  return stageName;
}

function isClosedStage(stageName) {
  if (!stageName) return false;
  const value = stageName.toLowerCase();
  return (
    value.includes("job lost") ||
    value === "won" ||
    value === "project awarded" ||
    value === "project complete"
  );
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function nowIso() {
  return new Date().toISOString();
}

function getIdentityEmail(identity) {
  return identity.email || identity.preferred_email || identity.name || identity.sub || null;
}

let metadataCache = null;
let metadataLoadedAt = 0;
const METADATA_TTL_MS = 5 * 60 * 1000;

async function getAccessPublicKey(env, kid) {
  const certsUrl = `${env.TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const res = await fetch(certsUrl);
  if (!res.ok) throw new Error("Unable to load Access certs");

  const data = await res.json();
  const jwk = (data.keys || []).find((k) => k.kid === kid);
  if (!jwk) throw new Error("Matching Access JWK not found");

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

function decodeBase64Url(input) {
  const padded =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJwtPart(input) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(input)));
}

async function validateAccessJwt(request, env) {
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!jwt) throw new Error("Missing Cf-Access-Jwt-Assertion header");

  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid Access JWT");

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJwtPart(encodedHeader);
  const payload = decodeJwtPart(encodedPayload);

  const key = await getAccessPublicKey(env, header.kid);
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = decodeBase64Url(encodedSignature);

  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    signed
  );

  if (!ok) throw new Error("Invalid Access JWT signature");

  const aud = payload.aud;
  const audList = Array.isArray(aud) ? aud : [aud];
  if (!audList.includes(env.POLICY_AUD)) {
    throw new Error("Access JWT aud mismatch");
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) {
    throw new Error("Access JWT expired");
  }

  return payload;
}

function mapEmailToRep(email) {
  const normalized = (email || "").trim().toLowerCase();
  const map = {
    "alex.schwindt@hoffman-hoffman.com": "Alex",
    "chris.loftis@hoffman-hoffman.com": "Loftis",
    "chris.turbeville@hoffman-hoffman.com": "Turbo",
    "nathan.harden@hoffman-hoffman.com": "Nate"
  };
  return map[normalized] || null;
}

function isAdminEmail(email, env) {
  return (email || "").trim().toLowerCase() === (env.ADMIN_EMAIL || "").trim().toLowerCase();
}

async function asanaFetch(path, env, options = {}) {
  const res = await fetch(`https://app.asana.com/api/1.0${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.ASANA_PAT}`,
      Accept: "application/json",
      ...(options.headers || {})
    }
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function getPortfolioItemsPage(env, offset = null, limit = 100) {
  const optFields = [
    "name",
    "resource_type",
    "custom_fields.gid",
    "custom_fields.name",
    "custom_fields.resource_subtype",
    "custom_fields.text_value",
    "custom_fields.number_value",
    "custom_fields.date_value",
    "custom_fields.enum_value.gid",
    "custom_fields.enum_value.name",
    "custom_fields.enum_options.gid",
    "custom_fields.enum_options.name",
    "custom_fields.enum_options.enabled",
    "custom_fields.multi_enum_values.gid",
    "custom_fields.multi_enum_values.name"
  ].join(",");

  const params = new URLSearchParams();
  params.set("limit", String(limit));
  params.set("opt_fields", optFields);
  if (offset) params.set("offset", offset);

  return await asanaFetch(`/portfolios/${env.ASANA_PORTFOLIO_GID}/items?${params.toString()}`, env);
}

async function getAllPortfolioItems(env) {
  const items = [];
  let offset = null;

  do {
    const page = await getPortfolioItemsPage(env, offset, 100);
    items.push(...(page.data || []));
    offset = page.next_page?.offset || null;
  } while (offset);

  return items;
}

async function getProjectDetails(projectGid, env) {
  const optFields = [
    "name",
    "custom_fields.gid",
    "custom_fields.name",
    "custom_fields.resource_subtype",
    "custom_fields.display_value",
    "custom_fields.text_value",
    "custom_fields.number_value",
    "custom_fields.date_value",
    "custom_fields.enum_value.gid",
    "custom_fields.enum_value.name",
    "custom_fields.enum_options.gid",
    "custom_fields.enum_options.name",
    "custom_fields.enum_options.enabled",
    "custom_fields.multi_enum_values.gid",
    "custom_fields.multi_enum_values.name"
  ].join(",");

  const data = await asanaFetch(
    `/projects/${projectGid}?opt_fields=${encodeURIComponent(optFields)}`,
    env
  );

  return data.data;
}

async function loadMetadata(env) {
  const now = Date.now();
  if (metadataCache && now - metadataLoadedAt < METADATA_TTL_MS) {
    return metadataCache;
  }

  const items = await getAllPortfolioItems(env);
  for (const project of items) {
    const fieldMap = getFieldMap(project.custom_fields || []);
    const stageField =
      fieldMap["Stage"] ||
      fieldMap["Project Stage"] ||
      fieldMap["Sales Stage"];

    if (!stageField?.gid) continue;

    metadataCache = {
      stageFieldName: stageField.name,
      stageFieldGid: stageField.gid,
      stageOptions: (stageField.enum_options || [])
        .filter((option) => option.enabled !== false)
        .map((option) => ({ gid: option.gid, name: option.name }))
    };
    metadataLoadedAt = now;
    return metadataCache;
  }

  throw new Error("Unable to load Stage field metadata from Asana");
}

function normalizeProjectToJob(project, metadata) {
  const fields = getFieldMap(project.custom_fields || []);
  const rawStage = getEnumName(fields[metadata.stageFieldName] || fields["Stage"]);

  return {
    gid: project.gid,
    name: project.name,
    rawStage,
    stage: normalizeStage(rawStage),
    closed: isClosedStage(rawStage),
    followUpDate: getDateValue(fields["Follow Up Date"]),
    lastFollowUp: getDateValue(fields["Last Follow Up"]),
    feedback: getTextValue(fields["Feedback"]),
    bidDate: getDateValue(fields["Bid Date"]),
    sellPrice: getNumberValue(fields["Sell Price"]),
    accuQuoteNumber: getTextValue(fields["AccuQuote#"]),
    salesReps: getMultiEnumNames(fields["Sales Rep"]),
    contractorCustomer: getMultiEnumNames(fields["Contractor/Customer"]),
    engineer: getTextValue(fields["Engineer"]) ? [getTextValue(fields["Engineer"])] : [],
    appEngineer: (() => {
      const f = fields["Application Engineer"];
      if (!f) return [];
      if (f.multi_enum_values && f.multi_enum_values.length > 0) return getMultiEnumNames(f);
      if (f.text_value) return [f.text_value];
      return [];
    })()
  };
}

async function upsertJob(env, job) {
  await env.DB.prepare(`
    INSERT INTO jobs (
      gid, name, raw_stage, stage, closed, follow_up_date, last_follow_up,
      feedback, bid_date, sell_price, accu_quote_number,
      sales_reps_json, contractor_customer_json, engineer_json, app_engineer_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(gid) DO UPDATE SET
      name = excluded.name,
      raw_stage = excluded.raw_stage,
      stage = excluded.stage,
      closed = excluded.closed,
      follow_up_date = excluded.follow_up_date,
      last_follow_up = excluded.last_follow_up,
      feedback = excluded.feedback,
      bid_date = excluded.bid_date,
      sell_price = excluded.sell_price,
      accu_quote_number = excluded.accu_quote_number,
      sales_reps_json = excluded.sales_reps_json,
      contractor_customer_json = excluded.contractor_customer_json,
      engineer_json = excluded.engineer_json,
      app_engineer_json = excluded.app_engineer_json,
      updated_at = excluded.updated_at
  `)
    .bind(
      job.gid,
      job.name,
      job.rawStage,
      job.stage,
      job.closed ? 1 : 0,
      job.followUpDate,
      job.lastFollowUp,
      job.feedback,
      job.bidDate,
      job.sellPrice,
      job.accuQuoteNumber,
      JSON.stringify(job.salesReps || []),
      JSON.stringify(job.contractorCustomer || []),
      JSON.stringify(job.engineer || []),
      JSON.stringify(job.appEngineer || []),
      nowIso()
    )
    .run();
}

async function refreshSingleProjectInDb(projectGid, env) {
  const metadata = await loadMetadata(env);
  const project = await getProjectDetails(projectGid, env);
  const job = normalizeProjectToJob(project, metadata);
  await upsertJob(env, job);
  return job;
}

async function syncJobsToDb(env) {
  const metadata = await loadMetadata(env);
  const portfolioItems = await getAllPortfolioItems(env);
  const projectItems = portfolioItems.filter((item) => item.resource_type === "project");
  const seen = new Set();
  let synced = 0;

  for (const item of projectItems) {
    const job = normalizeProjectToJob(item, metadata);
    await upsertJob(env, job);
    seen.add(job.gid);
    synced += 1;
  }

  const existing = await env.DB.prepare("SELECT gid FROM jobs").all();
  for (const row of existing.results || []) {
    if (!seen.has(row.gid)) {
      await env.DB.prepare("DELETE FROM jobs WHERE gid = ?").bind(row.gid).run();
    }
  }

  await env.DB.prepare(`
    INSERT INTO app_meta (key, value) VALUES ('last_sync_at', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `)
    .bind(nowIso())
    .run();

  return {
    synced,
    totalPortfolioProjects: projectItems.length
  };
}

function rowToJob(row) {
  return {
    gid: row.gid,
    name: row.name,
    rawStage: row.raw_stage,
    stage: row.stage,
    closed: !!row.closed,
    followUpDate: row.follow_up_date,
    lastFollowUp: row.last_follow_up,
    feedback: row.feedback,
    bidDate: row.bid_date,
    sellPrice: row.sell_price,
    accuQuoteNumber: row.accu_quote_number,
    salesReps: JSON.parse(row.sales_reps_json || "[]"),
    contractorCustomer: JSON.parse(row.contractor_customer_json || "[]"),
    engineer: JSON.parse(row.engineer_json || "[]"),
    appEngineer: JSON.parse(row.app_engineer_json || "[]")
  };
}

async function getLastSyncAt(env) {
  const row = await env.DB.prepare(
    "SELECT value FROM app_meta WHERE key = 'last_sync_at'"
  ).first();
  return row?.value || null;
}

async function handleJobs(request, env, origin) {
  const identity = await validateAccessJwt(request, env);
  const userEmail = getIdentityEmail(identity);
  const rep = mapEmailToRep(userEmail);
  const isAdmin = isAdminEmail(userEmail, env);

  if (!isAdmin && !rep) {
    return json({ ok: false, message: `Unauthorized viewer: ${userEmail}` }, 403, origin);
  }

  const metadata = await loadMetadata(env);
  const rows = await env.DB.prepare(`
    SELECT * FROM jobs
    ORDER BY
      CASE WHEN follow_up_date IS NULL THEN 1 ELSE 0 END,
      follow_up_date ASC,
      CASE WHEN bid_date IS NULL THEN 1 ELSE 0 END,
      bid_date DESC,
      name ASC
  `).all();

  let jobs = (rows.results || []).map(rowToJob);

  if (!isAdmin) {
    jobs = jobs.filter((job) => (job.salesReps || []).includes(rep));
  }

  return json(
    {
      ok: true,
      viewerEmail: userEmail,
      viewerRep: rep,
      isAdmin,
      count: jobs.length,
      jobs,
      stageOptions: metadata.stageOptions.map((option) => option.name),
      lastSyncAt: await getLastSyncAt(env)
    },
    200,
    origin
  );
}

async function updateProjectCustomFields(projectGid, updates, env) {
  const data = await asanaFetch(`/projects/${projectGid}`, env, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      data: {
        custom_fields: updates
      }
    })
  });

  return data.data;
}

async function handleFollowUp(request, env, projectGid, origin) {
  const body = await request.json().catch(() => ({}));
  const newFeedback = (body.feedback || "").trim();
  const nextFollowUpDate = body.nextFollowUpDate || null;
  const selectedStageName = (body.stage || "").trim();

  if (!newFeedback) {
    return json({ ok: false, message: "feedback is required" }, 400, origin);
  }

  const identity = await validateAccessJwt(request, env);
  const userEmail = getIdentityEmail(identity);
  const rep = mapEmailToRep(userEmail);

  if (!rep) {
    return json({ ok: false, message: `Unauthorized commenter: ${userEmail}` }, 403, origin);
  }

  const metadata = await loadMetadata(env);
  const project = await getProjectDetails(projectGid, env);
  const fields = getFieldMap(project.custom_fields || []);

  const feedbackField = fields["Feedback"];
  const lastFollowUpField = fields["Last Follow Up"];
  const followUpField = fields["Follow Up Date"];
  const stageField = fields[metadata.stageFieldName] || fields["Stage"];

  const existingFeedback = feedbackField?.text_value || "";
  const today = todayIsoDate();
  const headerParts = [today];
  if (rep) headerParts.push(`(${rep})`);
  const header = headerParts.join(" ");

  const newEntry = `${header}: ${newFeedback}\n`;
  const appendedFeedback = existingFeedback
    ? `${newEntry}\n${existingFeedback}`
    : newEntry;

  const currentStageName = getEnumName(stageField);
  const appliedStageName = selectedStageName || currentStageName;
  const closed = isClosedStage(appliedStageName);

  if (!closed && !nextFollowUpDate) {
    return json(
      { ok: false, message: "nextFollowUpDate is required for non-closed stages" },
      400,
      origin
    );
  }

  const updates = {};

  if (lastFollowUpField?.gid) {
    updates[lastFollowUpField.gid] = { date: today };
  }

  if (!closed && followUpField?.gid && nextFollowUpDate) {
    updates[followUpField.gid] = { date: nextFollowUpDate };
  }

  if (feedbackField?.gid) {
    updates[feedbackField.gid] = appendedFeedback;
  }

  if (stageField?.gid && selectedStageName) {
    const selectedStage = metadata.stageOptions.find(
      (option) => option.name === selectedStageName
    );

    if (!selectedStage) {
      return json(
        { ok: false, message: `Invalid stage selected: ${selectedStageName}` },
        400,
        origin
      );
    }

    updates[stageField.gid] = selectedStage.gid;
  }

  await updateProjectCustomFields(projectGid, updates, env);
  await refreshSingleProjectInDb(projectGid, env);

  return json(
    {
      ok: true,
      project: {
        gid: project.gid,
        name: project.name
      },
      appliedStage: appliedStageName,
      closed,
      commenterEmail: userEmail,
      commenterRep: rep
    },
    200,
    origin
  );
}

async function handleAdminSync(request, env, origin) {
  const identity = await validateAccessJwt(request, env);
  const userEmail = getIdentityEmail(identity);

  if (!isAdminEmail(userEmail, env)) {
    return json({ ok: false, message: `Unauthorized admin: ${userEmail}` }, 403, origin);
  }

  const lastSync = await getLastSyncAt(env);
  if (lastSync) {
    const secondsSinceLast = (Date.now() - new Date(lastSync).getTime()) / 1000;
    if (secondsSinceLast < 60) {
      return json(
        { ok: false, message: `Sync cooldown active. Please wait ${Math.ceil(60 - secondsSinceLast)}s before syncing again.` },
        429,
        origin
      );
    }
  }

  const result = await syncJobsToDb(env);
  return json(
    {
      ok: true,
      ...result,
      lastSyncAt: await getLastSyncAt(env)
    },
    200,
    origin
  );
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    try {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/api/jobs") {
        return await handleJobs(request, env, origin);
      }

      if (request.method === "POST" && url.pathname === "/api/admin/sync") {
        return await handleAdminSync(request, env, origin);
      }

      if (
        request.method === "POST" &&
        url.pathname.startsWith("/api/jobs/") &&
        url.pathname.endsWith("/follow-up")
      ) {
        const parts = url.pathname.split("/");
        const projectGid = parts[3];

        if (!projectGid) {
          return json({ ok: false, message: "Project GID missing in path" }, 400, origin);
        }

        if (!/^\d+$/.test(projectGid)) {
          return json({ ok: false, message: "Invalid project ID format" }, 400, origin);
        }

        return await handleFollowUp(request, env, projectGid, origin);
      }

      return json(
        {
          ok: true,
          message: "Asana Follow Up Dashboard API",
          endpoints: ["/api/jobs", "POST /api/jobs/{gid}/follow-up", "POST /api/admin/sync"]
        },
        200,
        origin
      );
    } catch (error) {
      console.error("Worker error:", error?.stack || String(error));
      return json({ ok: false, message: "Internal server error" }, 500, origin);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(syncJobsToDb(env));
  }
};
