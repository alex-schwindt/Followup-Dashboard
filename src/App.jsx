import { useEffect, useMemo, useState } from "react";

const SALES_REPS = ["All", "Turbo", "Nate", "Loftis", "Alex"];
const DUE_FILTERS = ["All", "Overdue", "Today", "This Week"];
const API_BASE = import.meta.env.VITE_API_BASE_URL || "";

function formatDate(value) {
  if (!value) return "—";
  const date = new Date(`${value}T00:00:00`);
  return date.toLocaleDateString();
}

function formatDateTime(value) {
  if (!value) return "Never";
  const date = new Date(value);
  return date.toLocaleString();
}

function formatCurrency(value) {
  if (value == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);
}

function daysUntil(dateString) {
  if (!dateString) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(`${dateString}T00:00:00`);
  const diff = target.getTime() - today.getTime();
  return Math.round(diff / 86400000);
}

function getDueLabel(dateString) {
  const diff = daysUntil(dateString);
  if (diff == null) return { label: "No date", tone: "neutral" };
  if (diff < 0) return { label: `${Math.abs(diff)} days overdue`, tone: "overdue" };
  if (diff === 0) return { label: "Due today", tone: "today" };
  if (diff <= 7) return { label: `Due in ${diff} days`, tone: "soon" };
  return { label: `Due in ${diff} days`, tone: "neutral" };
}

function matchesDueFilter(job, filter) {
  const diff = daysUntil(job.followUpDate);
  if (filter === "All") return true;
  if (diff == null) return false;
  if (filter === "Overdue") return diff < 0;
  if (filter === "Today") return diff === 0;
  if (filter === "This Week") return diff >= 0 && diff <= 7;
  return true;
}

function getSearchBlob(job) {
  return [
    job.name,
    job.accuQuoteNumber,
    job.stage,
    ...(job.salesReps || []),
    ...(job.contractorCustomer || []),
    ...(job.engineer || []),
    job.feedback || ""
  ]
    .join(" ")
    .toLowerCase();
}

export default function App() {
  const [jobs, setJobs] = useState([]);
  const [stageOptions, setStageOptions] = useState([]);
  const [viewerRep, setViewerRep] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState(null);

  const [selectedRep, setSelectedRep] = useState("All");
  const [selectedDueFilter, setSelectedDueFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [selectedJobId, setSelectedJobId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [formFeedback, setFormFeedback] = useState("");
  const [formNextDate, setFormNextDate] = useState("");
  const [formStage, setFormStage] = useState("");
  const [saveMessage, setSaveMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState("");
  const [syncError, setSyncError] = useState("");

  async function loadJobs() {
    try {
      setLoading(true);
      setError("");

      const response = await fetch(`${API_BASE}/api/jobs`);
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.message || "Failed to load jobs");
      }

      setJobs(data.jobs || []);
      setStageOptions(data.stageOptions || []);
      setViewerRep(data.viewerRep || null);
      setIsAdmin(data.isAdmin || false);
      setLastSyncAt(data.lastSyncAt || null);

      // If the viewer is a specific rep, auto-filter to their name
      if (data.viewerRep && !data.isAdmin) {
        setSelectedRep(data.viewerRep);
      }
    } catch (err) {
      setError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadJobs();
  }, []);

  async function handleAdminSync() {
    try {
      setSyncing(true);
      setSyncMessage("");
      setSyncError("");

      const response = await fetch(`${API_BASE}/api/admin/sync`, {
        method: "POST"
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.message || "Sync failed");
      }

      setSyncMessage(`Synced ${data.synced} of ${data.totalPortfolioProjects} projects`);
      setLastSyncAt(data.lastSyncAt);

      // Reload jobs from the freshly synced D1
      await loadJobs();
    } catch (err) {
      setSyncError(err.message || "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  const filteredJobs = useMemo(() => {
    const term = search.trim().toLowerCase();

    return jobs
      .filter((job) => !job.closed)
      .filter((job) => {
        if (selectedRep === "All") return true;
        return job.salesReps.includes(selectedRep);
      })
      .filter((job) => matchesDueFilter(job, selectedDueFilter))
      .filter((job) => {
        if (!term) return true;
        return getSearchBlob(job).includes(term);
      })
      .sort((a, b) => (a.followUpDate || "").localeCompare(b.followUpDate || ""));
  }, [jobs, selectedRep, selectedDueFilter, search]);

  useEffect(() => {
    if (!filteredJobs.length) {
      setSelectedJobId(null);
      return;
    }
    const exists = filteredJobs.some((job) => job.gid === selectedJobId);
    if (!exists) {
      setSelectedJobId(filteredJobs[0].gid);
    }
  }, [filteredJobs, selectedJobId]);

  const selectedJob = filteredJobs.find((job) => job.gid === selectedJobId) || null;

  const countsByRep = useMemo(() => {
    const activeJobs = jobs.filter((job) => !job.closed);
    const counts = { All: activeJobs.length };
    for (const rep of SALES_REPS.slice(1)) {
      counts[rep] = activeJobs.filter((job) => job.salesReps.includes(rep)).length;
    }
    return counts;
  }, [jobs]);

  function openModal() {
    if (!selectedJob) return;
    setSaveMessage("");
    setSaveError("");
    setFormFeedback("");
    setFormNextDate(selectedJob.followUpDate || "");
    setFormStage(selectedJob.rawStage || stageOptions[0] || "");
    setIsModalOpen(true);
  }

  function closeModal() {
    setIsModalOpen(false);
  }

  async function handleFollowUpSubmit(event) {
    event.preventDefault();
    if (!selectedJob) return;

    try {
      setSaving(true);
      setSaveError("");
      setSaveMessage("");

      const payload = {
        feedback: formFeedback,
        nextFollowUpDate: formNextDate,
        stage: formStage
      };

      const response = await fetch(`${API_BASE}/api/jobs/${selectedJob.gid}/follow-up`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.message || "Failed to save follow up");
      }

      setSaveMessage("Follow up saved.");

      // Optimistically update local state so UI reflects the change immediately
      setJobs((currentJobs) =>
        currentJobs.map((job) => {
          if (job.gid !== selectedJob.gid) return job;

          const today = new Date().toISOString().slice(0, 10);
          const rep = data.commenterRep || "";
          const header = rep ? `${today} (${rep})` : today;
          const newEntry = `${header}: ${formFeedback}\n`;
          const updatedFeedback = job.feedback
            ? `${newEntry}\n${job.feedback}`
            : newEntry;

          return {
            ...job,
            rawStage: formStage || job.rawStage,
            stage: formStage || job.stage,
            followUpDate: formNextDate,
            lastFollowUp: today,
            feedback: updatedFeedback
          };
        })
      );

      setTimeout(() => {
        setIsModalOpen(false);
      }, 700);
    } catch (err) {
      setSaveError(err.message || "Something went wrong");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Asana</p>
          <h1>Follow Up Dashboard</h1>
        </div>
        <div className="topbar-meta">
          {lastSyncAt && (
            <span className="sync-time">Synced {formatDateTime(lastSyncAt)}</span>
          )}
          {isAdmin && (
            <div className="sync-controls">
              <button
                className={`sync-btn ${syncing ? "syncing" : ""}`}
                onClick={handleAdminSync}
                disabled={syncing}
              >
                {syncing ? "Syncing…" : "Sync Now"}
              </button>
              {syncMessage && <span className="sync-ok">{syncMessage}</span>}
              {syncError && <span className="sync-err">{syncError}</span>}
            </div>
          )}
          <span>{filteredJobs.length} visible jobs</span>
        </div>
      </header>

      <section className="toolbar">
        <div className="toolbar-block">
          <span className="toolbar-label">Sales rep</span>
          <div className="filters">
            {SALES_REPS.map((rep) => (
              <button
                key={rep}
                className={rep === selectedRep ? "filter-chip active" : "filter-chip"}
                onClick={() => setSelectedRep(rep)}
              >
                {rep} <span>{countsByRep[rep] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-block">
          <span className="toolbar-label">Due window</span>
          <div className="filters">
            {DUE_FILTERS.map((filter) => (
              <button
                key={filter}
                className={filter === selectedDueFilter ? "filter-chip active" : "filter-chip"}
                onClick={() => setSelectedDueFilter(filter)}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        <div className="toolbar-block search-block">
          <span className="toolbar-label">Search</span>
          <input
            className="search-input"
            type="text"
            placeholder="Job, AccuQuote, contractor, engineer, feedback..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </section>

      {loading && <div className="state-card">Loading jobs…</div>}
      {error && <div className="state-card error">{error}</div>}

      {!loading && !error && (
        <main className="workspace">
          <section className="list-panel">
            <div className="panel-header">
              <h2>Queue</h2>
              <span>{filteredJobs.length} jobs</span>
            </div>

            {filteredJobs.length === 0 ? (
              <div className="empty-state">No jobs match the current filters.</div>
            ) : (
              <div className="job-list">
                {filteredJobs.map((job) => {
                  const due = getDueLabel(job.followUpDate);
                  const selected = job.gid === selectedJobId;

                  return (
                    <button
                      key={job.gid}
                      className={selected ? "job-row selected" : "job-row"}
                      onClick={() => setSelectedJobId(job.gid)}
                    >
                      <div className="job-row-top">
                        <strong>{job.name}</strong>
                        <span className={`due-badge ${due.tone}`}>{due.label}</span>
                      </div>
                      <div className="job-row-meta">
                        <span>{job.accuQuoteNumber || "No AccuQuote#"}</span>
                        <span>{job.stage}</span>
                        <span>{formatCurrency(job.sellPrice)}</span>
                      </div>
                      <div className="job-row-tags">
                        {job.salesReps.map((rep) => (
                          <span key={rep} className="tag rep-tag">{rep}</span>
                        ))}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>

          <section className="detail-panel">
            {!selectedJob ? (
              <div className="empty-state">Select a job to view details.</div>
            ) : (
              <>
                <div className="panel-header detail-header">
                  <div>
                    <h2>{selectedJob.name}</h2>
                    <p className="job-subtitle">
                      {selectedJob.accuQuoteNumber || "No AccuQuote#"} · {selectedJob.stage}
                    </p>
                  </div>
                  <button className="primary-btn enabled" onClick={openModal}>
                    Update follow up
                  </button>
                </div>

                <div className="detail-grid">
                  <div className="detail-card">
                    <span className="meta-label">Follow Up Date</span>
                    <strong>{formatDate(selectedJob.followUpDate)}</strong>
                  </div>
                  <div className="detail-card">
                    <span className="meta-label">Last Follow Up</span>
                    <strong>{formatDate(selectedJob.lastFollowUp)}</strong>
                  </div>
                  <div className="detail-card">
                    <span className="meta-label">Bid Date</span>
                    <strong>{formatDate(selectedJob.bidDate)}</strong>
                  </div>
                  <div className="detail-card">
                    <span className="meta-label">Sell Price</span>
                    <strong>{formatCurrency(selectedJob.sellPrice)}</strong>
                  </div>
                </div>

                <div className="stack-section">
                  <span className="meta-label">Sales Rep</span>
                  <div className="tag-row">
                    {selectedJob.salesReps.map((rep) => (
                      <span key={rep} className="tag rep-tag">{rep}</span>
                    ))}
                  </div>
                </div>

                <div className="stack-section">
                  <span className="meta-label">Contractor / Customer</span>
                  <div className="tag-row">
                    {selectedJob.contractorCustomer.map((item) => (
                      <span key={item} className="tag contractor-tag">{item}</span>
                    ))}
                  </div>
                </div>

                <div className="stack-section">
                  <span className="meta-label">Engineer</span>
                  <div className="tag-row">
                    {selectedJob.engineer.length > 0
                      ? selectedJob.engineer.map((item) => (
                          <span key={item} className="tag engineer-tag">{item}</span>
                        ))
                      : <span className="meta-empty">—</span>
                    }
                  </div>
                </div>

                <div className="stack-section">
                  <span className="meta-label">Application Engineer</span>
                  <div className="tag-row">
                    {selectedJob.appEngineer && selectedJob.appEngineer.length > 0
                      ? selectedJob.appEngineer.map((item) => (
                          <span key={item} className="tag app-engineer-tag">{item}</span>
                        ))
                      : <span className="meta-empty">—</span>
                    }
                  </div>
                </div>

                <div className="feedback-panel">
                  <span className="meta-label">Feedback history</span>
                  <div className="feedback-scroll">
                    <p>{selectedJob.feedback ? selectedJob.feedback.trim() : "No feedback yet."}</p>
                  </div>
                </div>
              </>
            )}
          </section>
        </main>
      )}

      {isModalOpen && selectedJob && (
        <div className="modal-backdrop" onClick={closeModal}>
          <div className="modal-card" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>
                <p className="eyebrow">Update follow up</p>
                <h3>{selectedJob.name}</h3>
              </div>
              <button className="modal-close" onClick={closeModal}>×</button>
            </div>

            <form className="modal-form" onSubmit={handleFollowUpSubmit}>
              <div className="detail-card">
                <span className="meta-label">AccuQuote#</span>
                <strong>{selectedJob.accuQuoteNumber || "—"}</strong>
              </div>

              <label className="form-field">
                <span className="meta-label">Feedback</span>
                <textarea
                  rows="6"
                  value={formFeedback}
                  onChange={(event) => setFormFeedback(event.target.value)}
                  placeholder="Enter follow-up notes..."
                  required
                />
              </label>

              <div className="form-row">
                <label className="form-field">
                  <span className="meta-label">Next Follow Up Date</span>
                  <input
                    type="date"
                    value={formNextDate}
                    onChange={(event) => setFormNextDate(event.target.value)}
                    required
                  />
                </label>

                <label className="form-field">
                  <span className="meta-label">Stage</span>
                  <select
                    value={formStage}
                    onChange={(event) => setFormStage(event.target.value)}
                  >
                    {stageOptions.map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </label>
              </div>

              {saveMessage && <div className="success-banner">{saveMessage}</div>}
              {saveError && <div className="error-banner">{saveError}</div>}

              <div className="modal-actions">
                <button type="button" className="secondary-btn" onClick={closeModal}>
                  Cancel
                </button>
                <button type="submit" className="primary-btn enabled" disabled={saving}>
                  {saving ? "Saving..." : "Save follow up"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
