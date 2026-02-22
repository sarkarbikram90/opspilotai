import { useState, useEffect, useRef } from "react";

// ─── Mock Data ──────────────────────────────────────────────────────────────
const MOCK_KB = [
  { id: "KB-001", title: "Redis OOM Recovery Runbook", tags: ["redis", "memory", "oom"] },
  { id: "KB-002", title: "Kubernetes Pod CrashLoop Resolution", tags: ["k8s", "pod", "crash"] },
  { id: "KB-003", title: "PostgreSQL Connection Pool Exhaustion", tags: ["postgres", "db", "connections"] },
  { id: "KB-004", title: "High CPU Node Remediation SOP", tags: ["cpu", "node", "performance"] },
];

const MOCK_PAST = [
  { id: "INC-2841", similarity: 94, resolution: "Flushed Redis memory + increased maxmemory to 4GB", date: "2024-12-10" },
  { id: "INC-2799", similarity: 78, resolution: "Restarted pod with updated resource limits", date: "2024-12-03" },
];

const MOCK_TICKETS = [
  {
    id: "INC-2991",
    title: "Redis OOM – prod-cache-01 unresponsive",
    severity: "P1",
    env: "production",
    app: "checkout-service",
    host: "prod-cache-01",
    description: "Redis instance prod-cache-01 is throwing OOM errors. Checkout service returning 503s. Cache hit rate dropped from 94% to 12% in last 20 mins.",
    logs: `[ERROR] 2025-02-22 09:41:03 redis-server: Can't save in background: fork: Out of memory
[WARN]  2025-02-22 09:41:10 checkout-service: Redis connection timeout after 5000ms
[ERROR] 2025-02-22 09:41:11 checkout-service: Circuit breaker OPEN – upstream=redis
[CRIT]  2025-02-22 09:41:15 redis-server: OOM command not allowed (used_memory > maxmemory)`,
    tags: ["redis", "memory", "oom"],
  },
  {
    id: "INC-2992",
    title: "K8s pod CrashLoopBackOff – api-gateway",
    severity: "P2",
    env: "staging",
    app: "api-gateway",
    host: "k8s-node-04",
    description: "api-gateway pod entering CrashLoopBackOff. Backoff delay reaching 5m. Deployment rollout from 30min ago likely culprit.",
    logs: `[ERROR] 2025-02-22 10:12:44 api-gateway: panic: runtime error: invalid memory address
[ERROR] 2025-02-22 10:12:44 goroutine 1 [running]: main.main()
[INFO]  2025-02-22 10:12:45 kubelet: Back-off restarting failed container
[WARN]  2025-02-22 10:17:01 kubelet: container "api-gateway" in pod is waiting to start: CrashLoopBackOff`,
    tags: ["k8s", "pod", "crash"],
  },
  {
    id: "INC-2993",
    title: "PostgreSQL connection pool exhausted – user-svc",
    severity: "P2",
    env: "production",
    app: "user-service",
    host: "db-primary-03",
    description: "PgBouncer pool exhausted. Max connections (100) reached. New queries queuing. User login and profile endpoints timing out.",
    logs: `[ERROR] 2025-02-22 11:03:22 pgbouncer: no more connections allowed (max_client_conn=100)
[WARN]  2025-02-22 11:03:23 user-service: Acquiring connection exceeded 30s timeout
[ERROR] 2025-02-22 11:03:25 user-service: DB query failed after 3 retries`,
    tags: ["postgres", "db", "connections"],
  },
];

const LLM_ANALYSIS = {
  "INC-2991": {
    summary: "Redis instance prod-cache-01 has exhausted its memory allocation, triggering OOM kill protection. The checkout service has lost all cache connectivity, causing a 503 cascade. Memory grew 340% in 6 hours, suggesting a keyspace leak or TTL misconfiguration.",
    rootCause: "Redis maxmemory limit (2GB) reached. allkeys-lru eviction policy not kicking in, likely due to memory fragmentation ratio > 2.0. Probable cause: TTL not set on session keys inserted by new feature deployment 3h ago.",
    components: ["prod-cache-01 (Redis 7.0)", "checkout-service (3 pods)", "payment-processor (downstream)"],
    confidence: 91,
    recommendation: {
      steps: [
        "Run MEMORY DOCTOR on Redis to confirm fragmentation",
        "Execute MEMORY PURGE to reclaim fragmented memory",
        "Scan and expire session keys without TTL (batch 1000)",
        "Increase maxmemory to 4GB as temporary headroom",
        "Restart Redis with SAVE disabled to prevent fork OOM",
      ],
      commands: [
        { id: "cmd-1", label: "Check memory fragmentation", cmd: 'redis-cli -h prod-cache-01 INFO memory | grep -E "used_memory|fragmentation"', risk: "safe" },
        { id: "cmd-2", label: "Purge fragmented memory", cmd: "redis-cli -h prod-cache-01 MEMORY PURGE", risk: "safe" },
        { id: "cmd-3", label: "Expire TTL-less session keys", cmd: `redis-cli -h prod-cache-01 --scan --pattern "session:*" | xargs -I{} redis-cli -h prod-cache-01 EXPIRE {} 3600`, risk: "needs-approval" },
        { id: "cmd-4", label: "Increase maxmemory to 4GB", cmd: "redis-cli -h prod-cache-01 CONFIG SET maxmemory 4gb", risk: "needs-approval" },
      ],
      rollback: "redis-cli -h prod-cache-01 CONFIG SET maxmemory 2gb && redis-cli -h prod-cache-01 CONFIG REWRITE",
      riskLevel: "needs-approval",
      dryRunOutput: `DRY RUN SIMULATION (prod-cache-01):
> INFO memory
used_memory: 2,147,483,648 (2.00 GB / 100% of limit)
mem_fragmentation_ratio: 2.34 ⚠️  HIGH
> MEMORY PURGE → would reclaim ~340MB
> EXPIRE scan: 48,291 keys without TTL found
> CONFIG SET maxmemory 4gb → would succeed (kernel limit: 16GB available)
─────────────────────────────────
Estimated impact: ✓ Non-destructive  ✓ Reversible  ⚠️ Session keys affected`,
    },
  },
  "INC-2992": {
    summary: "api-gateway pod is in CrashLoopBackOff due to a nil pointer dereference in the main goroutine. Timing correlates with the v2.4.1 deployment 30 minutes ago. No previous crash history for this service in the last 60 days.",
    rootCause: "Go runtime panic on invalid memory address dereference. Likely a missing nil check on a newly introduced config struct field. The staging env config may lack a required field added in v2.4.1.",
    components: ["api-gateway (pod: api-gateway-7d9f8c-xk2p1)", "k8s-node-04", "ingress-nginx"],
    confidence: 84,
    recommendation: {
      steps: [
        "Capture full panic stacktrace from pod logs",
        "Roll back deployment to v2.4.0",
        "Verify staging configmap has required new fields",
        "Redeploy v2.4.1 after config patch",
      ],
      commands: [
        { id: "cmd-1", label: "Get full crash stacktrace", cmd: "kubectl logs api-gateway-7d9f8c-xk2p1 --previous -n staging | tail -50", risk: "safe" },
        { id: "cmd-2", label: "Rollback deployment to v2.4.0", cmd: "kubectl rollout undo deployment/api-gateway -n staging", risk: "needs-approval" },
        { id: "cmd-3", label: "Verify rollout status", cmd: "kubectl rollout status deployment/api-gateway -n staging --timeout=120s", risk: "safe" },
      ],
      rollback: "kubectl rollout undo deployment/api-gateway -n staging (already is rollback)",
      riskLevel: "needs-approval",
      dryRunOutput: `DRY RUN SIMULATION (k8s-node-04 / staging):
> kubectl rollout undo deployment/api-gateway
  Current: v2.4.1 (image: gcr.io/co/api-gateway:v2.4.1)
  Target:  v2.4.0 (image: gcr.io/co/api-gateway:v2.4.0)
  Pods affected: 2 replicas
  Estimated downtime: ~45s rolling restart
> kubectl rollout status → would reach "successfully rolled out"
─────────────────────────────────
Estimated impact: ✓ Staging only  ✓ Reversible  ✓ No data loss`,
    },
  },
  "INC-2993": {
    summary: "PgBouncer connection pool is fully saturated at 100 max connections. Connection usage spiked from 40 to 100 over 8 minutes. User-service has 12 pods each holding idle connections, consuming the pool without releasing.",
    rootCause: "Connection pool exhaustion caused by idle connection hoarding in user-service pods. Recent scale-out from 6→12 pods doubled pool consumption without corresponding PgBouncer limit adjustment.",
    components: ["db-primary-03 (PostgreSQL 15)", "pgbouncer-svc", "user-service (12 pods)"],
    confidence: 88,
    recommendation: {
      steps: [
        "Kill idle connections older than 5 minutes",
        "Increase PgBouncer max_client_conn to 200",
        "Set pool_size per database to 15",
        "Restart user-service pods to reset connection state",
      ],
      commands: [
        { id: "cmd-1", label: "List idle connections", cmd: `psql -h db-primary-03 -U admin -c "SELECT pid, state, query_start, application_name FROM pg_stat_activity WHERE state='idle' ORDER BY query_start;"`, risk: "safe" },
        { id: "cmd-2", label: "Terminate idle connections (>5min)", cmd: `psql -h db-primary-03 -U admin -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE state='idle' AND query_start < NOW() - INTERVAL '5 minutes';"`, risk: "high-risk" },
        { id: "cmd-3", label: "Increase PgBouncer pool limit", cmd: "pgbouncer-ctl -c /etc/pgbouncer/pgbouncer.ini set max_client_conn=200 && pgbouncer-ctl reload", risk: "needs-approval" },
      ],
      rollback: "pgbouncer-ctl set max_client_conn=100 && pgbouncer-ctl reload",
      riskLevel: "high-risk",
      dryRunOutput: `DRY RUN SIMULATION (db-primary-03):
> pg_stat_activity query:
  Total connections: 100/100 (SATURATED)
  Idle connections: 67 (avg idle time: 8.3 min)
  Idle >5min: 52 connections (eligible for termination)
> pg_terminate_backend → would terminate 52 idle pids
  Active queries affected: 0
> PgBouncer reload: max_client_conn 100→200
─────────────────────────────────
Estimated impact: ⚠️ Terminates idle sessions  ✓ No data loss  ✓ Reversible`,
    },
  },
};

// ─── Utility ────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RiskBadge = ({ level }) => {
  const map = {
    safe: { label: "SAFE", color: "#00d68f", bg: "rgba(0,214,143,0.12)" },
    "needs-approval": { label: "NEEDS APPROVAL", color: "#f5a623", bg: "rgba(245,166,35,0.12)" },
    "high-risk": { label: "HIGH RISK", color: "#ff4d6d", bg: "rgba(255,77,109,0.12)" },
  };
  const s = map[level] || map["safe"];
  return (
    <span style={{ background: s.bg, color: s.color, border: `1px solid ${s.color}40`, borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700, letterSpacing: 1, fontFamily: "monospace" }}>
      {s.label}
    </span>
  );
};

const SeverityBadge = ({ sev }) => {
  const map = { P1: "#ff4d6d", P2: "#f5a623", P3: "#f0e040", P4: "#aaa" };
  return (
    <span style={{ background: `${map[sev]}22`, color: map[sev], border: `1px solid ${map[sev]}55`, borderRadius: 4, padding: "2px 8px", fontSize: 11, fontWeight: 700, fontFamily: "monospace" }}>
      {sev}
    </span>
  );
};

const StepIndicator = ({ steps, current }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 0, marginBottom: 32 }}>
    {steps.map((s, i) => (
      <div key={i} style={{ display: "flex", alignItems: "center", flex: i < steps.length - 1 ? 1 : "none" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div style={{
            width: 32, height: 32, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
            background: i < current ? "#00d68f" : i === current ? "#4361ee" : "transparent",
            border: `2px solid ${i < current ? "#00d68f" : i === current ? "#4361ee" : "#333"}`,
            fontSize: 13, fontWeight: 700, color: i <= current ? "#fff" : "#555",
            transition: "all 0.3s ease",
          }}>
            {i < current ? "✓" : i + 1}
          </div>
          <span style={{ fontSize: 10, color: i === current ? "#a0b4ff" : i < current ? "#00d68f" : "#555", whiteSpace: "nowrap", fontWeight: i === current ? 700 : 400 }}>{s}</span>
        </div>
        {i < steps.length - 1 && (
          <div style={{ flex: 1, height: 2, background: i < current ? "#00d68f" : "#222", margin: "0 8px", marginBottom: 18, transition: "background 0.3s ease" }} />
        )}
      </div>
    ))}
  </div>
);

// ─── Sub-views ────────────────────────────────────────────────────────────────

function TicketList({ onSelect }) {
  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700, color: "#e8eaf6", margin: 0 }}>Incident Queue</h2>
        <p style={{ color: "#666", fontSize: 14, marginTop: 6 }}>3 open incidents awaiting AI analysis & engineer review</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {MOCK_TICKETS.map((t) => (
          <div key={t.id} onClick={() => onSelect(t)}
            style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 10, padding: "18px 20px", cursor: "pointer", transition: "all 0.2s", display: "flex", alignItems: "flex-start", gap: 16 }}
            onMouseEnter={e => e.currentTarget.style.borderColor = "#4361ee"}
            onMouseLeave={e => e.currentTarget.style.borderColor = "#1e1e2e"}
          >
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <SeverityBadge sev={t.severity} />
                <span style={{ fontSize: 13, color: "#555", fontFamily: "monospace" }}>{t.id}</span>
                <span style={{ fontSize: 12, color: "#555" }}>•</span>
                <span style={{ fontSize: 12, color: "#4361ee" }}>{t.env}</span>
              </div>
              <div style={{ fontSize: 16, fontWeight: 600, color: "#e8eaf6", marginBottom: 6 }}>{t.title}</div>
              <div style={{ fontSize: 13, color: "#666" }}>{t.app} · {t.host}</div>
            </div>
            <div style={{ color: "#4361ee", fontSize: 20, marginTop: 4 }}>→</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function useTypewriter(text, speed = 12) {
  const [displayed, setDisplayed] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    setDisplayed("");
    setDone(false);
    let i = 0;
    const interval = setInterval(() => {
      i++;
      setDisplayed(text.slice(0, i));
      if (i >= text.length) { clearInterval(interval); setDone(true); }
    }, speed);
    return () => clearInterval(interval);
  }, [text]);
  return { displayed, done };
}

function ContextFetch({ ticket, onDone }) {
  const [phase, setPhase] = useState(0);
  const kb = MOCK_KB.filter(k => k.tags.some(t => ticket.tags.includes(t)));
  const past = MOCK_PAST;

  useEffect(() => {
    const timers = [
      setTimeout(() => setPhase(1), 600),
      setTimeout(() => setPhase(2), 1400),
      setTimeout(() => setPhase(3), 2200),
      setTimeout(() => setPhase(4), 3000),
      setTimeout(() => setPhase(5), 3600),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  const items = [
    { label: "Fetching KB articles…", done: phase > 1 },
    { label: "Loading SOPs & runbooks…", done: phase > 2 },
    { label: "Querying historical incidents…", done: phase > 3 },
    { label: "Pulling monitoring links…", done: phase > 4 },
  ];

  return (
    <div>
      <h3 style={{ color: "#a0b4ff", fontSize: 14, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", marginBottom: 20 }}>Context Builder</h3>
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 24 }}>
        {items.map((it, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, color: it.done ? "#00d68f" : phase === i ? "#a0b4ff" : "#444", fontSize: 14, transition: "color 0.3s" }}>
            <span>{it.done ? "✓" : phase === i ? "⟳" : "○"}</span>
            <span>{it.label}</span>
          </div>
        ))}
      </div>
      {phase >= 3 && (
        <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "#666", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Matched Knowledge Base</div>
          {kb.map(k => (
            <div key={k.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid #111" }}>
              <span style={{ fontSize: 12, color: "#4361ee", fontFamily: "monospace" }}>{k.id}</span>
              <span style={{ fontSize: 13, color: "#c0c8ff" }}>{k.title}</span>
            </div>
          ))}
        </div>
      )}
      {phase >= 4 && (
        <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "#666", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Similar Past Incidents</div>
          {past.map(p => (
            <div key={p.id} style={{ padding: "6px 0", borderBottom: "1px solid #111" }}>
              <div style={{ display: "flex", gap: 10, marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: "#4361ee", fontFamily: "monospace" }}>{p.id}</span>
                <span style={{ fontSize: 12, color: "#00d68f" }}>{p.similarity}% match</span>
                <span style={{ fontSize: 12, color: "#555" }}>{p.date}</span>
              </div>
              <div style={{ fontSize: 13, color: "#888" }}>{p.resolution}</div>
            </div>
          ))}
        </div>
      )}
      {phase >= 5 && (
        <button onClick={onDone} style={{ background: "#4361ee", color: "#fff", border: "none", borderRadius: 8, padding: "10px 24px", fontWeight: 700, cursor: "pointer", fontSize: 14, marginTop: 8 }}>
          Run LLM Analysis →
        </button>
      )}
    </div>
  );
}

function LLMAnalysis({ ticket, onDone }) {
  const analysis = LLM_ANALYSIS[ticket.id];
  const { displayed: summaryText, done: summaryDone } = useTypewriter(analysis.summary, 8);
  const { displayed: rcText, done: rcDone } = useTypewriter(summaryDone ? analysis.rootCause : "", 8);
  const [showConf, setShowConf] = useState(false);

  useEffect(() => {
    if (rcDone) setTimeout(() => setShowConf(true), 300);
  }, [rcDone]);

  return (
    <div>
      <h3 style={{ color: "#a0b4ff", fontSize: 14, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", marginBottom: 20 }}>LLM Summarization</h3>
      <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "#666", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>Incident Summary</div>
        <p style={{ fontSize: 14, color: "#c0c8ff", lineHeight: 1.7, margin: 0, minHeight: 80 }}>{summaryText}<span style={{ opacity: summaryDone ? 0 : 1 }}>▋</span></p>
      </div>
      {summaryDone && (
        <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "#f5a623", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>Probable Root Cause</div>
          <p style={{ fontSize: 14, color: "#c0c8ff", lineHeight: 1.7, margin: 0, minHeight: 60 }}>{rcText}<span style={{ opacity: rcDone ? 0 : 1 }}>▋</span></p>
        </div>
      )}
      {showConf && (
        <div style={{ display: "flex", gap: 16, marginBottom: 20 }}>
          <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, flex: 1 }}>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 8, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Confidence</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: analysis.confidence > 85 ? "#00d68f" : "#f5a623" }}>{analysis.confidence}%</div>
          </div>
          <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, flex: 2 }}>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 8, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>Impacted Components</div>
            {analysis.components.map((c, i) => (
              <div key={i} style={{ fontSize: 13, color: "#c0c8ff", padding: "3px 0" }}>• {c}</div>
            ))}
          </div>
        </div>
      )}
      {showConf && (
        <button onClick={onDone} style={{ background: "#4361ee", color: "#fff", border: "none", borderRadius: 8, padding: "10px 24px", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>
          View Recommendations →
        </button>
      )}
    </div>
  );
}

function HITLReview({ ticket, onDecision }) {
  const analysis = LLM_ANALYSIS[ticket.id];
  const rec = analysis.recommendation;
  const [showDryRun, setShowDryRun] = useState(false);
  const [editingCmd, setEditingCmd] = useState(null);
  const [commands, setCommands] = useState(rec.commands);
  const [note, setNote] = useState("");
  const [tab, setTab] = useState("recommendation");

  const updateCmd = (id, val) => setCommands(cs => cs.map(c => c.id === id ? { ...c, cmd: val } : c));

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h3 style={{ color: "#a0b4ff", fontSize: 14, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", margin: 0 }}>HITL Review – L2/L3 Engineer</h3>
        <RiskBadge level={rec.riskLevel} />
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid #1e1e2e", marginBottom: 20 }}>
        {["recommendation", "ticket", "dry-run"].map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ background: "none", border: "none", borderBottom: `2px solid ${tab === t ? "#4361ee" : "transparent"}`, color: tab === t ? "#a0b4ff" : "#555", padding: "8px 16px", cursor: "pointer", fontSize: 13, fontWeight: 700, textTransform: "capitalize", marginBottom: -1 }}>
            {t === "dry-run" ? "Dry Run Output" : t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === "ticket" && (
        <div>
          <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ display: "flex", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
              <SeverityBadge sev={ticket.severity} />
              <span style={{ fontSize: 13, color: "#4361ee", fontFamily: "monospace" }}>{ticket.id}</span>
              <span style={{ fontSize: 13, color: "#666" }}>{ticket.env} · {ticket.host}</span>
            </div>
            <div style={{ fontSize: 15, fontWeight: 600, color: "#e8eaf6", marginBottom: 10 }}>{ticket.title}</div>
            <p style={{ fontSize: 13, color: "#888", lineHeight: 1.7, margin: 0 }}>{ticket.description}</p>
          </div>
          <div style={{ background: "#050509", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16 }}>
            <div style={{ fontSize: 12, color: "#666", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 10 }}>Raw Logs</div>
            <pre style={{ fontSize: 12, color: "#7aebbc", margin: 0, lineHeight: 1.7, overflow: "auto", fontFamily: "'Fira Code', monospace" }}>{ticket.logs}</pre>
          </div>
        </div>
      )}

      {tab === "recommendation" && (
        <div>
          <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "#666", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Resolution Steps</div>
            {rec.steps.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 12, padding: "6px 0", borderBottom: "1px solid #111" }}>
                <span style={{ color: "#4361ee", fontFamily: "monospace", fontSize: 13, minWidth: 20 }}>{i + 1}.</span>
                <span style={{ fontSize: 13, color: "#c0c8ff" }}>{s}</span>
              </div>
            ))}
          </div>

          <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "#666", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Commands to Execute</div>
            {commands.map((c) => (
              <div key={c.id} style={{ marginBottom: 12, padding: 12, background: "#050509", borderRadius: 6, border: "1px solid #1a1a2a" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: "#e8eaf6", fontWeight: 600 }}>{c.label}</span>
                  <RiskBadge level={c.risk} />
                </div>
                {editingCmd === c.id ? (
                  <div>
                    <textarea value={c.cmd} onChange={e => updateCmd(c.id, e.target.value)}
                      style={{ width: "100%", background: "#0d0d1a", border: "1px solid #4361ee", borderRadius: 4, color: "#7aebbc", fontFamily: "'Fira Code', monospace", fontSize: 12, padding: 8, lineHeight: 1.6, boxSizing: "border-box", resize: "vertical", minHeight: 60 }} />
                    <button onClick={() => setEditingCmd(null)} style={{ marginTop: 6, background: "#4361ee22", color: "#a0b4ff", border: "1px solid #4361ee", borderRadius: 4, padding: "4px 12px", cursor: "pointer", fontSize: 12 }}>Done</button>
                  </div>
                ) : (
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                    <code style={{ flex: 1, fontSize: 12, color: "#7aebbc", fontFamily: "'Fira Code', monospace", background: "#050509", padding: "6px 8px", borderRadius: 4, lineHeight: 1.7, wordBreak: "break-all" }}>{c.cmd}</code>
                    <button onClick={() => setEditingCmd(c.id)} style={{ background: "none", border: "1px solid #333", borderRadius: 4, color: "#666", padding: "4px 10px", cursor: "pointer", fontSize: 11, flexShrink: 0, marginTop: 2 }}>Edit</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <div style={{ background: "#0a0a12", border: "1px solid #ff4d6d22", borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: "#ff4d6d", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 6 }}>Rollback Command</div>
            <code style={{ fontSize: 12, color: "#ff9aaa", fontFamily: "'Fira Code', monospace" }}>{rec.rollback}</code>
          </div>
        </div>
      )}

      {tab === "dry-run" && (
        <div>
          <div style={{ background: "#050509", border: "1px solid #00d68f33", borderRadius: 8, padding: 16 }}>
            <div style={{ fontSize: 12, color: "#00d68f", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Dry Run Simulation</div>
            <pre style={{ fontSize: 13, color: "#7aebbc", margin: 0, lineHeight: 1.8, fontFamily: "'Fira Code', monospace", whiteSpace: "pre-wrap" }}>{rec.dryRunOutput}</pre>
          </div>
          <div style={{ marginTop: 12, padding: 10, background: "#0d0d14", borderRadius: 6, border: "1px solid #333", fontSize: 12, color: "#666" }}>
            ⚠️ This is a simulation only. No changes were made to the target system.
          </div>
        </div>
      )}

      {/* Engineer note */}
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 12, color: "#666", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>Engineer Notes (optional)</div>
        <textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Add context, concerns, or modifications rationale…"
          style={{ width: "100%", background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, color: "#c0c8ff", fontSize: 13, padding: "10px 14px", lineHeight: 1.7, boxSizing: "border-box", resize: "vertical", minHeight: 70, fontFamily: "inherit", outline: "none" }} />
      </div>

      {/* Decision buttons */}
      <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
        <button onClick={() => onDecision("approve", commands, note)}
          style={{ flex: 1, background: "#00d68f", color: "#000", border: "none", borderRadius: 8, padding: "12px 0", fontWeight: 800, cursor: "pointer", fontSize: 14, letterSpacing: 0.5 }}>
          ✓ Approve & Queue
        </button>
        <button onClick={() => onDecision("modify", commands, note)}
          style={{ flex: 1, background: "#f5a62322", color: "#f5a623", border: "1px solid #f5a623", borderRadius: 8, padding: "12px 0", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>
          ✎ Approve as Modified
        </button>
        <button onClick={() => onDecision("reject", commands, note)}
          style={{ flex: 1, background: "#ff4d6d22", color: "#ff4d6d", border: "1px solid #ff4d6d", borderRadius: 8, padding: "12px 0", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>
          ✕ Reject
        </button>
      </div>
    </div>
  );
}

function ExecutionView({ ticket, decision, commands, onDone }) {
  const [execPhase, setExecPhase] = useState(0);
  const [cmdStatuses, setCmdStatuses] = useState({});

  useEffect(() => {
    if (decision === "reject") { setExecPhase(99); return; }
    const run = async () => {
      await sleep(500); setExecPhase(1);
      await sleep(800); setExecPhase(2);
      await sleep(600); setExecPhase(3);
      // simulate command execution
      for (let i = 0; i < commands.length; i++) {
        await sleep(700);
        setCmdStatuses(s => ({ ...s, [commands[i].id]: "running" }));
        await sleep(900 + Math.random() * 600);
        setCmdStatuses(s => ({ ...s, [commands[i].id]: "done" }));
      }
      await sleep(500); setExecPhase(4);
      await sleep(600); setExecPhase(5);
    };
    run();
  }, []);

  if (execPhase === 99) return (
    <div>
      <div style={{ textAlign: "center", padding: 40 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>✕</div>
        <div style={{ fontSize: 20, fontWeight: 700, color: "#ff4d6d", marginBottom: 12 }}>Ticket Rejected</div>
        <p style={{ color: "#666", fontSize: 14 }}>Feedback recorded. Knowledge base updated. Ticket status set to Rejected.</p>
        <button onClick={onDone} style={{ marginTop: 20, background: "#4361ee", color: "#fff", border: "none", borderRadius: 8, padding: "10px 24px", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>← Back to Queue</button>
      </div>
    </div>
  );

  const checks = [
    { label: "Access verification", done: execPhase > 1 },
    { label: "Target system reachability", done: execPhase > 2 },
    { label: "Dependency check", done: execPhase > 3 },
  ];

  return (
    <div>
      <h3 style={{ color: "#a0b4ff", fontSize: 14, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase", marginBottom: 20 }}>Execution Orchestrator</h3>

      <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: "#666", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Pre-Execution Checks</div>
        {checks.map((c, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0", fontSize: 13, color: c.done ? "#00d68f" : "#555", transition: "color 0.3s" }}>
            <span>{c.done ? "✓" : execPhase > i ? "⟳" : "○"}</span>
            <span>{c.label}</span>
          </div>
        ))}
      </div>

      {execPhase >= 4 && (
        <div style={{ background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: "#666", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 12 }}>Command Execution</div>
          {commands.map(c => (
            <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: "1px solid #111" }}>
              <span style={{ fontSize: 13, color: cmdStatuses[c.id] === "done" ? "#00d68f" : cmdStatuses[c.id] === "running" ? "#f5a623" : "#555" }}>
                {cmdStatuses[c.id] === "done" ? "✓" : cmdStatuses[c.id] === "running" ? "⟳" : "○"}
              </span>
              <span style={{ fontSize: 13, color: "#c0c8ff", flex: 1 }}>{c.label}</span>
              <span style={{ fontSize: 11, color: "#555", fontFamily: "monospace" }}>
                {cmdStatuses[c.id] === "done" ? "exit 0" : cmdStatuses[c.id] === "running" ? "running…" : "pending"}
              </span>
            </div>
          ))}
        </div>
      )}

      {execPhase >= 5 && (
        <div>
          <div style={{ background: "#050509", border: "1px solid #00d68f44", borderRadius: 8, padding: 16, marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#00d68f", marginBottom: 10 }}>✓ Execution Successful</div>
            <pre style={{ fontSize: 12, color: "#7aebbc", margin: 0, lineHeight: 1.7, fontFamily: "'Fira Code', monospace", whiteSpace: "pre-wrap" }}>
{`All commands completed successfully.
Target: ${ticket.host}
Executed by: L2-eng-session
Audit log: s3://audit-logs/exec/${ticket.id}-${Date.now()}.json
Ticket ${ticket.id}: auto-updated → RESOLVED`}
            </pre>
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            <div style={{ flex: 1, background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 14, fontSize: 13 }}>
              <div style={{ color: "#666", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Audit Log</div>
              <div style={{ color: "#00d68f" }}>✓ Written to S3</div>
            </div>
            <div style={{ flex: 1, background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 14, fontSize: 13 }}>
              <div style={{ color: "#666", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Ticket</div>
              <div style={{ color: "#00d68f" }}>✓ Auto-closed</div>
            </div>
            <div style={{ flex: 1, background: "#0a0a12", border: "1px solid #1e1e2e", borderRadius: 8, padding: 14, fontSize: 13 }}>
              <div style={{ color: "#666", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>KB Feedback</div>
              <div style={{ color: "#00d68f" }}>✓ Learned</div>
            </div>
          </div>
          <button onClick={onDone} style={{ marginTop: 20, background: "#4361ee", color: "#fff", border: "none", borderRadius: 8, padding: "10px 24px", fontWeight: 700, cursor: "pointer", fontSize: 14 }}>← Back to Queue</button>
        </div>
      )}
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────
const STEPS = ["Ticket", "Context", "LLM Analysis", "HITL Review", "Execution"];

export default function App() {
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [step, setStep] = useState(0);
  const [decision, setDecision] = useState(null);
  const [approvedCmds, setApprovedCmds] = useState(null);

  const handleSelect = (t) => { setSelectedTicket(t); setStep(1); setDecision(null); setApprovedCmds(null); };
  const handleBack = () => { setSelectedTicket(null); setStep(0); };
  const handleDecision = (d, cmds, note) => { setDecision(d); setApprovedCmds(cmds); setStep(4); };

  return (
    <div style={{ minHeight: "100vh", background: "#07070f", color: "#e8eaf6", fontFamily: "'DM Sans', 'Segoe UI', sans-serif" }}>
      {/* Top nav */}
      <div style={{ background: "#0a0a14", borderBottom: "1px solid #1e1e2e", padding: "0 32px", display: "flex", alignItems: "center", height: 56, gap: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 28, height: 28, background: "#4361ee", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>⚡</div>
          <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: 0.5 }}>RemediateAI</span>
          <span style={{ fontSize: 11, color: "#4361ee", background: "#4361ee22", padding: "2px 8px", borderRadius: 20, fontWeight: 700 }}>MVP</span>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 24, fontSize: 13, color: "#555" }}>
          <span style={{ color: "#a0b4ff" }}>HITL Platform</span>
          <span>Audit Logs</span>
          <span>KB Manager</span>
        </div>
        <div style={{ width: 32, height: 32, background: "#4361ee44", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, color: "#a0b4ff", fontWeight: 700 }}>L2</div>
      </div>

      <div style={{ maxWidth: 900, margin: "0 auto", padding: "32px 24px" }}>
        {!selectedTicket ? (
          <TicketList onSelect={handleSelect} />
        ) : (
          <div>
            {/* Breadcrumb */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28, fontSize: 13 }}>
              <button onClick={handleBack} style={{ background: "none", border: "none", color: "#4361ee", cursor: "pointer", padding: 0, fontSize: 13 }}>← Incident Queue</button>
              <span style={{ color: "#333" }}>/</span>
              <span style={{ color: "#888" }}>{selectedTicket.id}</span>
              <span style={{ color: "#333" }}>/</span>
              <span style={{ color: "#a0b4ff" }}>{STEPS[step]}</span>
            </div>

            {/* Ticket header */}
            <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 10, padding: "16px 20px", marginBottom: 28, display: "flex", alignItems: "center", gap: 14 }}>
              <SeverityBadge sev={selectedTicket.severity} />
              <span style={{ fontFamily: "monospace", fontSize: 13, color: "#4361ee" }}>{selectedTicket.id}</span>
              <span style={{ fontSize: 15, fontWeight: 600, color: "#e8eaf6", flex: 1 }}>{selectedTicket.title}</span>
              <span style={{ fontSize: 12, color: "#555" }}>{selectedTicket.env} · {selectedTicket.app}</span>
            </div>

            <StepIndicator steps={STEPS} current={step} />

            <div style={{ background: "#0d0d14", border: "1px solid #1e1e2e", borderRadius: 12, padding: 24 }}>
              {step === 1 && <ContextFetch ticket={selectedTicket} onDone={() => setStep(2)} />}
              {step === 2 && <LLMAnalysis ticket={selectedTicket} onDone={() => setStep(3)} />}
              {step === 3 && <HITLReview ticket={selectedTicket} onDecision={handleDecision} />}
              {step === 4 && <ExecutionView ticket={selectedTicket} decision={decision} commands={approvedCmds || []} onDone={handleBack} />}
            </div>
          </div>
        )}
      </div>

      {/* Footer guarantee bar */}
      <div style={{ position: "fixed", bottom: 0, left: 0, right: 0, background: "#0a0a14", borderTop: "1px solid #1e1e2e", padding: "8px 32px", display: "flex", gap: 32, justifyContent: "center" }}>
        {[
          "🔒 No auto-execution without L2/L3 approval",
          "🧪 Dry Run ≠ Execution",
          "🛡️ Secure access · No inbound exposure",
          "📋 Every action audited & traced",
        ].map((g, i) => (
          <span key={i} style={{ fontSize: 11, color: "#444", fontWeight: 500 }}>{g}</span>
        ))}
      </div>
    </div>
  );
}
