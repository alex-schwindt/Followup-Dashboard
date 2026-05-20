/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker 
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
function corsHeaders(origin = "*") {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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
  return value.includes("job lost") || value === "won";
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
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
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256"
    },
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
  const signed = new TextEncoder().encode(
    `${encodedHeader}.${encodedPayload}`
  );
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

  if (!res.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

async function getPortfolioItems(env) {
  const data = await asanaFetch(
    `/portfolios/${env.ASANA_PORTFOLIO_GID}/items`,
    env
  );
  return data.data || [];
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

  const portfolioItems = await getPortfolioItems(env);
  const projects = portfolioItems.filter((item) => item.resource_type === "project").slice(0, 10);

  for (const item of projects) {
    const project = await getProjectDetails(item.gid, env);
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
        .map((option) => ({
          gid: option.gid,
          name: option.name
        }))
    };

    metadataLoadedAt = now;
    return metadataCache;
  }

  throw new Error("Unable to load Stage field metadata from Asana");
}

async function handleJobs(request, env, origin) {
  const portfolioItems = await getPortfolioItems(env);
  const projects = portfolioItems
    .filter((item) => item.resource_type === "project")
    .slice(0, 10);

  const metadata = await loadMetadata(env);

  const detailedProjects = await Promise.all(
    projects.map(async (item) => {
      const project = await getProjectDetails(item.gid, env);
      const fields = getFieldMap(project.custom_fields || []);

      const rawStage = getEnumName(fields[metadata.stageFieldName] || fields["Stage"]);
      const normalizedStage = normalizeStage(rawStage);
      const salesReps = getMultiEnumNames(fields["Sales Rep"]);
      const contractorCustomer = getMultiEnumNames(fields["Contractor/Customer"]);
      const engineer = getMultiEnumNames(
        fields["Application Engineer"] || fields["Engineer"]
      );

      return {
        gid: project.gid,
        name: project.name,
        rawStage,
        stage: normalizedStage,
        closed: isClosedStage(rawStage),
        followUpDate: getDateValue(fields["Follow Up Date"]),
        lastFollowUp: getDateValue(fields["Last Follow Up"]),
        feedback: getTextValue(fields["Feedback"]),
        bidDate: getDateValue(fields["Bid Date"]),
        sellPrice: getNumberValue(fields["Sell Price"]),
        accuQuoteNumber: getTextValue(fields["AccuQuote#"]),
        salesReps,
        contractorCustomer,
        engineer
      };
    })
  );

  return json(
    {
      ok: true,
      count: detailedProjects.length,
      jobs: detailedProjects,
      stageOptions: metadata.stageOptions.map((option) => option.name)
    },
    200,
    origin
  );
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
  const userEmail =
    identity.email ||
    identity.preferred_email ||
    identity.name ||
    null;

  const rep = mapEmailToRep(userEmail);

  if (!rep) {
    return json(
      { ok: false, message: `Unauthorized commenter: ${userEmail}` },
      403,
      origin
    );
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

      if (
        request.method === "POST" &&
        url.pathname.startsWith("/api/jobs/") &&
        url.pathname.endsWith("/follow-up")
      ) {
        const parts = url.pathname.split("/");
        const projectGid = parts[3];

        if (!projectGid) {
          return json(
            { ok: false, message: "Project GID missing in path" },
            400,
            origin
          );
        }

        return await handleFollowUp(request, env, projectGid, origin);
      }

      return json(
        {
          ok: true,
          message: "Asana Follow Up Dashboard API",
          endpoints: ["/api/jobs", "POST /api/jobs/{gid}/follow-up"]
        },
        200,
        origin
      );
    } catch (error) {
      console.error("Worker error:", error);
      return json(
        {
          ok: false,
          message: "Worker error",
          error: String(error),
          stack: error?.stack || null
        },
        500,
        origin
      );
    }
  }
};
